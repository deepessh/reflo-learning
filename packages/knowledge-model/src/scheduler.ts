import { createHash } from "node:crypto";

import { loadFsrsAdapter, type FsrsExternalCard } from "./fsrs-adapter.js";
import {
  canonicalizeEvidence,
  evidenceIdentity,
  type ValidatedEvidence,
} from "./knowledge-model.js";
import {
  DELIVERY_TIME_PROFILE_ID,
  FSRS_CARD_SCHEMA,
  FSRS_PROFILE,
  FSRS_PROFILE_ID,
  FSRS_REPLAY_SCHEMA,
  FSRS_RUNTIME_TZDB_VERSION,
  MAX_REPLAY_EVIDENCE_PER_CONCEPT,
  SchedulerError,
  type CanonicalFsrsCard,
  type CanonicalFsrsTransition,
  type DeliveryDisambiguation,
  type DeliveryPreference,
  type DeliveryResolution,
  type FsrsReplayRun,
  type SchedulerEvidence,
} from "./scheduler-contracts.js";

interface LocalDateTime {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly year: number;
}

export async function replayFsrsSchedule(
  evidence: readonly SchedulerEvidence[],
  deliveryPreference: DeliveryPreference,
): Promise<FsrsReplayRun | null> {
  let canonical: readonly ValidatedEvidence[];
  try {
    canonical = canonicalizeEvidence(evidence);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "conflicting_duplicate"
    ) {
      throw new SchedulerError("conflicting_duplicate");
    }
    throw error;
  }

  const firstCanonical = canonical[0];
  if (firstCanonical === undefined) return null;
  const ownerScopeId = firstCanonical.evidence.ownerScopeId;
  const userId = firstCanonical.evidence.userId;
  const conceptId = firstCanonical.evidence.conceptId;
  for (const item of canonical) {
    validateSchedulerEvidence(item, ownerScopeId, userId, conceptId);
  }

  const eligible = canonical.filter(
    (item) =>
      item.evidence.eligibleForMastery && item.evidence.fsrsRating !== null,
  );
  if (eligible.length === 0) return null;
  if (eligible.length > MAX_REPLAY_EVIDENCE_PER_CONCEPT) {
    throw new SchedulerError("replay_limit_exceeded");
  }

  const first = eligible[0];
  if (first === undefined) return null;

  const adapter = await loadFsrsAdapter();
  const transitions: CanonicalFsrsTransition[] = [];
  let externalCard = adapter.createEmptyCard(new Date(first.occurredAtMs));

  for (const [index, item] of eligible.entries()) {
    const rating = item.evidence.fsrsRating;
    if (rating !== 1 && rating !== 3) {
      throw new SchedulerError("invalid_evidence");
    }
    const reviewedAt = new Date(item.occurredAtMs).toISOString();
    const priorCard = normalizeCard(externalCard);
    const nextExternalCard = adapter.next(
      externalCard,
      new Date(item.occurredAtMs),
      rating,
    );
    const nextCard = normalizeCard(nextExternalCard);
    const priorCardDigest = sha256(canonicalCardBytes(priorCard));
    const nextCardDigest = sha256(canonicalCardBytes(nextCard));
    const transitionWithoutDigest = {
      evidenceIdentity: evidenceIdentity(item.evidence),
      nextCard,
      nextCardDigest,
      priorCard,
      priorCardDigest,
      profileId: FSRS_PROFILE_ID,
      rating,
      reviewedAt,
      sequence: index,
    } as const;
    transitions.push({
      ...transitionWithoutDigest,
      transitionDigest: sha256(
        canonicalTransitionBytes(transitionWithoutDigest),
      ),
    });
    externalCard = nextExternalCard;
  }

  const currentCard = normalizeCard(externalCard);
  const fsrsDueAt = currentCard.due;
  const delivery = resolveNextDeliveryAt(fsrsDueAt, deliveryPreference);
  const profileDigest = sha256(stableJson(FSRS_PROFILE));
  const evidenceDigest = sha256(
    stableJson(
      eligible.map((item) => ({
        attemptCreatedAtOrder: item.timestampOrder,
        attemptId: item.evidence.attemptId,
        attemptOutcome: item.evidence.attemptOutcome,
        conceptId: item.evidence.conceptId,
        gradingPolicyVersion: item.evidence.gradingPolicyVersion,
        ownerScopeId: item.evidence.ownerScopeId,
        rating: item.evidence.fsrsRating,
        ratingMappingVersion: item.evidence.ratingMappingVersion,
        reviewedAt: new Date(item.occurredAtMs).toISOString(),
        userId: item.evidence.userId,
      })),
    ),
  );
  const manifestDigest = sha256(
    stableJson({
      profileId: FSRS_PROFILE_ID,
      replaySchema: FSRS_REPLAY_SCHEMA,
      transitions: transitions.map((transition) => transition.transitionDigest),
    }),
  );
  const currentCardDigest = sha256(canonicalCardBytes(currentCard));
  const runId = sha256(
    stableJson({
      conceptId,
      currentCardDigest,
      evidenceDigest,
      manifestDigest,
      ownerScopeId,
      profileDigest,
      profileId: FSRS_PROFILE_ID,
      replaySchema: FSRS_REPLAY_SCHEMA,
      userId,
    }),
  );
  const deliveryResolutionId = sha256(
    canonicalDeliveryResolutionBytes(runId, fsrsDueAt, delivery),
  );

  return {
    conceptId,
    currentCard,
    currentCardDigest,
    delivery,
    deliveryResolutionId,
    evidenceDigest,
    fsrsDueAt,
    manifestDigest,
    ownerScopeId,
    profileDigest,
    profileId: FSRS_PROFILE_ID,
    runId,
    transitions,
    userId,
  };
}

