from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import validate_adrs as validator  # noqa: E402


REGISTER = """# Reflo Decision Register

## Authority and lifecycle

Fixture.

## PRD Mandate Index

| Mandate | Fixed choice | Authoritative source | Change control |
|---|---|---|---|
| `M-001` | Use the fixture vector store. | `prds/reflo-prd.md` §9 | PRD revision only |

## Pending Decision Index

| Key | Choice | DRI | Decider | Deadline | Consequence | Issue |
|---|---|---|---|---|---|---|
| `P-001` | Fixture pending choice | Fixture DRI | Fixture decider | 2026-07-30 | Fixture consequence | https://github.com/acme/reflo/issues/1 |

## Effective Decision Records

## D-GH-42 — Example future verdict

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Proposer:** Agent example
- **Decision DRI:** Agent DRI
- **Authorized decider:** Human example
- **Implementation owner:** Agent owner
- **PRD references:** `prds/reflo-prd.md` §9
- **Context and boundary:** Validator fixture context.
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


def github_metadata(canonical_id: str = "0029", alias: str = "D-GH-42") -> dict:
    return {
        "id": canonical_id,
        "title": "Example future verdict",
        "status": "Accepted",
        "date": "2026-07-18",
        "aliases": [alias],
        "prd_references": "`prds/reflo-prd.md` §9",
        "ownership": {
            "proposer": "Agent example",
            "decision_dri": "Agent DRI",
            "implementation_owner": "Agent owner",
        },
        "authorization": {
            "decider": "Human example",
            "approval_basis": "Repository owner approval in the exact verdict comment.",
        },
        "provenance": {
            "kind": "github-decision",
            "issue": "https://github.com/acme/reflo/issues/42",
            "verdict_comment": "https://github.com/acme/reflo/issues/42#issuecomment-99",
            "record_pr": "https://github.com/acme/reflo/pull/43",
        },
        "supersedes": [],
        "superseded_by": None,
        "deprecation": None,
        "maintenance": [],
    }


def bootstrap_metadata() -> dict:
    metadata = github_metadata("0001", "D-BOOTSTRAP-001")
    metadata["provenance"] = {
        "kind": "bootstrap-exception",
        "owner_directive": "Repository owner directive",
        "directive_date": "2026-07-17",
        "bounded_exception": "Only the original governance bootstrap files.",
        "migration_pr": "https://github.com/acme/reflo/pull/50",
    }
    return metadata


def mandate_metadata(state: str = "staged", cutover_pr=None) -> dict:
    metadata = github_metadata("0023", "M-001")
    metadata["title"] = "Fixture mandate"
    metadata["provenance"] = {
        "kind": "prd-mandate",
        "prd_version": "1.8",
        "prd_commit": "a" * 40,
        "prd_path": "prds/reflo-prd.md",
        "prd_sections": ["§9"],
        "confirmation_issue": "https://github.com/acme/reflo/issues/22",
        "confirmation_comment": "https://github.com/acme/reflo/issues/22#issuecomment-100",
        "authority_state": state,
        "cutover_pr": cutover_pr,
    }
    return metadata


def body(metadata: dict, *, context: str = "Validator fixture context.") -> str:
    return f"""# ADR {metadata['id']}: {metadata['title']}

## Context

{context}

## Options

Option A; option B.

## Decision

### Authorized verdict

Choose option A.

### Rationale

Fixture rationale.

## Verification

Fixture consequence.

## Reversal criteria

