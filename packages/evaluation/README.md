# Reflo release-gate evaluation

`@reflo/evaluation` implements the repository-owned `evaluation-contract-v1`
defined by D-GH-15. It validates immutable dataset manifests, enforces the exact
Week 1 execution profiles, deterministically scores performance, dual-TTS,
upload-security, and adversarial runs, emits content-addressed evidence bundles,
and publishes fail-closed environment-scoped attestations through an authorized
index port.

CI may validate schemas, fixtures, determinism, and fail-closed behavior. It
cannot pass the performance or audio gates. Those require target-production
execution and current rights, capacity, quota, legal, human-listening, and other
operational evidence required by the PRD.

After building the package, evaluate an immutable input without overwriting an
existing bundle:

```sh
corepack pnpm --filter @reflo/evaluation build
corepack pnpm --filter @reflo/evaluation evaluate -- input.json bundle.json
```

The CLI prints only a bounded GitHub-safe summary. Authoritative bundles belong
in the private evaluation-evidence store, not the client-delivery bucket or a
GitHub comment.
