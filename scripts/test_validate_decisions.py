from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate_decisions.py")
SPEC = importlib.util.spec_from_file_location("validate_decisions", MODULE_PATH)
assert SPEC and SPEC.loader
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


class DecisionValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.valid_text = validator.DECISIONS.read_text(encoding="utf-8")

    def messages_for(self, text: str) -> str:
        errors, _ = validator.validate_document(text)
        return "\n".join(errors)

    def future_record(self) -> str:
        return """
## D-GH-42 — Example future verdict

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Proposer:** Agent example
- **Decision DRI:** Agent example
- **Authorized decider:** Human example
- **Implementation owner:** Agent example
- **PRD references:** `prds/reflo-prd.md` §9
- **Context and boundary:** Validator fixture only.
- **Options considered:** Option A; option B.
- **Authorized verdict:** Choose option A.
- **Rationale:** Fixture rationale.
- **Testable consequences:** Fixture consequence.
- **Reversal criteria:** Fixture reversal criterion.
- **Supersedes:** None
- **Issue:** https://github.com/acme/reflo/issues/42
- **Verdict:** https://github.com/acme/reflo/issues/42#issuecomment-99
- **Pull request:** https://github.com/acme/reflo/pull/43
- **Bootstrap exception:** No
"""

    def test_repository_register_is_valid(self) -> None:
        errors, _ = validator.validate_document(self.valid_text)
        self.assertEqual([], errors)

    def test_future_github_backed_record_is_valid(self) -> None:
        baseline_errors, baseline_urls = validator.validate_document(self.valid_text)
        errors, urls = validator.validate_document(self.valid_text + self.future_record())
        self.assertEqual([], baseline_errors)
        self.assertEqual([], errors)
        self.assertEqual(len(baseline_urls) + 3, len(urls))

    def test_duplicate_effective_id_is_rejected(self) -> None:
        duplicate = "\n".join(
            line
            for line in self.valid_text.splitlines()
            if line.startswith("## D-BOOTSTRAP-001")
        )
        messages = self.messages_for(self.valid_text + "\n" + duplicate + "\n")
        self.assertIn("duplicate effective decision ID D-BOOTSTRAP-001", messages)

    def test_invalid_pending_deadline_is_rejected(self) -> None:
        altered = self.valid_text.replace("2026-07-18", "2026-02-30", 1)
        self.assertIn("invalid calendar date", self.messages_for(altered))

    def test_secret_like_content_is_rejected(self) -> None:
        altered = self.valid_text + "\napi_key=abcdefghijklmnopqrstuvwx\n"
        self.assertIn("prohibited assigned secret", self.messages_for(altered))

    def test_prd_mandate_cannot_be_superseded(self) -> None:
        altered = self.valid_text.replace("- **Supersedes:** None", "- **Supersedes:** `M-001`", 1)
        self.assertIn("cannot supersede PRD mandate M-001", self.messages_for(altered))

    def test_non_bootstrap_record_requires_github_links(self) -> None:
        start = self.valid_text.index("## D-BOOTSTRAP-001")
        record = self.valid_text[start:]
        record = record.replace("D-BOOTSTRAP-001", "D-GH-999", 1)
        record = record.replace(
            "- **Bootstrap exception:** Yes — limited to the files listed in the Bootstrap exception section",
            "- **Bootstrap exception:** No",
            1,
        )
        messages = self.messages_for(self.valid_text + "\n" + record)
        self.assertIn("D-GH-999: Issue must contain a GitHub URL", messages)
        self.assertIn("D-GH-999: Verdict must contain a GitHub URL", messages)
        self.assertIn("D-GH-999: Pull request must contain a GitHub URL", messages)

    def test_github_links_are_mapped_to_api_resources(self) -> None:
        self.assertEqual(
            "https://api.github.com/repos/acme/reflo/issues/12",
            validator.github_api_url("https://github.com/acme/reflo/issues/12"),
        )
        self.assertEqual(
            "https://api.github.com/repos/acme/reflo/issues/comments/42",
            validator.github_api_url(
                "https://github.com/acme/reflo/issues/12#issuecomment-42"
            ),
        )
        self.assertEqual(
            "https://api.github.com/repos/acme/reflo/pulls/7",
            validator.github_api_url("https://github.com/acme/reflo/pull/7"),
        )

    def test_pending_id_cannot_be_effective_authority(self) -> None:
        altered = self.valid_text.replace(
            "- **Options considered:**",
            "- **Options considered:** `P-005` as binding authority;",
            1,
        )
        self.assertIn(
            "effective records cannot use pending IDs as authority",
            self.messages_for(altered),
        )

    def test_technical_p_256_identifier_is_allowed(self) -> None:
        altered = self.valid_text.replace(
            "- **Options considered:**",
            "- **Options considered:** A `P-256` signature profile;",
            1,
        )
        errors, _ = validator.validate_document(altered)
        self.assertEqual([], errors)


if __name__ == "__main__":
    unittest.main()