Fixture reversal criterion.
"""


def render(metadata: dict, *, context: str = "Validator fixture context.") -> str:
    frontmatter = validator.yaml.safe_dump(
        metadata, sort_keys=False, allow_unicode=True, default_flow_style=False
    ).strip()
    frontmatter = validator.re.sub(
        r"^id:\s*(?:['\"])?\d{4}(?:['\"])?$",
        f'id: "{metadata["id"]}"',
        frontmatter,
        count=1,
        flags=validator.re.MULTILINE,
    )
    return f"---\n{frontmatter}\n---\n{body(metadata, context=context)}"


def config(
    *,
    mode: str = "partial-mirror",
    complete: bool = False,
    exemptions: list[str] | None = None,
    legacy_ids: dict[str, str] | None = None,
    managed: list[str] | None = None,
) -> dict:
    return {
        "schema_version": 1,
        "mode": mode,
        "baseline_complete": complete,
        "adr_directory": "docs/adrs",
        "register": "DECISIONS.md",
        "managed_prd_mandates": managed or [],
        "partial_mirror_exemptions": exemptions or [],
        "legacy_ids": legacy_ids or {"D-GH-42": "0029"},
    }


class Fixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="reflo-adrs-")
        self.root = Path(self.temporary.name)
        (self.root / "docs/adrs").mkdir(parents=True)
        (self.root / "DECISIONS.md").write_text(REGISTER, encoding="utf-8")

    def close(self) -> None:
        self.temporary.cleanup()

    def write_config(self, value: dict) -> None:
        source = validator.yaml.safe_dump(value, sort_keys=False)
        (self.root / validator.CONFIG_NAME).write_text(source, encoding="utf-8")

    def write_adr(self, metadata: dict, *, context: str = "Validator fixture context.", slug: str = "fixture") -> Path:
        path = self.root / "docs/adrs" / f"{metadata['id']}-{slug}.md"
        path.write_text(render(metadata, context=context), encoding="utf-8")
        return path

    def validate(self) -> str:
        errors, _, _, _ = validator.validate_repository(self.root)
        return "\n".join(errors)


class AdrValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_repository_partial_mirror_is_valid_and_incomplete(self) -> None:
        errors, _, adrs, repository_config = validator.validate_repository(validator.ROOT)
        self.assertEqual([], errors)
        self.assertEqual({}, adrs)
        self.assertEqual("partial-mirror", repository_config["mode"])
        self.assertFalse(repository_config["baseline_complete"])
        self.assertGreater(len(repository_config["partial_mirror_exemptions"]), 0)

    def test_github_decision_provenance_and_field_preservation_pass(self) -> None:
        self.fixture.write_config(config())
        self.fixture.write_adr(github_metadata())
        self.assertEqual("", self.fixture.validate())

    def test_bootstrap_and_staged_prd_mandate_provenance_pass_schema(self) -> None:
        diagnostics = validator.Diagnostics()
        bootstrap_path = self.fixture.write_adr(bootstrap_metadata(), slug="bootstrap")
        bootstrap = validator.parse_adr(bootstrap_path, diagnostics)
        assert bootstrap
        validator.validate_adr_schema(bootstrap, "partial-mirror", diagnostics)

        mandate_path = self.fixture.write_adr(mandate_metadata(), slug="mandate")
        mandate = validator.parse_adr(mandate_path, diagnostics)
        assert mandate
        validator.validate_adr_schema(mandate, "partial-mirror", diagnostics)
        self.assertEqual([], diagnostics.finish())

    def test_bootstrap_coexistence_preserves_historical_provenance(self) -> None:
        bootstrap_register = (
            REGISTER.replace("D-GH-42", "D-BOOTSTRAP-001")
            .replace("https://github.com/acme/reflo/issues/42", "None — bootstrap exception")
            .replace(
                "None — bootstrap exception#issuecomment-99",
                "Repository owner directive dated 2026-07-17",
            )
            .replace("https://github.com/acme/reflo/pull/43", "Original bootstrap change")
            .replace("- **Bootstrap exception:** No", "- **Bootstrap exception:** Yes — bounded to governance files")
        )
        (self.fixture.root / "DECISIONS.md").write_text(
            bootstrap_register, encoding="utf-8"
        )
        metadata = bootstrap_metadata()
        metadata["date"] = "2026-07-18"
        metadata["provenance"]["owner_directive"] = (
            "Repository owner directive dated 2026-07-17"
        )
        metadata["provenance"]["directive_date"] = "2026-07-18"
        metadata["provenance"]["bounded_exception"] = (
            "Yes — bounded to governance files"
        )
        self.fixture.write_config(
            config(legacy_ids={"D-BOOTSTRAP-001": "0001"})
        )
        self.fixture.write_adr(metadata)
        self.assertEqual("", self.fixture.validate())

    def test_exact_github_provenance_is_enforced(self) -> None:
        metadata = github_metadata()
        metadata["provenance"]["verdict_comment"] = (
            "https://github.com/acme/reflo/issues/41#issuecomment-99"
        )
        self.fixture.write_config(config())
        self.fixture.write_adr(metadata)
        messages = self.fixture.validate()
        self.assertIn("issue and verdict comment must reference the same issue", messages)
        self.assertIn("does not exactly match D-GH-42 Verdict", messages)

    def test_rejected_proposals_remain_github_only(self) -> None:
        rejected_record = REGISTER[REGISTER.index("## D-GH-42") :]
        rejected_record = (
            rejected_record.replace(
                "## D-GH-42 — Example future verdict", "## D-GH-44 — Rejected fixture"
            )
            .replace("- **Status:** Accepted", "- **Status:** Rejected")
            .replace("/issues/42", "/issues/44")
        )
        rejected = REGISTER + "\n" + rejected_record
        (self.fixture.root / "DECISIONS.md").write_text(rejected, encoding="utf-8")
        metadata = github_metadata(alias="D-GH-44")
        metadata["title"] = "Rejected fixture"
        metadata["provenance"]["issue"] = "https://github.com/acme/reflo/issues/44"
        metadata["provenance"]["verdict_comment"] = (
            "https://github.com/acme/reflo/issues/44#issuecomment-99"
        )
        self.fixture.write_config(config(legacy_ids={"D-GH-44": "0001"}))
        self.fixture.write_adr(metadata)
        self.assertIn("alias D-GH-44 has no authoritative", self.fixture.validate())

    def test_prd_provenance_rejects_mutable_commit_and_premature_cutover(self) -> None:
        metadata = mandate_metadata(state="transferred", cutover_pr="https://github.com/acme/reflo/pull/80")
        metadata["provenance"]["prd_commit"] = "main"
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata, slug="mandate")
        adr = validator.parse_adr(path, diagnostics)
        assert adr
        validator.validate_adr_schema(adr, "partial-mirror", diagnostics)
        messages = "\n".join(diagnostics.finish())
        self.assertIn("full 40-character lowercase commit SHA", messages)
        self.assertIn("coexistence modes require 'staged'", messages)
        self.assertIn("staged PRD mandates must use null", messages)

    def test_authoritative_prd_mandate_requires_exact_cutover_pr(self) -> None:
        metadata = mandate_metadata(state="transferred", cutover_pr=None)
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata, slug="mandate")
        adr = validator.parse_adr(path, diagnostics)
        assert adr
        validator.validate_adr_schema(adr, "adr-authoritative", diagnostics)
        self.assertIn("cutover_pr: expected one exact GitHub URL", "\n".join(diagnostics.finish()))

    def test_duplicate_canonical_ids_and_aliases_are_rejected(self) -> None:
        self.fixture.write_config(
            config(legacy_ids={"D-GH-42": "0029", "D-GH-43": "0029"})
        )
        self.fixture.write_adr(github_metadata(), slug="first")
        second = github_metadata(alias="D-GH-43")
        second["provenance"]["issue"] = "https://github.com/acme/reflo/issues/43"
        second["provenance"]["verdict_comment"] = (
            "https://github.com/acme/reflo/issues/43#issuecomment-100"
        )
        self.fixture.write_adr(second, slug="second")
        messages = self.fixture.validate()
        self.assertIn("duplicate canonical ADR ID 0029", messages)

        first_path = self.fixture.root / "docs/adrs/0029-first.md"
        first = github_metadata()
        first["aliases"] = ["D-GH-42", "D-GH-42"]
        first_path.write_text(render(first), encoding="utf-8")
        self.assertIn("duplicate aliases are not allowed", self.fixture.validate())

    def test_field_preservation_reports_the_specific_section(self) -> None:
        self.fixture.write_config(config())
        self.fixture.write_adr(github_metadata(), context="Compressed context.")
        messages = self.fixture.validate()
        self.assertIn("Context does not losslessly match authoritative record D-GH-42", messages)
        self.assertNotIn("Compressed context", messages)

    def test_partial_mirror_allows_only_declared_baseline_gaps(self) -> None:
        self.fixture.write_config(config(exemptions=["D-GH-42"]))
        self.assertEqual("", self.fixture.validate())
        self.fixture.write_config(config(exemptions=[]))
        self.assertIn("late effective record D-GH-42 must be dual-written", self.fixture.validate())

    def test_late_dual_written_decision_passes_and_cannot_stay_exempt(self) -> None:
        self.fixture.write_adr(github_metadata())
        self.fixture.write_config(config(exemptions=[]))
        self.assertEqual("", self.fixture.validate())
        self.fixture.write_config(config(exemptions=["D-GH-42"]))
        self.assertIn("mirrored ADR D-GH-42 must be removed", self.fixture.validate())

    def test_complete_mirror_requires_bijection_and_complete_marker(self) -> None:
        self.fixture.write_config(config(mode="complete-mirror", complete=True))
        self.assertIn("complete-mirror requires an ADR for D-GH-42", self.fixture.validate())
        self.fixture.write_adr(github_metadata())
        self.assertEqual("", self.fixture.validate())
        self.fixture.write_config(config(mode="complete-mirror", complete=False))
        self.assertIn("complete-mirror requires baseline_complete: true", self.fixture.validate())

    def test_adr_authoritative_rejects_existing_register(self) -> None:
        self.fixture.write_config(
            config(mode="adr-authoritative", complete=True, legacy_ids={})
        )
        self.assertIn("adr-authoritative is forbidden while DECISIONS.md exists", self.fixture.validate())

    def test_adr_authoritative_requires_every_configured_alias(self) -> None:
        self.fixture.write_config(config(mode="adr-authoritative", complete=True))
        (self.fixture.root / "DECISIONS.md").unlink()
        self.assertIn("authoritative legacy alias D-GH-42 has no ADR", self.fixture.validate())
        self.fixture.write_adr(github_metadata())
        self.assertEqual("", self.fixture.validate())

    def test_supersession_requires_reverse_links_and_detects_cycles(self) -> None:
        old_metadata = github_metadata("0001")
        old_metadata["status"] = "Superseded"
        old_metadata["superseded_by"] = "0002"
        new_metadata = github_metadata("0002", "D-GH-43")
        new_metadata["supersedes"] = ["0001"]
        diagnostics = validator.Diagnostics()
        old_path = self.fixture.write_adr(old_metadata, slug="old")
        new_path = self.fixture.write_adr(new_metadata, slug="new")
        old = validator.parse_adr(old_path, diagnostics)
        new = validator.parse_adr(new_path, diagnostics)
        assert old and new
        validator.validate_lifecycle({"0001": old, "0002": new}, diagnostics)
        self.assertEqual([], diagnostics.finish())

        broken = copy.deepcopy(new_metadata)
        broken["supersedes"] = []
        new_path.write_text(render(broken), encoding="utf-8")
        broken_new = validator.parse_adr(new_path, diagnostics)
        assert broken_new
        validator.validate_lifecycle({"0001": old, "0002": broken_new}, diagnostics)
        self.assertIn("does not link back via supersedes", "\n".join(diagnostics.finish()))

        old_metadata["supersedes"] = ["0002"]
        old_path.write_text(render(old_metadata), encoding="utf-8")
        cyclic_old = validator.parse_adr(old_path, diagnostics)
        assert cyclic_old
        validator.validate_lifecycle({"0001": cyclic_old, "0002": new}, diagnostics)
        self.assertIn("supersession cycle", "\n".join(diagnostics.finish()))

    def test_deprecation_requires_separate_authorization(self) -> None:
        metadata = github_metadata()
        metadata["status"] = "Deprecated"
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata)
        adr = validator.parse_adr(path, diagnostics)
        assert adr
        validator.validate_adr_schema(adr, "partial-mirror", diagnostics)
        self.assertIn("deprecation: expected a mapping", "\n".join(diagnostics.finish()))

        metadata["deprecation"] = {
            "issue": "https://github.com/acme/reflo/issues/60",
            "verdict_comment": "https://github.com/acme/reflo/issues/60#issuecomment-101",
            "date": "2026-07-22",
            "record_pr": "https://github.com/acme/reflo/pull/61",
            "decider": "@owner",
            "approval_basis": "Owner-authored deprecation verdict.",
        }
        path.write_text(render(metadata), encoding="utf-8")
        diagnostics = validator.Diagnostics()
        adr = validator.parse_adr(path, diagnostics)
        assert adr
        validator.validate_adr_schema(adr, "partial-mirror", diagnostics)
        self.assertEqual([], diagnostics.finish())

    def test_accepted_content_is_immutable_across_lifecycle_transition(self) -> None:
        previous_metadata = github_metadata()
        current_metadata = copy.deepcopy(previous_metadata)
        current_metadata["status"] = "Superseded"
        current_metadata["superseded_by"] = "0002"
        diagnostics = validator.Diagnostics()
        previous_path = self.fixture.write_adr(previous_metadata, slug="same")
        previous = validator.parse_adr(previous_path, diagnostics)
        assert previous
        current_path = self.fixture.root / "docs/adrs/0001-same.md"
        current_path.write_text(
            render(current_metadata, context="Semantic rewrite."), encoding="utf-8"
        )
        current = validator.parse_adr(current_path, diagnostics)
        assert current
        validator.validate_transition(previous, current, diagnostics)
        messages = "\n".join(diagnostics.finish())
        self.assertIn("accepted decision content is immutable", messages)
        self.assertIn("lifecycle transitions cannot change accepted body content", messages)

    def test_invalid_lifecycle_reactivation_is_rejected(self) -> None:
        previous_metadata = github_metadata()
        previous_metadata["status"] = "Deprecated"
        previous_metadata["deprecation"] = {
            "issue": "https://github.com/acme/reflo/issues/60",
            "verdict_comment": "https://github.com/acme/reflo/issues/60#issuecomment-101",
            "date": "2026-07-22",
            "record_pr": "https://github.com/acme/reflo/pull/61",
            "decider": "@owner",
            "approval_basis": "Owner verdict.",
        }
        current_metadata = github_metadata()
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(previous_metadata, slug="same")
        previous = validator.parse_adr(path, diagnostics)
        assert previous
        path.write_text(render(current_metadata), encoding="utf-8")
        current = validator.parse_adr(path, diagnostics)
        assert current
        validator.validate_transition(previous, current, diagnostics)
        self.assertIn("invalid lifecycle transition 'Deprecated' -> 'Accepted'", "\n".join(diagnostics.finish()))

    def test_prd_authority_transfer_is_the_only_allowed_provenance_transition(self) -> None:
        old_metadata = mandate_metadata()
        new_metadata = mandate_metadata(
            state="transferred", cutover_pr="https://github.com/acme/reflo/pull/80"
        )
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(old_metadata, slug="same")
        previous = validator.parse_adr(path, diagnostics)
        assert previous
        path.write_text(render(new_metadata), encoding="utf-8")
        current = validator.parse_adr(path, diagnostics)
        assert current
        validator.validate_transition(previous, current, diagnostics)
        self.assertEqual([], diagnostics.finish())

    def test_legacy_id_resolution_handles_alias_canonical_and_unmigrated(self) -> None:
        repository_errors, _, repository_adrs, repository_config = validator.validate_repository(validator.ROOT)
        self.assertEqual([], repository_errors)
        self.assertEqual(("0026", None), validator.resolve_legacy_id(repository_config, repository_adrs, "D-GH-125"))

        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(github_metadata())
        adr = validator.parse_adr(path, diagnostics)
        assert adr
        self.assertEqual(("0029", path), validator.resolve_legacy_id(config(), {"0029": adr}, "D-GH-42"))
        self.assertEqual(("0029", path), validator.resolve_legacy_id(config(), {"0029": adr}, "0029"))
        with self.assertRaises(KeyError):
            validator.resolve_legacy_id(config(), {}, "D-GH-999")

    def test_secret_patterns_are_rejected_without_echoing_secret(self) -> None:
        metadata = github_metadata()
        secret = "ghp_abcdefghijklmnopqrstuvwxyz123456"
        metadata["authorization"]["approval_basis"] = secret
        self.fixture.write_config(config())
        self.fixture.write_adr(metadata)
        messages = self.fixture.validate()
        self.assertIn("prohibited GitHub token", messages)
        self.assertNotIn(secret, messages)

    def test_diagnostics_are_bounded(self) -> None:
        diagnostics = validator.Diagnostics(limit=2)
        for index in range(5):
            diagnostics.add(f"error {index}")
        messages = diagnostics.finish()
        self.assertEqual(3, len(messages))
        self.assertIn("omitted 3 additional", messages[-1])

    def test_duplicate_yaml_keys_are_rejected(self) -> None:
        path = self.fixture.root / "docs/adrs/0029-duplicate.md"
        source = render(github_metadata()).replace('id: "0029"', "id: '0029'\nid: '0030'", 1)
        path.write_text(source, encoding="utf-8")
        diagnostics = validator.Diagnostics()
        self.assertIsNone(validator.parse_adr(path, diagnostics))
        self.assertIn("duplicate key 'id'", "\n".join(diagnostics.finish()))


if __name__ == "__main__":
    unittest.main()
