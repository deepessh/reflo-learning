# `@reflo/accounts`

This package owns the provider-neutral `auth-v1` account lifecycle used by the
API. It implements ten-minute, keyed-digest magic links; 256-bit opaque server
sessions; exact HTTPS callback origins; host-only cookie and CSRF contracts;
recent-authentication enforcement; and the owner-scoped library,
session-history, and course-progress read ports.

Course progress applies the fixed-point `exam-readiness-profile-v1` contract:
only generation-current reviewed mappings with sufficient eligible assessment
evidence can produce a score. Ineligible courses remain labeled Course Mastery
Estimate, while eligible readiness discloses mapping coverage and frozen
calibration sample/error metadata without claiming a certification outcome.

Composition roots must provide:

- a database-owned `AccountRepository` (the PostgreSQL implementation lives in
  `@reflo/db`),
- a narrow `TransactionalEmailPort` adapter selected from the approved
  allowlist,
- four independent 32-byte keys from the environment's secret manager, and
- an exact list of approved HTTPS callback origins.

The package never logs email addresses, magic links, bearer secrets, or
digests. Production must not use the deterministic adapters exported from
`@reflo/accounts/testing`.
