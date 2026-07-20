from __future__ import annotations

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "agent_improvements.py"


FAKE_GH = r'''#!/usr/bin/env python3
import json
import os
import sys
import urllib.parse
from pathlib import Path

state_path = Path(os.environ["FAKE_GH_STATE"])
log_path = Path(os.environ["FAKE_GH_LOG"])
state = json.loads(state_path.read_text())
args = sys.argv[1:]
with log_path.open("a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\n")

if not args or args[0] != "api":
    raise SystemExit(f"only gh api is supported: {args}")
if "--method" not in args or args[args.index("--method") + 1] != "GET":
    raise SystemExit(f"write or implicit GitHub request rejected: {args}")

endpoint = next((value for value in args if value.startswith("/")), None)
if endpoint is None:
    raise SystemExit(f"missing endpoint: {args}")
path, _, query = endpoint.partition("?")
parts = path.strip("/").split("/")

def issue(number):
    return state["issues"][str(number)]

def paginated(items):
    print(json.dumps([items] if "--slurp" in args else items))

if path == "/search/issues":
    items = [
        value for value in state["issues"].values()
        if any(
            "reflo-improvement-candidate:v1" in comment.get("body", "")
            for comment in value.get("comments", [])
        )
    ]
    payload = {"total_count": len(items), "items": items}
    print(json.dumps([payload] if "--slurp" in args else payload))
    sys.exit(0)

if len(parts) == 4 and parts[:3] == ["repos", "deepessh", "reflo-learning"] and parts[3] == "issues":
    values = [
        value for value in state["issues"].values()
        if any(label.get("name") == "triage" for label in value.get("labels", []))
    ]
    paginated(values)
    sys.exit(0)

if len(parts) >= 5 and parts[:4] == ["repos", "deepessh", "reflo-learning", "issues"]:
    number = int(parts[4])
    value = issue(number)
    if len(parts) == 5:
        print(json.dumps(value))
        sys.exit(0)
    if parts[5] == "comments":
        paginated(value.get("comments", []))
        sys.exit(0)
    if parts[5] == "events":
        paginated(value.get("events", []))
        sys.exit(0)

raise SystemExit(f"unsupported endpoint: {endpoint}")
'''


def marker_comment(
    identifier: int,
    body: str,
    *,
    author: str = "reporter",
    association: str = "CONTRIBUTOR",
    edited: bool = False,
) -> dict[str, object]:
    return {
        "id": identifier,
        "body": textwrap.dedent(body).strip(),
        "user": {"login": author},
        "author_association": association,
        "created_at": "2026-07-20T00:00:00Z",
        "updated_at": "2026-07-20T00:01:00Z" if edited else "2026-07-20T00:00:00Z",
    }


def issue(
    number: int,
    *,
    title: str | None = None,
    author: str = "reporter",
    labels: list[str] | None = None,
    comments: list[dict[str, object]] | None = None,
    events: list[dict[str, object]] | None = None,
    state: str = "open",
) -> dict[str, object]:
    return {
        "number": number,
        "title": title or f"Issue {number}",
        "html_url": f"https://github.com/deepessh/reflo-learning/issues/{number}",
        "user": {"login": author},
        "author_association": "CONTRIBUTOR",
        "labels": [{"name": label} for label in labels or []],
        "comments": comments or [],
        "events": events or [],
        "state": state,
        "milestone": None,
    }


def claimed_source(number: int) -> dict[str, object]:
    return issue(
        number,
        events=[
            {"event": "labeled", "label": {"name": "work:claimed"}},
            {"event": "labeled", "label": {"name": "agent:wt-0123456789abcdefabcd"}},
        ],
    )


def candidate_marker(
    key: str,
    source: int,
    *,
    category: str = "ordinary",
    threshold: int = 2,
    evidence: str = "The same contributor workflow gap appeared during this claimed task.",
) -> str:
    return f"""\
    <!-- reflo-improvement-candidate:v1
    candidate-key: {key}
    category: {category}
    eligibility-threshold: {threshold}
    source-issue: {source}
    evidence: {evidence}
    -->"""


