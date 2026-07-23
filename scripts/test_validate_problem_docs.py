from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import validate_problem_docs as validator  # noqa: E402


NOTICE = (
    "> **Non-authoritative:** This document explores a durable architectural problem. "
    "It does not authorize architecture, record a decision, or track delivery work. "
    "Product requirements remain in the [PRD](../../prds/reflo-prd.md), and effective "
    "implementation verdicts remain in the [decision register](../../DECISIONS.md)."
)


def valid_document(extra: str = "") -> str:
    return f"""# Durable fixture problem

{NOTICE}

## Problem

A durable problem.

## Forces and constraints

- A force.

## Risks

- A risk.

## Evidence to preserve

- Evidence.

## Open questions

- A question?

## Related authoritative sources

- [PRD](../../prds/reflo-prd.md)
- [Decision](../../DECISIONS.md#effective-decision-records)
{extra}
"""


class Fixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="reflo-problems-")
        self.root = Path(self.temporary.name)
        (self.root / "docs/problems").mkdir(parents=True)
        (self.root / "docs/adrs").mkdir(parents=True)
        (self.root / "prds").mkdir()
        (self.root / "prds/reflo-prd.md").write_text(
            "# Product requirements\n", encoding="utf-8"
        )
        (self.root / "DECISIONS.md").write_text(
            "# Decisions\n\n## Effective Decision Records\n", encoding="utf-8"
        )
        (self.root / "docs/adrs/README.md").write_text(
            "# ADR mirrors\n", encoding="utf-8"
        )
        (self.root / "docs/problems/README.md").write_text(
            "# Problems\n\n[Fixture](durable-fixture.md)\n", encoding="utf-8"
        )

    def close(self) -> None:
        self.temporary.cleanup()

    def write(self, source: str, name: str = "durable-fixture.md") -> Path:
        path = self.root / "docs/problems" / name
        path.write_text(source, encoding="utf-8")
        return path

    def errors(self) -> str:
        return "\n".join(validator.validate_repository(self.root))


class ProblemDocumentValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_accepts_non_authoritative_problem_document(self) -> None:
        self.fixture.write(valid_document())
        self.assertEqual("", self.fixture.errors())

    def test_rejects_tracker_and_verdict_shapes(self) -> None:
        self.fixture.write(
            valid_document(
                """
## Status

Accepted

- [ ] Deliver the selected architecture.
"""
            )
        )
        errors = self.fixture.errors()
        self.assertIn("prohibited tracker or verdict heading: Status", errors)
        self.assertIn("task-list items are prohibited", errors)

    def test_rejects_labeled_owner_and_recommendation_metadata(self) -> None:
        self.fixture.write(
            valid_document(
                """
**Owner:** Architecture team

Recommendation: use the fixture.
"""
            )
        )
        errors = self.fixture.errors()
        self.assertGreaterEqual(
            errors.count("prohibited tracker or verdict metadata"), 2
        )

    def test_rejects_decisive_language(self) -> None:
        self.fixture.write(valid_document("\nThis document decides the adapter.\n"))
        self.assertIn("problem exploration cannot present a verdict", self.fixture.errors())

    def test_rejects_broken_local_path_and_fragment(self) -> None:
        self.fixture.write(
            valid_document(
                """
- [Missing file](../../docs/missing.md)
- [Missing heading](../../DECISIONS.md#not-a-heading)
"""
            )
        )
        errors = self.fixture.errors()
        self.assertIn("broken local link", errors)
        self.assertIn("missing Markdown fragment", errors)

    def test_requires_authoritative_source_links(self) -> None:
        source = valid_document().replace(
            "../../prds/reflo-prd.md", "https://example.com/prd"
        ).replace("../../DECISIONS.md", "https://example.com/decisions")
        self.fixture.write(source)
        errors = self.fixture.errors()
        self.assertIn("must link the authoritative PRD", errors)
        self.assertIn("must link the effective decision register", errors)

    def test_rejects_non_kebab_filename(self) -> None:
        self.fixture.write(valid_document(), name="Durable_Fixture.md")
        self.assertIn("filename must use lowercase kebab-case", self.fixture.errors())


if __name__ == "__main__":
    unittest.main()
