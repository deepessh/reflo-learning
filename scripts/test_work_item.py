from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "work-item.sh"


FAKE_GH = r'''#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from pathlib import Path

state_path = Path(os.environ["FAKE_GH_STATE"])
state = json.loads(state_path.read_text())
args = sys.argv[1:]

def save():
    state_path.write_text(json.dumps(state))

def issue_object(issue):
    return {
        "number": issue["number"],
        "title": issue["title"],
        "url": issue["url"],
        "state": issue["state"],
        "body": issue.get("body", ""),
        "assignees": [{"login": name} for name in issue.get("assignees", [])],
        "labels": [{"name": name} for name in issue.get("labels", [])],
        "comments": issue.get("comments", []),
    }

def get_issue(number):
    return state["issues"][str(number)]

def option(name, default=None):
    if name not in args:
        return default
    index = args.index(name)
    return args[index + 1]

if args == ["--version"]:
    print("gh version fake")
    sys.exit(0)

if args[:2] == ["auth", "status"]:
    sys.exit(0)

if args[:2] == ["repo", "view"]:
    print(state.get("repo", "deepessh/reflo-learning"))
    sys.exit(0)

if args[:2] == ["label", "list"]:
    print(json.dumps([{"name": item["name"]} for item in state.get("labels", [])]))
    sys.exit(0)

if args[:2] == ["label", "create"]:
    name = args[2]
    if any(item["name"] == name for item in state.get("labels", [])):
        sys.exit(1)
    state.setdefault("labels", []).append({
        "name": name,
        "color": option("--color"),
        "description": option("--description"),
    })
    save()
    sys.exit(0)

if args[:2] == ["issue", "list"]:
    wanted_state = option("--state", "open").upper()
    wanted_label = option("--label")
    wanted_milestone = option("--milestone")
    result = []
    for issue in state["issues"].values():
        if wanted_state != "ALL" and issue["state"] != wanted_state:
            continue
        if wanted_label and wanted_label not in issue.get("labels", []):
            continue
        if wanted_milestone and issue.get("milestone") != wanted_milestone:
            continue
        result.append(issue_object(issue))
    print(json.dumps(sorted(result, key=lambda value: value["number"], reverse=True)))
    sys.exit(0)

if args[:2] == ["issue", "view"]:
    issue = get_issue(args[2])
    if "--jq" in args:
        expression = option("--jq")
        if expression == ".state":
            print(issue["state"])
            sys.exit(0)
        raise SystemExit(f"unsupported fake jq expression: {expression}")
    print(json.dumps(issue_object(issue)))
    sys.exit(0)

if args[:2] == ["issue", "comment"]:
    issue = get_issue(args[2])
    body = option("--body")
    state["next_comment_id"] = state.get("next_comment_id", 0) + 1
    issue.setdefault("comments", []).append({
        "id": state["next_comment_id"],
        "body": body,
        "created_at": f"2026-07-19T00:00:{state['next_comment_id']:02d}Z",
    })
    save()
    print(issue["url"] + "#comment")
    sys.exit(0)

if args[:2] == ["issue", "edit"]:
    issue = get_issue(args[2])
    label = option("--remove-label")
    failure = state.get("fail_remove_label_once")
    if failure == label and not state.get("remove_failure_used"):
        state["remove_failure_used"] = True
        save()
        sys.exit(1)
    if label in issue.get("labels", []):
        issue["labels"].remove(label)
        state["next_event_id"] = state.get("next_event_id", 0) + 1
        issue.setdefault("events", []).append({
            "id": state["next_event_id"],
            "event": "unlabeled",
            "created_at": f"2026-07-19T00:01:{state['next_event_id']:02d}Z",
            "label": {"name": label},
        })
    save()
    print(issue["url"])
    sys.exit(0)

if args and args[0] == "api":
    endpoint = args[1]
    if endpoint == "user":
        print(state.get("user", "deepessh"))
        sys.exit(0)
    match = re.search(r"issues/(\d+)/(labels|events|comments)", endpoint)
    if not match:
        raise SystemExit(f"unsupported fake endpoint: {endpoint}")
    issue = get_issue(match.group(1))
    resource = match.group(2)
    if resource == "labels":
        injected = state.get("inject_collision")
        if injected and not state.get("collision_used"):
            other = injected["label"]
            if other not in issue.get("labels", []):
                issue.setdefault("labels", []).append(other)
                state["next_event_id"] = state.get("next_event_id", 0) + 1
                issue.setdefault("events", []).append({
                    "id": state["next_event_id"],
                    "event": "labeled",
                    "created_at": "2026-07-19T00:00:01Z",
                    "label": {"name": other},
                })
            state["collision_used"] = True
        additions = [value.split("=", 1)[1] for value in args if value.startswith("labels[]=")]
        for label in additions:
            if label not in issue.get("labels", []):
                issue.setdefault("labels", []).append(label)
                state["next_event_id"] = state.get("next_event_id", 0) + 1
                issue.setdefault("events", []).append({
                    "id": state["next_event_id"],
                    "event": "labeled",
                    "created_at": f"2026-07-19T00:00:{state['next_event_id'] + 1:02d}Z",
                    "label": {"name": label},
                })
        save()
        if "--silent" not in args:
            print(json.dumps([{"name": name} for name in issue.get("labels", [])]))
        sys.exit(0)
    if resource == "events":
        print(json.dumps([issue.get("events", [])]))
        sys.exit(0)
    if resource == "comments":
        print(json.dumps([issue.get("comments", [])]))
        sys.exit(0)

raise SystemExit(f"unsupported fake gh invocation: {args}")
'''


