export type DeliveryProvider = "email" | "telegram";

export interface DeliveryPreferenceView {
  readonly availableProviders: readonly DeliveryProvider[];
  readonly chosenLocalTime: string;
  readonly provider: DeliveryProvider;
  readonly timeZone: string;
}

export function parseDeliveryPreference(
  value: unknown,
): DeliveryPreferenceView | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.availableProviders) ||
    candidate.availableProviders.length === 0 ||
    !candidate.availableProviders.every(isDeliveryProvider) ||
    !isDeliveryProvider(candidate.provider) ||
    !candidate.availableProviders.includes(candidate.provider) ||
    typeof candidate.chosenLocalTime !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(candidate.chosenLocalTime) ||
    typeof candidate.timeZone !== "string" ||
    candidate.timeZone.length === 0 ||
    candidate.timeZone.length > 100
  ) {
    return null;
  }
  return {
    availableProviders: candidate.availableProviders,
    chosenLocalTime: candidate.chosenLocalTime,
    provider: candidate.provider,
    timeZone: candidate.timeZone,
  };
}

export function deliveryProviderLabel(provider: DeliveryProvider): string {
  return provider === "email" ? "Email" : "Telegram";
}

function isDeliveryProvider(value: unknown): value is DeliveryProvider {
  return value === "email" || value === "telegram";
}
