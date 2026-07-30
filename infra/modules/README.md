# OpenTofu modules

Exact-pinned, reviewable Alibaba Cloud modules shared by explicit environment roots:

- `private-oss-bucket`: private ACL, Block Public Access, AES-256 server-side encryption, optional versioning, and destroy protection.
- `dev-network`: isolated VPC, application/data VSwitches, default-deny east-west security groups, and the one explicit application-to-PostgreSQL ingress rule.

Modules never select environments with OpenTofu workspaces and contain no credentials, secret values, provider configuration, remote-state access, or apply behavior.
