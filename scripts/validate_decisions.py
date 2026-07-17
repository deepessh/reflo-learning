#!/usr/bin/env python3
"""Validate the structure and references in DECISIONS.md using only stdlib."""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DECISIONS = ROOT / "DECISIONS.md"

RECORD_HEADING = re.compile(r"^## (D-[A-Z0-9-]+) — (.+)$")
FIELD = re.compile(r"^- \*\*(.+?):\*\*\s+(.+)$")
URL = re.compile(r"https://github\.com/[^\s)>]+")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

ALLOWED_STATUSES = {"Accepted", "Rejected", "Superseded"}
REQUIRED_FIELDS = {
    "Status",
    "Decision date",
    "Proposer",
    "Decision DRI",
    "Authorized decider",
    "Implementation owner",
    "PRD references",
    "Context and boundary",
    "Options considered",
    "Authorized verdict",
    "Rationale",
    "Testable consequences",
    "Reversal criteria",
    "Supersedes",
    "Issue",
    "Verdict",
    "Pull request",
    "Bootstrap exception",
}

SENSITIVE_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    "AWS-style access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "assigned secret": re.compile(r"(?i)\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{12,}"),
    "email address / contact PII": re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
}


def error(errors: list[str], message: str) -> None:
    errors.append(message)


def parse_date(value: str, label: str, errors: list[str]) -> None:
    if not ISO_DATE.fullmatch(value):
        error(errors, f"{label}: expected ISO date YYYY-MM-DD, got {value!r}")
        return
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        error(errors, f"{label}: invalid calendar date {value!r}")


def markdown_urls(value: str) -> list[str]:
    return [match.rstrip(".,;`") for match in URL.findall(value)]


def github_api_url(url: str) -> str:
    match = re.fullmatch(
        r"https://github\.com/([^/]+)/([^/]+)/(issues|pull)/(\d+)(?:#issuecomment-(\d+))?",
        url,
    )
    if not match:
        raise ValueError(f"unsupported GitHub decision-link shape: {url}")
    owner, repository, kind, number, comment_id = match.groups()
    if comment_id:
        return f"https://api.github.com/repos/{owner}/{repository}/issues/comments/{comment_id}"
    endpoint = "issues" if kind == "issues" else "pulls"
    return f"https://api.github.com/repos/{owner}/{repository}/{endpoint}/{number}"


def parse_records(lines: list[str], errors: list[str]) -> dict[str, dict[str, str]]:
    records: dict[str, dict[str, str]] = {}
    current_id: str | None = None

    for line_number, line in enumerate(lines, 1):
        heading = RECORD_HEADING.match(line)
        if heading:
            current_id = heading.group(1)
            if current_id in records:
                error(errors, f"line {line_number}: duplicate effective decision ID {current_id}")
            records[current_id] = {"Title": heading.group(2), "_line": str(line_number)}
            continue
        if line.startswith("## "):
            current_id = None
            continue
        if current_id:
            field = FIELD.match(line)
            if field:
                name, value = field.groups()
                if name in records[current_id]:
                    error(errors, f"line {line_number}: duplicate field {name!r} in {current_id}")
                records[current_id][name] = value.strip()

    return records


def parse_index(
    lines: list[str], prefix: str, expected_columns: int, errors: list[str]
) -> dict[str, list[str]]:
    rows: dict[str, list[str]] = {}
    marker = f"| `{prefix}"
    for line_number, line in enumerate(lines, 1):
        if not line.startswith(marker):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != expected_columns:
            error(
                errors,
                f"line {line_number}: {prefix} row must contain {expected_columns} columns, found {len(cells)}",
            )
            continue
        row_id = cells[0].strip("`")
        if row_id in rows:
            error(errors, f"line {line_number}: duplicate index ID {row_id}")
        if any(not cell for cell in cells):
            error(errors, f"line {line_number}: {row_id} contains an empty cell")
        rows[row_id] = cells
    return rows


