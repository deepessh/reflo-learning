# `@reflo/observability`

Demo-only, provider-neutral operational tracing with a thin OTLP/HTTP adapter
for Langfuse model traces and a repository-owned structured operational log.

The package implements `demo-operational-trace-v1`, a closed schema. It accepts
only bounded stage, operation, status, timing, prompt/model version, validation,
and random demo-correlation fields. It has no extension map, raw diagnostics,
URLs, filenames, titles, passages, answers, generated content, contact fields,
learner/request identifiers, provider payloads, tokens, or credentials.

Model-router logical calls go to Langfuse. API composition emits one-line JSON
operational records prefixed with `reflo.demo-operational-trace`; every record
is validated against the closed safe schema before reaching the process log.
This preserves the repository trace contract without provisioning SLS. The
historical SLS adapter, projection, and dashboard remain testable compatibility
artifacts but are not selected by the bounded dev runtime.

## Configuration

Tracing is disabled unless `REFLO_DEMO_TRACING_MODE=staff-only-demo-v1`.
Enabled mode requires:

- `REFLO_DEMO_TRACE_RUN_ID=demo-<32 lowercase hex characters>`, generated for a
  rehearsal and never derived from a learner, owner scope, source, contact,
  filename, or request path.
- `REFLO_LANGFUSE_BASE_URL`, `REFLO_LANGFUSE_PUBLIC_KEY`, and
  `REFLO_LANGFUSE_SECRET_KEY`.

Outside local development the Langfuse endpoint must use HTTPS. Credentials
appear only in provider authentication headers and never in trace attributes.
The operational log contains only the closed safe event. Container-log
retention and access remain deployment controls; the dev stack provisions no
SLS project or SLS credential.
