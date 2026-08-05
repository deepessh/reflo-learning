# `@reflo/delivery`

Provider-neutral ambient review delivery for PRD F6 and Flow C.

The package reserves 1–3 due review items, sends them through a narrow Telegram
or email port, and finalizes each delivered item into one replay-safe ambient
attempt. Telegram uses a direct chat whose callback sender must match the linked
chat identity. Email uses an authenticated, user-bound, 24-hour HMAC link;
inbound email bodies are never parsed.

Runtime composition stays disabled by default and accepts only explicitly
configured channel identities. The delivery boundary does not provide public
enrollment, destination discovery, or inbound email handling.

The database package owns delivery reservation, dispatch claims, replay
receipts, attempt uniqueness, streak projection, knowledge evidence, and
authorized fixture reset. A dispatch claim is persisted before a non-idempotent
provider call; an ambiguous provider result is never blindly resent.
