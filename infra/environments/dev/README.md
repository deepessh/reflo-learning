# Development environment root

The issue #199 root uses a partial OSS backend so credentials remain in the protected GitHub OIDC execution context. Initialization must provide the bootstrap output values for `bucket`, `region`, `tablestore_endpoint`, and `tablestore_table`; the committed configuration fixes the environment prefix/key, encryption, and private ACL.

The current slice declares the isolated resource group, segmented VPC/VSwitch/security-group foundation, and distinct private buckets for deployment artifacts, ClamAV snapshots, quarantine, validated delivery assets, and web artifacts. All buckets block public access and use AES-256 server-side encryption. Artifact and scanner-snapshot buckets retain version history.

Compute, database, vector-store, queue, CDN, Function Compute, container-registry, observability, DNS, and messaging resources remain deliberately undeclared until issue #199 records the required region, resource-class/spending, identity, hostname, and dedicated-destination approvals. No plan or apply from this root is authorized before then.
