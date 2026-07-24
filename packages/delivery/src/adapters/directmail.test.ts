import { describe, expect, it, vi } from "vitest";

import { DirectMailDemoMessageAdapter } from "./directmail.js";

describe("DirectMail demo adapter", () => {
  it("sends a one-recipient link and explicitly rejects email replies", async () => {
    const singleSendMail = vi
      .fn()
      .mockResolvedValue({ body: { requestId: "request-43" } });
    const adapter = new DirectMailDemoMessageAdapter(
      { singleSendMail },
      {
        fromAlias: "Reflo",
        senderAddress: "demo@reflo.example",
      },
    );
    const result = await adapter.send({
      deliveryId: "30000000-0000-4000-8000-000000000043",
      demoOnlyLabel: "Staff-controlled demo only",
      emailLink: "https://app.reflo.example/demo/review?token=signed",
      expiresAt: "2026-07-25T00:00:00.000Z",
      provider: "email",
      questions: [],
      recipient: "staff@example.test",
    });

    expect(result.providerMessageId).toBe("directmail/request-43");
    const request = singleSendMail.mock.calls[0][0];
    expect(request.toAddress).toBe("staff@example.test");
    expect(request.replyToAddress).toBe(false);
    expect(request.textBody).toContain("Email replies are not read or graded");
  });
});
