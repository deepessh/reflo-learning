# Bounded dev deployment runbook

This runbook is executable only after the corresponding sanitized human
approvals are recorded on issue #199. It never authorizes spending or expands
the staff-controlled Demo Day boundary.

## 1. Approval preflight

Confirm issue #199 contains owner-authored approval for:

1. the designated Alibaba Cloud International account;
2. the exact paid classes and quantities plus a monthly ceiling;
3. the one-time bootstrap identity and GitHub OIDC provisioning;
4. the dedicated staff hostname boundary, if CDN domains will be enabled; and
5. exactly one dedicated Telegram or email destination.

Singapore `ap-southeast-1` and dev are already the only region/environment
accepted by this root. Staging, public access, external learners, external
uploads, external recipients, KMS Secrets Manager, SLS, and Alibaba Container
Registry remain excluded.

## 2. Prepare the GitHub `dev` environment

Require a reviewer, restrict deployments to `main`, and configure:

Environment variables:

- `REFLO_ALIBABA_REGION=ap-southeast-1`
- `REFLO_ALIBABA_OIDC_AUDIENCE`
- `REFLO_ALIBABA_OIDC_PROVIDER_ARN`
- `REFLO_ALIBABA_DEV_DEPLOYMENT_ROLE_ARN`
- `REFLO_DEV_STATE_BUCKET`
- `REFLO_DEV_LOCK_ENDPOINT`
- `REFLO_DEV_LOCK_TABLE`
- `REFLO_DEV_BUCKET_NAMES`: JSON matching `bucket_names`
- `REFLO_DEV_SUBNETS`: JSON matching `subnets`
- `REFLO_DEV_RUNTIME_CONFIGURATION`: JSON matching
  `approved_runtime_configuration`, copied exactly from the approved BOM. The
  protected workflow derives artifact keys and digests directly from its
  freshly generated immutable manifest.

Environment secret:

- `REFLO_DEV_RUNTIME_SECRETS`: JSON matching `runtime_secrets`

Do not configure an Alibaba AccessKey. Do not put account IDs, role/provider
ARNs, bucket names, hostnames, messaging identifiers, or secret JSON in issues
or workflow inputs.

## 3. Bootstrap once

Use a separately approved short-lived bootstrap identity. Query
`GET /repos/deepessh/reflo-learning/actions/oidc/customization/sub` and supply
the exact returned `sub_claim_prefix`; do not reconstruct it from the
repository name. Run bootstrap from an encrypted, mode-0700 temporary
directory, with values supplied through protected environment variables.
Never create a tfvars file in the repository.

Initialize bootstrap with `-backend=false`, validate, save a reviewed plan only
inside that temporary directory, and apply that exact plan. Then immediately
initialize the committed OSS backend with the new private bucket and TableStore
lock values and use `tofu init -migrate-state`. Verify:

- state bucket ACL private, Block Public Access enabled, AES-256 enabled, and
  versioning enabled;
- the lock table has exactly one string primary key named `LockID`;
- the role trust subject equals the immutable repository prefix plus
  `:environment:dev`;
- the role has state/lock access and only the action-scoped dev service-family
  policy; and
- no local state remains after successful migration.

The bootstrap state is a recovery boundary and is never uploaded to GitHub.

## 4. Package immutable artifacts

The protected workflow runs `pnpm package:dev-deployment`. It produces, under
`.artifacts/deployment/`, an API tarball, jobs ZIP, parser OCI archive, and
`manifest.json`. A generated `deployment.tfvars.json` passes the same non-secret
manifest to OpenTofu. The manifest records the exact Git commit, SHA-256
digests, and content-addressed OSS keys. The directory is ignored and must
never contain runtime configuration or secrets.

The parser archive is built from the exact-pinned Containerfile and loaded
directly from private OSS with `podman load`; no registry is involved. The ECS
base images approved in the BOM must already contain `ossutil`, and the parser
base image must contain rootless Podman. Do not substitute mutable artifact
keys or image tags for the recorded digests.

## 5. Protected plan and apply

From Actions, run **Deploy protected dev** on `main` with:

- the exact 40-character main commit; and
- the exact sanitized issue #199 spending-approval comment URL.

The `dev` environment review happens before the job receives secrets or an
OIDC token. The job checks out only that commit, verifies the exact OpenTofu
download, packages artifacts, requests a short-lived GitHub OIDC token, and
creates one fresh saved plan on encrypted ephemeral runner storage. It records
only the plan SHA-256 and sanitized metadata, applies that exact file under the
environment concurrency lock, deletes it, and requires a no-change follow-up
plan. Any changed configuration, artifact identity, commit, BOM, or approval
reference requires a new workflow dispatch and environment review.

Do not copy the console plan, raw state, runner files, hostnames, destination
identifiers, or secrets into GitHub.

## 6. Smoke and rollback

Use only seeded, synthetic, rights-cleared, and staff-controlled identities.
Record exact observed results for health, staff authentication, seeded online
Flow B, one approved PDF upload, the selected messaging channel, dependency
failure display, and signed private delivery. These are deployment smoke
observations, not p95, security qualification, production readiness, or pilot
evidence.

Application rollback selects an earlier immutable API/jobs/parser manifest and
runs a newly reviewed deployment. Infrastructure recovery is a reviewed
roll-forward or new rollback plan; never edit state manually.

## 7. Recovery and teardown

For lock recovery, first prove no apply is running, identify the exact stale
`LockID`, obtain named break-glass approval, and use `tofu force-unlock` only
against the initialized dev backend. For state recovery, select a known-good
private OSS object version, preserve the current version, restore through a
reviewed temporary copy, and run `tofu plan` before mutation.

After Demo Day, disable the workflow, create and review an exact destroy plan
for the dev root, and destroy only those state-addressed dev resources. The
foundation's `prevent_destroy` guards require an explicit reviewed code change
before final foundation deletion; never bypass them with state removal. Retain
the protected bootstrap recovery boundary until the owner authorizes its
separate teardown. Rotate every dev secret, prove old credentials fail, revoke
the test messaging token if no longer needed, and record only sanitized
completion evidence.
