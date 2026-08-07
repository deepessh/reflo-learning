import type {
  DeliveryAnswerFinalization,
  DeliveryMessage,
} from "../contracts.js";
import { DeliveryError } from "../errors.js";
import { REVIEW_MESSAGE_COPY } from "../experience.js";
import type { DemoMessagePort } from "../ports.js";
import { encodeTelegramCallback } from "../telegram-callback.js";

export interface TelegramAdapterConfig {
  readonly botToken: string;
  readonly fetch: typeof fetch;
}

export class TelegramDemoMessageAdapter implements DemoMessagePort {
  readonly provider = "telegram" as const;

  constructor(private readonly config: TelegramAdapterConfig) {
    if (
      !/^\d+:[A-Za-z0-9_-]{30,}$/.test(config.botToken) ||
      typeof config.fetch !== "function"
    ) {
      throw new DeliveryError("invalid_configuration");
    }
  }

  async send(message: DeliveryMessage): Promise<{
    readonly providerMessageId: string;
  }> {
    if (
      message.provider !== this.provider ||
      !/^\d+$/.test(message.recipient) ||
      message.questions.length < 1 ||
      message.questions.length > 3
    ) {
      throw new DeliveryError("invalid_input");
    }
    const body = {
      chat_id: message.recipient,
      disable_notification: false,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: message.questions.flatMap((question, questionIndex) =>
          question.responseOptions.map((option, answerIndex) => [
            {
              callback_data: encodeTelegramCallback({
                answerIndex,
                deliveryId: message.deliveryId,
                deliveryItemId: question.deliveryItemId,
              }),
              text: `${message.questions.length > 1 ? questionIndex + 1 : ""}${answerLetter(answerIndex)} · ${boundedLabel(option)}`,
            },
          ]),
        ),
      },
      text: [
        `🧠 <b>${escapeHtml(REVIEW_MESSAGE_COPY.telegramHeading)}</b>`,
        `<i>${message.questions.length === 1 ? "One quick question · about 30 seconds" : `${message.questions.length} quick questions`}</i>`,
        ...message.questions.map(
          (question, index) =>
            `<b>${index + 1}. ${escapeHtml(question.prompt)}</b>\n<blockquote>${question.responseOptions
              .map(
                (option, optionIndex) =>
                  `${answerLetter(optionIndex)}. ${escapeHtml(option)}`,
              )
              .join("\n")}</blockquote>`,
        ),
        "<i>Tap one answer below.</i>",
      ].join("\n\n"),
    };
    let response: Response;
    try {
      response = await this.config.fetch(
        `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
        {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new DeliveryError("dispatch_ambiguous");
    }
    if (!response.ok) {
      throw new DeliveryError("dispatch_failed");
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new DeliveryError("dispatch_ambiguous");
    }
    const messageId = telegramMessageId(result);
    if (messageId === null) {
      throw new DeliveryError("dispatch_ambiguous");
    }
    return { providerMessageId: `telegram/${messageId}` };
  }

  async acknowledge(
    rawUpdate: string,
    finalizations: readonly Pick<DeliveryAnswerFinalization, "correct">[],
  ): Promise<void> {
    const callback = telegramFeedbackContext(rawUpdate);
    const result = finalizations[0];
    if (result === undefined || finalizations.length !== 1) {
      throw new DeliveryError("invalid_input");
    }
    const status = result.correct
      ? "✅ <b>Correct</b>"
      : "↗️ <b>Keep going</b>";
    const guidance = result.correct
      ? "Nice work — Reflo updated your learning progress from this answer."
      : "Your answer is saved. Reflo will keep this concept in your review plan.";
    const response = await this.#post("editMessageText", {
      chat_id: callback.chatId,
      message_id: callback.messageId,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: callback.remainingKeyboard },
      text: [
        escapeHtml(callback.messageText),
        status,
        "<b>Response received and graded.</b>",
        escapeHtml(guidance),
      ].join("\n\n"),
    });
    if (!response.ok && !(await telegramMessageWasAlreadyEdited(response))) {
      throw new DeliveryError(
        response.status === 429 || response.status >= 500
          ? "dispatch_ambiguous"
          : "invalid_input",
      );
    }
    await this.#answerCallbackBestEffort(
      callback.callbackQueryId,
      result.correct
        ? "Correct — received and graded."
        : "Received and graded.",
    );
  }

  async #answerCallbackBestEffort(
    callbackQueryId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.#post("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        show_alert: false,
        text,
      });
    } catch {
      // The durable edited message is the source of truth. A missed transient
      // toast must not reinterpret or replay an already persisted answer.
    }
  }

  async #post(
    method: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    try {
      return await this.config.fetch(
        `https://api.telegram.org/bot${this.config.botToken}/${method}`,
        {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new DeliveryError("dispatch_ambiguous");
    }
  }
}

export function createTelegramDemoMessageAdapter(
  config: Omit<TelegramAdapterConfig, "fetch"> & {
    readonly fetch?: typeof fetch;
  },
): TelegramDemoMessageAdapter {
  return new TelegramDemoMessageAdapter({
    botToken: config.botToken,
    fetch: config.fetch ?? globalThis.fetch,
  });
}

function telegramMessageId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = (value as Record<string, unknown>).result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const messageId = (result as Record<string, unknown>).message_id;
  return typeof messageId === "number" && Number.isSafeInteger(messageId)
    ? String(messageId)
    : null;
}

