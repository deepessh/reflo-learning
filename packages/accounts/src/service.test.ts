import { describe, expect, it } from "vitest";

import {
  AccountInputError,
  AccountService,
  FixedWindowAuthAbuseLimiter,
} from "./service.js";
import {
  FixedAccountClock,
  InMemoryAccountRepository,
  RecordingEmailPort,
  SequentialAccountIdGenerator,
} from "./testing.js";

const key = (value: number) => new Uint8Array(32).fill(value);

function createFixture() {
  const clock = new FixedAccountClock(new Date("2026-07-20T12:00:00.000Z"));
  const emailPort = new RecordingEmailPort();
  const repository = new InMemoryAccountRepository();
  const service = new AccountService({
    abuseLimiter: new FixedWindowAuthAbuseLimiter(),
    callbackOrigins: ["https://app.reflo.example"],
    clock,
    emailEncryptionKey: key(1),
    emailPort,
    idGenerator: new SequentialAccountIdGenerator(),
    lookupKey: key(2),
    magicLinkDailyLimit: 200,
    magicLinkTotalLimit: 2_000,
    repository,
    sessionDigestKey: key(3),
    tokenDigestKey: key(4),
  });
  return { clock, emailPort, repository, service };
}

describe("auth-v1 account service", () => {
  it("issues a ten-minute single-use magic link without retaining plaintext email", async () => {
    const { emailPort, repository, service } = createFixture();

    await service.requestMagicLink(
      "  Learner@Example.COM ",
      "https://app.reflo.example",
    );

    expect(emailPort.messages).toHaveLength(1);
    expect(emailPort.messages[0]?.destination).toBe("learner@example.com");
    expect(emailPort.messages[0]?.expiresAt.toISOString()).toBe(
      "2026-07-20T12:10:00.000Z",
    );
    expect(repository.issues).toHaveLength(1);
    expect(repository.issues[0]?.emailCiphertext).not.toContain(
      "learner@example.com",
    );
    expect(repository.issues[0]?.emailLookupDigest).toMatch(/^[a-f0-9]{64}$/);

    const token = new URL(emailPort.messages[0]!.loginUrl).searchParams.get(
      "token",
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = await service.redeemMagicLink(token!);
    const replay = await service.redeemMagicLink(token!);

    expect(first).toMatchObject({
      ownerScopeId: "00000000-0000-4000-8000-000000000005",
      sessionId: "00000000-0000-4000-8000-000000000003",
      userId: "00000000-0000-4000-8000-000000000002",
    });
    expect(first?.sessionSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replay).toBeNull();
  });

  it("rejects host-header style callback injection and non-HTTPS remote origins", async () => {
    const { service } = createFixture();

    await expect(
      service.requestMagicLink(
        "learner@example.com",
        "https://app.reflo.example.evil.test",
      ),
    ).rejects.toBeInstanceOf(AccountInputError);
    await expect(
      service.requestMagicLink("learner@example.com", "http://reflo.example"),
    ).rejects.toBeInstanceOf(AccountInputError);
  });

  it("requires matching session-bound CSRF proofs and revokes on deletion start", async () => {
    const { emailPort, repository, service } = createFixture();
    await service.requestMagicLink(
      "learner@example.com",
      "https://app.reflo.example",
    );
    const token = new URL(emailPort.messages[0]!.loginUrl).searchParams.get(
      "token",
    );
    const redeemed = await service.redeemMagicLink(token!);
    expect(redeemed).not.toBeNull();

    expect(
      service.verifyCsrf(
        redeemed!.sessionSecret,
        redeemed!.csrfToken,
        redeemed!.csrfToken,
      ),
    ).toBe(true);
    expect(
      service.verifyCsrf(
        redeemed!.sessionSecret,
        redeemed!.csrfToken,
        "forged",
      ),
    ).toBe(false);

    const account = await service.authenticate(redeemed!.sessionSecret);
    expect(account).not.toBeNull();
    await service.beginDeletion(account!);
    expect(repository.deletedUsers).toContain(account!.userId);
    await expect(
      service.authenticate(redeemed!.sessionSecret),
    ).resolves.toBeNull();
  });

  it("silently rate-limits repeated requests to preserve account privacy", async () => {
    const { emailPort, service } = createFixture();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await service.requestMagicLink(
        "learner@example.com",
        "https://app.reflo.example",
      );
    }
    expect(emailPort.messages).toHaveLength(4);
  });

  it("stops before the configured delivery budget without revealing exhaustion", async () => {
    const { emailPort, repository } = createFixture();
    const budgeted = new AccountService({
      abuseLimiter: new FixedWindowAuthAbuseLimiter(10, 10),
      callbackOrigins: ["https://app.reflo.example"],
      clock: new FixedAccountClock(new Date("2026-07-20T12:00:00.000Z")),
      emailEncryptionKey: key(1),
      emailPort,
      idGenerator: new SequentialAccountIdGenerator(),
      lookupKey: key(2),
      magicLinkDailyLimit: 1,
      magicLinkTotalLimit: 2,
      repository,
      sessionDigestKey: key(3),
      tokenDigestKey: key(4),
    });

    await budgeted.requestMagicLink(
      "first@example.com",
      "https://app.reflo.example",
    );
    await budgeted.requestMagicLink(
      "second@example.com",
      "https://app.reflo.example",
    );

    expect(emailPort.messages).toHaveLength(1);
    expect(repository.issues).toHaveLength(1);
  });
});