export function canonicalDeliveryResolutionBytes(
  runId: string,
  fsrsDueAt: string,
  delivery: DeliveryResolution,
): string {
  return JSON.stringify({
    run_id: runId,
    fsrs_due_at: fsrsDueAt,
    time_zone: delivery.timeZone,
    chosen_local_time: delivery.chosenLocalTime,
    delivery_profile_id: delivery.profileId,
    tzdb_version: delivery.tzdbVersion,
    disambiguation: delivery.disambiguation,
    base_next_delivery_at: delivery.nextDeliveryAt,
  });
}

export function resolveNextDeliveryAt(
  fsrsDueAt: string,
  preference: DeliveryPreference,
): DeliveryResolution {
  if (process.versions.tz !== FSRS_RUNTIME_TZDB_VERSION) {
    throw new SchedulerError("invalid_runtime");
  }
  const dueMs = parseCanonicalUtc(fsrsDueAt);
  const { hour, minute } = parseChosenLocalTime(preference.chosenLocalTime);
  const formatter = createLocalFormatter(preference.timeZone);
  let candidateDate = localParts(formatter, dueMs);

  for (let dayOffset = 0; dayOffset < 370; dayOffset += 1) {
    const local = {
      ...candidateDate,
      hour,
      minute,
    };
    const possible = possibleInstants(local, preference.timeZone);
    let disambiguation: DeliveryDisambiguation = "exact";
    let candidates = possible;
    if (candidates.length === 0) {
      candidates = gapShiftedInstants(local, preference.timeZone);
      disambiguation = "gap_forward";
    }
    const qualifying = candidates.filter((instant) => instant >= dueMs);
    if (qualifying.length > 0) {
      const nextDeliveryMs = Math.min(...qualifying);
      if (possible.length > 1) {
        disambiguation =
          nextDeliveryMs === Math.min(...possible)
            ? "fold_earlier"
            : "fold_later";
      }
      return {
        chosenLocalTime: preference.chosenLocalTime,
        disambiguation,
        nextDeliveryAt: new Date(nextDeliveryMs).toISOString(),
        profileId: DELIVERY_TIME_PROFILE_ID,
        timeZone: preference.timeZone,
        tzdbVersion: FSRS_RUNTIME_TZDB_VERSION,
      };
    }
    candidateDate = incrementLocalDate(candidateDate);
  }
  throw new SchedulerError("invalid_delivery_preference");
}

export function canonicalCardBytes(card: CanonicalFsrsCard): string {
  return JSON.stringify({
    due: card.due,
    last_review: card.lastReview,
    stability: card.stability,
    difficulty: card.difficulty,
    state: card.state,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    reps: card.reps,
    lapses: card.lapses,
    learning_steps: card.learningSteps,
    schema: FSRS_CARD_SCHEMA,
  });
}

export function canonicalTransitionBytes(
  transition: Omit<CanonicalFsrsTransition, "transitionDigest">,
): string {
  return JSON.stringify({
    sequence: transition.sequence,
    evidence_identity: transition.evidenceIdentity,
    rating: transition.rating,
    reviewed_at: transition.reviewedAt,
    profile_id: transition.profileId,
    prior_card_digest: transition.priorCardDigest,
    next_card_digest: transition.nextCardDigest,
  });
}

function normalizeCard(card: FsrsExternalCard): CanonicalFsrsCard {
  if (
    !Number.isSafeInteger(card.elapsed_days) ||
    !Number.isSafeInteger(card.scheduled_days) ||
    !Number.isSafeInteger(card.reps) ||
    !Number.isSafeInteger(card.lapses) ||
    card.elapsed_days < 0 ||
    card.scheduled_days < 0 ||
    card.reps < 0 ||
    card.lapses < 0 ||
    card.learning_steps !== 0 ||
    (card.state !== 0 && card.state !== 2)
  ) {
    throw new SchedulerError("invalid_card");
  }
  const due = canonicalDate(card.due);
  const lastReview =
    card.last_review === undefined ? null : canonicalDate(card.last_review);
  const stability = canonicalDecimal(card.stability);
  const difficulty = canonicalDecimal(card.difficulty);
  if (
    (card.state === 0 &&
      (lastReview !== null ||
        stability !== "0.00000000" ||
        difficulty !== "0.00000000" ||
        card.reps !== 0 ||
        card.lapses !== 0)) ||
    (card.state === 2 &&
      (lastReview === null ||
        Number(stability) <= 0 ||
        Number(difficulty) < 1 ||
        Number(difficulty) > 10))
  ) {
    throw new SchedulerError("invalid_card");
  }
  return {
    difficulty,
    due,
    elapsedDays: card.elapsed_days,
    lapses: card.lapses,
    lastReview,
    learningSteps: 0,
    reps: card.reps,
    scheduledDays: card.scheduled_days,
    stability,
    state: card.state,
  };
}

