import { describe, expect, it, vi } from "vitest";

import { TelegramDemoMessageAdapter } from "./telegram.js";
import { decodeTelegramCallback } from "../telegram-callback.js";

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
    expect(body.text).toContain("<b>1. Choose B</b>");
    expect(body.text).toContain("<blockquote>A. A\nB. B</blockquote>");
    expect(body.text).toContain("Tap one answer below");
    expect(body.text.toLowerCase()).not.toContain("demo");
    expect(body.parse_mode).toBe("HTML");
    expect(body.reply_markup.inline_keyboard[0][0].text).toBe("A · A");
    const callback = body.reply_markup.inline_keyboard[1][0].callback_data;
    expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
    expect(decodeTelegramCallback(callback)).toEqual({
      answerIndex: 1,
      deliveryId: "30000000-0000-4000-8000-000000000043",
      deliveryItemId: "40000000-0000-4000-8000-000000000043",
    });
  });

  it.each([
    [true, "Correct", "updated your learning progress"],
    [false, "Keep going", "keep this concept in your review plan"],
  ])(
    "replaces the buttons with durable graded feedback when correct is %s",
    async (correct, statusCopy, guidanceCopy) => {
      const fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        }),
      );
      const adapter = new TelegramDemoMessageAdapter({
        botToken: `123:${"a".repeat(32)}`,
        fetch,
      });

      await adapter.acknowledge(
        JSON.stringify({
          callback_query: {
            data: "selected-answer",
            id: "callback-43",
            message: {
              chat: { id: 100123456 },
              message_id: 43,
              reply_markup: {
                inline_keyboard: [
                  [{ callback_data: "selected-answer", text: "A · A" }],
                  [{ callback_data: "remaining-answer", text: "B · B" }],
                ],
              },
              text: "A quick Reflo review\n\n1. Choose B",
            },
          },
        }),
        [{ correct }] as never,
      );

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]![0]).toContain("/editMessageText");
      const edit = JSON.parse(fetch.mock.calls[0]![1].body);
      expect(edit).toMatchObject({
        chat_id: "100123456",
        message_id: 43,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ callback_data: "remaining-answer", text: "B · B" }],
          ],
        },
      });
      expect(edit.text).toContain(statusCopy);
      expect(edit.text).toContain("Response received and graded");
      expect(edit.text).toContain(guidanceCopy);
      expect(fetch.mock.calls[1]![0]).toContain("/answerCallbackQuery");
    },
  );

  it("treats a replayed identical message edit as acknowledged", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            description: "Bad Request: message is not modified",
            ok: false,
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        }),
      );
    const adapter = new TelegramDemoMessageAdapter({
      botToken: `123:${"a".repeat(32)}`,
      fetch,
    });

    await expect(
      adapter.acknowledge(
        JSON.stringify({
          callback_query: {
            data: "selected-answer",
            id: "callback-replay",
            message: {
              chat: { id: 100123456 },
              message_id: 43,
              text: "Already graded",
            },
          },
        }),
        [{ correct: true }] as never,
      ),
    ).resolves.toBeUndefined();
  });
});
