#!/usr/bin/env python3
"""Validate non-authoritative architectural problem documents."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
PROBLEM_DIRECTORY = Path("docs/problems")
DOCUMENT_FILENAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+['\"][^'\"]*['\"])?\)")
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
TASK_ITEM = re.compile(r"^\s*[-*+]\s+\[[ xX]\]\s+")
LABELED_METADATA = re.compile(
    r"^\s*(?:[-*+]\s+)?(?:\*\*)?"
    r"(?:status|owners?|assignees?|milestones?|delivery sequence|"
    r"implementation sequence|implementation plan|task list|checklist|"
    r"recommendations?|decisions?|verdict|accepted|rejected)"
    r"(?:\*\*)?\s*:",
    re.IGNORECASE,
)
VERDICT_LANGUAGE = (
    re.compile(r"^\s*(?:we|this document)\s+(?:decided|decides)\b", re.IGNORECASE),
    re.compile(r"^\s*the\s+(?:decision|verdict|recommendation)\s+is\b", re.IGNORECASE),
    re.compile(r"^\s*the\s+architecture\s+shall\b", re.IGNORECASE),
)
PROHIBITED_HEADINGS = {
    "accepted",
    "accepted decision",
    "assignee",
    "assignees",
    "checklist",
    "decision",
    "decisions",
    "delivery sequence",
    "implementation plan",
    "implementation sequence",
    "milestone",
    "milestones",
    "next steps",
    "owner",
    "owners",
    "recommendation",
    "recommendations",
    "rejected",
    "rejected decision",
    "status",
    "task list",
    "tasks",
    "verdict",
}
REQUIRED_HEADINGS = (
    "Problem",
    "Forces and constraints",
    "Risks",
    "Evidence to preserve",
    "Open questions",
    "Related authoritative sources",
)
NON_AUTHORITATIVE_NOTICE = (
    "**Non-authoritative:** This document explores a durable architectural problem."
)
MAX_DIAGNOSTICS = 50


def github_slug(value: str) -> str:
    """Return the GitHub-style heading fragment used by repository Markdown."""

    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"[`*_~]", "", value)
    value = value.strip().lower()
    value = re.sub(r"[^\w\s-]", "", value)
    return re.sub(r"\s", "-", value)


def heading_fragments(path: Path) -> set[str]:
    fragments: set[str] = set()
    counts: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = HEADING.match(line)
        if not match:
            continue
        base = github_slug(match.group(2))
        index = counts.get(base, 0)
        counts[base] = index + 1
        fragments.add(base if index == 0 else f"{base}-{index}")
    return fragments


def normalize_heading(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[`*_~]", "", value)).strip().lower()


def resolve_local_target(
    root: Path, source: Path, raw_target: str
) -> tuple[Path, str] | None:
    if raw_target.startswith(("http://", "https://", "mailto:", "tel:")):
        return None
    path_text, separator, fragment = raw_target.partition("#")
    path_text = unquote(path_text)
    fragment = unquote(fragment) if separator else ""
    if path_text.startswith("/"):
        target = root / path_text.lstrip("/")
    elif path_text:
        target = source.parent / path_text
    else:
        target = source
    return target.resolve(), fragment


def validate_local_links(root: Path, path: Path, errors: list[str]) -> set[Path]:
    linked_paths: set[Path] = set()
    source = path.read_text(encoding="utf-8")
    for line_number, line in enumerate(source.splitlines(), 1):
        for raw_target in MARKDOWN_LINK.findall(line):
            resolved = resolve_local_target(root, path, raw_target)
            if resolved is None:
                continue
            target, fragment = resolved
            try:
                target.relative_to(root.resolve())
            except ValueError:
                errors.append(
                    f"{path.relative_to(root)}:{line_number}: local link escapes the repository: {raw_target}"
                )
                continue
            if not target.exists():
                errors.append(
                    f"{path.relative_to(root)}:{line_number}: broken local link: {raw_target}"
                )
                continue
            linked_paths.add(target)
            if fragment:
                if not target.is_file() or target.suffix.lower() != ".md":
                    errors.append(
                        f"{path.relative_to(root)}:{line_number}: fragment targets a non-Markdown file: {raw_target}"
                    )
                elif fragment not in heading_fragments(target):
                    errors.append(
                        f"{path.relative_to(root)}:{line_number}: missing Markdown fragment: {raw_target}"
                    )
    return linked_paths


def validate_problem_document(root: Path, path: Path, errors: list[str]) -> None:
    relative = path.relative_to(root)
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()

    if source.startswith("---\n"):
        errors.append(f"{relative}: YAML frontmatter is prohibited in problem documents")
    if NON_AUTHORITATIVE_NOTICE not in source:
        errors.append(f"{relative}: missing the required non-authoritative notice")

    headings: list[tuple[int, str]] = []
    for line_number, line in enumerate(lines, 1):
        heading = HEADING.match(line)
        if heading:
            normalized = normalize_heading(heading.group(2))
            headings.append((line_number, normalized))
            if normalized in PROHIBITED_HEADINGS:
                errors.append(
                    f"{relative}:{line_number}: prohibited tracker or verdict heading: {heading.group(2)}"
                )
        if TASK_ITEM.match(line):
            errors.append(f"{relative}:{line_number}: task-list items are prohibited")
        if LABELED_METADATA.match(line):
            errors.append(
                f"{relative}:{line_number}: prohibited tracker or verdict metadata"
            )
        if any(pattern.search(line) for pattern in VERDICT_LANGUAGE):
            errors.append(
                f"{relative}:{line_number}: problem exploration cannot present a verdict"
            )

    heading_names = [name for _, name in headings]
    missing = [
        heading for heading in REQUIRED_HEADINGS if heading.lower() not in heading_names
    ]
    if missing:
        errors.append(f"{relative}: missing required headings: {', '.join(missing)}")

    linked_paths = validate_local_links(root, path, errors)
    if (root / "prds/reflo-prd.md").resolve() not in linked_paths:
        errors.append(f"{relative}: must link the authoritative PRD")
    if (root / "docs/adrs/README.md").resolve() not in linked_paths:
        errors.append(f"{relative}: must link the authoritative ADR collection")


def validate_repository(root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    directory = root / PROBLEM_DIRECTORY
    if not directory.is_dir():
        return [f"{PROBLEM_DIRECTORY}: architectural problem directory is missing"]

    markdown_files = sorted(directory.glob("*.md"))
    documents = [path for path in markdown_files if path.name != "README.md"]
    if not documents:
        errors.append(f"{PROBLEM_DIRECTORY}: at least one problem document is required")

    for path in documents:
        if not DOCUMENT_FILENAME.fullmatch(path.name):
            errors.append(
                f"{path.relative_to(root)}: filename must use lowercase kebab-case"
            )
        validate_problem_document(root, path, errors)

    readme = directory / "README.md"
    if not readme.is_file():
        errors.append(f"{readme.relative_to(root)}: problem-document index is missing")
    else:
        validate_local_links(root, readme, errors)

    return errors[:MAX_DIAGNOSTICS]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="repository root (defaults to the current Reflo checkout)",
    )
    args = parser.parse_args(argv)
    errors = validate_repository(args.root.resolve())
    if errors:
        print("Problem-document validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Problem-document validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
