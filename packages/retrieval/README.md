# `@reflo/retrieval`

Owns Reflo's `chunk-v1`, `embedding-v1`, and `vector-namespace-v1`
contracts. The package turns validated normalized documents into stable source
spans, routes document/query embeddings through `@reflo/model-router`, writes
owner-prefixed vectors to AnalyticDB for PostgreSQL, and resolves retrieved span
IDs through an authoritative RDS repository before source text can enter model
context.

Exact cosine search is the only enabled search mode. The SQL under `sql/` is an
AnalyticDB schema, not an RDS/dbmate migration.
