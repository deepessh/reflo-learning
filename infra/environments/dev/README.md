# Development environment root

This issue #199 root declares the minimum bounded Alibaba Cloud dev topology:

- an isolated resource group and application/data network boundaries;
- private OSS buckets for artifacts, ClamAV snapshots, quarantine, delivery,
  and web assets;
- one API/orchestrator ECS host and one session-isolated Function Compute
  parser with no runtime role, VPC attachment, mount, trigger, or Internet
  access;
- RDS PostgreSQL, AnalyticDB for PostgreSQL, and private RocketMQ;
- private-VPC Function Compute jobs with zero provisioned concurrency and an
  EventBridge-managed, synchronous, one-message RocketMQ trigger;
- optional overseas web and private-delivery CDN domains, enabled only after
  the owner supplies the approved hostname boundary; and
- action-scoped ECS, Function Compute, and deployment identities.

Every paid class is a required value inside
`approved_runtime_configuration`; there are no SKU defaults. A valid issue
#199 approval-comment URL is also required. Singapore `ap-southeast-1` is the
only authorized dev region. The protected deployment supplies the non-secret
Alibaba account ID used by the API to address the parser function. This
configuration does not authorize an account, resource class, spend, bootstrap
identity, hostname, messaging destination, plan, or apply.

The managed RocketMQ trigger introduces a separately billed EventBridge event
stream. It must use the owner-approved metering mode and allowance, and its
service-linked roles must be activated before the protected plan. The dev apply
also remains blocked until issue #199 records an authorized transactional
outbox publisher and dead-letter destination. The immutable Piper layer is
packaged with the jobs function but forced to `blocked`; a later activation
still requires ADR 0011's legal, security, capacity, and listening evidence.
The revised conservative BOM is USD 401.14/month, so it also requires an
owner-approved cost reduction or a new ceiling before planning.

The partial OSS backend receives `bucket`, `region`,
`tablestore_endpoint`, and `tablestore_table` only from the protected workflow.
Credentials remain in its repository/environment-bound OIDC context. Dev
runtime secrets arrive as the one protected JSON object `runtime_secrets` and
become secret-bearing encrypted state under ADR 0043. No raw plan or state is
uploaded as a GitHub artifact.

The bounded dev root contains no Alibaba KMS Secrets Manager, SLS, or Alibaba
Container Registry. Deployment artifacts use SHA-256-addressed private OSS
keys. ECS consumes the API archive by exact digest; Function Compute consumes
the content-addressed jobs ZIP, its activation-blocked Piper layer, plus the
parser code and three immutable parser layers. Operational traces use the
repository's closed structured-log contract rather than SLS.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for bootstrap, protected deployment,
recovery, rollback, and teardown procedures.