def validate_records(records: dict[str, dict[str, str]], errors: list[str]) -> list[str]:
    urls: list[str] = []
    supersession: dict[str, list[str]] = {}

    for record_id, fields in records.items():
        missing = sorted(REQUIRED_FIELDS - fields.keys())
        if missing:
            error(errors, f"{record_id}: missing fields: {', '.join(missing)}")
            continue

        if fields["Status"] not in ALLOWED_STATUSES:
            error(errors, f"{record_id}: unsupported status {fields['Status']!r}")
        parse_date(fields["Decision date"], f"{record_id} Decision date", errors)
        if "`prds/reflo-prd.md` §" not in fields["PRD references"]:
            error(errors, f"{record_id}: PRD references must cite an exact section")

        is_bootstrap = fields["Bootstrap exception"].startswith("Yes")
        if is_bootstrap:
            if not record_id.startswith("D-BOOTSTRAP-"):
                error(errors, f"{record_id}: bootstrap records must use D-BOOTSTRAP-* IDs")
        else:
            if not re.fullmatch(r"D-GH-\d+", record_id):
                error(errors, f"{record_id}: non-bootstrap IDs must use D-GH-<issue-number>")
            linked: dict[str, str] = {}
            for link_field in ("Issue", "Verdict", "Pull request"):
                field_urls = markdown_urls(fields[link_field])
                if not field_urls:
                    error(errors, f"{record_id}: {link_field} must contain a GitHub URL")
                elif len(field_urls) > 1:
                    error(errors, f"{record_id}: {link_field} must contain exactly one GitHub URL")
                else:
                    linked[link_field] = field_urls[0]
                urls.extend(field_urls)

            issue_match = re.fullmatch(
                r"https://github\.com/([^/]+)/([^/]+)/issues/(\d+)", linked.get("Issue", "")
            )
            verdict_match = re.fullmatch(
                r"https://github\.com/([^/]+)/([^/]+)/issues/(\d+)#issuecomment-(\d+)",
                linked.get("Verdict", ""),
            )
            pr_match = re.fullmatch(
                r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)",
                linked.get("Pull request", ""),
            )
            if linked.get("Issue") and not issue_match:
                error(errors, f"{record_id}: Issue must link to one GitHub issue")
            if linked.get("Verdict") and not verdict_match:
                error(errors, f"{record_id}: Verdict must link to an exact issue comment")
            if linked.get("Pull request") and not pr_match:
                error(errors, f"{record_id}: Pull request must link to one GitHub pull request")
            if issue_match and verdict_match:
                if issue_match.groups() != verdict_match.groups()[:3]:
                    error(errors, f"{record_id}: Issue and Verdict must reference the same issue")
                if record_id != f"D-GH-{issue_match.group(3)}":
                    error(errors, f"{record_id}: ID must match originating issue number")
            if issue_match and pr_match and issue_match.groups()[:2] != pr_match.groups()[:2]:
                error(errors, f"{record_id}: Issue and Pull request must belong to the same repository")

        for value in fields.values():
            if re.search(r"\bP-\d{3}\b", value):
                error(errors, f"{record_id}: effective records cannot use pending IDs as authority")
                break

        raw_targets = fields["Supersedes"].strip()
        if raw_targets.lower() == "none":
            targets: list[str] = []
        else:
            targets = [target.strip().strip("`") for target in raw_targets.split(",")]
        for target in targets:
            if target.startswith("M-"):
                error(errors, f"{record_id}: ordinary decisions cannot supersede PRD mandate {target}")
            if target == record_id:
                error(errors, f"{record_id}: cannot supersede itself")
        supersession[record_id] = targets

    for record_id, targets in supersession.items():
        for target in targets:
            if target not in records:
                error(errors, f"{record_id}: supersession target {target} does not exist")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(record_id: str) -> None:
        if record_id in visiting:
            error(errors, f"supersession cycle detected at {record_id}")
            return
        if record_id in visited:
            return
        visiting.add(record_id)
        for target in supersession.get(record_id, []):
            if target in records:
                visit(target)
        visiting.remove(record_id)
        visited.add(record_id)

    for record_id in records:
        visit(record_id)

    return urls


def validate_document(text: str) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    lines = text.splitlines()

    for section in (
        "## Authority and lifecycle",
        "## PRD Mandate Index",
        "## Pending Decision Index",
        "## Effective Decision Records",
    ):
        if section not in lines:
            error(errors, f"missing required section: {section}")

    mandates = parse_index(lines, "M-", 4, errors)
    pending = parse_index(lines, "P-", 7, errors)
    records = parse_records(lines, errors)

    if not mandates:
        error(errors, "PRD Mandate Index must contain at least one mandate")
    if not pending:
        error(errors, "Pending Decision Index must contain at least one pending choice")
    if not records:
        error(errors, "Effective Decision Records must contain at least one record")

    all_ids = list(mandates) + list(pending) + list(records)
    if len(all_ids) != len(set(all_ids)):
        error(errors, "IDs must be unique across mandate, pending, and effective sections")

    for mandate_id, cells in mandates.items():
        if "`prds/reflo-prd.md` §" not in cells[2]:
            error(errors, f"{mandate_id}: authoritative source must cite an exact PRD section")
        if "PRD revision only" not in cells[3]:
            error(errors, f"{mandate_id}: mandate change control must be 'PRD revision only'")

    for pending_id, cells in pending.items():
        parse_date(cells[4], f"{pending_id} deadline", errors)
        issue = cells[6]
        if not markdown_urls(issue) and issue != "Not opened — GitHub bootstrap pending":
            error(errors, f"{pending_id}: issue must be a GitHub URL or the exact bootstrap placeholder")

    urls = validate_records(records, errors)

    for label, pattern in SENSITIVE_PATTERNS.items():
        if pattern.search(text):
            error(errors, f"DECISIONS.md appears to contain prohibited {label}")

    return errors, sorted(set(urls))


def check_urls(urls: list[str], errors: list[str]) -> None:
    token = os.environ.get("GITHUB_TOKEN")
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "reflo-decision-validator",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    for url in urls:
        try:
            api_url = github_api_url(url)
        except ValueError as exc:
            error(errors, str(exc))
            continue
        request = urllib.request.Request(api_url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                if response.status >= 400:
                    error(errors, f"unresolvable GitHub link ({response.status}): {url}")
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            error(errors, f"unresolvable GitHub link: {url} ({exc})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check-links",
        action="store_true",
        help="Resolve GitHub links; uses GITHUB_TOKEN when available.",
    )
    args = parser.parse_args()

    if not DECISIONS.exists():
        print(f"ERROR: missing {DECISIONS.relative_to(ROOT)}", file=sys.stderr)
        return 1

    errors, urls = validate_document(DECISIONS.read_text(encoding="utf-8"))
    if args.check_links:
        check_urls(urls, errors)

    if errors:
        for message in errors:
            print(f"ERROR: {message}", file=sys.stderr)
        return 1

    print(
        "DECISIONS.md is valid: "
        f"{len(urls)} effective-record GitHub link(s) checked structurally"
        + (" and resolved" if args.check_links else "")
        + "."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
