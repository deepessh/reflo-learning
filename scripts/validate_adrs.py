#!/usr/bin/env python3
"""Validate Reflo ADR schema, provenance, lifecycle, and coexistence rules."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - exercised by the CLI environment
    raise SystemExit(
        "PyYAML==6.0.3 is required; run: "
        "python3 -m pip install --requirement scripts/requirements-governance.txt"
    ) from exc

if yaml.__version__ != "6.0.3":  # pragma: no cover - depends on caller environment
    raise SystemExit(
        f"PyYAML version mismatch: expected exactly 6.0.3, found {yaml.__version__}"
    )

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from validate_decisions import (  # noqa: E402
    DECISIONS,
    SENSITIVE_PATTERNS,
    check_urls,
    markdown_urls,
    parse_index,
)


ROOT = Path(__file__).resolve().parents[1]
CONFIG_NAME = ".adr-governance.yaml"
CUTOVER_CONTRACT = Path("scripts/fixtures/adr-governance/cutover-contract.json")
CONFIG_MODES = {"partial-mirror", "complete-mirror", "adr-authoritative"}
STATUSES = {"Accepted", "Deprecated", "Superseded"}
PROVENANCE_KINDS = {"github-decision", "bootstrap-exception", "prd-mandate"}
LEGACY_ID = re.compile(r"^(?:D-BOOTSTRAP-[A-Z0-9-]+|D-GH-\d+|M-\d{3})$")
CANONICAL_ID = re.compile(r"^\d{4}$")
ADR_FILENAME = re.compile(r"^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
COMMIT_SHA = re.compile(r"^[0-9a-f]{40}$")
FIELD = re.compile(r"^- \*\*(.+?):\*\*\s*(.*)$")
RECORD_HEADING = re.compile(r"^## (D-[A-Z0-9-]+) — (.+)$")
BODY_HEADINGS = (
    "## Context",
    "## Options",
    "## Decision",
    "### Authorized verdict",
    "### Rationale",
    "## Verification",
    "## Reversal criteria",
)
TOP_LEVEL_KEYS = {
    "id",
    "title",
    "status",
    "date",
    "aliases",
    "prd_references",
    "ownership",
    "authorization",
    "provenance",
    "supersedes",
    "superseded_by",
    "deprecation",
    "maintenance",
}
OWNERSHIP_KEYS = {"proposer", "decision_dri", "implementation_owner"}
AUTHORIZATION_KEYS = {"decider", "approval_basis"}
MAX_DIAGNOSTICS = 50
MAX_VALUE_DISPLAY = 180
RESERVED_LEGACY_IDS = {
    "D-BOOTSTRAP-001": "0001",
    **{f"D-GH-{number}": f"{number:04d}" for number in range(2, 17)},
    "D-GH-67": "0017",
    "D-GH-81": "0018",
    "D-GH-83": "0019",
    "D-GH-95": "0020",
    "D-GH-96": "0021",
    "D-GH-120": "0022",
    "M-001": "0023",
    "M-002": "0024",
    "M-003": "0025",
    "D-GH-125": "0026",
    "D-GH-126": "0027",
    "D-GH-127": "0028",
}


class UniqueKeySafeLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate mapping keys."""


def _construct_mapping(loader: UniqueKeySafeLoader, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"duplicate key {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeySafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping
)


class Diagnostics:
    def __init__(self, limit: int = MAX_DIAGNOSTICS) -> None:
        self.limit = limit
        self.messages: list[str] = []
        self._omitted = 0

    def add(self, message: str) -> None:
        bounded = message.replace("\n", " ")
        if len(bounded) > MAX_VALUE_DISPLAY:
            bounded = bounded[: MAX_VALUE_DISPLAY - 1] + "…"
        if len(self.messages) < self.limit:
            self.messages.append(bounded)
        else:
            self._omitted += 1

    def finish(self) -> list[str]:
        if self._omitted:
            return self.messages + [
                f"diagnostic limit reached; omitted {self._omitted} additional error(s)"
            ]
        return self.messages


@dataclass(frozen=True)
class Adr:
    path: Path
    metadata: dict[str, Any]
    sections: dict[str, str]
    source: str

    @property
    def canonical_id(self) -> str:
        value = self.metadata.get("id")
        return value if isinstance(value, str) else ""

    @property
    def aliases(self) -> list[str]:
        value = self.metadata.get("aliases")
        return value if isinstance(value, list) else []


def load_yaml(text: str, label: str, diagnostics: Diagnostics) -> Any:
    try:
        return yaml.load(text, Loader=UniqueKeySafeLoader)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        location = f" line {mark.line + 1}" if mark else ""
        diagnostics.add(f"{label}:{location}: invalid YAML: {getattr(exc, 'problem', exc)}")
        return None


def normalize_markdown(value: str) -> str:
    lines = [line.rstrip() for line in value.strip().splitlines()]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def parse_register_records(text: str, diagnostics: Diagnostics) -> dict[str, dict[str, str]]:
    lines = text.splitlines()
    records: dict[str, dict[str, str]] = {}
    index = 0
    while index < len(lines):
        heading = RECORD_HEADING.match(lines[index])
        if not heading:
            index += 1
            continue
        record_id, title = heading.groups()
        if record_id in records:
            diagnostics.add(f"DECISIONS.md: duplicate effective decision ID {record_id}")
        fields: dict[str, str] = {"Title": title}
        index += 1
        while index < len(lines) and not lines[index].startswith("## "):
            field = FIELD.match(lines[index])
            if not field:
                index += 1
                continue
            name, first_line = field.groups()
            value_lines = [first_line]
            index += 1
            while index < len(lines):
                if FIELD.match(lines[index]) or lines[index].startswith("## "):
                    break
                continuation = lines[index]
                if continuation.startswith("  "):
                    continuation = continuation[2:]
                value_lines.append(continuation)
                index += 1
            if name in fields:
                diagnostics.add(f"DECISIONS.md: {record_id} has duplicate field {name!r}")
            fields[name] = normalize_markdown("\n".join(value_lines))
        records[record_id] = fields
    return records


def split_frontmatter(source: str, label: str, diagnostics: Diagnostics) -> tuple[str, str] | None:
    lines = source.splitlines()
    if not lines or lines[0] != "---":
        diagnostics.add(f"{label}: ADR must start with YAML frontmatter delimiter ---")
        return None
    try:
        closing = lines.index("---", 1)
    except ValueError:
        diagnostics.add(f"{label}: YAML frontmatter is missing its closing --- delimiter")
        return None
    return "\n".join(lines[1:closing]), "\n".join(lines[closing + 1 :])


