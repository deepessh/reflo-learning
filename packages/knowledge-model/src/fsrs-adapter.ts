import type {
  Card,
  CardInput,
  createEmptyCard,
  FSRSParameters,
  fsrs,
  Grade,
  generatorParameters,
} from "ts-fsrs";

import {
  FSRS_PACKAGE_VERSION,
  FSRS_PROFILE,
  FSRS_PROFILE_VERSION,
  FSRS_RUNTIME_NODE_VERSION,
  SchedulerError,
} from "./scheduler-contracts.js";

const DATE_PROTOTYPE_KEYS = Object.freeze([
  "scheduler",
  "diff",
  "format",
  "dueFormat",
] as const);

export interface FsrsAdapter {
  createEmptyCard(reviewedAt: Date): Card;
  next(card: CardInput | Card, reviewedAt: Date, rating: 1 | 3): Card;
}

export type FsrsExternalCard = Card;

interface TsFsrsModule {
  readonly createEmptyCard: typeof createEmptyCard;
  readonly fsrs: typeof fsrs;
  readonly FSRSVersion: string;
  readonly generatorParameters: typeof generatorParameters;
}

let adapterPromise: Promise<FsrsAdapter> | undefined;

export function loadFsrsAdapter(): Promise<FsrsAdapter> {
  adapterPromise ??= initializeAdapter();
  return adapterPromise;
}

async function initializeAdapter(): Promise<FsrsAdapter> {
  if (process.versions.node !== FSRS_RUNTIME_NODE_VERSION) {
    throw new SchedulerError("invalid_runtime");
  }

  const beforeKeys = Reflect.ownKeys(Date.prototype);
  const beforeDescriptors = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of beforeKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(Date.prototype, key);
    if (descriptor !== undefined) {
      beforeDescriptors.set(key, descriptor);
    }
  }

  let imported: TsFsrsModule;
  try {
    imported = await import("ts-fsrs");
    verifyPackageSideEffects(beforeKeys, beforeDescriptors);
  } finally {
    restoreDatePrototype(beforeKeys, beforeDescriptors);
  }

  if (
    imported.FSRSVersion !== FSRS_PROFILE_VERSION ||
    FSRS_PACKAGE_VERSION !== "5.4.1"
  ) {
    throw new SchedulerError("invalid_profile");
  }

  const requested: FSRSParameters = {
    enable_fuzz: FSRS_PROFILE.enableFuzz,
    enable_short_term: FSRS_PROFILE.enableShortTerm,
    learning_steps: FSRS_PROFILE.learningSteps,
    maximum_interval: FSRS_PROFILE.maximumIntervalDays,
    relearning_steps: FSRS_PROFILE.relearningSteps,
    request_retention: FSRS_PROFILE.requestRetention,
    w: FSRS_PROFILE.weights,
  };
  const resolved = imported.generatorParameters(requested);
  if (!sameParameters(resolved, requested)) {
    throw new SchedulerError("invalid_profile");
  }
  const scheduler = imported.fsrs(resolved);

  return Object.freeze({
    createEmptyCard(reviewedAt: Date): Card {
      return imported.createEmptyCard(reviewedAt);
    },
    next(card: CardInput | Card, reviewedAt: Date, rating: 1 | 3): Card {
      if (rating !== 1 && rating !== 3) {
        throw new SchedulerError("invalid_evidence");
      }
      const nextCard = scheduler.next(card, reviewedAt, rating as Grade).card;
      if (nextCard.scheduled_days <= FSRS_PROFILE.maximumIntervalDays) {
        return nextCard;
      }
      // ts-fsrs enforces Hard < Good < Easy after interval capping, which can
      // push Good one day above maximum_interval. The accepted profile's
      // maximum is authoritative at this adapter boundary.
      return {
        ...nextCard,
        due: new Date(
          reviewedAt.getTime() + FSRS_PROFILE.maximumIntervalDays * 86_400_000,
        ),
        scheduled_days: FSRS_PROFILE.maximumIntervalDays,
      };
    },
  });
}

function sameParameters(left: FSRSParameters, right: FSRSParameters): boolean {
  return (
    left.enable_fuzz === right.enable_fuzz &&
    left.enable_short_term === right.enable_short_term &&
    left.maximum_interval === right.maximum_interval &&
    left.request_retention === right.request_retention &&
    JSON.stringify(left.learning_steps) ===
      JSON.stringify(right.learning_steps) &&
    JSON.stringify(left.relearning_steps) ===
      JSON.stringify(right.relearning_steps) &&
    JSON.stringify(left.w) === JSON.stringify(right.w)
  );
}

function verifyPackageSideEffects(
  beforeKeys: readonly PropertyKey[],
  beforeDescriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>,
): void {
  const expected = new Set<PropertyKey>(DATE_PROTOTYPE_KEYS);
  const before = new Set(beforeKeys);
  const afterKeys = Reflect.ownKeys(Date.prototype);

  for (const key of afterKeys) {
    if (!before.has(key) && !expected.has(key)) {
      throw new SchedulerError("unexpected_package_side_effect");
    }
  }
  for (const key of beforeKeys) {
    if (expected.has(key)) continue;
    const current = Object.getOwnPropertyDescriptor(Date.prototype, key);
    if (!sameDescriptor(current, beforeDescriptors.get(key))) {
      throw new SchedulerError("unexpected_package_side_effect");
    }
  }
  for (const key of DATE_PROTOTYPE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(Date.prototype, key);
    if (
      descriptor === undefined ||
      descriptor.configurable !== true ||
      descriptor.enumerable !== true ||
      descriptor.writable !== true ||
      typeof descriptor.value !== "function"
    ) {
      throw new SchedulerError("unexpected_package_side_effect");
    }
  }
}

function restoreDatePrototype(
  beforeKeys: readonly PropertyKey[],
  beforeDescriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>,
): void {
  const before = new Set(beforeKeys);
  for (const key of Reflect.ownKeys(Date.prototype)) {
    if (!before.has(key)) {
      if (!Reflect.deleteProperty(Date.prototype, key)) {
        throw new SchedulerError("unexpected_package_side_effect");
      }
    }
  }
  for (const [key, descriptor] of beforeDescriptors) {
    Object.defineProperty(Date.prototype, key, descriptor);
  }
  for (const key of beforeKeys) {
    if (
      !sameDescriptor(
        Object.getOwnPropertyDescriptor(Date.prototype, key),
        beforeDescriptors.get(key),
      )
    ) {
      throw new SchedulerError("unexpected_package_side_effect");
    }
  }
}

function sameDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  return (
    left?.configurable === right?.configurable &&
    left?.enumerable === right?.enumerable &&
    left?.get === right?.get &&
    left?.set === right?.set &&
    left?.value === right?.value &&
    left?.writable === right?.writable
  );
}
