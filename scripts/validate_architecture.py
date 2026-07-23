#!/usr/bin/env python3
"""Generate and validate Reflo's target and implemented architecture views."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from validate_adrs import Diagnostics, load_yaml, split_frontmatter  # noqa: E402
from validate_problem_docs import (  # noqa: E402
    MARKDOWN_LINK,
    resolve_local_target,
    validate_local_links,
)


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(".adr-governance.yaml")
ARCHITECTURE_PATH = Path("docs/architecture.md")
TARGET_HEADING = "## Decided target architecture"
IMPLEMENTED_HEADING = "## Implemented state"
PROBLEMS_HEADING = "## Architectural problems"
NON_AUTHORITATIVE_NOTICE = (
    "**Non-authoritative:** This page is a reviewable projection"
)
TARGET_NOTICE = (
    "**View contract:** this is the decided target, sourced from the active records "
    "below. It is not evidence of repository or runtime state."
)
IMPLEMENTED_NOTICE = (
    "**View contract:** every row describes only the named implemented slice and "
    "must carry concrete evidence. A row does not prove its whole target ADR complete."
)
REVIEW_BOUNDARY = (
    "Free-form semantic contradictions remain review defects; this validation "
    "does not claim to detect them."
)
TARGET_START = "<!-- BEGIN GENERATED ACTIVE ADRS -->"
TARGET_END = "<!-- END GENERATED ACTIVE ADRS -->"
IMPLEMENTED_START = "<!-- BEGIN IMPLEMENTED STATE -->"
IMPLEMENTED_END = "<!-- END IMPLEMENTED STATE -->"
IMPLEMENTED_HEADER = "| Implemented slice | Evidence | Target ADRs |"
IMPLEMENTED_SEPARATOR = "|---|---|---|"
OVERSTATEMENT = re.compile(
    r"\b(?:complete(?:ly)?|fully implemented|shipped|production-ready|"
    r"deployed|operational)\b",
    re.IGNORECASE,
)
ALLOWED_EVIDENCE_ROOTS = {
    ".github",
    "apps",
    "infra",
    "packages",
    "scripts",
}
MAX_DIAGNOSTICS = 50


@dataclass(frozen=True)
class TargetAdr:
    canonical_id: str
    title: str
    aliases: tuple[str, ...]
    path: Path
    provenance: dict[str, Any]


def read_config(root: Path, errors: list[str]) -> dict[str, Any]:
    path = root / CONFIG_PATH
    if not path.is_file():
        errors.append(f"{CONFIG_PATH}: ADR governance configuration is missing")
        return {}
    diagnostics = Diagnostics()
    config = load_yaml(path.read_text(encoding="utf-8"), str(CONFIG_PATH), diagnostics)
    errors.extend(diagnostics.finish())
    if not isinstance(config, dict):
        errors.append(f"{CONFIG_PATH}: configuration must be a mapping")
        return {}
    return config


def active_adrs(root: Path, config: dict[str, Any], errors: list[str]) -> list[TargetAdr]:
    directory_value = config.get("adr_directory")
    if not isinstance(directory_value, str) or not directory_value:
        errors.append(f"{CONFIG_PATH}: adr_directory must be a non-empty string")
        return []
    directory = root / directory_value
    if not directory.is_dir():
        errors.append(f"{directory_value}: ADR directory is missing")
        return []

    records: list[TargetAdr] = []
    seen_ids: set[str] = set()
    for path in sorted(directory.glob("[0-9][0-9][0-9][0-9]-*.md")):
        relative = path.relative_to(root)
        diagnostics = Diagnostics()
        parts = split_frontmatter(
            path.read_text(encoding="utf-8"), relative.as_posix(), diagnostics
        )
        if not parts:
            errors.extend(diagnostics.finish())
            continue
        frontmatter, _body = parts
        metadata = load_yaml(frontmatter, relative.as_posix(), diagnostics)
        errors.extend(diagnostics.finish())
        if not isinstance(metadata, dict):
            continue

        canonical_id = metadata.get("id")
        title = metadata.get("title")
        aliases = metadata.get("aliases")
        provenance = metadata.get("provenance")
        if (
            not isinstance(canonical_id, str)
            or not re.fullmatch(r"\d{4}", canonical_id)
            or not isinstance(title, str)
            or not title.strip()
            or not isinstance(aliases, list)
            or not all(isinstance(alias, str) and alias for alias in aliases)
            or not isinstance(provenance, dict)
        ):
            errors.append(
                f"{relative}: active-index metadata requires id, title, aliases, and provenance"
            )
            continue
        if canonical_id in seen_ids:
            errors.append(f"{relative}: duplicate ADR id {canonical_id}")
            continue
        seen_ids.add(canonical_id)

        is_active = (
            metadata.get("status") == "Accepted"
            and metadata.get("superseded_by") is None
            and metadata.get("deprecation") is None
        )
        if is_active:
            records.append(
                TargetAdr(
                    canonical_id=canonical_id,
                    title=title.strip(),
                    aliases=tuple(aliases),
                    path=relative,
                    provenance=provenance,
                )
            )
    return sorted(records, key=lambda record: record.canonical_id)


def authority_label(config: dict[str, Any], adr: TargetAdr) -> str:
    if config.get("mode") == "adr-authoritative":
        return "ADR"
    if adr.provenance.get("kind") == "prd-mandate":
        return "PRD mandate (staged ADR mirror)"
    return "Decision register (ADR mirror)"


def render_active_table(config: dict[str, Any], records: list[TargetAdr]) -> str:
    lines = [
        "| ADR | Decided target | Legacy IDs | Current authority |",
        "|---|---|---|---|",
    ]
    for adr in records:
        link = f"adrs/{adr.path.name}"
        aliases = ", ".join(f"`{alias}`" for alias in adr.aliases)
        lines.append(
            f"| [ADR {adr.canonical_id}]({link}) | {adr.title} | "
            f"{aliases} | {authority_label(config, adr)} |"
        )
    return "\n".join(lines)


def extract_block(
    source: str, start: str, end: str, label: str, errors: list[str]
) -> tuple[int, int, str] | None:
    if source.count(start) != 1 or source.count(end) != 1:
        errors.append(f"{ARCHITECTURE_PATH}: requires exactly one {label} marker pair")
        return None
    start_at = source.index(start) + len(start)
    end_at = source.index(end)
    if start_at >= end_at:
        errors.append(f"{ARCHITECTURE_PATH}: {label} markers are out of order")
        return None
    return start_at, end_at, source[start_at:end_at].strip()


def replace_target_table(source: str, generated: str, errors: list[str]) -> str:
    block = extract_block(source, TARGET_START, TARGET_END, "active-ADR", errors)
    if not block:
        return source
    start_at, end_at, _content = block
    return source[:start_at] + f"\n{generated}\n" + source[end_at:]


def validate_headings_and_notices(source: str, errors: list[str]) -> None:
    headings = (TARGET_HEADING, IMPLEMENTED_HEADING, PROBLEMS_HEADING)
    for heading in headings:
        if source.count(heading) != 1:
            errors.append(f"{ARCHITECTURE_PATH}: requires exactly one {heading!r}")
    if all(source.count(heading) == 1 for heading in headings):
        positions = [source.index(heading) for heading in headings]
        if positions != sorted(positions):
            errors.append(
                f"{ARCHITECTURE_PATH}: target, implemented, and problem views are out of order"
            )
    for notice in (TARGET_NOTICE, IMPLEMENTED_NOTICE, REVIEW_BOUNDARY):
        if notice not in source:
            errors.append(f"{ARCHITECTURE_PATH}: missing required view contract: {notice}")
    if NON_AUTHORITATIVE_NOTICE not in source:
        errors.append(
            f"{ARCHITECTURE_PATH}: missing required non-authoritative notice"
        )


def markdown_targets(value: str) -> list[str]:
    return MARKDOWN_LINK.findall(value)


def local_link_path(root: Path, source_path: Path, target: str) -> Path | None:
    resolved = resolve_local_target(root, source_path, target)
    if resolved is None:
        return None
    return resolved[0]


def validate_implemented_table(
    root: Path,
    architecture_path: Path,
    source: str,
    active: list[TargetAdr],
    errors: list[str],
) -> None:
    block = extract_block(
        source, IMPLEMENTED_START, IMPLEMENTED_END, "implemented-state", errors
    )
    if not block:
        return
    start_at, _end_at, content = block
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if len(lines) < 3 or lines[:2] != [IMPLEMENTED_HEADER, IMPLEMENTED_SEPARATOR]:
        errors.append(
            f"{ARCHITECTURE_PATH}: implemented-state block must use the required "
            "three-column table and contain at least one evidence row"
        )
        return

    active_paths = {(root / adr.path).resolve() for adr in active}
    for row_offset, line in enumerate(lines[2:], 3):
        line_number = source[:start_at].count("\n") + row_offset + 1
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) != 3 or any(not cell for cell in cells):
            errors.append(
                f"{ARCHITECTURE_PATH}:{line_number}: implemented-state rows require "
                "three non-empty cells"
            )
            continue
        claim, evidence, targets = cells
        if OVERSTATEMENT.search(claim):
            errors.append(
                f"{ARCHITECTURE_PATH}:{line_number}: implemented claim overstates "
                "evidence; describe only an implemented slice"
            )

        evidence_links = markdown_targets(evidence)
        if not evidence_links:
            errors.append(
                f"{ARCHITECTURE_PATH}:{line_number}: implemented claim has no evidence link"
            )
        valid_local_evidence = 0
        for raw_target in evidence_links:
            target_path = local_link_path(root, architecture_path, raw_target)
            if target_path is None:
                continue
            try:
                relative = target_path.relative_to(root.resolve())
            except ValueError:
                continue
            if relative.parts and relative.parts[0] in ALLOWED_EVIDENCE_ROOTS:
                valid_local_evidence += 1
        if valid_local_evidence == 0:
            errors.append(
                f"{ARCHITECTURE_PATH}:{line_number}: implemented claim needs concrete "
                "repository evidence under apps/, packages/, infra/, scripts/, or .github/"
            )

        target_links = markdown_targets(targets)
        linked_active = {
            local_link_path(root, architecture_path, target)
            for target in target_links
        }
        if not linked_active.intersection(active_paths):
            errors.append(
                f"{ARCHITECTURE_PATH}:{line_number}: implemented claim must reference "
                "at least one active target ADR"
            )


def validate_problem_references(
    root: Path, architecture_path: Path, source: str, errors: list[str]
) -> None:
    problem_directory = root / "docs/problems"
    expected = {
        path.resolve()
        for path in problem_directory.glob("*.md")
        if path.name != "README.md"
    }
    linked = {
        path
        for target in markdown_targets(source)
        if (path := local_link_path(root, architecture_path, target)) is not None
    }
    missing = sorted(expected - linked)
    if missing:
        errors.append(
            f"{ARCHITECTURE_PATH}: missing architectural problem references: "
            + ", ".join(path.relative_to(root).as_posix() for path in missing)
        )


def validate_repository(root: Path = ROOT) -> list[str]:
    root = root.resolve()
    errors: list[str] = []
    config = read_config(root, errors)
    records = active_adrs(root, config, errors)
    architecture_path = root / ARCHITECTURE_PATH
    if not architecture_path.is_file():
        errors.append(f"{ARCHITECTURE_PATH}: architecture view is missing")
        return errors[:MAX_DIAGNOSTICS]

    source = architecture_path.read_text(encoding="utf-8")
    validate_headings_and_notices(source, errors)
    target = extract_block(source, TARGET_START, TARGET_END, "active-ADR", errors)
    if target:
        _start_at, _end_at, current = target
        expected = render_active_table(config, records)
        if current != expected:
            errors.append(
                f"{ARCHITECTURE_PATH}: active-ADR table is stale; "
                "run scripts/validate_architecture.py --write"
            )

    validate_local_links(root, architecture_path, errors)
    validate_implemented_table(
        root, architecture_path, source, records, errors
    )
    validate_problem_references(root, architecture_path, source, errors)
    return errors[:MAX_DIAGNOSTICS]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--write",
        action="store_true",
        help="rewrite the generated active-ADR table from canonical ADR metadata",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve()

    if args.write:
        errors: list[str] = []
        config = read_config(root, errors)
        records = active_adrs(root, config, errors)
        path = root / ARCHITECTURE_PATH
        if not path.is_file():
            errors.append(f"{ARCHITECTURE_PATH}: architecture view is missing")
        if errors:
            for error in errors[:MAX_DIAGNOSTICS]:
                print(f"ERROR: {error}", file=sys.stderr)
            return 1
        source = path.read_text(encoding="utf-8")
        updated = replace_target_table(
            source, render_active_table(config, records), errors
        )
        if errors:
            for error in errors[:MAX_DIAGNOSTICS]:
                print(f"ERROR: {error}", file=sys.stderr)
            return 1
        path.write_text(updated, encoding="utf-8")

    errors = validate_repository(root)
    if errors:
        print("Architecture validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Architecture validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
