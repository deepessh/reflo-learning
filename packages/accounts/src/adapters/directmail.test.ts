import { describe, expect, it, vi } from "vitest";

import type { MagicLinkMessage } from "../contracts.js";
import {
  DirectMailTransactionalEmailAdapter,
  TransactionalEmailDeliveryError,
  type DirectMailSingleSendClient,
} from "./directmail.js";

const message: MagicLinkMessage = {
  destination: "learner@example.com",
  expiresAt: new Date("2026-07-20T12:10:00.000Z"),
  loginUrl:
    "https://app.reflo.example/auth/callback?token=opaque-token&next=%3Clibrary%3E",
};

describe("DirectMail transactional-email adapter", () => {
  it("maps one magic link to SingleSendMail with tracking disabled", async () => {
    const singleSendMail = vi.fn().mockResolvedValue({});
    const adapter = new DirectMailTransactionalEmailAdapter(
      { singleSendMail } satisfies DirectMailSingleSendClient,
      { fromAlias: "Reflo", senderAddress: "signin@reflo.example" },
    );

    await adapter.sendMagicLink(message);

    expect(singleSendMail).toHaveBeenCalledTimes(1);
    expect(singleSendMail.mock.calls[0]?.[0]).toMatchObject({
      accountName: "signin@reflo.example",
      addressType: 1,
      clickTrace: "0",
      fromAlias: "Reflo",
      replyToAddress: false,
      subject: "Your secure Reflo sign-in link",
      toAddress: "learner@example.com",
      unSubscribeFilterLevel: "disabled",
      unSubscribeLinkType: "disabled",
    });
    const request = singleSendMail.mock.calls[0]?.[0];
    expect(request?.textBody).toContain(message.loginUrl);
    expect(request?.htmlBody).toContain("&amp;next=%3Clibrary%3E");
    expect(request?.bccAddress).toBeUndefined();
  });

  it("normalizes provider failures without leaking contact data or links", async () => {
    const adapter = new DirectMailTransactionalEmailAdapter(
      {
        singleSendMail: vi
          .fn()
          .mockRejectedValue(
            new Error(
              `provider rejected ${message.destination} for ${message.loginUrl}`,
            ),
          ),
      },
      { fromAlias: "Reflo", senderAddress: "signin@reflo.example" },
    );

    const error = await adapter.sendMagicLink(message).catch((value) => value);

    expect(error).toBeInstanceOf(TransactionalEmailDeliveryError);
    expect(JSON.stringify(error)).not.toContain(message.destination);
    expect(String(error)).not.toContain("opaque-token");
  });

  it("refuses recipient lists before calling the provider", async () => {
    const singleSendMail = vi.fn().mockResolvedValue({});
    const adapter = new DirectMailTransactionalEmailAdapter(
      { singleSendMail },
      { fromAlias: "Reflo", senderAddress: "signin@reflo.example" },
    );

    await expect(
      adapter.sendMagicLink({
        ...message,
        destination: "first@example.com,second@example.com",
      }),
    ).rejects.toBeInstanceOf(TransactionalEmailDeliveryError);
    expect(singleSendMail).not.toHaveBeenCalled();
  });
});