def issue(
    number: int,
    *,
    state: str = "OPEN",
    milestone: str = "W1",
    body: str = "",
    labels: list[str] | None = None,
    assignees: list[str] | None = None,
) -> dict[str, object]:
    return {
        "number": number,
        "title": f"Issue {number}",
        "url": f"https://github.com/deepessh/reflo-learning/issues/{number}",
        "state": state,
        "milestone": milestone,
        "body": body,
        "labels": labels or [],
        "assignees": assignees or [],
        "comments": [],
        "events": [],
    }


class WorkItemTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.worktree = Path(self.temp.name) / "repo"
        self.bin_dir = Path(self.temp.name) / "bin"
        self.worktree.mkdir()
        self.bin_dir.mkdir()
        subprocess.run(["git", "init", "-q", str(self.worktree)], check=True)
        scripts = self.worktree / "scripts"
        scripts.mkdir()
        shutil.copy2(HELPER, scripts / "work-item.sh")
        fake = self.bin_dir / "gh"
        fake.write_text(textwrap.dedent(FAKE_GH), encoding="utf-8")
        fake.chmod(0o755)
        self.state_path = Path(self.temp.name) / "state.json"
        self.env = os.environ.copy()
        self.env.update(
            {
                "PATH": f"{self.bin_dir}:{self.env['PATH']}",
                "FAKE_GH_STATE": str(self.state_path),
                "REFLO_WORK_ITEM_TODAY": "2026-07-19",
                "CODEX_THREAD_ID": "019f77a9-762f-7c10-ae47-aee191d5684f",
            }
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_state(self, *issues: dict[str, object], **extra: object) -> None:
        state: dict[str, object] = {
            "repo": "deepessh/reflo-learning",
            "user": "deepessh",
            "labels": [],
            "issues": {str(item["number"]): item for item in issues},
            "next_event_id": 0,
            "next_comment_id": 0,
        }
        state.update(extra)
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

    def read_state(self) -> dict[str, object]:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def run_helper(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["bash", "scripts/work-item.sh", *args],
            cwd=self.worktree,
            env=self.env,
            text=True,
            capture_output=True,
        )
        if check and result.returncode != 0:
            self.fail(f"helper failed ({result.returncode}):\nstdout={result.stdout}\nstderr={result.stderr}")
        return result

    def identity_label(self) -> str:
        value = (self.worktree / ".reflo" / "identity").read_text().strip()
        self.assertRegex(value, r"^agent:wt-[0-9a-f]{20}$")
        return value

    def test_pick_prefers_ready_p0_and_recovers_existing_claim(self) -> None:
        self.write_state(
            issue(1, labels=["p1"]),
            issue(2, body="Depends on: #3"),
            issue(3, state="CLOSED"),
            issue(4, body="Depends on: #5"),
            issue(5),
            issue(6, assignees=["deepessh"]),
        )
        first = self.run_helper("pick")
        self.assertIn("Claimed #2", first.stdout)
        label = self.identity_label()
        state = self.read_state()
        self.assertEqual(["work:claimed", label], state["issues"]["2"]["labels"])
        (self.worktree / ".reflo" / "current-issue").unlink()

        second = self.run_helper("pick")
        self.assertIn("Existing claim #2", second.stdout)
        self.assertEqual("2", (self.worktree / ".reflo" / "current-issue").read_text().strip())

    def test_pick_skips_malformed_dependencies_and_falls_back_to_p1(self) -> None:
        self.write_state(
            issue(1, body="Depends on #9"),
            issue(2, labels=["blocked"]),
            issue(3, labels=["needs-human"]),
            issue(4, labels=["p1"]),
        )
        result = self.run_helper("pick")
        self.assertIn("Claimed #4", result.stdout)

    def test_cross_worktree_collision_loser_retries(self) -> None:
        other = "agent:wt-aaaaaaaaaaaaaaaaaaaa"
        self.write_state(
            issue(1),
            issue(2),
            inject_collision={"label": other},
            labels=[{"name": other, "color": "C5DEF5", "description": "other"}],
        )
        result = self.run_helper("pick")
        self.assertIn("Claimed #2", result.stdout)
        label = self.identity_label()
        state = self.read_state()
        self.assertIn(other, state["issues"]["1"]["labels"])
        self.assertNotIn(label, state["issues"]["1"]["labels"])
        self.assertIn(label, state["issues"]["2"]["labels"])

    def test_release_is_retry_safe_and_attributes_thread(self) -> None:
        self.write_state(issue(1), fail_remove_label_once="agent-placeholder")
        self.run_helper("pick")
        label = self.identity_label()
        state = self.read_state()
        state["fail_remove_label_once"] = label
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        first = self.run_helper("release", "--handoff", "Done; next step is review.", check=False)
        self.assertNotEqual(0, first.returncode)
        state = self.read_state()
        self.assertEqual(1, len(state["issues"]["1"]["comments"]))
        self.assertIn("Codex-Thread-ID: 019f77a9-762f-7c10-ae47-aee191d5684f", state["issues"]["1"]["comments"][0]["body"])
        self.assertNotIn("work:claimed", state["issues"]["1"]["labels"])
        self.assertIn(label, state["issues"]["1"]["labels"])

        second = self.run_helper("release", "--handoff", "Done; next step is review.")
        self.assertIn("Released #1", second.stdout)
        state = self.read_state()
        self.assertEqual(1, len(state["issues"]["1"]["comments"]))
        self.assertEqual([], state["issues"]["1"]["labels"])
        self.assertFalse((self.worktree / ".reflo" / "current-issue").exists())

        self.run_helper("pick")
        self.run_helper("release", "--handoff", "Done; next step is review.")
        state = self.read_state()
        self.assertEqual(2, len(state["issues"]["1"]["comments"]))

    def test_active_local_lock_blocks_pick(self) -> None:
        self.write_state(issue(1))
        lock = self.worktree / ".reflo" / "work-item.lock"
        lock.mkdir(parents=True)
        (lock / "pid").write_text(str(os.getpid()), encoding="utf-8")
        result = self.run_helper("pick", check=False)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("another work-item operation is active", result.stderr)

    def test_outside_sprint_dates_fails_without_claiming(self) -> None:
        self.write_state(issue(1))
        self.env["REFLO_WORK_ITEM_TODAY"] = "2026-08-08"
        result = self.run_helper("pick", check=False)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("no active sprint milestone", result.stderr)
        self.assertEqual([], self.read_state()["issues"]["1"]["labels"])


if __name__ == "__main__":
    unittest.main()
