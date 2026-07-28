# Bootstrap root

This one-time root declares the ADR 0043 control plane for issue #199:

- private, versioned, AES-256-encrypted OSS state;
- TableStore locking with the exact `LockID` string key required by the OpenTofu OSS backend;
- GitHub OIDC trust restricted to one repository and the protected `dev` environment; and
- least-privilege state and lock-table access for the deployment role.

The committed partial OSS backend is disabled only for the first reviewed bootstrap apply. Immediately afterward, migrate that local bootstrap state into the created bucket and lock table using the non-secret backend metadata output, verify the remote version, and remove the local copy through the documented recovery procedure. It must not be applied until issue #199 records the required account, region, bootstrap-identity, and spending approvals. Inputs are supplied through the protected execution boundary; never commit tfvars, state, plans, account identifiers, or fingerprints copied from an unverified source.
