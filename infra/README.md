# Infrastructure boundary

OpenTofu 1.12.0 with `aliyun/alicloud` 1.283.0 is the effective infrastructure path. This scaffold establishes only the approved source and environment boundaries:

- `bootstrap/`: one-time remote-state, locking, and OIDC control-plane bootstrap
- `environments/dev/`: isolated development root
- `environments/staging/`: isolated staging root
- `environments/pilot/`: isolated pilot root
- `modules/`: reusable Alibaba Cloud modules

Issue #199 introduces the first HCL for the bootstrap control plane and the non-compute dev foundation. It follows ADR 0043's protected-GitHub-secret exception, OIDC-to-STS identity, private OSS/TableStore state boundary, explicit roots, and no-workspace rule. Paid runtime classes and deployable services remain gated on the human approvals listed in issue #199; the presence of configuration never authorizes a plan or apply.

Repository checks already reject committed state, plans, variable-value files, crash logs, unpinned declared core/provider versions, local backends outside bootstrap, and workspace-based environment selection.
