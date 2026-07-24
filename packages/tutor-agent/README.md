# `@reflo/tutor-agent`

The online Tutor Agent orchestrates the stored-evidence Flow B loop without
owning grading, mastery, scheduling, retrieval, or model-provider behavior.

Its `nextAction` policy:

- requires a completed lesson exposure, at least two eligible attempts, a
  latest failing eligible result, and mastery strictly below `0.60000`;
- generates replacements only through `lesson.reteach.v1`, verifies a changed
  strategy tag, resolves source-span provenance against the authorized concept,
  and requires embedding cosine similarity strictly below `0.85`;
- serves at most two replacement lessons for one concept in one session;
- waits for a stored eligible re-test, records an evidence-only mastery delta
  after a correct result, or uses the existing FSRS projection for a later
  review after the second failure; and
- records tutor questions as sanitized events while returning only citations
  resolved from server-authorized source spans.

The service is dependency-injected. `PostgresTutorAgentRepository` in
`@reflo/db` provides the owner-scoped durable adapter and also supplies the
later-review scheduler port from the existing review projection. Generated
lesson bytes remain behind the artifact-store port; model calls remain behind
the shared typed router.

Run the focused checks with:

```sh
corepack pnpm --filter @reflo/tutor-agent test
corepack pnpm --filter @reflo/tutor-agent lint
corepack pnpm --filter @reflo/tutor-agent build
```
