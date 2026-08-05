import type { DeliveryMessage } from "../contracts.js";
import { DeliveryError } from "../errors.js";
import { REVIEW_MESSAGE_COPY } from "../experience.js";
import type { DemoMessagePort } from "../ports.js";

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
      reply_markup: {
        inline_keyboard: message.questions.flatMap((question, questionIndex) =>
          question.responseOptions.map((option, answerIndex) => [
            {
              callback_data: `reflo:${message.deliveryId}:${question.deliveryItemId}:${answerIndex}`,
              text: `${questionIndex + 1}.${answerIndex + 1} ${boundedLabel(option)}`,
            },
          ]),
        ),
      },
      text: [
        REVIEW_MESSAGE_COPY.telegramHeading,
        ...message.questions.map(
          (question, index) =>
            `${index + 1}. ${question.prompt}\n${question.responseOptions
              .map((option, optionIndex) => `  ${optionIndex + 1}) ${option}`)
              .join("\n")}`,
        ),
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
