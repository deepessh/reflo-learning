# `@reflo/retrieval`

Owns Reflo's `chunk-v1`, `embedding-v1`, `vector-namespace-v1`,
`curriculum-partition-v1`, and `curriculum-compose-v1` contracts. The package
turns validated normalized documents into stable source spans, routes
document/query embeddings through `@reflo/model-router`, writes owner-prefixed
vectors to AnalyticDB for PostgreSQL, and resolves retrieved span IDs through an
authoritative RDS repository before source text can enter model context.

Curriculum generation partitions the complete ordered source into
section-aware windows of at most 12 spans and 8,000 source tokens. It executes
at most four traced `curriculum.segment.v1` calls concurrently under one
480-second parent deadline, preserves a 48-second finalization reserve, durably
replays completed child results, and composes `curriculum-v2` deterministically.
Missing, foreign, stale, or malformed child results fail closed.

Exact cosine search is the only enabled search mode. The SQL under `sql/` is an
AnalyticDB schema, not an RDS/dbmate migration.
