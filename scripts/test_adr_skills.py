from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ALLOCATE = ROOT / "skills/writing-adrs/scripts/allocate_adr_number.py"
RENUMBER = ROOT / "skills/renumber-adr/scripts/renumber_adr.py"
FIXTURES = ROOT / "scripts/fixtures/adr-skills"


def run(command: list[str], root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=root,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def git(root: Path, *arguments: str) -> str:
    result = run(["git", *arguments], root)
    if result.returncode:
        raise AssertionError(
            f"git {' '.join(arguments)} failed:\n{result.stdout}\n{result.stderr}"
        )
    return result.stdout


def adr(canonical_id: str, title: str, *, supersedes: str = "[]") -> str:
    return f"""---
id: "{canonical_id}"
title: {title}
status: Accepted
supersedes: {supersedes}
superseded_by: null
---

# ADR {canonical_id}: {title}

## Context

Fixture context.
"""


class RepositoryFixture:
    def __init__(
        self,
        *,
        target_adrs: dict[str, str] | None = None,
        target_aliases: dict[str, str] | None = None,
    ) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="reflo-adr-skills-")
        self.root = Path(self.temporary.name)
        (self.root / "docs/adrs").mkdir(parents=True)
        (self.root / "docs/adrs/README.md").write_text("Fixture ADRs.\n", encoding="utf-8")
        self.write_config(target_aliases or {"D-GH-1": "0001"})
        for name, source in (target_adrs or {}).items():
            (self.root / "docs/adrs" / name).write_text(source, encoding="utf-8")
        git(self.root, "init", "-b", "main")
        git(self.root, "config", "user.email", "fixture@example.com")
        git(self.root, "config", "user.name", "Fixture")
        git(self.root, "add", ".")
        git(self.root, "commit", "-m", "target")
        git(self.root, "switch", "-c", "feature")

    def close(self) -> None:
        self.temporary.cleanup()

    def write_config(self, aliases: dict[str, str]) -> None:
        lines = [
            "schema_version: 1",
            "mode: partial-mirror",
            "baseline_complete: false",
            "adr_directory: docs/adrs",
            "register: DECISIONS.md",
            "managed_prd_mandates: []",
            "partial_mirror_exemptions: []",
            "legacy_ids:",
        ]
        lines.extend(f'  {alias}: "{canonical_id}"' for alias, canonical_id in aliases.items())
        (self.root / ".adr-governance.yaml").write_text(
            "\n".join(lines) + "\n",
            encoding="utf-8",
        )

    def add_adr(self, name: str, source: str) -> None:
        (self.root / "docs/adrs" / name).write_text(source, encoding="utf-8")

    def commit(self, message: str = "draft") -> None:
        git(self.root, "add", ".")
        git(self.root, "commit", "-m", message)


class AdrSkillScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repositories: list[RepositoryFixture] = []

    def tearDown(self) -> None:
        for repository in self.repositories:
            repository.close()

    def repository(self, **kwargs) -> RepositoryFixture:
        value = RepositoryFixture(**kwargs)
        self.repositories.append(value)
        return value

    def execute(
        self,
        script: Path,
        repository: RepositoryFixture,
        fixture: str,
        *arguments: str,
    ) -> subprocess.CompletedProcess[str]:
        return run(
            [
                sys.executable,
                str(script),
                "--root",
                str(repository.root),
                "--target-ref",
                "main",
                "--base-branch",
                "main",
                "--github-fixture",
                str(FIXTURES / fixture),
                *arguments,
            ],
            repository.root,
        )

    def test_allocator_counts_reserved_target_local_and_open_pr_ids(self) -> None:
        repository = self.repository(
            target_adrs={"0002-target.md": adr("0002", "Target")}
        )
        repository.add_adr("0003-local.md", adr("0003", "Local"))
        repository.commit()

        result = self.execute(
            ALLOCATE,
            repository,
            "allocation-inventory.json",
            "--json",
        )

        self.assertEqual(0, result.returncode, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual("0005", report["allocated_id"])
        self.assertEqual(["0001", "0002", "0003", "0004"], report["used_ids"])

    def test_allocator_fails_closed_on_duplicate_local_claims(self) -> None:
        repository = self.repository()
        repository.add_adr("0002-first.md", adr("0002", "First"))
        repository.add_adr("0002-second.md", adr("0002", "Second"))
        repository.commit()

        result = self.execute(ALLOCATE, repository, "clear.json")

        self.assertEqual(1, result.returncode)
        self.assertIn("new local ADR paths claims ADR 0002", result.stderr)

    def test_allocator_fails_closed_on_target_collision(self) -> None:
        repository = self.repository(
            target_adrs={"0001-accepted.md": adr("0001", "Accepted")}
        )
        repository.add_adr("0001-local-draft.md", adr("0001", "Local draft"))
        repository.commit()

        result = self.execute(ALLOCATE, repository, "clear.json")

        self.assertEqual(1, result.returncode)
        self.assertIn("ADR 0001 is claimed by", result.stderr)
        self.assertIn("target:docs/adrs/0001-accepted.md", result.stderr)
        self.assertIn("local:docs/adrs/0001-local-draft.md", result.stderr)

    def test_allocator_fails_closed_on_open_pr_collision(self) -> None:
        repository = self.repository()
        repository.add_adr("0002-local-draft.md", adr("0002", "Local draft"))
        repository.commit()

        result = self.execute(ALLOCATE, repository, "open-pr-collision.json")

        self.assertEqual(1, result.returncode)
        self.assertIn("pr#21:docs/adrs/0002-other-draft.md", result.stderr)

    def test_allocator_refuses_a_merged_current_pr(self) -> None:
        repository = self.repository()

        result = self.execute(ALLOCATE, repository, "merged-current-pr.json")

        self.assertEqual(1, result.returncode)
        self.assertIn("permitted only for an unmerged branch", result.stderr)

    def test_renumber_updates_target_collision_without_touching_history(self) -> None:
        accepted_source = adr("0001", "Accepted")
        repository = self.repository(
            target_adrs={"0001-accepted.md": accepted_source},
            target_aliases={"D-GH-1": "0001"},
        )
        repository.add_adr("0001-local-draft.md", adr("0001", "Local draft"))
        repository.write_config({"D-GH-1": "0001", "D-GH-99": "0001"})
        (repository.root / "docs/index.md").write_text(
            "| ADR | File |\n"
            "| --- | --- |\n"
            "| ADR 0001 | [draft](adrs/0001-local-draft.md) |\n",
            encoding="utf-8",
        )
        migration = repository.root / "packages/db/migrations/0001_history.sql"
        migration.parent.mkdir(parents=True)
        migration_source = "-- historical ADR 0001 in 0001-local-draft.md\n"
        migration.write_text(migration_source, encoding="utf-8")
        repository.commit()

        result = self.execute(RENUMBER, repository, "clear.json", "--apply")

        self.assertEqual(0, result.returncode, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual("0002", report["renumbers"][0]["new_id"])
        self.assertFalse((repository.root / "docs/adrs/0001-local-draft.md").exists())
        draft = repository.root / "docs/adrs/0002-local-draft.md"
        self.assertTrue(draft.exists())
        self.assertIn('id: "0002"', draft.read_text(encoding="utf-8"))
        self.assertIn("# ADR 0002: Local draft", draft.read_text(encoding="utf-8"))
        self.assertEqual(
            accepted_source,
            (repository.root / "docs/adrs/0001-accepted.md").read_text(encoding="utf-8"),
        )
        self.assertEqual(
            "| ADR | File |\n"
            "| --- | --- |\n"
            "| ADR 0002 | [draft](adrs/0002-local-draft.md) |\n",
            (repository.root / "docs/index.md").read_text(encoding="utf-8"),
        )
        config = (repository.root / ".adr-governance.yaml").read_text(encoding="utf-8")
        self.assertIn('D-GH-1: "0001"', config)
        self.assertIn('D-GH-99: "0002"', config)
        self.assertEqual(migration_source, migration.read_text(encoding="utf-8"))
        self.assertIn(
            "packages/db/migrations/0001_history.sql",
            report["protected_references_left_unchanged"],
        )

    def test_renumber_updates_open_pr_collision_and_draft_supersession(self) -> None:
        repository = self.repository()
        repository.add_adr("0002-local-draft.md", adr("0002", "Local draft"))
        repository.add_adr(
            "0004-related-draft.md",
            adr("0004", "Related draft", supersedes='["0002"]'),
        )
        repository.write_config(
            {"D-GH-1": "0001", "D-GH-2": "0002", "D-GH-4": "0004"}
        )
        repository.commit()

        result = self.execute(
            RENUMBER,
            repository,
            "open-pr-collision.json",
            "--apply",
        )

        self.assertEqual(0, result.returncode, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual("0003", report["renumbers"][0]["new_id"])
        related = (repository.root / "docs/adrs/0004-related-draft.md").read_text(
            encoding="utf-8"
        )
        self.assertIn('supersedes: ["0003"]', related)
        config = (repository.root / ".adr-governance.yaml").read_text(encoding="utf-8")
        self.assertIn('D-GH-2: "0003"', config)
        self.assertTrue((repository.root / "docs/adrs/0003-local-draft.md").exists())

    def test_renumber_refuses_a_merged_current_pr(self) -> None:
        repository = self.repository()
        repository.add_adr("0002-local-draft.md", adr("0002", "Local draft"))
        repository.commit()
        before = git(repository.root, "status", "--short")

        result = self.execute(
            RENUMBER,
            repository,
            "merged-current-pr.json",
            "--apply",
        )

        self.assertEqual(1, result.returncode)
        self.assertIn("permitted only for an unmerged branch", result.stderr)
        self.assertEqual(before, git(repository.root, "status", "--short"))
        self.assertTrue((repository.root / "docs/adrs/0002-local-draft.md").exists())

    def test_renumber_never_selects_a_merged_accepted_adr(self) -> None:
        accepted_source = adr("0001", "Accepted")
        repository = self.repository(
            target_adrs={"0001-accepted.md": accepted_source}
        )

        result = self.execute(RENUMBER, repository, "clear.json", "--apply")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("No unmerged ADR drafts", result.stdout)
        self.assertEqual(
            accepted_source,
            (repository.root / "docs/adrs/0001-accepted.md").read_text(encoding="utf-8"),
        )


if __name__ == "__main__":
    unittest.main()
