#!/usr/bin/env python3
"""Allocate the next Reflo ADR number after checking every active claim source."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml
except ImportError:
    print(
        "ERROR: PyYAML==6.0.3 is required; run: "
        "python3 -m pip install --requirement scripts/requirements-governance.txt",
        file=sys.stderr,
    )
    raise SystemExit(2)

if getattr(yaml, "__version__", None) != "6.0.3":
    print(
        "ERROR: exactly PyYAML==6.0.3 is required; run: "
        "python3 -m pip install --requirement scripts/requirements-governance.txt",
        file=sys.stderr,
    )
    raise SystemExit(2)


ADR_PATH = re.compile(r"^docs/adrs/(?P<id>\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
CANONICAL_ID = re.compile(r"^\d{4}$")
README_PATH = "docs/adrs/README.md"


class InventoryError(RuntimeError):
    """Raised when allocation cannot prove that a number is safe."""


@dataclass(frozen=True)
class PullRequest:
    number: int
    base_ref_name: str
    state: str
    merged_at: str | None
    files: tuple[str, ...]


def run(
    command: list[str],
    *,
    root: Path,
    allow_failure: bool = False,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=root,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode and not allow_failure:
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic"
        raise InventoryError(f"{' '.join(command)} failed: {detail}")
    return result


def git_output(root: Path, *arguments: str) -> str:
    return run(["git", *arguments], root=root).stdout


def normalized_paths(lines: Iterable[str]) -> tuple[str, ...]:
    return tuple(sorted({line.strip() for line in lines if line.strip()}))


def parse_adr_paths(paths: Iterable[str], source: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for path in normalized_paths(paths):
        if not path.startswith("docs/adrs/") or path == README_PATH:
            continue
        if not path.endswith(".md"):
            continue
        match = ADR_PATH.fullmatch(path)
        if not match:
            raise InventoryError(f"{source} contains malformed ADR path {path!r}")
        canonical_id = match.group("id")
        previous = parsed.get(canonical_id)
        if previous and previous != path:
            raise InventoryError(
                f"{source} claims ADR {canonical_id} in both {previous!r} and {path!r}"
            )
        parsed[canonical_id] = path
    return parsed


def load_yaml(source: str, label: str) -> dict[str, Any]:
    try:
        value = yaml.safe_load(source)
    except yaml.YAMLError as exc:
        raise InventoryError(f"{label} is not valid YAML: {exc}") from exc
    if not isinstance(value, dict):
        raise InventoryError(f"{label} must contain a YAML mapping")
    return value


def load_reserved_ids(root: Path) -> set[str]:
    path = root / ".adr-governance.yaml"
    try:
        config = load_yaml(path.read_text(encoding="utf-8"), path.as_posix())
    except OSError as exc:
        raise InventoryError(f"cannot read {path}: {exc}") from exc
    mapping = config.get("legacy_ids")
    if not isinstance(mapping, dict):
        raise InventoryError(".adr-governance.yaml legacy_ids must be a mapping")
    ids: set[str] = set()
    for alias, canonical_id in mapping.items():
        if not isinstance(alias, str) or not isinstance(canonical_id, str):
            raise InventoryError(".adr-governance.yaml legacy_ids must map strings to strings")
        if not CANONICAL_ID.fullmatch(canonical_id):
            raise InventoryError(
                f".adr-governance.yaml maps {alias!r} to invalid ADR ID {canonical_id!r}"
            )
        ids.add(canonical_id)
    return ids


def local_adr_paths(root: Path) -> tuple[str, ...]:
    directory = root / "docs/adrs"
    if not directory.is_dir():
        raise InventoryError("docs/adrs does not exist")
    return normalized_paths(
        path.relative_to(root).as_posix() for path in directory.glob("*.md")
    )


def target_adr_paths(root: Path, target_ref: str) -> tuple[str, ...]:
    run(["git", "rev-parse", "--verify", f"{target_ref}^{{commit}}"], root=root)
    return normalized_paths(
        git_output(root, "ls-tree", "-r", "--name-only", target_ref, "--", "docs/adrs").splitlines()
    )


def current_branch(root: Path) -> str:
    branch = git_output(root, "branch", "--show-current").strip()
    if not branch:
        raise InventoryError("detached HEAD makes current-PR exclusion uncertain")
    return branch


class GitHub:
    def __init__(self, root: Path, fixture: Path | None) -> None:
        self.root = root
        self.fixture = fixture
        self.data: dict[str, Any] | None = None
        if fixture:
            try:
                value = json.loads(fixture.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise InventoryError(f"cannot load GitHub fixture {fixture}: {exc}") from exc
            if not isinstance(value, dict):
                raise InventoryError("GitHub fixture must contain a JSON object")
            self.data = value

    @staticmethod
    def _parse_pr(value: Any, *, require_files: bool) -> PullRequest:
        if not isinstance(value, dict):
            raise InventoryError("GitHub pull-request data must be an object")
        try:
            number = int(value["number"])
            base = str(value["base_ref_name"])
            state = str(value.get("state", "OPEN")).upper()
            merged_at = value.get("merged_at")
            files_value = value.get("files", [])
        except (KeyError, TypeError, ValueError) as exc:
            raise InventoryError(f"invalid GitHub pull-request data: {value!r}") from exc
        if require_files and not isinstance(files_value, list):
            raise InventoryError(f"pull request #{number} files must be a list")
        files = tuple(str(path) for path in files_value) if isinstance(files_value, list) else ()
        return PullRequest(number, base, state, str(merged_at) if merged_at else None, files)

    def current_pull_request(self, branch: str) -> PullRequest | None:
        if self.data is not None:
            value = self.data.get("current_pr")
            return None if value is None else self._parse_pr(value, require_files=False)

        result = run(
            [
                "gh",
                "pr",
                "list",
                "--head",
                branch,
                "--state",
                "all",
                "--json",
                "number,state,mergedAt,baseRefName",
            ],
            root=self.root,
        )
        try:
            values = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise InventoryError("gh pr list returned invalid JSON") from exc
        if not isinstance(values, list):
            raise InventoryError("gh pr list did not return a JSON list")
        if len(values) > 1:
            raise InventoryError(
                f"branch {branch!r} has multiple pull requests; merge state is uncertain"
            )
        if not values:
            return None
        value = values[0]
        normalized = {
            "number": value.get("number"),
            "state": value.get("state"),
            "merged_at": value.get("mergedAt"),
            "base_ref_name": value.get("baseRefName"),
        }
        return self._parse_pr(normalized, require_files=False)

    def open_pull_requests(self, base_branch: str) -> tuple[PullRequest, ...]:
        if self.data is not None:
            values = self.data.get("open_prs", [])
            if not isinstance(values, list):
                raise InventoryError("GitHub fixture open_prs must be a list")
            prs = tuple(self._parse_pr(value, require_files=True) for value in values)
            for pr in prs:
                if pr.state != "OPEN" or pr.merged_at:
                    raise InventoryError(
                        f"fixture lists non-open pull request #{pr.number} as open"
                    )
                if pr.base_ref_name != base_branch:
                    raise InventoryError(
                        f"fixture pull request #{pr.number} targets {pr.base_ref_name!r}, "
                        f"not {base_branch!r}"
                    )
            return tuple(sorted(prs, key=lambda pr: pr.number))

        listed = run(
            [
                "gh",
                "pr",
                "list",
                "--base",
                base_branch,
                "--state",
                "open",
                "--json",
                "number,state,mergedAt,baseRefName",
            ],
            root=self.root,
        )
        try:
            values = json.loads(listed.stdout)
        except json.JSONDecodeError as exc:
            raise InventoryError("gh pr list returned invalid JSON") from exc
        if not isinstance(values, list):
            raise InventoryError("gh pr list did not return a JSON list")
        repository = run(
            ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
            root=self.root,
        ).stdout.strip()
        if not repository or "/" not in repository:
            raise InventoryError("gh repo view did not return owner/name")
        prs: list[PullRequest] = []
        for value in sorted(values, key=lambda item: int(item["number"])):
            number = int(value["number"])
            files = run(
                [
                    "gh",
                    "api",
                    "--paginate",
                    "--jq",
                    '.[] | select(.status == "added" or .status == "renamed") | .filename',
                    f"repos/{repository}/pulls/{number}/files",
                ],
                root=self.root,
            ).stdout.splitlines()
            normalized = {
                "number": number,
                "state": value.get("state"),
                "merged_at": value.get("mergedAt"),
                "base_ref_name": value.get("baseRefName"),
                "files": files,
            }
            prs.append(self._parse_pr(normalized, require_files=True))
        return tuple(prs)


@dataclass(frozen=True)
class Inventory:
    reserved: frozenset[str]
    local: dict[str, str]
    target: dict[str, str]
    open_prs: tuple[tuple[int, dict[str, str]], ...]
    current_pr: PullRequest | None

    @property
    def used(self) -> set[str]:
        ids = set(self.reserved) | set(self.local) | set(self.target)
        for _, claims in self.open_prs:
            ids.update(claims)
        return ids


def build_inventory(
    root: Path,
    *,
    target_ref: str,
    base_branch: str,
    github_fixture: Path | None,
) -> Inventory:
    target = parse_adr_paths(target_adr_paths(root, target_ref), f"target ref {target_ref}")
    target_path_set = set(target.values())
    local = parse_adr_paths(
        (path for path in local_adr_paths(root) if path not in target_path_set),
        "new local ADR paths",
    )
    github = GitHub(root, github_fixture)
    current = github.current_pull_request(current_branch(root))
    if current and current.base_ref_name != base_branch:
        raise InventoryError(
            f"current pull request #{current.number} targets {current.base_ref_name!r}, "
            f"not {base_branch!r}"
        )
    if current and (current.state != "OPEN" or current.merged_at):
        raise InventoryError(
            f"current pull request #{current.number} is {current.state.lower()} or merged; "
            "ADR number operations are permitted only for an unmerged branch"
        )
    prs: list[tuple[int, dict[str, str]]] = []
    for pr in github.open_pull_requests(base_branch):
        if current and pr.number == current.number:
            continue
        prs.append((pr.number, parse_adr_paths(pr.files, f"open pull request #{pr.number}")))
    return Inventory(
        frozenset(load_reserved_ids(root)),
        local,
        target,
        tuple(prs),
        current,
    )


def collision_diagnostics(inventory: Inventory) -> list[str]:
    claims: dict[str, list[str]] = {}
    for canonical_id, path in inventory.target.items():
        claims.setdefault(canonical_id, []).append(f"target:{path}")
    for canonical_id, path in inventory.local.items():
        claims.setdefault(canonical_id, []).append(f"local:{path}")
    for number, pr_claims in inventory.open_prs:
        for canonical_id, path in pr_claims.items():
            claims.setdefault(canonical_id, []).append(f"pr#{number}:{path}")
    return [
        f"ADR {canonical_id} is claimed by {', '.join(sorted(sources))}"
        for canonical_id, sources in sorted(claims.items())
        if len(sources) > 1
    ]


def next_available(used: set[str]) -> str:
    for number in range(1, 10_000):
        candidate = f"{number:04d}"
        if candidate not in used:
            return candidate
    raise InventoryError("all four-digit ADR identifiers are exhausted")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--target-ref", default="origin/main")
    parser.add_argument("--base-branch", default="main")
    parser.add_argument("--github-fixture", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    try:
        root = args.root.resolve()
        inventory = build_inventory(
            root,
            target_ref=args.target_ref,
            base_branch=args.base_branch,
            github_fixture=args.github_fixture,
        )
        collisions = collision_diagnostics(inventory)
        if collisions:
            raise InventoryError(
                "existing ADR collision(s) make allocation unsafe:\n- "
                + "\n- ".join(collisions)
            )
        allocated = next_available(inventory.used)
    except InventoryError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.as_json:
        print(
            json.dumps(
                {
                    "allocated_id": allocated,
                    "base_branch": args.base_branch,
                    "current_pr": inventory.current_pr.number
                    if inventory.current_pr
                    else None,
                    "target_ref": args.target_ref,
                    "used_ids": sorted(inventory.used),
                },
                sort_keys=True,
            )
        )
    else:
        print(allocated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