function boundedLabel(value: string): string {
  return Array.from(value).slice(0, 24).join("");
}

function answerLetter(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function telegramFeedbackContext(rawUpdate: string): {
  readonly callbackQueryId: string;
  readonly chatId: string;
  readonly messageId: number;
  readonly messageText: string;
  readonly remainingKeyboard: readonly (readonly {
    readonly callback_data: string;
    readonly text: string;
  }[])[];
} {
  let value: unknown;
  try {
    value = JSON.parse(rawUpdate);
  } catch {
    throw new DeliveryError("invalid_input");
  }
  const update = asObject(value);
  const callback = asObject(update?.callback_query);
  const message = asObject(callback?.message);
  const chat = asObject(message?.chat);
  const chatId = String(chat?.id ?? "");
  if (
    typeof callback?.id !== "string" ||
    typeof callback?.data !== "string" ||
    !/^\d+$/.test(chatId) ||
    !Number.isSafeInteger(message?.message_id) ||
    typeof message?.text !== "string" ||
    message.text.length === 0
  ) {
    throw new DeliveryError("invalid_input");
  }
  return {
    callbackQueryId: callback.id,
    chatId,
    messageId: Number(message.message_id),
    messageText: message.text,
    remainingKeyboard: remainingTelegramKeyboard(message, callback.data),
  };
}

function remainingTelegramKeyboard(
  message: Record<string, unknown>,
  selectedCallback: string,
): readonly (readonly {
  readonly callback_data: string;
  readonly text: string;
}[])[] {
  const markup = asObject(message.reply_markup);
  if (!Array.isArray(markup?.inline_keyboard)) return [];
  const remaining: { callback_data: string; text: string }[][] = [];
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    const buttons: { callback_data: string; text: string }[] = [];
    for (const value of row) {
      const button = asObject(value);
      if (
        typeof button?.callback_data === "string" &&
        typeof button.text === "string" &&
        Buffer.byteLength(button.callback_data, "utf8") <= 64 &&
        Array.from(button.text).length <= 64 &&
        button.callback_data !== selectedCallback
      ) {
        buttons.push({
          callback_data: button.callback_data,
          text: button.text,
        });
      }
    }
    if (buttons.length > 0) remaining.push(buttons);
  }
  return remaining;
}

async function telegramMessageWasAlreadyEdited(
  response: Response,
): Promise<boolean> {
  try {
    const value: unknown = await response.json();
    const body = asObject(value);
    return (
      typeof body?.description === "string" &&
      body.description.toLowerCase().includes("message is not modified")
    );
  } catch {
    return false;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export {
  createTelegramLongPollingReceiver,
  TelegramLongPollingReceiver,
} from "./telegram-polling.js";
