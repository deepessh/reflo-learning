#!/usr/bin/env python3
"""Validate and discover evidence-backed contributor-agent improvement candidates."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass, field
from typing import Any


MARKER = re.compile(
    r"<!-- reflo-improvement-(candidate|occurrence|disposition):v1\n(.*?)\n-->",
    re.DOTALL,
)
MARKER_PREFIX = "<!-- reflo-improvement-"
FIELD = re.compile(r"^([a-z][a-z-]*): (.+)$")
KEY = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
AGENT_LABEL = re.compile(r"^agent:wt-[0-9a-f]{20}$")

ORDINARY_CATEGORY = "ordinary"
CRITICAL_CATEGORIES = {
    "security",
    "privacy",
    "authorization",
    "data-loss",
    "release-governance",
}
CATEGORY_THRESHOLDS = {
    ORDINARY_CATEGORY: 2,
    **{category: 1 for category in CRITICAL_CATEGORIES},
}
HUMAN_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
MAX_EVIDENCE_LENGTH = 240
MAX_ERRORS = 50
MAX_DIAGNOSTIC_LENGTH = 240

EXPECTED_FIELDS = {
    "candidate": {
        "candidate-key",
        "category",
        "eligibility-threshold",
        "source-issue",
        "evidence",
    },
    "occurrence": {"candidate-issue", "source-issue", "evidence"},
    "disposition": {"candidate-issue", "disposition", "linked-issue"},
}

UNSAFE_EVIDENCE = {
    "credential or secret": re.compile(
        r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
        r"|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b"
        r"|\bgithub_pat_[A-Za-z0-9_]{20,}\b"
        r"|\b(?:api[_-]?key|secret|password|token)\s*[:=]",
        re.IGNORECASE,
    ),
    "contact PII": re.compile(
        r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"
        r"|\b(?:\+?\d[\d .()-]{7,}\d)\b",
        re.IGNORECASE,
    ),
    "task transcript": re.compile(
        r"(?:^|\s)(?:user|assistant|system)\s*:|task transcript|<\/?(?:user|assistant|system)>",
        re.IGNORECASE,
    ),
    "learner data": re.compile(
        r"\b(?:learner|student)(?:[_ -]?(?:id|name|answer|email))?\s*[:=]",
        re.IGNORECASE,
    ),
    "destructive live reproduction": re.compile(
        r"\brm\s+-rf\b|\bDROP\s+DATABASE\b|\bTRUNCATE\s+TABLE\b"
        r"|\bDELETE\s+FROM\b|\bproduction\b.{0,40}\b(?:delete|destroy|erase)\b",
        re.IGNORECASE,
    ),
    "individual-agent ranking": re.compile(
        r"\bagent\b.{0,40}\b(?:rank|ranking|score|leaderboard|better|worse|best|worst)\b",
        re.IGNORECASE,
    ),
}


class GitHubReadError(RuntimeError):
    pass


class ReadOnlyGitHub:
    """Small gh API adapter whose only permitted HTTP method is GET."""

    def __init__(self, repository: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("repository must use the owner/name form")
        self.repository = repository
        self._comment_cache: dict[int, list[dict[str, Any]]] = {}

    def get(self, endpoint: str, *, paginate: bool = False) -> Any:
        command = [
            "gh",
            "api",
            "--method",
            "GET",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            endpoint,
        ]
        if paginate:
            command.extend(["--paginate", "--slurp"])
        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode != 0:
            detail = " ".join(result.stderr.strip().split())[:MAX_DIAGNOSTIC_LENGTH]
            raise GitHubReadError(f"GitHub GET failed for {endpoint.split('?')[0]}: {detail}")
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise GitHubReadError(
                f"GitHub GET returned invalid JSON for {endpoint.split('?')[0]}: {exc.msg}"
            ) from exc
        if paginate:
            if not isinstance(payload, list):
                raise GitHubReadError("paginated GitHub GET did not return a list of pages")
            if all(isinstance(page, list) for page in payload):
                return [item for page in payload for item in page]
            if all(isinstance(page, dict) for page in payload):
                return payload
            raise GitHubReadError("paginated GitHub GET returned inconsistent page shapes")
        return payload

    def issue(self, number: int) -> dict[str, Any]:
        return self.get(f"/repos/{self.repository}/issues/{number}")

    def comments(self, number: int) -> list[dict[str, Any]]:
        if number not in self._comment_cache:
            self._comment_cache[number] = self.get(
                f"/repos/{self.repository}/issues/{number}/comments?per_page=100",
                paginate=True,
            )
        return self._comment_cache[number]

    def events(self, number: int) -> list[dict[str, Any]]:
        return self.get(
            f"/repos/{self.repository}/issues/{number}/events?per_page=100",
            paginate=True,
        )

    def candidate_numbers(self) -> list[int]:
        triage = self.get(
            f"/repos/{self.repository}/issues?state=all&labels=triage&per_page=100",
            paginate=True,
        )
        query = urllib.parse.urlencode(
            {
                "q": (
                    f'repo:{self.repository} "reflo-improvement-candidate:v1" '
                    "in:comments is:issue"
                ),
                "per_page": "100",
            }
        )
        search_pages = self.get(f"/search/issues?{query}", paginate=True)
        items = [
            item
            for page in search_pages
            if isinstance(page, dict)
            for item in page.get("items", [])
        ]
        numbers = {
            int(issue["number"])
            for issue in items
            if isinstance(issue, dict) and "pull_request" not in issue and "number" in issue
        }
        for issue in triage:
            if not isinstance(issue, dict) or "pull_request" in issue or "number" not in issue:
                continue
            number = int(issue["number"])
            if any(MARKER_PREFIX in (comment.get("body") or "") for comment in self.comments(number)):
                numbers.add(number)
        return sorted(numbers)


@dataclass(frozen=True)
class ParsedMarker:
    kind: str
    fields: dict[str, str]
    comment: dict[str, Any]


@dataclass
class CandidateStatus:
    number: int
    title: str
    key: str = "invalid"
    occurrences: int = 0
    threshold: int = 0
    disposition: str = "pending"
    errors: list[str] = field(default_factory=list)

    @property
    def eligible(self) -> bool:
        return self.threshold > 0 and self.occurrences >= self.threshold

    def output(self) -> str:
        if self.errors:
            eligibility = "invalid"
        else:
            eligibility = "eligible-for-human-triage" if self.eligible else "not-yet-eligible"
        return (
            f"#{self.number} key={self.key} occurrences={self.occurrences} "
            f"eligibility={eligibility} disposition={self.disposition} title={json.dumps(self.title)}"
        )


class Validator:
    def __init__(self, api: ReadOnlyGitHub) -> None:
        self.api = api
        self._issues: dict[int, dict[str, Any]] = {}
        self._events: dict[int, list[dict[str, Any]]] = {}

    def _issue(self, number: int) -> dict[str, Any]:
        if number not in self._issues:
            self._issues[number] = self.api.issue(number)
        return self._issues[number]

    def _issue_events(self, number: int) -> list[dict[str, Any]]:
        if number not in self._events:
            self._events[number] = self.api.events(number)
        return self._events[number]

    @staticmethod
    def _error(status: CandidateStatus, message: str) -> None:
        if len(status.errors) < MAX_ERRORS:
            status.errors.append(message[:MAX_DIAGNOSTIC_LENGTH])

    def _parse_comment(self, status: CandidateStatus, comment: dict[str, Any]) -> list[ParsedMarker]:
        body = comment.get("body") or ""
        matches = list(MARKER.finditer(body))
        if MARKER_PREFIX in body and not matches:
            self._error(status, f"comment {comment.get('id')} has a malformed improvement marker")
            return []
        parsed: list[ParsedMarker] = []
        for match in matches:
            kind, raw_fields = match.groups()
            if body.strip() != match.group(0):
                self._error(
                    status,
                    f"comment {comment.get('id')} must contain exactly one standalone marker",
                )
            fields: dict[str, str] = {}
            malformed = False
            for line in raw_fields.splitlines():
                field_match = FIELD.fullmatch(line)
                if not field_match:
                    malformed = True
                    continue
                name, value = field_match.groups()
                if name in fields:
                    self._error(
                        status,
                        f"comment {comment.get('id')} duplicates field {name}",
                    )
                fields[name] = value
            if malformed:
                self._error(status, f"comment {comment.get('id')} has malformed marker fields")
            expected = EXPECTED_FIELDS[kind]
            if set(fields) != expected:
                missing = sorted(expected - set(fields))
                unexpected = sorted(set(fields) - expected)
                detail = []
                if missing:
                    detail.append(f"missing {','.join(missing)}")
                if unexpected:
                    detail.append(f"unexpected {','.join(unexpected)}")
                self._error(
                    status,
                    f"comment {comment.get('id')} {kind} fields invalid: {'; '.join(detail)}",
                )
            if comment.get("created_at") != comment.get("updated_at"):
                self._error(status, f"comment {comment.get('id')} marker was edited and is mutable")
            parsed.append(ParsedMarker(kind, fields, comment))
        if len(matches) > 1:
            self._error(status, f"comment {comment.get('id')} contains duplicate markers")
        return parsed

    def _validate_evidence(
        self, status: CandidateStatus, marker: ParsedMarker, source_issue: int
    ) -> None:
        evidence = marker.fields.get("evidence", "")
        comment_id = marker.comment.get("id")
        if not (20 <= len(evidence) <= MAX_EVIDENCE_LENGTH):
            self._error(
                status,
                f"comment {comment_id} evidence must be 20-{MAX_EVIDENCE_LENGTH} characters",
            )
        if any(ord(character) < 32 or ord(character) > 126 for character in evidence):
            self._error(status, f"comment {comment_id} evidence must be printable single-line ASCII")
        if "```" in evidence or "`" in evidence:
            self._error(status, f"comment {comment_id} evidence cannot contain code or transcript blocks")
        for label, pattern in UNSAFE_EVIDENCE.items():
            if pattern.search(evidence):
                self._error(status, f"comment {comment_id} contains prohibited {label} evidence")

        if source_issue == status.number:
            self._error(status, f"comment {comment_id} cannot use the candidate as its source issue")
            return
        try:
            issue = self._issue(source_issue)
            events = self._issue_events(source_issue)
        except GitHubReadError:
            self._error(status, f"comment {comment_id} source issue #{source_issue} is inaccessible")
            return
        if "pull_request" in issue:
            self._error(status, f"comment {comment_id} source #{source_issue} is not an issue")
        labels = {
            item.get("name")
            for item in issue.get("labels", [])
            if isinstance(item, dict)
        }
        labels.update(
            event.get("label", {}).get("name")
            for event in events
            if event.get("event") == "labeled" and isinstance(event.get("label"), dict)
        )
        if "work:claimed" not in labels or not any(
            isinstance(label, str) and AGENT_LABEL.fullmatch(label) for label in labels
        ):
            self._error(
                status,
                f"comment {comment_id} source issue #{source_issue} lacks claimed-work attribution",
            )

    def validate_candidate(self, number: int) -> CandidateStatus:
        issue = self._issue(number)
        status = CandidateStatus(number=number, title=issue.get("title") or "")
        comments = self.api.comments(number)
        markers = [
            marker
            for comment in comments
            for marker in self._parse_comment(status, comment)
        ]
        candidate_markers = [marker for marker in markers if marker.kind == "candidate"]
        occurrence_markers = [marker for marker in markers if marker.kind == "occurrence"]
        disposition_markers = [marker for marker in markers if marker.kind == "disposition"]

        if len(candidate_markers) != 1:
            self._error(status, f"candidate #{number} must contain exactly one candidate marker")
            return status
        candidate = candidate_markers[0]
        if not comments or candidate.comment.get("id") != comments[0].get("id"):
            self._error(status, "candidate marker must be the issue's first comment")
        issue_author = issue.get("user", {}).get("login")
        marker_author = candidate.comment.get("user", {}).get("login")
        if not issue_author or issue_author != marker_author:
            self._error(status, "candidate marker must be owned by the issue reporter")

        labels = {
            item.get("name")
            for item in issue.get("labels", [])
            if isinstance(item, dict)
        }
        if "triage" not in labels:
            events = self._issue_events(number)
            if not any(
                event.get("event") == "labeled"
                and event.get("label", {}).get("name") == "triage"
                for event in events
            ):
                self._error(status, "candidate issue has no triage-label history")

        raw_key = candidate.fields.get("candidate-key", "")
        if not KEY.fullmatch(raw_key) or not (3 <= len(raw_key) <= 64):
            self._error(status, "candidate key must be a 3-64 character lowercase kebab-case alias")
        else:
            status.key = raw_key
        category = candidate.fields.get("category", "")
        expected_threshold = CATEGORY_THRESHOLDS.get(category)
        if expected_threshold is None:
            self._error(status, "candidate category is unsupported")
        try:
            threshold = int(candidate.fields.get("eligibility-threshold", ""))
        except ValueError:
            threshold = 0
        status.threshold = threshold
        if expected_threshold is not None and threshold != expected_threshold:
            self._error(
                status,
                f"candidate threshold drift: {category} requires {expected_threshold}, found {threshold}",
            )

        occurrence_sources: set[int] = set()
        for marker in [candidate, *occurrence_markers]:
            if marker.kind == "occurrence":
                try:
                    candidate_issue = int(marker.fields.get("candidate-issue", ""))
                except ValueError:
                    candidate_issue = 0
                if candidate_issue != number:
                    self._error(
                        status,
                        f"comment {marker.comment.get('id')} references candidate #{candidate_issue}, expected #{number}",
                    )
            try:
                source_issue = int(marker.fields.get("source-issue", ""))
            except ValueError:
                source_issue = 0
            if source_issue <= 0:
                self._error(
                    status,
                    f"comment {marker.comment.get('id')} source-issue must be a positive issue number",
                )
                continue
            if source_issue in occurrence_sources:
                self._error(
                    status,
                    f"source issue #{source_issue} is counted by more than one occurrence marker",
                )
            occurrence_sources.add(source_issue)
            self._validate_evidence(status, marker, source_issue)
        status.occurrences = len(occurrence_sources)

        transitions: list[tuple[str, str]] = []
        for marker in disposition_markers:
            comment_id = marker.comment.get("id")
            if marker.comment.get("author_association") not in HUMAN_ASSOCIATIONS:
                self._error(status, f"comment {comment_id} disposition is not maintainer-owned")
            try:
                candidate_issue = int(marker.fields.get("candidate-issue", ""))
            except ValueError:
                candidate_issue = 0
            if candidate_issue != number:
                self._error(
                    status,
                    f"comment {comment_id} disposition references #{candidate_issue}, expected #{number}",
                )
            disposition = marker.fields.get("disposition", "")
            linked_issue = marker.fields.get("linked-issue", "")
            if disposition not in {"promoted", "declined", "implemented"}:
                self._error(status, f"comment {comment_id} has an unsupported disposition")
            if disposition == "declined":
                if linked_issue != "none":
                    self._error(status, f"comment {comment_id} declined disposition must link to none")
            elif not linked_issue.isdigit() or int(linked_issue) == number:
                self._error(
                    status,
                    f"comment {comment_id} {disposition} disposition requires a separate linked issue",
                )
            transitions.append((disposition, linked_issue))

        sequence = [item[0] for item in transitions]
        if sequence not in ([], ["promoted"], ["promoted", "implemented"], ["declined"]):
            self._error(status, "invalid or duplicate disposition sequence")
        if len(transitions) == 2 and transitions[0][1] != transitions[1][1]:
            self._error(status, "promoted and implemented dispositions must reference the same issue")
        if sequence:
            status.disposition = sequence[-1]
        if issue.get("state") == "closed" and status.disposition not in {"declined", "implemented"}:
            self._error(status, "closed candidate requires a declined or implemented human disposition")
        return status

    def validate_many(self, numbers: list[int]) -> list[CandidateStatus]:
        statuses = [self.validate_candidate(number) for number in numbers]
        by_key: dict[str, list[CandidateStatus]] = {}
        for status in statuses:
            if status.key != "invalid":
                by_key.setdefault(status.key, []).append(status)
        for key, matches in by_key.items():
            if len(matches) > 1:
                canonical = ", ".join(f"#{item.number}" for item in matches)
                for status in matches:
                    self._error(status, f"candidate key {key!r} is duplicated across {canonical}")
        return statuses


def print_errors(statuses: list[CandidateStatus]) -> int:
    count = 0
    for status in statuses:
        for message in status.errors:
            if count >= MAX_ERRORS:
                break
            print(f"ERROR: candidate #{status.number}: {message}", file=sys.stderr)
            count += 1
    total = sum(len(status.errors) for status in statuses)
    if total > MAX_ERRORS:
        print(f"ERROR: {total - MAX_ERRORS} additional diagnostic(s) suppressed", file=sys.stderr)
    return total


def repository_from_gh() -> str:
    result = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise GitHubReadError("unable to resolve repository with gh repo view")
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="GitHub repository in owner/name form")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate", help="validate all discoverable candidates")
    search = subparsers.add_parser("search", help="search validated candidates by key or title")
    search.add_argument("query", nargs="?", default="")
    status = subparsers.add_parser("status", help="show one candidate's validated status")
    status.add_argument("issue", type=int)
    args = parser.parse_args()

    try:
        api = ReadOnlyGitHub(args.repo or repository_from_gh())
        validator = Validator(api)
        if args.command == "status":
            numbers = sorted({*api.candidate_numbers(), args.issue})
            statuses = [
                item for item in validator.validate_many(numbers) if item.number == args.issue
            ]
        else:
            statuses = validator.validate_many(api.candidate_numbers())
    except (GitHubReadError, ValueError) as exc:
        print(f"ERROR: {str(exc)[:MAX_DIAGNOSTIC_LENGTH]}", file=sys.stderr)
        return 1

    errors = print_errors(statuses)
    if args.command == "validate":
        if not statuses:
            print("No improvement candidates found.")
        elif not errors:
            print(f"Validated {len(statuses)} improvement candidate(s); GitHub access was read-only.")
    else:
        query = args.query.casefold() if args.command == "search" else ""
        for item in statuses:
            if query and query not in item.key.casefold() and query not in item.title.casefold():
                continue
            print(item.output())
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
