# `@reflo/observability`

Demo-only, provider-neutral operational tracing with thin OTLP/HTTP adapters for
Langfuse model traces and Alibaba Cloud Simple Log Service (SLS) health traces.

The package implements `demo-operational-trace-v1`, a closed schema. It accepts
only bounded stage, operation, status, timing, prompt/model version, validation,
and random demo-correlation fields. It has no extension map, tags object, raw
diagnostics, URLs, filenames, titles, passages, answers, prompts/results,
generated content, contact fields, learner/request identifiers, provider
payloads, tokens, or credentials.

Model-router logical calls go to Langfuse and are projected into SLS health
spans for ingestion, generation, and grading. The API composition emits SLS
health spans for staff-test delivery. The checked-in
`SLS_DEMO_HEALTH_DASHBOARD` contract defines one panel and one executable SLS
query for ingestion, generation, grading, and test delivery with trace count,
success/failure/replay counts, and p95 latency. The dashboard is labeled:

> Seeded/staff-controlled Demo Day operational health; not production privacy
> or pilot-readiness evidence

## Configuration

Tracing is disabled unless `REFLO_DEMO_TRACING_MODE=staff-only-demo-v1`.
Enabled mode requires:

- `REFLO_DEMO_TRACE_RUN_ID=demo-<32 lowercase hex characters>` generated for a
  rehearsal, never derived from a learner, owner scope, course, source,
  delivery, contact, filename, or request path.
- `REFLO_LANGFUSE_BASE_URL`, `REFLO_LANGFUSE_PUBLIC_KEY`, and
  `REFLO_LANGFUSE_SECRET_KEY`.
- `REFLO_SLS_OTEL_ENDPOINT` as the complete HTTPS
  `/opentelemetry/v1/traces` endpoint, `REFLO_SLS_PROJECT`,
  `REFLO_SLS_TRACE_INSTANCE_ID`, `REFLO_SLS_ACCESS_KEY_ID`, and
  `REFLO_SLS_ACCESS_KEY_SECRET`.

Outside local development both endpoints must use HTTPS, and the SLS endpoint
must end in `.log.aliyuncs.com`. Runtime credentials are KMS-injected
environment values and must not be committed or logged. Provider-resource
creation, paid capacity, provider retention/deletion configuration, and
production learner privacy lifecycle hooks are not implemented or claimed by
this package.

Langfuse uses its current OTLP/HTTP trace endpoint with Basic authentication
and ingestion version 4. SLS uses its OTLP/HTTP trace endpoint and the four
documented `x-sls-otel-*` authentication headers. Both adapters send credentials
only in headers and return bounded status-only errors without reading provider
response bodies.

Official integration references:

- <https://langfuse.com/integrations/native/opentelemetry>
- <https://www.alibabacloud.com/help/en/sls/import-trace-data-from-opentelemetry-to-log-service>
