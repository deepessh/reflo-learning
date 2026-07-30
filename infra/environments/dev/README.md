# Development environment root

This issue #199 root declares the minimum bounded Alibaba Cloud dev topology:

- an isolated resource group and application/data network boundaries;
- private OSS buckets for artifacts, ClamAV snapshots, quarantine, delivery,
  and web assets;
- one API/orchestrator ECS host and one session-isolated Function Compute
  parser with no runtime role, VPC attachment, mount, trigger, or Internet
  access;
- RDS PostgreSQL, AnalyticDB for PostgreSQL, and private RocketMQ;
- private-VPC Function Compute jobs with zero provisioned concurrency, a
  dedicated 24-hour RocketMQ EventBridge DLQ, and a one-message trigger that
  stays fail-closed until its Singapore activation proof;
- one separately supervised outbox relay on the API ECS host and one
  non-daemon, operator-only audited DLQ redrive command;
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
service-linked roles must be activated before the protected plan. The initial
dev configuration must set
`approved_runtime_configuration.rocketmq.activation_status` to `blocked`.
Only a separately reviewed exact plan after ADRs 0045 and 0046's Singapore
proof may set it to `active`, which enables the relay and changes the trigger
from `ErrorsTolerance: NONE` to `ALL` with the exact private DLQ. The immutable
Piper layer is packaged with the jobs function but forced to `blocked`; a
later activation still requires ADR 0011's legal, security, capacity, and
listening evidence.

RocketMQ operational alerts use the existing ECS `journald` boundary rather
than activating SLS, ARMS, Managed Service for Prometheus, or an additional
service-linked role. Relay and operator processes emit only the closed
`reflo-rocketmq-operational-alert-v1` schema for DLQ handoff/backlog,
oldest-record age, retry guard, validator rejection, ambiguous publication,
publication failure, and configuration drift. The Singapore proof must
exercise every alert, verify its bounded safe fields, and verify the protected
operator can retrieve it from the exact service journal before activation.

The owner-approved conservative BOM is USD 401.14/month under a USD 425
ceiling, with a USD 300 alert and a freeze/teardown review at USD 375.

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
