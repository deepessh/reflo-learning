import { DeliveryError } from "../errors.js";

const DEFAULT_LONG_POLL_SECONDS = 25;
const DEFAULT_RETRY_DELAY_MS = 500;

export interface TelegramLongPollingConfig {
  readonly botToken: string;
  readonly fetch: typeof fetch;
  readonly handleUpdate: (rawUpdate: string) => Promise<void>;
  readonly longPollSeconds: number;
  readonly retryDelayMs: number;
}

export class TelegramLongPollingReceiver {
  readonly #config: TelegramLongPollingConfig;
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(config: TelegramLongPollingConfig) {
    if (
      !/^\d+:[A-Za-z0-9_-]{30,}$/.test(config.botToken) ||
      typeof config.fetch !== "function" ||
      typeof config.handleUpdate !== "function" ||
      !Number.isSafeInteger(config.longPollSeconds) ||
      config.longPollSeconds < 0 ||
      config.longPollSeconds > 50 ||
      !Number.isSafeInteger(config.retryDelayMs) ||
      config.retryDelayMs < 1 ||
      config.retryDelayMs > 60_000
    ) {
      throw new DeliveryError("invalid_configuration");
    }
    this.#config = config;
  }

  start(): void {
    if (this.#running !== undefined) {
      throw new DeliveryError("invalid_configuration");
    }
    this.#controller = new AbortController();
    this.#running = this.#run(this.#controller.signal);
  }

  async close(): Promise<void> {
    this.#controller?.abort();
    await this.#running;
    this.#controller = undefined;
    this.#running = undefined;
  }

  async pollOnce(
    offset: number | undefined,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const response = await this.#config.fetch(
      `https://api.telegram.org/bot${this.#config.botToken}/getUpdates`,
      {
        body: JSON.stringify({
          allowed_updates: ["callback_query"],
          ...(offset === undefined ? {} : { offset }),
          timeout: this.#config.longPollSeconds,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      },
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DeliveryError("invalid_configuration");
    }
    const updates = telegramUpdates(response.ok, body);
    let nextOffset = offset;
    for (const update of updates) {
      const updateId = update.update_id;
      if (nextOffset !== undefined && updateId < nextOffset) {
        continue;
      }
      try {
        await this.#config.handleUpdate(JSON.stringify(update));
      } catch (error) {
        if (!(
          error instanceof DeliveryError && error.code === "invalid_input"
        )) {
          throw error;
        }
      }
      nextOffset = updateId + 1;
    }
    return nextOffset;
  }

  async #run(signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    while (!signal.aborted) {
      try {
        offset = await this.pollOnce(offset, signal);
      } catch {
        if (signal.aborted) return;
        await abortableDelay(this.#config.retryDelayMs, signal);
      }
    }
  }
}

export function createTelegramLongPollingReceiver(
  config: Pick<TelegramLongPollingConfig, "botToken" | "handleUpdate"> &
    Partial<
      Pick<
        TelegramLongPollingConfig,
        "fetch" | "longPollSeconds" | "retryDelayMs"
      >
    >,
): TelegramLongPollingReceiver {
  return new TelegramLongPollingReceiver({
    botToken: config.botToken,
    fetch: config.fetch ?? globalThis.fetch,
    handleUpdate: config.handleUpdate,
    longPollSeconds: config.longPollSeconds ?? DEFAULT_LONG_POLL_SECONDS,
    retryDelayMs: config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  });
}

function telegramUpdates(
  responseOk: boolean,
  value: unknown,
): readonly (Record<string, unknown> & { readonly update_id: number })[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryError("invalid_configuration");
  }
  const body = value as Record<string, unknown>;
  if (responseOk !== true || body.ok !== true || !Array.isArray(body.result)) {
    throw new DeliveryError("invalid_configuration");
  }
  const updates: (Record<string, unknown> & { readonly update_id: number })[] =
    [];
  for (const update of body.result) {
    if (
      update === null ||
      typeof update !== "object" ||
      Array.isArray(update) ||
      !Number.isSafeInteger((update as Record<string, unknown>).update_id) ||
      Number((update as Record<string, unknown>).update_id) < 0
    ) {
      throw new DeliveryError("invalid_configuration");
    }
    updates.push(
      update as Record<string, unknown> & { readonly update_id: number },
    );
  }
  return updates;
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
