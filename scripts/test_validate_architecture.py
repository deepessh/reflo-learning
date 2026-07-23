from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import validate_architecture as validator  # noqa: E402


def adr_source(
    canonical_id: str,
    *,
    title: str,
    status: str = "Accepted",
    superseded_by: str = "null",
    deprecation: str = "null",
) -> str:
    return f"""---
id: "{canonical_id}"
title: "{title}"
status: {status}
date: "2026-07-22"
aliases: [D-GH-{int(canonical_id)}]
prd_references: "`prds/reflo-prd.md` §9"
ownership: {{}}
authorization: {{}}
provenance:
  kind: github-decision
supersedes: []
superseded_by: {superseded_by}
deprecation: {deprecation}
maintenance: []
---

# ADR {canonical_id}: {title}
"""


class Fixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="reflo-architecture-")
        self.root = Path(self.temporary.name)
        for directory in (
            "docs/adrs",
            "docs/problems",
            "packages/example/src",
        ):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        (self.root / ".adr-governance.yaml").write_text(
            "schema_version: 1\n"
            "mode: complete-mirror\n"
            "adr_directory: docs/adrs\n",
            encoding="utf-8",
        )
        self.write_adr("0001", "Active fixture")
        self.write_adr(
            "0002",
            "Superseded fixture",
            status="Superseded",
            superseded_by='"0001"',
        )
        (self.root / "docs/problems/durable-problem.md").write_text(
            "# Durable problem\n", encoding="utf-8"
        )
        (self.root / "packages/example/src/index.ts").write_text(
            "export const fixture = true;\n", encoding="utf-8"
        )

    def close(self) -> None:
        self.temporary.cleanup()

    def write_adr(self, canonical_id: str, title: str, **kwargs: str) -> None:
        name = f"{canonical_id}-{title.lower().replace(' ', '-')}.md"
        (self.root / "docs/adrs" / name).write_text(
            adr_source(canonical_id, title=title, **kwargs), encoding="utf-8"
        )

    def valid_architecture(self) -> str:
        records_errors: list[str] = []
        config = validator.read_config(self.root, records_errors)
        records = validator.active_adrs(self.root, config, records_errors)
        self.assert_no_errors(records_errors)
        table = validator.render_active_table(config, records)
        return f"""# Reflo architecture

> {validator.NON_AUTHORITATIVE_NOTICE} Its linked sources retain authority.

{validator.TARGET_HEADING}

{validator.TARGET_NOTICE}

{validator.TARGET_START}
{table}
{validator.TARGET_END}

{validator.IMPLEMENTED_HEADING}

{validator.IMPLEMENTED_NOTICE}

{validator.IMPLEMENTED_START}
{validator.IMPLEMENTED_HEADER}
{validator.IMPLEMENTED_SEPARATOR}
| Example package slice | [source](../packages/example/src/index.ts) | [ADR 0001](adrs/0001-active-fixture.md) |
{validator.IMPLEMENTED_END}

{validator.REVIEW_BOUNDARY}

{validator.PROBLEMS_HEADING}

- [Durable problem](problems/durable-problem.md)
"""

    def assert_no_errors(self, errors: list[str]) -> None:
        if errors:
            raise AssertionError("\n".join(errors))

    def write_architecture(self, source: str | None = None) -> None:
        (self.root / "docs/architecture.md").write_text(
            source if source is not None else self.valid_architecture(),
            encoding="utf-8",
        )

    def errors(self) -> str:
        return "\n".join(validator.validate_repository(self.root))


class ArchitectureValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_accepts_separate_target_and_evidence_views(self) -> None:
        self.fixture.write_architecture()
        self.assertEqual("", self.fixture.errors())

    def test_rejects_stale_generated_rows_and_missing_active_reference(self) -> None:
        source = self.fixture.valid_architecture().replace(
            "| [ADR 0001]", "| [ADR 9999]"
        )
        self.fixture.write_architecture(source)
        self.assertIn("active-ADR table is stale", self.fixture.errors())

    def test_requires_structurally_separate_non_authoritative_views(self) -> None:
        source = (
            self.fixture.valid_architecture()
            .replace(validator.NON_AUTHORITATIVE_NOTICE, "Architecture status")
            .replace(validator.IMPLEMENTED_HEADING, "## Repository notes")
        )
        self.fixture.write_architecture(source)
        errors = self.fixture.errors()
        self.assertIn("missing required non-authoritative notice", errors)
        self.assertIn(
            f"requires exactly one {validator.IMPLEMENTED_HEADING!r}", errors
        )

    def test_ignores_superseded_and_deprecated_records_in_target_index(self) -> None:
        self.fixture.write_adr(
            "0003",
            "Deprecated fixture",
            status="Deprecated",
            deprecation="{issue: fixture}",
        )
        self.fixture.write_architecture()
        source = (self.fixture.root / "docs/architecture.md").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("ADR 0002", source)
        self.assertNotIn("ADR 0003", source)
        self.assertEqual("", self.fixture.errors())

    def test_rejects_implemented_claim_without_evidence(self) -> None:
        source = self.fixture.valid_architecture().replace(
            "[source](../packages/example/src/index.ts)", "No evidence"
        )
        self.fixture.write_architecture(source)
        errors = self.fixture.errors()
        self.assertIn("implemented claim has no evidence link", errors)
        self.assertIn("needs concrete repository evidence", errors)

    def test_rejects_implemented_claim_without_active_target(self) -> None:
        source = self.fixture.valid_architecture().replace(
            "[ADR 0001](adrs/0001-active-fixture.md)",
            "[ADR 0002](adrs/0002-superseded-fixture.md)",
        )
        self.fixture.write_architecture(source)
        self.assertIn(
            "must reference at least one active target ADR", self.fixture.errors()
        )

    def test_rejects_broken_evidence_reference(self) -> None:
        source = self.fixture.valid_architecture().replace(
            "../packages/example/src/index.ts", "../packages/example/src/missing.ts"
        )
        self.fixture.write_architecture(source)
        self.assertIn("broken local link", self.fixture.errors())

    def test_rejects_target_represented_as_shipped(self) -> None:
        source = self.fixture.valid_architecture().replace(
            "Example package slice", "Fully implemented and shipped target"
        )
        self.fixture.write_architecture(source)
        self.assertIn("implemented claim overstates evidence", self.fixture.errors())

    def test_requires_every_problem_document_reference(self) -> None:
        (self.fixture.root / "docs/problems/second-problem.md").write_text(
            "# Second problem\n", encoding="utf-8"
        )
        self.fixture.write_architecture()
        self.assertIn(
            "missing architectural problem references", self.fixture.errors()
        )

    def test_write_refreshes_the_generated_table(self) -> None:
        self.fixture.write_architecture(
            self.fixture.valid_architecture().replace(
                "| [ADR 0001]", "| [ADR 9999]"
            )
        )
        result = validator.main(["--root", str(self.fixture.root), "--write"])
        self.assertEqual(0, result)
        self.assertEqual("", self.fixture.errors())


if __name__ == "__main__":
    unittest.main()