def occurrence_marker(candidate: int, source: int, *, evidence: str | None = None) -> str:
    summary = evidence or "The independent claimed task reproduced the same contributor workflow gap."
    return f"""\
    <!-- reflo-improvement-occurrence:v1
    candidate-issue: {candidate}
    source-issue: {source}
    evidence: {summary}
    -->"""


def disposition_marker(candidate: int, disposition: str, linked: str) -> str:
    return f"""\
    <!-- reflo-improvement-disposition:v1
    candidate-issue: {candidate}
    disposition: {disposition}
    linked-issue: {linked}
    -->"""


class AgentImprovementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.bin_directory = self.directory / "bin"
        self.bin_directory.mkdir()
        fake = self.bin_directory / "gh"
        fake.write_text(textwrap.dedent(FAKE_GH), encoding="utf-8")
        fake.chmod(0o755)
        self.state_path = self.directory / "state.json"
        self.log_path = self.directory / "gh.log"
        self.env = os.environ.copy()
        self.env.update(
            {
                "PATH": f"{self.bin_directory}:{self.env['PATH']}",
                "FAKE_GH_STATE": str(self.state_path),
                "FAKE_GH_LOG": str(self.log_path),
            }
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_state(self, *issues: dict[str, object]) -> None:
        self.state_path.write_text(
            json.dumps({"issues": {str(item["number"]): item for item in issues}}),
            encoding="utf-8",
        )
        self.log_path.write_text("", encoding="utf-8")

    def run_helper(self, command: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3",
                str(HELPER),
                "--repo",
                "deepessh/reflo-learning",
                command,
                *args,
            ],
            cwd=ROOT,
            env=self.env,
            text=True,
            capture_output=True,
        )

    def assert_read_only(self) -> None:
        calls = [json.loads(line) for line in self.log_path.read_text().splitlines()]
        self.assertTrue(calls)
        for call in calls:
            self.assertEqual("api", call[0])
            self.assertIn("--method", call)
            self.assertEqual("GET", call[call.index("--method") + 1])
            self.assertFalse({"POST", "PATCH", "PUT", "DELETE"} & set(call))

    def test_ordinary_candidate_counts_distinct_claimed_issues_and_is_read_only(self) -> None:
        candidate = issue(
            100,
            title="Keep governance helpers deterministic",
            labels=["triage"],
            comments=[
                marker_comment(1, candidate_marker("deterministic-governance", 42)),
                marker_comment(2, occurrence_marker(100, 57), author="observer"),
            ],
        )
        self.write_state(candidate, claimed_source(42), claimed_source(57))

        result = self.run_helper("search", "governance")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("#100 key=deterministic-governance occurrences=2", result.stdout)
        self.assertIn("eligibility=eligible-for-human-triage", result.stdout)
        self.assertIn("disposition=pending", result.stdout)
        self.assert_read_only()

    def test_critical_candidate_is_eligible_once_and_reports_human_disposition(self) -> None:
        candidate = issue(
            101,
            labels=["triage"],
            state="closed",
            comments=[
                marker_comment(
                    1,
                    candidate_marker(
                        "release-guard",
                        43,
                        category="release-governance",
                        threshold=1,
                    ),
                ),
                marker_comment(
                    2,
                    disposition_marker(101, "promoted", "110"),
                    author="maintainer",
                    association="OWNER",
                ),
                marker_comment(
                    3,
                    disposition_marker(101, "implemented", "110"),
                    author="maintainer",
                    association="OWNER",
                ),
            ],
        )
        self.write_state(candidate, claimed_source(43))

        result = self.run_helper("status", "101")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("occurrences=1", result.stdout)
        self.assertIn("eligibility=eligible-for-human-triage", result.stdout)
        self.assertIn("disposition=implemented", result.stdout)
        self.assert_read_only()

    def test_duplicate_source_unsafe_evidence_and_unclaimed_source_fail_safely(self) -> None:
        secret = "ghp_abcdefghijklmnopqrstuvwxyz123456"
        candidate = issue(
            102,
            labels=["triage"],
            comments=[
                marker_comment(
                    1,
                    candidate_marker(
                        "unsafe-duplicate",
                        44,
                        evidence=f"The task exposed token={secret} while reproducing the workflow gap.",
                    ),
                ),
                marker_comment(2, occurrence_marker(102, 44), author="observer"),
                marker_comment(3, occurrence_marker(102, 45), author="observer"),
            ],
        )
        self.write_state(candidate, claimed_source(44), issue(45))

        result = self.run_helper("validate")

        self.assertNotEqual(0, result.returncode)
        self.assertIn("prohibited credential or secret evidence", result.stderr)
        self.assertIn("counted by more than one occurrence marker", result.stderr)
        self.assertIn("lacks claimed-work attribution", result.stderr)
        self.assertNotIn(secret, result.stderr)
        self.assertLessEqual(max(map(len, result.stderr.splitlines())), 260)
        self.assert_read_only()

    def test_mutable_identity_missing_source_and_threshold_drift_fail(self) -> None:
        malformed = """\
        <!-- reflo-improvement-candidate:v1
        candidate-key: mutable-key
        category: ordinary
        eligibility-threshold: 1
        evidence: The claimed task showed a reusable contributor workflow problem.
        -->"""
        candidate = issue(
            103,
            labels=["triage"],
            comments=[marker_comment(1, malformed, edited=True)],
        )
        self.write_state(candidate)

        result = self.run_helper("status", "103")

        self.assertNotEqual(0, result.returncode)
        self.assertIn("missing source-issue", result.stderr)
        self.assertIn("marker was edited and is mutable", result.stderr)
        self.assertIn("candidate threshold drift", result.stderr)
        self.assert_read_only()

    def test_duplicate_candidate_aliases_and_nonhuman_disposition_fail(self) -> None:
        first = issue(
            104,
            labels=["triage"],
            comments=[
                marker_comment(1, candidate_marker("duplicate-alias", 46)),
                marker_comment(
                    2,
                    disposition_marker(104, "declined", "none"),
                    author="automation",
                    association="CONTRIBUTOR",
                ),
            ],
        )
        second = issue(
            105,
            labels=["triage"],
            comments=[marker_comment(3, candidate_marker("duplicate-alias", 47))],
        )
        self.write_state(first, second, claimed_source(46), claimed_source(47))

        result = self.run_helper("validate")

        self.assertNotEqual(0, result.returncode)
        self.assertIn("duplicated across #104, #105", result.stderr)
        self.assertIn("disposition is not maintainer-owned", result.stderr)
        self.assert_read_only()

    def test_protocol_preserves_existing_authority_and_runs_in_required_ci(self) -> None:
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        package = (ROOT / "package.json").read_text(encoding="utf-8")
        workflow = (ROOT / ".github" / "workflows" / "validate-decisions.yml").read_text(
            encoding="utf-8"
        )

        for route in ("bug", "tech-debt", "blocked", "needs-human", "decision"):
            self.assertIn(f"`{route}`", agents)
        self.assertIn("Humans alone disposition or promote candidates", agents)
        self.assertIn("eligibility", agents)
        self.assertIn("scripts/test_agent_improvements.py", package)
        self.assertIn("scripts/test_agent_improvements.py", workflow)

    def test_unrelated_triage_issues_are_not_treated_as_candidates(self) -> None:
        self.write_state(issue(106, labels=["triage"], comments=[]))

        result = self.run_helper("validate")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("No improvement candidates found.", result.stdout)
        self.assert_read_only()


if __name__ == "__main__":
    unittest.main()