def parse_body(body: str, label: str, metadata: dict[str, Any], diagnostics: Diagnostics) -> dict[str, str]:
    lines = body.splitlines()
    title_index = next((index for index, line in enumerate(lines) if line.strip()), -1)
    nonempty = lines[title_index] if title_index >= 0 else ""
    expected_title = f"# ADR {metadata.get('id', '')}: {metadata.get('title', '')}"
    if nonempty != expected_title:
        diagnostics.add(f"{label}: first body heading must be {expected_title!r}")

    positions: dict[str, int] = {}
    for line_number, line in enumerate(lines, 1):
        if line in BODY_HEADINGS:
            if line in positions:
                diagnostics.add(f"{label}:{line_number}: duplicate body heading {line!r}")
            positions[line] = line_number - 1
    missing = [heading for heading in BODY_HEADINGS if heading not in positions]
    if missing:
        diagnostics.add(f"{label}: missing body headings: {', '.join(missing)}")
        return {}
    ordered = [positions[heading] for heading in BODY_HEADINGS]
    if ordered != sorted(ordered):
        diagnostics.add(f"{label}: ADR body headings are out of order")
        return {}
    prelude = lines[title_index + 1 : positions["## Context"]]
    decision_preface = lines[
        positions["## Decision"] + 1 : positions["### Authorized verdict"]
    ]
    if any(line.strip() for line in prelude):
        diagnostics.add(f"{label}: content between the title and Context is not part of the ADR schema")
    if any(line.strip() for line in decision_preface):
        diagnostics.add(f"{label}: Decision content must be under Authorized verdict or Rationale")

    ranges = {
        "Context": (positions["## Context"] + 1, positions["## Options"]),
        "Options": (positions["## Options"] + 1, positions["## Decision"]),
        "Authorized verdict": (
            positions["### Authorized verdict"] + 1,
            positions["### Rationale"],
        ),
        "Rationale": (positions["### Rationale"] + 1, positions["## Verification"]),
        "Verification": (
            positions["## Verification"] + 1,
            positions["## Reversal criteria"],
        ),
        "Reversal criteria": (positions["## Reversal criteria"] + 1, len(lines)),
    }
    sections = {
        name: normalize_markdown("\n".join(lines[start:end]))
        for name, (start, end) in ranges.items()
    }
    empty = [name for name, value in sections.items() if not value]
    if empty:
        diagnostics.add(f"{label}: empty body sections: {', '.join(empty)}")
    return sections


def parse_adr(path: Path, diagnostics: Diagnostics) -> Adr | None:
    label = path.as_posix()
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as exc:
        diagnostics.add(f"{label}: cannot read ADR: {exc}")
        return None
    parts = split_frontmatter(source, label, diagnostics)
    if not parts:
        return None
    frontmatter, body = parts
    metadata = load_yaml(frontmatter, label, diagnostics)
    if not isinstance(metadata, dict):
        diagnostics.add(f"{label}: frontmatter must be a YAML mapping")
        return None
    sections = parse_body(body, label, metadata, diagnostics)
    return Adr(path=path, metadata=metadata, sections=sections, source=source)


