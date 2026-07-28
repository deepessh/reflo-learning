# Infrastructure boundary

OpenTofu 1.12.0 with `aliyun/alicloud` 1.283.0 is the effective infrastructure path. This scaffold establishes only the approved source and environment boundaries:

- `bootstrap/`: one-time remote-state, locking, and OIDC control-plane bootstrap
- `environments/dev/`: isolated development root
- `environments/staging/`: isolated staging root
- `environments/pilot/`: isolated pilot root
- `modules/`: reusable Alibaba Cloud modules

Issue #199 declares the bootstrap, non-compute foundation, and parametric
minimal runtime topology. It follows ADR 0043's protected-GitHub-secret
exception, immutable repository OIDC identity, private OSS/TableStore state
boundary, explicit roots, and no-workspace rule. The bounded dev deployment
excludes Alibaba KMS Secrets Manager, SLS, and Alibaba Container Registry.
Every paid runtime class is required and has no default; the presence of
configuration never authorizes a plan or apply.

Repository checks already reject committed state, plans, variable-value files, crash logs, unpinned declared core/provider versions, local backends outside bootstrap, and workspace-based environment selection.
