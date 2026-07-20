# `@reflo/asset-delivery`

Provider-neutral private source and generated-asset delivery for Reflo's
`private-delivery-v1` contract.

The package owns:

- canonical, opaque OSS delivery keys;
- point-of-use delivery authorization over a server-resolved resource ID;
- Alibaba CDN Type A signing with a fixed 15-minute capability lifetime;
- non-persistent client metadata for byte-range playback and refresh;
- tombstone-first deletion with verified OSS absence and CDN purge completion;
- fail-closed private-bucket/CDN configuration checks.

Feature code must not accept an object key from a caller. Its repository adapter
must resolve the resource and active owner membership in one authoritative RDS
operation, with the existing RLS policy as an independent backstop. Production
composition supplies the signing secret from KMS Secrets Manager and provider
adapters that satisfy the ports in `src/ports.ts`.

This package intentionally does not provision cloud resources. The effective
infrastructure decision requires those resources to be managed through the
separately owned OpenTofu environment roots.