function validateSchedulerEvidence(
  item: ValidatedEvidence,
  ownerScopeId: string,
  userId: string,
  conceptId: string,
): void {
  const evidence = item.evidence;
  if (
    evidence.ownerScopeId !== ownerScopeId ||
    evidence.userId !== userId ||
    evidence.conceptId !== conceptId ||
    !isCanonicalUuid(evidence.ownerScopeId) ||
    !isCanonicalUuid(evidence.userId) ||
    !isCanonicalUuid(evidence.attemptId) ||
    !isCanonicalUuid(evidence.conceptId)
  ) {
    throw new SchedulerError("invalid_evidence");
  }
}

function canonicalDate(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SchedulerError("invalid_card");
  }
  return value.toISOString();
}

function canonicalDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new SchedulerError("invalid_card");
  }
  const fixed = value.toFixed(8);
  if (!/^\d{1,5}\.\d{8}$/.test(fixed)) {
    throw new SchedulerError("invalid_card");
  }
  return fixed;
}

function parseCanonicalUtc(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new SchedulerError("invalid_timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new SchedulerError("invalid_timestamp");
  }
  return parsed;
}

function parseChosenLocalTime(value: string): {
  readonly hour: number;
  readonly minute: number;
} {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (matched === null) {
    throw new SchedulerError("invalid_delivery_preference");
  }
  return {
    hour: Number(matched[1]),
    minute: Number(matched[2]),
  };
}

function createLocalFormatter(timeZone: string): Intl.DateTimeFormat {
  if (
    timeZone !== "UTC" &&
    !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timeZone)
  ) {
    throw new SchedulerError("invalid_delivery_preference");
  }
  try {
    return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    });
  } catch {
    throw new SchedulerError("invalid_delivery_preference");
  }
}

function localParts(
  formatter: Intl.DateTimeFormat,
  instantMs: number,
): LocalDateTime {
  const values = new Map(
    formatter
      .formatToParts(new Date(instantMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const result = {
    day: values.get("day"),
    hour: values.get("hour"),
    minute: values.get("minute"),
    month: values.get("month"),
    year: values.get("year"),
  };
  if (
    Object.values(result).some(
      (value) => value === undefined || !Number.isInteger(value),
    )
  ) {
    throw new SchedulerError("invalid_delivery_preference");
  }
  return result as LocalDateTime;
}

function possibleInstants(local: LocalDateTime, timeZone: string): number[] {
  const naiveUtc = wallTimeAsUtc(local);
  const offsets = candidateOffsets(naiveUtc, timeZone);
  const formatter = createLocalFormatter(timeZone);
  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = naiveUtc - offset * 60_000;
    if (sameLocal(localParts(formatter, candidate), local)) {
      matches.add(candidate);
    }
  }
  return [...matches].sort((left, right) => left - right);
}

function gapShiftedInstants(local: LocalDateTime, timeZone: string): number[] {
  const naiveUtc = wallTimeAsUtc(local);
  const offsets = candidateOffsets(naiveUtc, timeZone);
  if (offsets.length < 2) {
    throw new SchedulerError("invalid_delivery_preference");
  }
  const gapMinutes = Math.max(...offsets) - Math.min(...offsets);
  if (gapMinutes <= 0) {
    throw new SchedulerError("invalid_delivery_preference");
  }
  const shifted = new Date(naiveUtc + gapMinutes * 60_000);
  const shiftedLocal = {
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  };
  const candidates = possibleInstants(shiftedLocal, timeZone);
  if (candidates.length === 0) {
    throw new SchedulerError("invalid_delivery_preference");
  }
  return candidates;
}

function candidateOffsets(naiveUtc: number, timeZone: string): number[] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const name = formatter
      .formatToParts(new Date(naiveUtc + hours * 3_600_000))
      .find((part) => part.type === "timeZoneName")?.value;
    if (name === undefined) {
      throw new SchedulerError("invalid_delivery_preference");
    }
    if (name === "GMT") {
      offsets.add(0);
      continue;
    }
    const matched = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
    if (matched === null) {
      throw new SchedulerError("invalid_delivery_preference");
    }
    const magnitude = Number(matched[2]) * 60 + Number(matched[3]);
    offsets.add(matched[1] === "+" ? magnitude : -magnitude);
  }
  return [...offsets];
}

function incrementLocalDate(
  local: Pick<LocalDateTime, "day" | "month" | "year">,
): LocalDateTime {
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return {
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
    month: next.getUTCMonth() + 1,
    year: next.getUTCFullYear(),
  };
}

function wallTimeAsUtc(local: LocalDateTime): number {
  return Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );
}

function sameLocal(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
