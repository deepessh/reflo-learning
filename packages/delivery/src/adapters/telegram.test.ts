import { describe, expect, it, vi } from "vitest";

import { TelegramDemoMessageAdapter } from "./telegram.js";

describe("Telegram demo adapter", () => {
  it("sends one bounded staff-only message with delivery-bound callbacks", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 43 } }), {
        status: 200,
      }),
    );
    const adapter = new TelegramDemoMessageAdapter({
      botToken: `123:${"a".repeat(32)}`,
      fetch,
    });
    const result = await adapter.send({
      deliveryId: "30000000-0000-4000-8000-000000000043",
      emailLink: null,
      expiresAt: "2026-07-25T00:00:00.000Z",
      provider: "telegram",
      questions: [
        {
          conceptId: "20000000-0000-4000-8000-000000000043",
          deliveryItemId: "40000000-0000-4000-8000-000000000043",
          prompt: "Choose B",
          quizItemId: "50000000-0000-4000-8000-000000000043",
          responseOptions: ["A", "B"],
        },
      ],
      recipient: "100123456",
    });

    expect(result.providerMessageId).toBe("telegram/43");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text).toContain("A quick Reflo review");
    expect(body.text.toLowerCase()).not.toContain("demo");
    expect(body.reply_markup.inline_keyboard[1][0].callback_data).toBe(
      "reflo:30000000-0000-4000-8000-000000000043:40000000-0000-4000-8000-000000000043:1",
    );
  });
});
