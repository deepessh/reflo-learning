from __future__ import annotations

import copy
import json
import subprocess
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
| `M-001` | Use the fixture vector store. | `prds/reflo-prd.md` §9 at v1.8 commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | PRD revision only; discovery [#22](https://github.com/acme/reflo/issues/22); confirmation [owner comment](https://github.com/acme/reflo/issues/22#issuecomment-100) |

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
            "approval_basis": "repository-owner authorization.",
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
    metadata["prd_references"] = (
        "`prds/reflo-prd.md` §9 at v1.8 commit "
        "`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`"
    )
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
    mandate = (metadata.get("provenance") or {}).get("kind") == "prd-mandate"
    verdict = "Use the fixture vector store." if mandate else "Choose option A."
    reversal = (
        "PRD revision only; discovery [#22](https://github.com/acme/reflo/issues/22); "
        "confirmation [owner comment](https://github.com/acme/reflo/issues/22#issuecomment-100)"
        if mandate
        else "Fixture reversal criterion."
    )
    return f"""# ADR {metadata['id']}: {metadata['title']}

## Context

{context}

## Options

Option A; option B.

## Decision

### Authorized verdict

{verdict}

### Rationale

Fixture rationale.

## Verification

Fixture consequence.

## Reversal criteria

{reversal}
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


def live_github_responses(
    *,
    canonical_path: str = "docs/adrs/0029-fixture.md",
    record_path: str | None = None,
) -> dict:
    return {
        "/repos/acme/reflo/issues/42": {
            "body": "Authorized decider: @owner",
            "labels": [{"name": "decision"}],
        },
        "/repos/acme/reflo/issues/comments/99": {
            "issue_url": "https://api.github.com/repos/acme/reflo/issues/42",
            "user": {"login": "owner"},
            "author_association": "OWNER",
            "body": (
                "Accepted. Authorized decider: @owner. "
                "Approval basis: repository-owner authorization."
            ),
        },
        "/repos/acme/reflo/pulls/43": {
            "state": "closed",
            "merged_at": "2026-07-23T00:00:00Z",
            "body": "Closes #42",
        },
        "/repos/acme/reflo/pulls/43/files?per_page=100&page=1": [
            {"filename": record_path or canonical_path}
        ],
    }


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
        "authority_transfer_pr": (
            "https://github.com/acme/reflo/pull/80"
            if mode == "adr-authoritative"
            else None
        ),
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

    def test_repository_is_adr_authoritative_and_complete(self) -> None:
        errors, _, adrs, repository_config = validator.validate_repository(validator.ROOT)
        self.assertEqual([], errors)
        self.assertEqual("adr-authoritative", repository_config["mode"])
        self.assertTrue(repository_config["baseline_complete"])
        self.assertEqual([], repository_config["partial_mirror_exemptions"])
        self.assertFalse((validator.ROOT / "DECISIONS.md").exists())
        self.assertEqual(
            len(repository_config["legacy_ids"]),
            len(adrs),
        )

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

    def test_live_github_provenance_accepts_historical_and_future_records(self) -> None:
        for canonical_id, record_path in (("0028", "DECISIONS.md"), ("0029", None)):
            with self.subTest(canonical_id=canonical_id):
                metadata = github_metadata(canonical_id)
                metadata["authorization"]["decider"] = (
                    "@owner, repository owner and authorized decision authority"
                )
                diagnostics = validator.Diagnostics()
                path = self.fixture.write_adr(
                    metadata, slug=f"fixture-{canonical_id}"
                )
                adr = validator.parse_adr(path, diagnostics)
                assert adr
                responses = live_github_responses(
                    canonical_path=validator.canonical_adr_path(adr),
                    record_path=record_path,
                )
                validator.validate_live_github_evidence(
                    {canonical_id: adr},
                    diagnostics,
                    evidence=validator.GitHubEvidence(responses=responses),
                )
                self.assertEqual([], diagnostics.finish())

    def test_live_github_provenance_rejects_non_authorizing_comments(self) -> None:
        metadata = github_metadata()
        metadata["authorization"]["decider"] = "@owner"
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata)
        adr = validator.parse_adr(path, diagnostics)
        assert adr

        cases = {
            "bare accepted": (
                lambda responses: responses[
                    "/repos/acme/reflo/issues/comments/99"
                ].update({"body": "Accepted."}),
                "does not identify the declared authorized decider",
            ),
            "unauthorized actor": (
                lambda responses: responses[
                    "/repos/acme/reflo/issues/comments/99"
                ]["user"].update({"login": "other"}),
                "was not authored by the declared authorized decider",
            ),
            "rejected": (
                lambda responses: responses[
                    "/repos/acme/reflo/issues/comments/99"
                ].update(
                    {
                        "body": (
                            "Authorized verdict: Rejected. Authorized decider: "
                            "@owner. Approval basis: owner review."
                        )
                    }
                ),
                "is not an authorized Accepted verdict",
            ),
            "mismatched approval basis": (
                lambda responses: responses[
                    "/repos/acme/reflo/issues/comments/99"
                ].update(
                    {
                        "body": (
                            "Accepted. Authorized decider: @owner. "
                            "Approval basis: a different authorization."
                        )
                    }
                ),
                "approval basis does not exactly match",
            ),
        }
        for name, (mutate, expected) in cases.items():
            with self.subTest(name=name):
                responses = live_github_responses(
                    canonical_path=validator.canonical_adr_path(adr)
                )
                mutate(responses)
                case_diagnostics = validator.Diagnostics()
                validator.validate_live_github_evidence(
                    {"0029": adr},
                    case_diagnostics,
                    evidence=validator.GitHubEvidence(responses=responses),
                )
                self.assertIn(expected, "\n".join(case_diagnostics.finish()))

    def test_bold_and_unbold_approval_labels_normalize_identically(self) -> None:
        expected = (
            "Direct owner approval after review.\n"
            "The owner instructed Codex to proceed."
        )
        for label in (
            "Approval basis:",
            "**Approval basis:**",
            "**Approval basis**:",
            "__Approval basis:__",
        ):
            with self.subTest(label=label):
                comment = (
                    f"Accepted. Authorized decider: @owner.\n\n{label} {expected}"
                )
                self.assertEqual(expected, validator.exact_approval_basis(comment))

    def test_live_github_provenance_accepts_bold_approval_label_and_legacy_artifact(
        self,
    ) -> None:
        metadata = github_metadata()
        metadata["authorization"]["decider"] = "@owner"
        metadata["authorization"]["approval_basis"] = (
            "** repository-owner authorization."
        )
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata)
        adr = validator.parse_adr(path, diagnostics)
        assert adr
        responses = live_github_responses(
            canonical_path=validator.canonical_adr_path(adr)
        )
        responses["/repos/acme/reflo/issues/comments/99"]["body"] = (
            "Accepted. Authorized decider: @owner.\n\n"
            "**Approval basis:** repository-owner authorization."
        )

        validator.validate_live_github_evidence(
            {"0029": adr},
            diagnostics,
            evidence=validator.GitHubEvidence(responses=responses),
        )

        self.assertEqual([], diagnostics.finish())

    def test_live_github_provenance_allows_the_issue_named_agent_decider(self) -> None:
        metadata = github_metadata()
        metadata["authorization"]["decider"] = (
            "@reflo-agent, authorized decider named by the issue"
        )
        metadata["authorization"]["approval_basis"] = (
            "issue-delegated agent authorization."
        )
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata)
        adr = validator.parse_adr(path, diagnostics)
        assert adr
        responses = live_github_responses(
            canonical_path=validator.canonical_adr_path(adr)
        )
        responses["/repos/acme/reflo/issues/42"]["body"] = (
            "Authorized decider: @reflo-agent"
        )
        responses["/repos/acme/reflo/issues/comments/99"].update(
            {
                "user": {"login": "reflo-agent"},
                "author_association": "COLLABORATOR",
                "body": (
                    "Accepted. Authorized decider: @reflo-agent. "
                    "Approval basis: issue-delegated agent authorization."
                ),
            }
        )
        validator.validate_live_github_evidence(
            {"0029": adr},
            diagnostics,
            evidence=validator.GitHubEvidence(responses=responses),
        )
        self.assertEqual([], diagnostics.finish())

    def test_live_github_provenance_rejects_unmerged_unrelated_or_missing_record_pr(
        self,
    ) -> None:
        metadata = github_metadata()
        metadata["authorization"]["decider"] = "@owner"
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata)
        adr = validator.parse_adr(path, diagnostics)
        assert adr

        cases = {
            "unmerged": (
                lambda responses: responses["/repos/acme/reflo/pulls/43"].update(
                    {"state": "open", "merged_at": None}
                ),
                "record pull request must be merged",
            ),
            "unrelated": (
                lambda responses: responses["/repos/acme/reflo/pulls/43"].update(
                    {"body": "Closes #41"}
                ),
                "record pull request is unrelated",
            ),
            "missing path": (
                lambda responses: responses[
                    "/repos/acme/reflo/pulls/43/files?per_page=100&page=1"
                ][0].update({"filename": "docs/architecture.md"}),
                "does not contain required path",
            ),
        }
        for name, (mutate, expected) in cases.items():
            with self.subTest(name=name):
                responses = live_github_responses(
                    canonical_path=validator.canonical_adr_path(adr)
                )
                mutate(responses)
                case_diagnostics = validator.Diagnostics()
                validator.validate_live_github_evidence(
                    {"0029": adr},
                    case_diagnostics,
                    evidence=validator.GitHubEvidence(responses=responses),
                )
                self.assertIn(expected, "\n".join(case_diagnostics.finish()))

        responses = live_github_responses(
            canonical_path=validator.canonical_adr_path(adr)
        )
        responses["/repos/acme/reflo/pulls/43"].update(
            {"state": "open", "merged_at": None}
        )
        premerge = validator.Diagnostics()
        validator.validate_live_github_evidence(
            {"0029": adr},
            premerge,
            current_pr_number=43,
            evidence=validator.GitHubEvidence(responses=responses),
        )
        self.assertEqual([], premerge.finish())

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

    def test_mandate_mirror_must_match_authoritative_source_and_confirmation(self) -> None:
        self.fixture.write_config(
            config(
                exemptions=["D-GH-42"],
                legacy_ids={"D-GH-42": "0029", "M-001": "0023"},
                managed=["M-001"],
            )
        )
        metadata = mandate_metadata()
        self.fixture.write_adr(metadata, slug="mandate")
        self.assertEqual("", self.fixture.validate())

        invented = copy.deepcopy(metadata)
        invented["provenance"]["confirmation_comment"] = (
            "https://github.com/acme/reflo/issues/22#issuecomment-101"
        )
        mandate_path = self.fixture.root / "docs/adrs/0023-mandate.md"
        mandate_path.write_text(render(invented), encoding="utf-8")
        messages = self.fixture.validate()
        self.assertIn(
            "provenance.confirmation_comment does not exactly match authoritative mandate M-001",
            messages,
        )

        invented["provenance"]["confirmation_comment"] = (
            "https://github.com/acme/reflo/issues/22#issuecomment-100"
        )
        invented["provenance"]["prd_commit"] = "b" * 40
        mandate_path.write_text(render(invented), encoding="utf-8")
        self.assertIn(
            "provenance.prd_commit does not exactly match authoritative mandate M-001",
            self.fixture.validate(),
        )

    def test_authoritative_mode_accepts_only_transferred_mandate_provenance(self) -> None:
        (self.fixture.root / "DECISIONS.md").unlink()
        self.fixture.write_config(
            config(
                mode="adr-authoritative",
                complete=True,
                exemptions=[],
                legacy_ids={"M-001": "0023"},
                managed=["M-001"],
            )
        )
        metadata = mandate_metadata(
            state="transferred",
            cutover_pr="https://github.com/acme/reflo/pull/80",
        )
        self.fixture.write_adr(metadata, slug="mandate")
        self.assertEqual("", self.fixture.validate())

        metadata["provenance"]["authority_state"] = "staged"
        metadata["provenance"]["cutover_pr"] = None
        path = self.fixture.root / "docs/adrs/0023-mandate.md"
        path.write_text(render(metadata), encoding="utf-8")
        messages = self.fixture.validate()
        self.assertIn("adr-authoritative mode requires 'transferred'", messages)
        self.assertIn("cutover_pr: expected one exact GitHub URL", messages)

    def test_authoritative_mode_requires_one_exact_transfer_pr(self) -> None:
        (self.fixture.root / "DECISIONS.md").unlink()
        self.fixture.write_config(
            config(
                mode="adr-authoritative",
                complete=True,
                legacy_ids={"M-001": "0023"},
                managed=["M-001"],
            )
        )
        metadata = mandate_metadata(
            state="transferred",
            cutover_pr="https://github.com/acme/reflo/pull/81",
        )
        self.fixture.write_adr(metadata, slug="mandate")
        self.assertIn(
            "cutover_pr must exactly match .adr-governance.yaml authority_transfer_pr",
            self.fixture.validate(),
        )

    def test_golden_cutover_preserves_complete_register_and_late_decisions(self) -> None:
        self.fixture.write_config(
            config(
                mode="complete-mirror",
                complete=True,
                legacy_ids={"D-GH-42": "0029", "M-001": "0023"},
                managed=["M-001"],
            )
        )
        github_path = self.fixture.write_adr(github_metadata())
        mandate_path = self.fixture.write_adr(
            mandate_metadata(), slug="mandate"
        )
        subprocess.run(
            ["git", "init", "-b", "main"],
            cwd=self.fixture.root,
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "fixture@example.com"],
            cwd=self.fixture.root,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Fixture"],
            cwd=self.fixture.root,
            check=True,
        )
        subprocess.run(
            ["git", "add", "."], cwd=self.fixture.root, check=True
        )
        subprocess.run(
            ["git", "commit", "-m", "complete mirror"],
            cwd=self.fixture.root,
            check=True,
            capture_output=True,
            text=True,
        )

        github_diagnostics = validator.Diagnostics()
        github_adr = validator.parse_adr(github_path, github_diagnostics)
        mandate_adr = validator.parse_adr(mandate_path, github_diagnostics)
        assert github_adr and mandate_adr
        by_alias = {"D-GH-42": github_adr, "M-001": mandate_adr}
        authoritative = config(
            mode="adr-authoritative",
            complete=True,
            legacy_ids={"D-GH-42": "0029", "M-001": "0023"},
            managed=["M-001"],
        )
        diagnostics = validator.Diagnostics()
        validator.validate_cutover_bijection(
            self.fixture.root,
            authoritative,
            by_alias,
            "HEAD",
            diagnostics,
        )
        self.assertEqual([], diagnostics.finish())

        diagnostics = validator.Diagnostics()
        validator.validate_cutover_bijection(
            self.fixture.root,
            authoritative,
            {"M-001": mandate_adr},
            "HEAD",
            diagnostics,
        )
        self.assertIn(
            "atomic cutover lost authoritative record D-GH-42",
            "\n".join(diagnostics.finish()),
        )

    def test_immutable_sql_history_rejects_edits_and_allows_new_files(self) -> None:
        migration = self.fixture.root / "packages/db/migrations/001.sql"
        migration.parent.mkdir(parents=True)
        migration.write_text("select 1;\n", encoding="utf-8")
        subprocess.run(
            ["git", "init", "-b", "main"],
            cwd=self.fixture.root,
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "fixture@example.com"],
            cwd=self.fixture.root,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Fixture"],
            cwd=self.fixture.root,
            check=True,
        )
        subprocess.run(
            ["git", "add", "."], cwd=self.fixture.root, check=True
        )
        subprocess.run(
            ["git", "commit", "-m", "baseline"],
            cwd=self.fixture.root,
            check=True,
            capture_output=True,
            text=True,
        )
        migration.write_text("select 2;\n", encoding="utf-8")
        added = self.fixture.root / "packages/db/migrations/002.sql"
        added.write_text("select 2;\n", encoding="utf-8")
        diagnostics = validator.Diagnostics()
        validator.validate_immutable_sql_history(
            self.fixture.root, "HEAD", diagnostics
        )
        messages = "\n".join(diagnostics.finish())
        self.assertIn("001.sql: merged SQL history is immutable", messages)
        self.assertNotIn("002.sql", messages)

    def test_cutover_contract_retains_product_requirements_and_maps_m006_architecture(self) -> None:
        diagnostics = validator.Diagnostics()
        errors, _, adrs, repository_config = validator.validate_repository(validator.ROOT)
        self.assertEqual([], errors)
        validator.validate_cutover_contract(
            validator.ROOT, repository_config, adrs, diagnostics
        )
        self.assertEqual([], diagnostics.finish())

        contract = json.loads(
            (validator.ROOT / validator.CUTOVER_CONTRACT).read_text(encoding="utf-8")
        )
        self.assertEqual(
            {"M-004", "M-005", "M-006-product"},
            set(contract["retained_prd_requirements"]),
        )
        self.assertNotIn(
            "M-004", repository_config["managed_prd_mandates"]
        )
        self.assertNotIn(
            "M-005", repository_config["managed_prd_mandates"]
        )
        self.assertGreater(
            len(
                contract["moved_architecture_requirements"][
                    "M-006-provider-storage"
                ]["adr_aliases"]
            ),
            0,
        )

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

    def test_maintenance_is_bounded_to_its_declared_nonsemantic_delta(self) -> None:
        metadata = github_metadata()
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata, slug="same")
        previous = validator.parse_adr(path, diagnostics)
        assert previous

        current_metadata = copy.deepcopy(metadata)
        current_metadata["maintenance"] = [
            {
                "kind": "typo",
                "issue": "https://github.com/acme/reflo/issues/70",
                "pull_request": "https://github.com/acme/reflo/pull/71",
                "summary": "Correct one typo in Context.",
                "sections": ["Context"],
            }
        ]
        path.write_text(
            render(current_metadata, context="Validator fixture contexts."),
            encoding="utf-8",
        )
        current = validator.parse_adr(path, diagnostics)
        assert current
        validator.validate_transition(previous, current, diagnostics)
        self.assertEqual([], diagnostics.finish())

        path.write_text(
            render(current_metadata, context="A completely different decision boundary."),
            encoding="utf-8",
        )
        oversized = validator.parse_adr(path, diagnostics)
        assert oversized
        validator.validate_transition(previous, oversized, diagnostics)
        self.assertIn(
            "typo maintenance exceeds the bounded textual delta",
            "\n".join(diagnostics.finish()),
        )

        undeclared_metadata = copy.deepcopy(current_metadata)
        undeclared_metadata["maintenance"][0]["sections"] = ["Options"]
        path.write_text(
            render(undeclared_metadata, context="Validator fixture contexts."),
            encoding="utf-8",
        )
        undeclared = validator.parse_adr(path, diagnostics)
        assert undeclared
        validator.validate_transition(previous, undeclared, diagnostics)
        self.assertIn(
            "maintenance sections must exactly declare",
            "\n".join(diagnostics.finish()),
        )

    def test_maintenance_marker_cannot_change_immutable_metadata(self) -> None:
        metadata = github_metadata()
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata, slug="same")
        previous = validator.parse_adr(path, diagnostics)
        assert previous

        mutations = {
            "identity": lambda value: value.update({"title": "Changed identity"}),
            "date": lambda value: value.update({"date": "2026-07-19"}),
            "aliases": lambda value: value.update({"aliases": ["D-GH-43"]}),
            "ownership": lambda value: value["ownership"].update(
                {"decision_dri": "Different DRI"}
            ),
            "authorization": lambda value: value["authorization"].update(
                {"decider": "@different"}
            ),
            "provenance": lambda value: value["provenance"].update(
                {"record_pr": "https://github.com/acme/reflo/pull/99"}
            ),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                current_metadata = copy.deepcopy(metadata)
                current_metadata["maintenance"] = [
                    {
                        "kind": "typo",
                        "issue": "https://github.com/acme/reflo/issues/70",
                        "pull_request": "https://github.com/acme/reflo/pull/71",
                        "summary": "Correct one typo in Context.",
                        "sections": ["Context"],
                    }
                ]
                mutate(current_metadata)
                path.write_text(
                    render(current_metadata, context="Validator fixture contexts."),
                    encoding="utf-8",
                )
                current_diagnostics = validator.Diagnostics()
                current = validator.parse_adr(path, current_diagnostics)
                assert current
                validator.validate_transition(
                    previous, current, current_diagnostics
                )
                self.assertIn(
                    "accepted ADR metadata is immutable",
                    "\n".join(current_diagnostics.finish()),
                )

    def test_formatting_and_navigation_maintenance_reject_semantic_changes(self) -> None:
        metadata = github_metadata()
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(metadata, slug="same")
        previous = validator.parse_adr(path, diagnostics)
        assert previous

        for kind, expected in (
            ("formatting", "formatting maintenance changed non-whitespace content"),
            (
                "navigation",
                "navigation maintenance changed content outside link destinations",
            ),
        ):
            with self.subTest(kind=kind):
                current_metadata = copy.deepcopy(metadata)
                current_metadata["maintenance"] = [
                    {
                        "kind": kind,
                        "issue": "https://github.com/acme/reflo/issues/70",
                        "pull_request": "https://github.com/acme/reflo/pull/71",
                        "summary": f"Apply a {kind} correction in Context.",
                        "sections": ["Context"],
                    }
                ]
                path.write_text(
                    render(current_metadata, context="Semantic replacement."),
                    encoding="utf-8",
                )
                current_diagnostics = validator.Diagnostics()
                current = validator.parse_adr(path, current_diagnostics)
                assert current
                validator.validate_transition(
                    previous, current, current_diagnostics
                )
                self.assertIn(expected, "\n".join(current_diagnostics.finish()))

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

    def test_merged_lifecycle_history_cannot_be_rewritten(self) -> None:
        superseded = github_metadata()
        superseded["status"] = "Superseded"
        superseded["superseded_by"] = "0030"
        diagnostics = validator.Diagnostics()
        path = self.fixture.write_adr(superseded, slug="same")
        previous = validator.parse_adr(path, diagnostics)
        assert previous
        rewritten = copy.deepcopy(superseded)
        rewritten["superseded_by"] = "0031"
        path.write_text(render(rewritten), encoding="utf-8")
        current = validator.parse_adr(path, diagnostics)
        assert current
        validator.validate_transition(previous, current, diagnostics)
        self.assertIn(
            "merged superseded_by history is immutable",
            "\n".join(diagnostics.finish()),
        )

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
        self.assertEqual(
            (
                "0026",
                validator.ROOT
                / "docs/adrs/0026-file-per-decision-adr-storage-and-lifecycle.md",
            ),
            validator.resolve_legacy_id(
                repository_config, repository_adrs, "D-GH-125"
            ),
        )
        self.assertEqual(
            (
                "0023",
                validator.ROOT
                / "docs/adrs/0023-analyticdb-for-postgresql-sprint-vector-store.md",
            ),
            validator.resolve_legacy_id(
                repository_config, repository_adrs, "M-001"
            ),
        )

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
