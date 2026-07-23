#!/usr/bin/env python3
"""Detect and safely renumber colliding, unmerged Reflo ADR drafts."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


WRITING_SCRIPTS = Path(__file__).resolve().parents[2] / "writing-adrs" / "scripts"
if str(WRITING_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(WRITING_SCRIPTS))

from allocate_adr_number import (  # noqa: E402
    ADR_PATH,
    Inventory,
    InventoryError,
    build_inventory,
    git_output,
    load_yaml,
    next_available,
    parse_adr_paths,
)


FRONTMATTER_ID = re.compile(r'^(id:\s*)["\']?(\d{4})["\']?\s*$', re.MULTILINE)
ADR_HEADING = re.compile(r"^(# ADR )(\d{4})(: .+)$", re.MULTILINE)
CANONICAL_REFERENCE = re.compile(r"\bADR (?P<id>\d{4})\b")
PROTECTED_FILES: set[str] = set()


@dataclass(frozen=True)
class Renumber:
    old_id: str
    new_id: str
    old_path: str
    new_path: str


def new_local_paths(root: Path, target_ref: str) -> tuple[str, ...]:
    committed = git_output(
        root,
        "diff",
        "--name-only",
        "--diff-filter=A",
        f"{target_ref}...HEAD",
        "--",
        "docs/adrs",
    ).splitlines()
    untracked = git_output(
        root,
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        "docs/adrs",
    ).splitlines()
    return tuple(sorted(set(committed + untracked)))


def ensure_unmerged(inventory: Inventory) -> None:
    current = inventory.current_pr
    if current and (current.state != "OPEN" or current.merged_at):
        raise InventoryError(
            f"pull request #{current.number} is {current.state.lower()} or merged; "
            "only unmerged ADR drafts may be renumbered"
        )


def external_claims(inventory: Inventory) -> set[str]:
    ids = set(inventory.target)
    for _, claims in inventory.open_prs:
        ids.update(claims)
    return ids


def plan_renumbers(
    inventory: Inventory,
    local_new: dict[str, str],
) -> tuple[Renumber, ...]:
    duplicate_local = [
        canonical_id
        for canonical_id, count in sorted(
            {
                canonical_id: sum(1 for value in local_new if value == canonical_id)
                for canonical_id in local_new
            }.items()
        )
        if count > 1
    ]
    if duplicate_local:
        raise InventoryError(
            "duplicate local ADR IDs are ambiguous and require manual disambiguation: "
            + ", ".join(duplicate_local)
        )

    taken_elsewhere = external_claims(inventory)
    colliding = [
        (canonical_id, path)
        for canonical_id, path in sorted(local_new.items(), key=lambda item: item[1])
        if canonical_id in taken_elsewhere
    ]
    used = set(inventory.reserved) | taken_elsewhere | set(local_new)
    planned: list[Renumber] = []
    for old_id, old_path in colliding:
        new_id = next_available(used)
        used.add(new_id)
        old_name = Path(old_path).name
        new_name = f"{new_id}-{old_name[5:]}"
        planned.append(
            Renumber(
                old_id=old_id,
                new_id=new_id,
                old_path=old_path,
                new_path=(Path(old_path).parent / new_name).as_posix(),
            )
        )
    return tuple(planned)


def tracked_and_untracked_files(root: Path) -> tuple[str, ...]:
    output = git_output(
        root,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
    )
    return tuple(sorted(set(line for line in output.splitlines() if line)))


def protected_path(path: str, target_adr_paths: set[str], local_new_paths: set[str]) -> bool:
    value = Path(path)
    if path in PROTECTED_FILES:
        return True
    if value.suffix.lower() == ".sql" or "migrations" in value.parts:
        return True
    if path in target_adr_paths and path not in local_new_paths:
        return True
    return False


def target_legacy_ids(root: Path, target_ref: str) -> dict[str, str]:
    result = git_output(root, "show", f"{target_ref}:.adr-governance.yaml")
    config = load_yaml(result, f"{target_ref}:.adr-governance.yaml")
    mapping = config.get("legacy_ids")
    if not isinstance(mapping, dict):
        raise InventoryError(f"{target_ref}:.adr-governance.yaml legacy_ids must be a mapping")
    return {str(alias): str(canonical_id) for alias, canonical_id in mapping.items()}


def local_legacy_ids(root: Path) -> dict[str, str]:
    path = root / ".adr-governance.yaml"
    try:
        config = load_yaml(path.read_text(encoding="utf-8"), path.as_posix())
    except OSError as exc:
        raise InventoryError(f"cannot read {path}: {exc}") from exc
    mapping = config.get("legacy_ids")
    if not isinstance(mapping, dict):
        raise InventoryError(".adr-governance.yaml legacy_ids must be a mapping")
    return {str(alias): str(canonical_id) for alias, canonical_id in mapping.items()}


def draft_aliases(
    root: Path,
    target_ref: str,
    renumbers: tuple[Renumber, ...],
) -> dict[str, str]:
    target = target_legacy_ids(root, target_ref)
    local = local_legacy_ids(root)
    renumbered_ids = {item.old_id for item in renumbers}
    aliases: dict[str, str] = {}
    for alias, canonical_id in local.items():
        if alias not in target and canonical_id in renumbered_ids:
            aliases[alias] = canonical_id
    return aliases


def replace_draft_alias(
    source: str,
    *,
    alias: str,
    old_id: str,
    new_id: str,
) -> str:
    pattern = re.compile(
        rf'^(\s*{re.escape(alias)}:\s*)["\']?{re.escape(old_id)}["\']?\s*$',
        re.MULTILINE,
    )
    rewritten, count = pattern.subn(rf'\g<1>"{new_id}"', source)
    if count != 1:
        raise InventoryError(
            f"cannot update draft legacy alias {alias!r} from {old_id} to {new_id}"
        )
    return rewritten


def rewrite_frontmatter_links(source: str, mapping: dict[str, str]) -> str:
    if not source.startswith("---\n"):
        return source
    end = source.find("\n---\n", 4)
    if end < 0:
        return source
    frontmatter = source[4:end]
    body = source[end:]
    in_supersedes_block = False
    output: list[str] = []
    for line in frontmatter.splitlines():
        stripped = line.strip()
        if stripped.startswith("supersedes:"):
            in_supersedes_block = stripped == "supersedes:"
            for old_id, new_id in mapping.items():
                line = re.sub(
                    rf'(["\']?){re.escape(old_id)}\1',
                    f'"{new_id}"',
                    line,
                )
        elif stripped.startswith("superseded_by:"):
            in_supersedes_block = False
            for old_id, new_id in mapping.items():
                line = re.sub(
                    rf'(["\']?){re.escape(old_id)}\1',
                    f'"{new_id}"',
                    line,
                )
        elif in_supersedes_block and re.match(r"^\s*-\s+", line):
            for old_id, new_id in mapping.items():
                line = re.sub(
                    rf'(["\']?){re.escape(old_id)}\1',
                    f'"{new_id}"',
                    line,
                )
        elif line and not line.startswith((" ", "\t")):
            in_supersedes_block = False
        output.append(line)
    return "---\n" + "\n".join(output) + body


def rewrite_repository(
    root: Path,
    *,
    target_ref: str,
    inventory: Inventory,
    local_new: dict[str, str],
    renumbers: tuple[Renumber, ...],
) -> tuple[dict[str, str], tuple[str, ...]]:
    target_paths = set(inventory.target.values())
    local_new_paths = set(local_new.values())
    files = tracked_and_untracked_files(root)
    draft_alias_mapping = draft_aliases(root, target_ref, renumbers)
    id_mapping = {item.old_id: item.new_id for item in renumbers}
    old_to_item = {item.old_id: item for item in renumbers}
    target_ids = set(inventory.target)
    changes: dict[str, str] = {}
    protected_hits: set[str] = set()

    for relative in files:
        path = root / relative
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        relevant = any(
            item.old_id in source or Path(item.old_path).name in source
            for item in renumbers
        )
        if not relevant:
            continue
        if protected_path(relative, target_paths, local_new_paths):
            protected_hits.add(relative)
            continue

        rewritten = source
        for item in renumbers:
            old_name = Path(item.old_path).name
            new_name = Path(item.new_path).name
            had_filename_reference = old_name in rewritten
            if (
                relative != item.old_path
                and item.old_id in target_ids
                and not had_filename_reference
                and re.search(rf"\bADR {re.escape(item.old_id)}\b", rewritten)
            ):
                raise InventoryError(
                    f"{relative} contains ambiguous bare ADR {item.old_id} reference; "
                    "link the draft filename or resolve it manually"
                )
            rewritten = rewritten.replace(old_name, new_name)

            if relative == item.old_path:
                rewritten, id_count = FRONTMATTER_ID.subn(
                    rf'\g<1>"{item.new_id}"',
                    rewritten,
                    count=1,
                )
                if id_count != 1:
                    raise InventoryError(
                        f"{relative} does not contain exactly one Reflo frontmatter id"
                    )
                rewritten, heading_count = ADR_HEADING.subn(
                    rf"\g<1>{item.new_id}\g<3>",
                    rewritten,
                    count=1,
                )
                if heading_count != 1:
                    raise InventoryError(
                        f"{relative} does not contain exactly one Reflo ADR heading"
                    )

            if item.old_id not in target_ids or had_filename_reference:
                rewritten = re.sub(
                    rf"\bADR {re.escape(item.old_id)}\b",
                    f"ADR {item.new_id}",
                    rewritten,
                )

        if relative in local_new_paths:
            safe_link_mapping = {
                old_id: new_id
                for old_id, new_id in id_mapping.items()
                if old_id not in target_ids
            }
            rewritten = rewrite_frontmatter_links(rewritten, safe_link_mapping)

        if relative == ".adr-governance.yaml":
            for alias, old_id in draft_alias_mapping.items():
                rewritten = replace_draft_alias(
                    rewritten,
                    alias=alias,
                    old_id=old_id,
                    new_id=old_to_item[old_id].new_id,
                )

        if rewritten != source:
            changes[relative] = rewritten

    for item in renumbers:
        if item.old_path not in changes:
            raise InventoryError(f"renumber plan did not rewrite draft {item.old_path}")
    return changes, tuple(sorted(protected_hits))


def atomic_write(path: Path, source: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
        text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(source)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def apply_changes(
    root: Path,
    changes: dict[str, str],
    renumbers: tuple[Renumber, ...],
) -> None:
    for relative, source in sorted(changes.items()):
        atomic_write(root / relative, source)
    for item in renumbers:
        old_path = root / item.old_path
        new_path = root / item.new_path
        if new_path.exists():
            raise InventoryError(f"renumber target already exists: {item.new_path}")
        os.replace(old_path, new_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--target-ref", default="origin/main")
    parser.add_argument("--base-branch", default="main")
    parser.add_argument("--github-fixture", type=Path)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply the reported draft renames and mutable-reference updates.",
    )
    args = parser.parse_args()

    try:
        root = args.root.resolve()
        inventory = build_inventory(
            root,
            target_ref=args.target_ref,
            base_branch=args.base_branch,
            github_fixture=args.github_fixture,
        )
        ensure_unmerged(inventory)
        paths = new_local_paths(root, args.target_ref)
        local_new = parse_adr_paths(paths, "new local ADR drafts")
        if not local_new:
            print("No unmerged ADR drafts were added on this branch.")
            return 0
        renumbers = plan_renumbers(inventory, local_new)
        if not renumbers:
            print("No ADR draft number collisions found.")
            return 0
        changes, protected_hits = rewrite_repository(
            root,
            target_ref=args.target_ref,
            inventory=inventory,
            local_new=local_new,
            renumbers=renumbers,
        )
        report = {
            "applied": args.apply,
            "protected_references_left_unchanged": list(protected_hits),
            "renumbers": [
                {
                    "new_id": item.new_id,
                    "new_path": item.new_path,
                    "old_id": item.old_id,
                    "old_path": item.old_path,
                }
                for item in renumbers
            ],
            "updated_files": sorted(changes),
        }
        if args.apply:
            apply_changes(root, changes, renumbers)
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0 if args.apply else 2
    except InventoryError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