def require_mapping(
    value: Any,
    label: str,
    required: set[str],
    allowed: set[str],
    diagnostics: Diagnostics,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        diagnostics.add(f"{label}: expected a mapping")
        return {}
    missing = sorted(required - value.keys())
    unknown = sorted(value.keys() - allowed)
    if missing:
        diagnostics.add(f"{label}: missing keys: {', '.join(missing)}")
    if unknown:
        diagnostics.add(f"{label}: unsupported keys: {', '.join(map(str, unknown))}")
    return value


def require_nonempty_strings(mapping: dict[str, Any], keys: set[str], label: str, diagnostics: Diagnostics) -> None:
    for key in sorted(keys):
        value = mapping.get(key)
        if not isinstance(value, str) or not value.strip():
            diagnostics.add(f"{label}.{key}: expected a non-empty string")


def validate_iso_date(value: Any, label: str, diagnostics: Diagnostics) -> None:
    if not isinstance(value, str) or not ISO_DATE.fullmatch(value):
        diagnostics.add(f"{label}: expected quoted ISO date YYYY-MM-DD")
        return
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        diagnostics.add(f"{label}: invalid calendar date {value!r}")


def one_github_url(value: Any, label: str, pattern: str, diagnostics: Diagnostics) -> str:
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        diagnostics.add(f"{label}: expected one exact GitHub URL")
        return ""
    return value


def issue_parts(url: str) -> tuple[str, str, str] | None:
    match = re.fullmatch(r"https://github\.com/([^/]+)/([^/]+)/issues/(\d+)", url)
    return match.groups() if match else None


def comment_parts(url: str) -> tuple[str, str, str, str] | None:
    match = re.fullmatch(
        r"https://github\.com/([^/]+)/([^/]+)/issues/(\d+)#issuecomment-(\d+)", url
    )
    return match.groups() if match else None


def pr_parts(url: str) -> tuple[str, str, str] | None:
    match = re.fullmatch(r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)", url)
    return match.groups() if match else None


def validate_same_issue(issue: str, comment: str, label: str, diagnostics: Diagnostics) -> None:
    parsed_issue = issue_parts(issue)
    parsed_comment = comment_parts(comment)
    if parsed_issue and parsed_comment and parsed_issue != parsed_comment[:3]:
        diagnostics.add(f"{label}: issue and verdict comment must reference the same issue")


def validate_same_repository(urls: list[str], label: str, diagnostics: Diagnostics) -> None:
    repositories: set[tuple[str, str]] = set()
    for url in urls:
        parts = issue_parts(url) or comment_parts(url) or pr_parts(url)
        if parts:
            repositories.add((parts[0], parts[1]))
    if len(repositories) > 1:
        diagnostics.add(f"{label}: GitHub provenance URLs must belong to one repository")


def validate_provenance(adr: Adr, mode: str, diagnostics: Diagnostics) -> list[str]:
    label = f"{adr.path.as_posix()}: provenance"
    provenance = adr.metadata.get("provenance")
    if not isinstance(provenance, dict):
        diagnostics.add(f"{label}: expected a mapping")
        return []
    kind = provenance.get("kind")
    if kind not in PROVENANCE_KINDS:
        diagnostics.add(f"{label}.kind: expected one of {', '.join(sorted(PROVENANCE_KINDS))}")
        return []
    urls: list[str] = []

    if kind == "github-decision":
        required = {"kind", "issue", "verdict_comment", "record_pr"}
        require_mapping(provenance, label, required, required, diagnostics)
        issue = one_github_url(
            provenance.get("issue"), f"{label}.issue", r"https://github\.com/[^/]+/[^/]+/issues/\d+", diagnostics
        )
        verdict = one_github_url(
            provenance.get("verdict_comment"),
            f"{label}.verdict_comment",
            r"https://github\.com/[^/]+/[^/]+/issues/\d+#issuecomment-\d+",
            diagnostics,
        )
        record_pr = one_github_url(
            provenance.get("record_pr"), f"{label}.record_pr", r"https://github\.com/[^/]+/[^/]+/pull/\d+", diagnostics
        )
        validate_same_issue(issue, verdict, label, diagnostics)
        validate_same_repository([issue, verdict, record_pr], label, diagnostics)
        urls.extend(filter(None, [issue, verdict, record_pr]))
        issue_number = issue_parts(issue)[2] if issue_parts(issue) else None
        if issue_number and f"D-GH-{issue_number}" not in adr.aliases:
            diagnostics.add(f"{label}: aliases must contain D-GH-{issue_number} from the originating issue")

    elif kind == "bootstrap-exception":
        required = {
            "kind",
            "owner_directive",
            "directive_date",
            "bounded_exception",
            "migration_pr",
        }
        require_mapping(provenance, label, required, required, diagnostics)
        require_nonempty_strings(
            provenance, {"owner_directive", "bounded_exception"}, label, diagnostics
        )
        validate_iso_date(provenance.get("directive_date"), f"{label}.directive_date", diagnostics)
        migration_pr = one_github_url(
            provenance.get("migration_pr"), f"{label}.migration_pr", r"https://github\.com/[^/]+/[^/]+/pull/\d+", diagnostics
        )
        urls.extend(filter(None, [migration_pr]))
        if "D-BOOTSTRAP-001" not in adr.aliases:
            diagnostics.add(f"{label}: bootstrap provenance must retain D-BOOTSTRAP-001")

    else:
        required = {
            "kind",
            "prd_version",
            "prd_commit",
            "prd_path",
            "prd_sections",
            "confirmation_issue",
            "confirmation_comment",
            "authority_state",
            "cutover_pr",
        }
        require_mapping(provenance, label, required, required, diagnostics)
        require_nonempty_strings(provenance, {"prd_version", "prd_path"}, label, diagnostics)
        if provenance.get("prd_path") != "prds/reflo-prd.md":
            diagnostics.add(f"{label}.prd_path: expected immutable source path 'prds/reflo-prd.md'")
        commit = provenance.get("prd_commit")
        if not isinstance(commit, str) or not COMMIT_SHA.fullmatch(commit):
            diagnostics.add(f"{label}.prd_commit: expected a full 40-character lowercase commit SHA")
        sections = provenance.get("prd_sections")
        if not isinstance(sections, list) or not sections or any(
            not isinstance(section, str) or not section.strip() for section in sections
        ):
            diagnostics.add(f"{label}.prd_sections: expected a non-empty list of exact section references")
        confirmation_issue = one_github_url(
            provenance.get("confirmation_issue"),
            f"{label}.confirmation_issue",
            r"https://github\.com/[^/]+/[^/]+/issues/\d+",
            diagnostics,
        )
        confirmation_comment = one_github_url(
            provenance.get("confirmation_comment"),
            f"{label}.confirmation_comment",
            r"https://github\.com/[^/]+/[^/]+/issues/\d+#issuecomment-\d+",
            diagnostics,
        )
        validate_same_issue(confirmation_issue, confirmation_comment, label, diagnostics)
        authority_state = provenance.get("authority_state")
        cutover_pr = provenance.get("cutover_pr")
        if mode == "adr-authoritative":
            if authority_state != "transferred":
                diagnostics.add(f"{label}.authority_state: adr-authoritative mode requires 'transferred'")
            parsed_cutover = one_github_url(
                cutover_pr, f"{label}.cutover_pr", r"https://github\.com/[^/]+/[^/]+/pull/\d+", diagnostics
            )
            urls.extend(filter(None, [confirmation_issue, confirmation_comment, parsed_cutover]))
        else:
            if authority_state != "staged":
                diagnostics.add(f"{label}.authority_state: coexistence modes require 'staged'")
            if cutover_pr is not None:
                diagnostics.add(f"{label}.cutover_pr: staged PRD mandates must use null, not premature transfer provenance")
            urls.extend(filter(None, [confirmation_issue, confirmation_comment]))
        validate_same_repository(urls, label, diagnostics)
        if not any(isinstance(alias, str) and alias.startswith("M-") for alias in adr.aliases):
            diagnostics.add(f"{label}: PRD mandate provenance requires an M-* legacy alias")
    return urls


def validate_deprecation(adr: Adr, diagnostics: Diagnostics) -> list[str]:
    label = f"{adr.path.as_posix()}: deprecation"
    value = adr.metadata.get("deprecation")
    if adr.metadata.get("status") != "Deprecated":
        if value is not None:
            diagnostics.add(f"{label}: only Deprecated ADRs may carry deprecation provenance")
        return []
    required = {"issue", "verdict_comment", "date", "record_pr", "decider", "approval_basis"}
    mapping = require_mapping(value, label, required, required, diagnostics)
    require_nonempty_strings(mapping, {"decider", "approval_basis"}, label, diagnostics)
    validate_iso_date(mapping.get("date"), f"{label}.date", diagnostics)
    issue = one_github_url(
        mapping.get("issue"), f"{label}.issue", r"https://github\.com/[^/]+/[^/]+/issues/\d+", diagnostics
    )
    verdict = one_github_url(
        mapping.get("verdict_comment"),
        f"{label}.verdict_comment",
        r"https://github\.com/[^/]+/[^/]+/issues/\d+#issuecomment-\d+",
        diagnostics,
    )
    record_pr = one_github_url(
        mapping.get("record_pr"), f"{label}.record_pr", r"https://github\.com/[^/]+/[^/]+/pull/\d+", diagnostics
    )
    validate_same_issue(issue, verdict, label, diagnostics)
    validate_same_repository([issue, verdict, record_pr], label, diagnostics)
    return list(filter(None, [issue, verdict, record_pr]))


def validate_maintenance(adr: Adr, diagnostics: Diagnostics) -> list[str]:
    value = adr.metadata.get("maintenance", [])
    label = f"{adr.path.as_posix()}: maintenance"
    if not isinstance(value, list):
        diagnostics.add(f"{label}: expected a list")
        return []
    urls: list[str] = []
    required = {"kind", "issue", "pull_request", "summary"}
    for index, item in enumerate(value):
        item_label = f"{label}[{index}]"
        mapping = require_mapping(item, item_label, required, required, diagnostics)
        if mapping.get("kind") not in {"typo", "formatting", "navigation"}:
            diagnostics.add(f"{item_label}.kind: expected typo, formatting, or navigation")
        require_nonempty_strings(mapping, {"summary"}, item_label, diagnostics)
        issue = one_github_url(
            mapping.get("issue"), f"{item_label}.issue", r"https://github\.com/[^/]+/[^/]+/issues/\d+", diagnostics
        )
        pull_request = one_github_url(
            mapping.get("pull_request"),
            f"{item_label}.pull_request",
            r"https://github\.com/[^/]+/[^/]+/pull/\d+",
            diagnostics,
        )
        validate_same_repository([issue, pull_request], item_label, diagnostics)
        urls.extend(filter(None, [issue, pull_request]))
    return urls


def validate_adr_schema(adr: Adr, mode: str, diagnostics: Diagnostics) -> list[str]:
    label = adr.path.as_posix()
    metadata = adr.metadata
    missing = sorted(TOP_LEVEL_KEYS - metadata.keys())
    unknown = sorted(metadata.keys() - TOP_LEVEL_KEYS)
    if missing:
        diagnostics.add(f"{label}: missing frontmatter keys: {', '.join(missing)}")
    if unknown:
        diagnostics.add(f"{label}: unsupported frontmatter keys: {', '.join(map(str, unknown))}")

    canonical_id = metadata.get("id")
    if not isinstance(canonical_id, str) or not CANONICAL_ID.fullmatch(canonical_id):
        diagnostics.add(f"{label}: id must be a quoted four-digit string")
    elif not re.search(rf'^id:\s*["\']{re.escape(canonical_id)}["\']\s*$', adr.source, re.MULTILINE):
        diagnostics.add(f"{label}: id must be quoted in YAML to prevent numeric coercion")
    filename = ADR_FILENAME.fullmatch(adr.path.name)
    if not filename:
        diagnostics.add(f"{label}: filename must match NNNN-lowercase-kebab-title.md")
    elif canonical_id != filename.group(1):
        diagnostics.add(f"{label}: filename ID {filename.group(1)} does not match frontmatter ID {canonical_id!r}")

    require_nonempty_strings(metadata, {"title"}, label, diagnostics)
    require_nonempty_strings(metadata, {"prd_references"}, label, diagnostics)
    if metadata.get("status") not in STATUSES:
        diagnostics.add(f"{label}: status must be Accepted, Deprecated, or Superseded")
    validate_iso_date(metadata.get("date"), f"{label}: date", diagnostics)

    aliases = metadata.get("aliases")
    if not isinstance(aliases, list) or not aliases:
        diagnostics.add(f"{label}: aliases must be a non-empty list")
    else:
        for alias in aliases:
            if not isinstance(alias, str) or not LEGACY_ID.fullmatch(alias):
                diagnostics.add(f"{label}: invalid legacy alias {alias!r}")
        if len(aliases) != len(set(map(str, aliases))):
            diagnostics.add(f"{label}: duplicate aliases are not allowed")

    ownership = require_mapping(
        metadata.get("ownership"), f"{label}: ownership", OWNERSHIP_KEYS, OWNERSHIP_KEYS, diagnostics
    )
    require_nonempty_strings(ownership, OWNERSHIP_KEYS, f"{label}: ownership", diagnostics)
    authorization = require_mapping(
        metadata.get("authorization"),
        f"{label}: authorization",
        AUTHORIZATION_KEYS,
        AUTHORIZATION_KEYS,
        diagnostics,
    )
    require_nonempty_strings(authorization, AUTHORIZATION_KEYS, f"{label}: authorization", diagnostics)

    supersedes = metadata.get("supersedes")
    if not isinstance(supersedes, list) or any(
        not isinstance(item, str) or not CANONICAL_ID.fullmatch(item) for item in supersedes
    ):
        diagnostics.add(f"{label}: supersedes must be a list of four-digit canonical IDs")
    elif len(supersedes) != len(set(supersedes)):
        diagnostics.add(f"{label}: duplicate supersedes links are not allowed")
    superseded_by = metadata.get("superseded_by")
    if superseded_by is not None and (
        not isinstance(superseded_by, str) or not CANONICAL_ID.fullmatch(superseded_by)
    ):
        diagnostics.add(f"{label}: superseded_by must be null or one four-digit canonical ID")
    if metadata.get("status") == "Superseded" and superseded_by is None:
        diagnostics.add(f"{label}: Superseded ADRs require superseded_by")
    if metadata.get("status") != "Superseded" and superseded_by is not None:
        diagnostics.add(f"{label}: only Superseded ADRs may set superseded_by")
    if canonical_id and canonical_id in (supersedes if isinstance(supersedes, list) else []):
        diagnostics.add(f"{label}: an ADR cannot supersede itself")

    urls = validate_provenance(adr, mode, diagnostics)
    urls.extend(validate_deprecation(adr, diagnostics))
    urls.extend(validate_maintenance(adr, diagnostics))
    for sensitive_label, pattern in SENSITIVE_PATTERNS.items():
        if pattern.search(adr.source):
            diagnostics.add(f"{label}: appears to contain prohibited {sensitive_label}")
    return urls


def validate_lifecycle(adrs: dict[str, Adr], diagnostics: Diagnostics) -> None:
    edges: dict[str, list[str]] = {}
    for canonical_id, adr in adrs.items():
        supersedes = adr.metadata.get("supersedes")
        edges[canonical_id] = supersedes if isinstance(supersedes, list) else []
        for target in edges[canonical_id]:
            target_adr = adrs.get(target)
            if not target_adr:
                diagnostics.add(f"{adr.path.as_posix()}: supersedes target {target} does not exist")
                continue
            if target_adr.metadata.get("superseded_by") != canonical_id:
                diagnostics.add(
                    f"{adr.path.as_posix()}: supersedes {target}, but {target_adr.path.name} does not link back via superseded_by"
                )
            if target_adr.metadata.get("status") != "Superseded":
                diagnostics.add(f"{target_adr.path.as_posix()}: superseded target must have status Superseded")
        successor = adr.metadata.get("superseded_by")
        if isinstance(successor, str):
            successor_adr = adrs.get(successor)
            if not successor_adr:
                diagnostics.add(f"{adr.path.as_posix()}: superseded_by target {successor} does not exist")
            elif canonical_id not in (successor_adr.metadata.get("supersedes") or []):
                diagnostics.add(
                    f"{adr.path.as_posix()}: superseded_by {successor}, but {successor_adr.path.name} does not link back via supersedes"
                )

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(canonical_id: str) -> None:
        if canonical_id in visiting:
            diagnostics.add(f"ADR supersession cycle detected at {canonical_id}")
            return
        if canonical_id in visited:
            return
        visiting.add(canonical_id)
        for target in edges.get(canonical_id, []):
            if target in adrs:
                visit(target)
        visiting.remove(canonical_id)
        visited.add(canonical_id)

    for canonical_id in adrs:
        visit(canonical_id)


def immutable_snapshot(adr: Adr) -> dict[str, Any]:
    return {
        "id": adr.metadata.get("id"),
        "title": adr.metadata.get("title"),
        "date": adr.metadata.get("date"),
        "aliases": adr.metadata.get("aliases"),
        "prd_references": adr.metadata.get("prd_references"),
        "ownership": adr.metadata.get("ownership"),
        "authorization": adr.metadata.get("authorization"),
        "provenance": adr.metadata.get("provenance"),
        "sections": adr.sections,
    }


def is_prd_authority_transfer(previous: Adr, current: Adr) -> bool:
    old = copy_without_transfer(previous.metadata.get("provenance"))
    new = copy_without_transfer(current.metadata.get("provenance"))
    previous_provenance = previous.metadata.get("provenance") or {}
    current_provenance = current.metadata.get("provenance") or {}
    return (
        isinstance(previous_provenance, dict)
        and isinstance(current_provenance, dict)
        and previous_provenance.get("kind") == current_provenance.get("kind") == "prd-mandate"
        and previous_provenance.get("authority_state") == "staged"
        and previous_provenance.get("cutover_pr") is None
        and current_provenance.get("authority_state") == "transferred"
        and bool(pr_parts(str(current_provenance.get("cutover_pr", ""))))
        and old == new
        and previous.sections == current.sections
        and all(
            previous.metadata.get(key) == current.metadata.get(key)
            for key in (
                "id",
                "title",
                "date",
                "aliases",
                "prd_references",
                "ownership",
                "authorization",
            )
        )
    )


def copy_without_transfer(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    return {
        key: item
        for key, item in value.items()
        if key not in {"authority_state", "cutover_pr"}
    }


def validate_transition(previous: Adr, current: Adr, diagnostics: Diagnostics) -> None:
    label = current.path.as_posix()
    old_status = previous.metadata.get("status")
    new_status = current.metadata.get("status")
    allowed = {
        "Accepted": {"Accepted", "Deprecated", "Superseded"},
        "Deprecated": {"Deprecated"},
        "Superseded": {"Superseded"},
    }
    if new_status not in allowed.get(old_status, set()):
        diagnostics.add(f"{label}: invalid lifecycle transition {old_status!r} -> {new_status!r}")
    if previous.path.name != current.path.name:
        diagnostics.add(f"{label}: merged ADR filenames and canonical IDs are immutable")
    if immutable_snapshot(previous) != immutable_snapshot(current):
        old_maintenance = previous.metadata.get("maintenance") or []
        new_maintenance = current.metadata.get("maintenance") or []
        marked_correction = (
            old_status == new_status == "Accepted"
            and isinstance(old_maintenance, list)
            and isinstance(new_maintenance, list)
            and len(new_maintenance) == len(old_maintenance) + 1
            and new_maintenance[:-1] == old_maintenance
        )
        if not marked_correction and not is_prd_authority_transfer(previous, current):
            diagnostics.add(
                f"{label}: accepted decision content is immutable; use a successor ADR or one marked typo/formatting/navigation correction"
            )
    if old_status != new_status and previous.sections != current.sections:
        diagnostics.add(f"{label}: lifecycle transitions cannot change accepted body content")


def parse_config(root: Path, diagnostics: Diagnostics) -> dict[str, Any]:
    path = root / CONFIG_NAME
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as exc:
        diagnostics.add(f"{CONFIG_NAME}: cannot read governance configuration: {exc}")
        return {}
    config = load_yaml(source, CONFIG_NAME, diagnostics)
    if not isinstance(config, dict):
        diagnostics.add(f"{CONFIG_NAME}: configuration must be a YAML mapping")
        return {}
    required = {
        "schema_version",
        "mode",
        "baseline_complete",
        "adr_directory",
        "register",
        "authority_transfer_pr",
        "managed_prd_mandates",
        "partial_mirror_exemptions",
        "legacy_ids",
    }
    unknown = sorted(config.keys() - required)
    missing = sorted(required - config.keys())
    if missing:
        diagnostics.add(f"{CONFIG_NAME}: missing keys: {', '.join(missing)}")
    if unknown:
        diagnostics.add(f"{CONFIG_NAME}: unsupported keys: {', '.join(map(str, unknown))}")
    if config.get("schema_version") != 1:
        diagnostics.add(f"{CONFIG_NAME}: schema_version must equal 1")
    if config.get("mode") not in CONFIG_MODES:
        diagnostics.add(f"{CONFIG_NAME}: mode must be one of {', '.join(sorted(CONFIG_MODES))}")
    for key in ("adr_directory", "register"):
        if not isinstance(config.get(key), str) or not config[key].strip():
            diagnostics.add(f"{CONFIG_NAME}: {key} must be a non-empty relative path")
        elif Path(config[key]).is_absolute() or ".." in Path(config[key]).parts:
            diagnostics.add(f"{CONFIG_NAME}: {key} must stay within the repository")
    transfer_pr = config.get("authority_transfer_pr")
    if mode := config.get("mode"):
        if mode == "adr-authoritative":
            one_github_url(
                transfer_pr,
                f"{CONFIG_NAME}: authority_transfer_pr",
                r"https://github\.com/[^/]+/[^/]+/pull/\d+",
                diagnostics,
            )
        elif transfer_pr is not None:
            diagnostics.add(
                f"{CONFIG_NAME}: coexistence modes require authority_transfer_pr: null"
            )
    for key in ("managed_prd_mandates", "partial_mirror_exemptions"):
        values = config.get(key)
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            diagnostics.add(f"{CONFIG_NAME}: {key} must be a list of legacy IDs")
        elif len(values) != len(set(values)):
            diagnostics.add(f"{CONFIG_NAME}: {key} contains duplicate IDs")
    legacy_ids = config.get("legacy_ids")
    if not isinstance(legacy_ids, dict):
        diagnostics.add(f"{CONFIG_NAME}: legacy_ids must be a mapping")
    else:
        for alias, canonical_id in legacy_ids.items():
            if not isinstance(alias, str) or not LEGACY_ID.fullmatch(alias):
                diagnostics.add(f"{CONFIG_NAME}: invalid legacy alias {alias!r}")
            if not isinstance(canonical_id, str) or not CANONICAL_ID.fullmatch(canonical_id):
                diagnostics.add(f"{CONFIG_NAME}: {alias} must map to a quoted four-digit ID")
                continue
            reserved = RESERVED_LEGACY_IDS.get(str(alias))
            if reserved and canonical_id != reserved:
                diagnostics.add(
                    f"{CONFIG_NAME}: reserved alias {alias} must map to {reserved}, not {canonical_id}"
                )
            if not reserved and int(canonical_id) < 29:
                diagnostics.add(
                    f"{CONFIG_NAME}: unreserved alias {alias} must use canonical ID 0029 or above"
                )

    mode = config.get("mode")
    exemptions = config.get("partial_mirror_exemptions")
    baseline_complete = config.get("baseline_complete")
    if not isinstance(baseline_complete, bool):
        diagnostics.add(f"{CONFIG_NAME}: baseline_complete must be true or false")
    if mode == "partial-mirror" and baseline_complete is not False:
        diagnostics.add(f"{CONFIG_NAME}: partial-mirror must not claim baseline_complete")
    if mode in {"complete-mirror", "adr-authoritative"}:
        if baseline_complete is not True:
            diagnostics.add(f"{CONFIG_NAME}: {mode} requires baseline_complete: true")
        if exemptions:
            diagnostics.add(f"{CONFIG_NAME}: {mode} requires an empty partial_mirror_exemptions list")
    for sensitive_label, pattern in SENSITIVE_PATTERNS.items():
        if pattern.search(source):
            diagnostics.add(f"{CONFIG_NAME}: appears to contain prohibited {sensitive_label}")
    return config


def validate_authority_transfer(
    config: dict[str, Any],
    by_id: dict[str, Adr],
    diagnostics: Diagnostics,
) -> None:
    """Require one exact atomic cutover PR for every promoted PRD mandate."""

    if config.get("mode") != "adr-authoritative":
        return
    transfer_pr = config.get("authority_transfer_pr")
    if not isinstance(transfer_pr, str) or not pr_parts(transfer_pr):
        return
    legacy_ids = config.get("legacy_ids") or {}
    for mandate in config.get("managed_prd_mandates") or []:
        canonical_id = legacy_ids.get(mandate)
        adr = by_id.get(canonical_id) if isinstance(canonical_id, str) else None
        if not adr:
            continue
        provenance = adr.metadata.get("provenance") or {}
        if provenance.get("kind") != "prd-mandate":
            diagnostics.add(
                f"{adr.path.as_posix()}: managed mandate {mandate} must use prd-mandate provenance"
            )
            continue
        if provenance.get("cutover_pr") != transfer_pr:
            diagnostics.add(
                f"{adr.path.as_posix()}: cutover_pr must exactly match "
                f"{CONFIG_NAME} authority_transfer_pr"
            )


def collect_adrs(root: Path, config: dict[str, Any], diagnostics: Diagnostics) -> tuple[dict[str, Adr], dict[str, Adr], list[str]]:
    directory_value = config.get("adr_directory")
    if not isinstance(directory_value, str):
        return {}, {}, []
    directory = root / directory_value
    if not directory.is_dir():
        diagnostics.add(f"{directory_value}: ADR directory does not exist")
        return {}, {}, []
    by_id: dict[str, Adr] = {}
    by_alias: dict[str, Adr] = {}
    urls: list[str] = []
    for path in sorted(directory.glob("[0-9][0-9][0-9][0-9]-*.md")):
        adr = parse_adr(path, diagnostics)
        if not adr:
            continue
        urls.extend(validate_adr_schema(adr, str(config.get("mode")), diagnostics))
        canonical_id = adr.canonical_id
        if canonical_id in by_id:
            diagnostics.add(f"{path.as_posix()}: duplicate canonical ADR ID {canonical_id}")
        elif canonical_id:
            by_id[canonical_id] = adr
        for alias in adr.aliases:
            if not isinstance(alias, str):
                continue
            if alias in by_alias:
                diagnostics.add(f"{path.as_posix()}: duplicate legacy alias {alias}")
            else:
                by_alias[alias] = adr
    validate_lifecycle(by_id, diagnostics)
    return by_id, by_alias, urls


def validate_alias_allocation(config: dict[str, Any], by_id: dict[str, Adr], diagnostics: Diagnostics) -> None:
    mapping = config.get("legacy_ids")
    if not isinstance(mapping, dict):
        return
    for canonical_id, adr in by_id.items():
        mapped_aliases = [alias for alias in adr.aliases if mapping.get(alias) == canonical_id]
        if not mapped_aliases:
            diagnostics.add(
                f"{adr.path.as_posix()}: no legacy alias maps to canonical ID {canonical_id} in {CONFIG_NAME}"
            )
        for alias in adr.aliases:
            expected = mapping.get(alias)
            if expected is None:
                diagnostics.add(f"{adr.path.as_posix()}: alias {alias} is missing from {CONFIG_NAME} legacy_ids")
            elif expected != canonical_id:
                diagnostics.add(f"{adr.path.as_posix()}: alias {alias} is reserved for ADR {expected}, not {canonical_id}")


def validate_field_preservation(
    adr: Adr,
    record_id: str,
    record: dict[str, str],
    legacy_ids: dict[str, str],
    diagnostics: Diagnostics,
) -> None:
    label = adr.path.as_posix()
    comparisons = {
        "title": (str(adr.metadata.get("title", "")), record.get("Title", "")),
        "date": (str(adr.metadata.get("date", "")), record.get("Decision date", "")),
        "prd_references": (
            str(adr.metadata.get("prd_references", "")),
            record.get("PRD references", ""),
        ),
        "ownership.proposer": (
            str((adr.metadata.get("ownership") or {}).get("proposer", "")),
            record.get("Proposer", ""),
        ),
        "ownership.decision_dri": (
            str((adr.metadata.get("ownership") or {}).get("decision_dri", "")),
            record.get("Decision DRI", ""),
        ),
        "ownership.implementation_owner": (
            str((adr.metadata.get("ownership") or {}).get("implementation_owner", "")),
            record.get("Implementation owner", ""),
        ),
        "authorization.decider": (
            str((adr.metadata.get("authorization") or {}).get("decider", "")),
            record.get("Authorized decider", ""),
        ),
        "Context": (adr.sections.get("Context", ""), record.get("Context and boundary", "")),
        "Options": (adr.sections.get("Options", ""), record.get("Options considered", "")),
        "Authorized verdict": (
            adr.sections.get("Authorized verdict", ""),
            record.get("Authorized verdict", ""),
        ),
        "Rationale": (adr.sections.get("Rationale", ""), record.get("Rationale", "")),
        "Verification": (
            adr.sections.get("Verification", ""),
            record.get("Testable consequences", ""),
        ),
        "Reversal criteria": (
            adr.sections.get("Reversal criteria", ""),
            record.get("Reversal criteria", ""),
        ),
    }
    for field, (actual, expected) in comparisons.items():
        if normalize_markdown(actual) != normalize_markdown(expected):
            diagnostics.add(f"{label}: {field} does not losslessly match authoritative record {record_id}")
    if adr.metadata.get("status") != record.get("Status"):
        diagnostics.add(f"{label}: status does not match authoritative record {record_id}")
    raw_supersedes = record.get("Supersedes", "").strip()
    legacy_targets = [] if raw_supersedes.lower() == "none" else [
        target.strip().strip("`") for target in raw_supersedes.split(",")
    ]
    expected_supersedes = [legacy_ids.get(target, "") for target in legacy_targets]
    if not all(expected_supersedes) or adr.metadata.get("supersedes") != expected_supersedes:
        diagnostics.add(f"{label}: supersedes does not match authoritative record {record_id}")
    provenance = adr.metadata.get("provenance") or {}
    if provenance.get("kind") == "bootstrap-exception":
        bootstrap_comparisons = {
            "owner_directive": record.get("Verdict", ""),
            "directive_date": record.get("Decision date", ""),
            "bounded_exception": record.get("Bootstrap exception", ""),
        }
        for field, expected in bootstrap_comparisons.items():
            if normalize_markdown(str(provenance.get(field, ""))) != normalize_markdown(expected):
                diagnostics.add(
                    f"{label}: provenance.{field} does not losslessly match bootstrap record {record_id}"
                )
    else:
        if record.get("Bootstrap exception", "") != "No":
            diagnostics.add(f"{label}: {record_id} requires bootstrap-exception provenance")
        link_comparisons = {
            "issue": "Issue",
            "verdict_comment": "Verdict",
            "record_pr": "Pull request",
        }
        for adr_field, record_field in link_comparisons.items():
            expected_urls = markdown_urls(record.get(record_field, ""))
            expected = expected_urls[0] if len(expected_urls) == 1 else ""
            if provenance.get(adr_field) != expected:
                diagnostics.add(
                    f"{label}: provenance.{adr_field} does not exactly match {record_id} {record_field}"
                )


def validate_mandate_preservation(
    adr: Adr,
    mandate_id: str,
    cells: list[str],
    diagnostics: Diagnostics,
) -> None:
    """Match a staged mandate mirror to its immutable register provenance."""
    label = adr.path.as_posix()
    fixed_choice, source, change_control = cells[1], cells[2], cells[3]
    comparisons = {
        "prd_references": (str(adr.metadata.get("prd_references", "")), source),
        "Authorized verdict": (adr.sections.get("Authorized verdict", ""), fixed_choice),
        "Reversal criteria": (adr.sections.get("Reversal criteria", ""), change_control),
    }
    for field, (actual, expected) in comparisons.items():
        if normalize_markdown(actual) != normalize_markdown(expected):
            diagnostics.add(
                f"{label}: {field} does not losslessly match authoritative mandate {mandate_id}"
            )

    provenance = adr.metadata.get("provenance") or {}
    if not isinstance(provenance, dict):
        return
    version_matches = re.findall(r"\bv(\d+\.\d+)\b", source)
    commit_matches = re.findall(r"\b[0-9a-f]{40}\b", source)
    source_urls = markdown_urls(change_control)
    issue_urls = [url for url in source_urls if issue_parts(url)]
    comment_urls = [url for url in source_urls if comment_parts(url)]
    expected_values: dict[str, list[str]] = {
        "prd_version": version_matches,
        "prd_commit": commit_matches,
        "confirmation_issue": issue_urls,
        "confirmation_comment": comment_urls,
    }
    for field, expected in expected_values.items():
        if len(expected) != 1:
            diagnostics.add(
                f"DECISIONS.md: {mandate_id} must declare exactly one immutable {field.replace('_', ' ')}"
            )
        elif provenance.get(field) != expected[0]:
            diagnostics.add(
                f"{label}: provenance.{field} does not exactly match authoritative mandate {mandate_id}"
            )


def validate_coexistence(
    root: Path,
    config: dict[str, Any],
    by_alias: dict[str, Adr],
    diagnostics: Diagnostics,
) -> None:
    mode = config.get("mode")
    register_value = config.get("register")
    if not isinstance(register_value, str):
        return
    register_path = root / register_value
    if mode == "adr-authoritative":
        if register_path.exists():
            diagnostics.add(f"{CONFIG_NAME}: adr-authoritative is forbidden while {register_value} exists")
        expected = set((config.get("legacy_ids") or {}).keys())
        actual = set(by_alias)
        for alias in sorted(expected - actual):
            diagnostics.add(f"{CONFIG_NAME}: authoritative legacy alias {alias} has no ADR")
        for alias in sorted(actual - expected):
            diagnostics.add(f"{CONFIG_NAME}: ADR alias {alias} is absent from the authoritative legacy map")
        return

    if not register_path.exists():
        diagnostics.add(f"{CONFIG_NAME}: {mode} requires authoritative register {register_value}")
        return
    register_text = register_path.read_text(encoding="utf-8")
    records = parse_register_records(register_text, diagnostics)
    register_errors: list[str] = []
    mandates = parse_index(register_text.splitlines(), "M-", 4, register_errors)
    for message in register_errors:
        diagnostics.add(f"{register_value}: {message}")
    managed_mandates = set(config.get("managed_prd_mandates") or [])
    missing_mandates = managed_mandates - mandates.keys()
    for mandate in sorted(missing_mandates):
        diagnostics.add(f"{CONFIG_NAME}: managed PRD mandate {mandate} is absent from {register_value}")
    effective_records = {
        record_id: record
        for record_id, record in records.items()
        if record.get("Status") != "Rejected"
    }
    authoritative_ids = set(effective_records) | managed_mandates
    exemptions = set(config.get("partial_mirror_exemptions") or [])
    unknown_exemptions = exemptions - authoritative_ids
    for alias in sorted(unknown_exemptions):
        diagnostics.add(f"{CONFIG_NAME}: partial mirror exemption {alias} is not authoritative")

    for alias, adr in by_alias.items():
        if alias not in authoritative_ids:
            diagnostics.add(f"{adr.path.as_posix()}: alias {alias} has no authoritative register or mandate source")
            continue
        if alias in effective_records:
            if (adr.metadata.get("provenance") or {}).get("kind") == "prd-mandate":
                diagnostics.add(f"{adr.path.as_posix()}: {alias} must use github-decision or bootstrap-exception provenance")
            else:
                validate_field_preservation(
                    adr,
                    alias,
                    effective_records[alias],
                    config.get("legacy_ids") or {},
                    diagnostics,
                )
        elif (adr.metadata.get("provenance") or {}).get("kind") != "prd-mandate":
            diagnostics.add(f"{adr.path.as_posix()}: {alias} must use prd-mandate provenance")
        else:
            validate_mandate_preservation(adr, alias, mandates[alias], diagnostics)

    for adr in {id(value): value for value in by_alias.values()}.values():
        sources = [alias for alias in adr.aliases if alias in authoritative_ids]
        if len(sources) != 1:
            diagnostics.add(
                f"{adr.path.as_posix()}: coexistence requires exactly one authoritative source alias, found {len(sources)}"
            )

    missing = authoritative_ids - by_alias.keys()
    if mode == "partial-mirror":
        for alias in sorted(missing - exemptions):
            diagnostics.add(f"{CONFIG_NAME}: late effective record {alias} must be dual-written as an ADR")
        for alias in sorted(exemptions & by_alias.keys()):
            diagnostics.add(f"{CONFIG_NAME}: mirrored ADR {alias} must be removed from partial_mirror_exemptions")
    elif mode == "complete-mirror":
        for alias in sorted(missing):
            diagnostics.add(f"{CONFIG_NAME}: complete-mirror requires an ADR for {alias}")
        extra = by_alias.keys() - authoritative_ids
        for alias in sorted(extra):
            diagnostics.add(f"{CONFIG_NAME}: complete-mirror ADR {alias} has no authoritative source")


def validate_cutover_contract(
    root: Path,
    config: dict[str, Any],
    by_id: dict[str, Adr],
    diagnostics: Diagnostics,
) -> None:
    """Keep the approved PRD retain/move boundary executable before cutover."""
    path = root / CUTOVER_CONTRACT
    label = CUTOVER_CONTRACT.as_posix()
    if not path.exists():
        return
    try:
        contract = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        diagnostics.add(f"{label}: cannot load cutover contract: {exc}")
        return
    if not isinstance(contract, dict) or contract.get("schema_version") != 1:
        diagnostics.add(f"{label}: schema_version must equal 1")
        return

    retained = contract.get("retained_prd_requirements")
    moved = contract.get("moved_architecture_requirements")
    if not isinstance(retained, dict):
        diagnostics.add(f"{label}: retained_prd_requirements must be a mapping")
        return
    if set(retained) != {"M-004", "M-005", "M-006-product"}:
        diagnostics.add(f"{label}: retained requirements must be exactly M-004, M-005, and M-006-product")
    if not isinstance(moved, dict) or set(moved) != {"M-006-provider-storage"}:
        diagnostics.add(f"{label}: moved requirements must contain exactly M-006-provider-storage")
        moved = {}

    prd_path = root / "prds/reflo-prd.md"
    try:
        prd_text = prd_path.read_text(encoding="utf-8")
    except OSError as exc:
        diagnostics.add(f"{label}: cannot read retained PRD source: {exc}")
        return
    managed = set(config.get("managed_prd_mandates") or [])
    for requirement_id, entry in retained.items():
        entry_label = f"{label}: {requirement_id}"
        if not isinstance(entry, dict):
            diagnostics.add(f"{entry_label} must be a mapping")
            continue
        if requirement_id in managed:
            diagnostics.add(f"{entry_label} must remain a PRD requirement, not an ADR-managed mandate")
        sections = entry.get("source_sections")
        fragments = entry.get("required_fragments")
        if not isinstance(sections, list) or not sections:
            diagnostics.add(f"{entry_label}.source_sections must be a non-empty list")
        else:
            for section in sections:
                section_match = re.search(r"§\s*(\d+)", str(section))
                if not section_match or not re.search(
                    rf"^##\s+{re.escape(section_match.group(1))}(?:\.|\s)",
                    prd_text,
                    re.MULTILINE,
                ):
                    diagnostics.add(f"{entry_label}: PRD section {section!r} is missing")
        if not isinstance(fragments, list) or not fragments:
            diagnostics.add(f"{entry_label}.required_fragments must be a non-empty list")
        else:
            for fragment in fragments:
                if not isinstance(fragment, str) or not fragment.strip():
                    diagnostics.add(f"{entry_label}: required fragments must be non-empty strings")
                elif fragment not in prd_text:
                    diagnostics.add(f"{entry_label}: retained PRD fragment is missing")

    moved_entry = moved.get("M-006-provider-storage")
    if isinstance(moved_entry, dict):
        aliases = moved_entry.get("adr_aliases")
        legacy_ids = config.get("legacy_ids") or {}
        if not isinstance(aliases, list) or not aliases:
            diagnostics.add(f"{label}: M-006-provider-storage.adr_aliases must be a non-empty list")
        else:
            for alias in aliases:
                canonical_id = legacy_ids.get(alias)
                if not isinstance(canonical_id, str) or canonical_id not in by_id:
                    diagnostics.add(
                        f"{label}: M-006 provider/storage alias {alias!r} has no migrated ADR"
                    )
        prohibited = moved_entry.get("prohibited_prd_fragments_after_cutover")
        if not isinstance(prohibited, list) or not prohibited:
            diagnostics.add(
                f"{label}: M-006-provider-storage must declare prohibited PRD fragments"
            )
        elif config.get("mode") == "adr-authoritative":
            for fragment in prohibited:
                if not isinstance(fragment, str) or not fragment.strip():
                    diagnostics.add(
                        f"{label}: prohibited PRD fragments must be non-empty strings"
                    )
                elif fragment in prd_text:
                    diagnostics.add(
                        f"{label}: moved architecture fragment remains in the authoritative PRD"
                    )


def git_previous_adrs(root: Path, config: dict[str, Any], base_ref: str, diagnostics: Diagnostics) -> dict[str, Adr]:
    directory = config.get("adr_directory")
    if not isinstance(directory, str) or not (root / ".git").exists():
        return {}
    result = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", base_ref, "--", directory],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        diagnostics.add(f"git baseline {base_ref!r} is unavailable; cannot verify accepted ADR immutability")
        return {}
    previous: dict[str, Adr] = {}
    scratch_diagnostics = Diagnostics()
    for relative in result.stdout.splitlines():
        if not re.search(r"/\d{4}-[a-z0-9-]+\.md$", relative):
            continue
        shown = subprocess.run(
            ["git", "show", f"{base_ref}:{relative}"],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
        if shown.returncode != 0:
            diagnostics.add(f"{relative}: cannot read merged ADR from {base_ref}")
            continue
        synthetic_path = Path(relative)
        parts = split_frontmatter(shown.stdout, relative, scratch_diagnostics)
        if not parts:
            continue
        frontmatter, body = parts
        metadata = load_yaml(frontmatter, relative, scratch_diagnostics)
        if not isinstance(metadata, dict):
            continue
        sections = parse_body(body, relative, metadata, scratch_diagnostics)
        adr = Adr(synthetic_path, metadata, sections, shown.stdout)
        if adr.canonical_id:
            previous[adr.canonical_id] = adr
    for message in scratch_diagnostics.finish():
        diagnostics.add(f"baseline: {message}")
    return previous


def git_show_text(root: Path, base_ref: str, relative: str) -> str | None:
    result = subprocess.run(
        ["git", "show", f"{base_ref}:{relative}"],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


def validate_cutover_bijection(
    root: Path,
    config: dict[str, Any],
    by_alias: dict[str, Adr],
    base_ref: str,
    diagnostics: Diagnostics,
) -> None:
    """Prove the authoritative cutover preserves the complete prior register."""

    if config.get("mode") != "adr-authoritative":
        return
    register = config.get("register")
    if not isinstance(register, str):
        return
    previous_config_source = git_show_text(root, base_ref, CONFIG_NAME)
    previous_config = (
        load_yaml(previous_config_source, f"{base_ref}:{CONFIG_NAME}", diagnostics)
        if previous_config_source is not None
        else None
    )
    if isinstance(previous_config, dict) and previous_config.get("mode") == "adr-authoritative":
        return
    if not isinstance(previous_config, dict) or previous_config.get("mode") != "complete-mirror":
        diagnostics.add(
            f"atomic cutover must transition from complete-mirror at {base_ref}"
        )
        return
    previous_register = git_show_text(root, base_ref, register)
    if previous_register is None:
        diagnostics.add(
            f"git baseline {base_ref!r} has no {register}; cannot prove cutover bijection"
        )
        return

    records = parse_register_records(previous_register, diagnostics)
    register_errors: list[str] = []
    mandates = parse_index(
        previous_register.splitlines(), "M-", 4, register_errors
    )
    for message in register_errors:
        diagnostics.add(f"{base_ref}:{register}: {message}")
    effective_records = {
        record_id: record
        for record_id, record in records.items()
        if record.get("Status") != "Rejected"
    }
    managed_mandates = set(config.get("managed_prd_mandates") or [])
    expected = set(effective_records) | managed_mandates
    actual = set(by_alias)
    for alias in sorted(expected - actual):
        diagnostics.add(
            f"atomic cutover lost authoritative record {alias} from {base_ref}:{register}"
        )
    for alias in sorted(actual - expected):
        diagnostics.add(
            f"atomic cutover ADR alias {alias} has no source in {base_ref}:{register}"
        )
    legacy_ids = config.get("legacy_ids") or {}
    for alias, adr in by_alias.items():
        if alias in effective_records:
            validate_field_preservation(
                adr, alias, effective_records[alias], legacy_ids, diagnostics
            )
        elif alias in managed_mandates and alias in mandates:
            validate_mandate_preservation(
                adr, alias, mandates[alias], diagnostics
            )
        elif alias in managed_mandates:
            diagnostics.add(
                f"atomic cutover mandate {alias} is absent from {base_ref}:{register}"
            )


def validate_immutable_sql_history(
    root: Path,
    base_ref: str,
    diagnostics: Diagnostics,
) -> None:
    """Reject changes to SQL files that were already merged at the base ref."""

    result = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", base_ref],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        diagnostics.add(
            f"git baseline {base_ref!r} is unavailable; cannot verify immutable SQL history"
        )
        return
    for relative in sorted(
        path
        for path in result.stdout.splitlines()
        if Path(path).suffix.lower() == ".sql"
        and (
            "migrations" in Path(path).parts
            or Path(path).parent.name == "sql"
        )
    ):
        previous = git_show_text(root, base_ref, relative)
        current_path = root / relative
        if previous is None or not current_path.is_file():
            diagnostics.add(f"{relative}: merged SQL history cannot be deleted")
            continue
        try:
            current = current_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            diagnostics.add(f"{relative}: merged SQL history cannot be read")
            continue
        if current != previous:
            diagnostics.add(f"{relative}: merged SQL history is immutable")


def validate_prd_sources(root: Path, adrs: dict[str, Adr], diagnostics: Diagnostics) -> None:
    if not (root / ".git").exists():
        return
    for adr in adrs.values():
        provenance = adr.metadata.get("provenance") or {}
        if not isinstance(provenance, dict) or provenance.get("kind") != "prd-mandate":
            continue
        commit = provenance.get("prd_commit")
        path = provenance.get("prd_path")
        version = provenance.get("prd_version")
        sections = provenance.get("prd_sections")
        if (
            not isinstance(commit, str)
            or not COMMIT_SHA.fullmatch(commit)
            or not isinstance(path, str)
            or not isinstance(version, str)
            or not isinstance(sections, list)
        ):
            continue
        shown = subprocess.run(
            ["git", "show", f"{commit}:{path}"],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
        label = f"{adr.path.as_posix()}: provenance"
        if shown.returncode != 0:
            diagnostics.add(f"{label}.prd_commit: commit/path cannot be resolved from repository history")
            continue
        if not re.search(rf"^\*\*Version:\*\*\s*{re.escape(version)}(?:\s|·|$)", shown.stdout, re.MULTILINE):
            diagnostics.add(f"{label}.prd_version: does not match the immutable PRD at prd_commit")
        for section in sections:
            section_match = re.search(r"§\s*(\d+)", str(section))
            if not section_match:
                diagnostics.add(f"{label}.prd_sections: invalid exact section reference {section!r}")
                continue
            number = section_match.group(1)
            if not re.search(rf"^##\s+{re.escape(number)}(?:\.|\s)", shown.stdout, re.MULTILINE):
                diagnostics.add(f"{label}.prd_sections: {section!r} is absent from the immutable PRD")


def validate_repository(
    root: Path = ROOT,
    *,
    base_ref: str | None = None,
) -> tuple[list[str], list[str], dict[str, Adr], dict[str, Any]]:
    diagnostics = Diagnostics()
    config = parse_config(root, diagnostics)
    by_id, by_alias, urls = collect_adrs(root, config, diagnostics)
    validate_alias_allocation(config, by_id, diagnostics)
    validate_authority_transfer(config, by_id, diagnostics)
    validate_coexistence(root, config, by_alias, diagnostics)
    validate_cutover_contract(root, config, by_id, diagnostics)
    validate_prd_sources(root, by_id, diagnostics)
    if base_ref:
        validate_cutover_bijection(
            root, config, by_alias, base_ref, diagnostics
        )
        validate_immutable_sql_history(root, base_ref, diagnostics)
        previous = git_previous_adrs(root, config, base_ref, diagnostics)
        for canonical_id, old_adr in previous.items():
            current = by_id.get(canonical_id)
            if not current:
                diagnostics.add(f"{old_adr.path.as_posix()}: merged ADRs cannot be deleted")
            else:
                validate_transition(old_adr, current, diagnostics)
    return diagnostics.finish(), sorted(set(urls)), by_id, config


def resolve_legacy_id(config: dict[str, Any], adrs: dict[str, Adr], value: str) -> tuple[str, Path | None]:
    mapping = config.get("legacy_ids") or {}
    canonical_id = mapping.get(value, value if CANONICAL_ID.fullmatch(value) else None)
    if not isinstance(canonical_id, str):
        raise KeyError(value)
    adr = adrs.get(canonical_id)
    return canonical_id, adr.path if adr else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--base-ref",
        default=None,
        help="Git ref containing merged ADRs to enforce lifecycle and content immutability against.",
    )
    parser.add_argument("--check-links", action="store_true")
    parser.add_argument("--resolve", metavar="LEGACY_OR_CANONICAL_ID")
    args = parser.parse_args()

    errors, urls, adrs, config = validate_repository(args.root.resolve(), base_ref=args.base_ref)
    if args.check_links:
        check_urls(urls, errors)
    if len(errors) > MAX_DIAGNOSTICS:
        omitted = len(errors) - MAX_DIAGNOSTICS
        errors = errors[:MAX_DIAGNOSTICS] + [
            f"diagnostic limit reached; omitted {omitted} additional error(s)"
        ]
    if errors:
        for message in errors:
            print(f"ERROR: {message}", file=sys.stderr)
        return 1
    if args.resolve:
        try:
            canonical_id, path = resolve_legacy_id(config, adrs, args.resolve)
        except KeyError:
            print(f"ERROR: unknown ADR or legacy ID {args.resolve!r}", file=sys.stderr)
            return 1
        location = path.as_posix() if path else "not migrated"
        print(f"{args.resolve} -> {canonical_id} ({location})")
        return 0
    mode = config.get("mode")
    print(
        f"ADR governance is valid in {mode} mode: {len(adrs)} ADR(s), "
        f"{len(urls)} provenance link(s) checked structurally."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
