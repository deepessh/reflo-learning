# Infrastructure boundary

OpenTofu 1.12.0 with `aliyun/alicloud` 1.283.0 is the effective infrastructure path. This scaffold establishes only the approved source and environment boundaries:

- `bootstrap/`: one-time remote-state, locking, and OIDC control-plane bootstrap
- `environments/dev/`: isolated development root
- `environments/staging/`: isolated staging root
- `environments/pilot/`: isolated pilot root
- `modules/`: reusable Alibaba Cloud modules

No cloud resources are declared or purchased by issue #26. A separately triaged implementation issue must introduce the first HCL, exact provider lock file, remote OSS/TableStore backend configuration, roles, modules, and environment resources. That work must follow D-GH-5, including KMS-only runtime secret payloads, OIDC-to-STS CI identity, no OpenTofu workspaces, exact plans, approvals, and human authorization for spending.

Repository checks already reject committed state, plans, variable-value files, crash logs, unpinned declared core/provider versions, local backends outside bootstrap, and workspace-based environment selection.
