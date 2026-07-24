import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FSRS_PACKAGE_INTEGRITY,
  FSRS_PROFILE_ID,
  MAX_REPLAY_EVIDENCE_PER_CONCEPT,
  replayFsrsSchedule,
  resolveNextDeliveryAt,
  type PerConceptEvidence,
  type SchedulerError,
} from "./index.js";

const ids = {
  attempt0: "10000000-0000-4000-8000-000000000000",
  attempt1: "10000000-0000-4000-8000-000000000001",
  concept: "20000000-0000-4000-8000-000000000000",
  ownerScope: "30000000-0000-4000-8000-000000000000",
  user: "40000000-0000-4000-8000-000000000000",
} as const;

const deliveryPreference = {
  chosenLocalTime: "09:00",
  timeZone: "UTC",
} as const;

describe("deterministic FSRS-6 replay", () => {
  it("initializes the dependency without changing Date prototype descriptors", async () => {
    const before = Object.getOwnPropertyDescriptors(Date.prototype);
    await replayFsrsSchedule(
      [evidence(ids.attempt0, "2026-07-23T17:00:00.000Z", 3)],
      deliveryPreference,
    );
    expect(Object.getOwnPropertyDescriptors(Date.prototype)).toEqual(before);
  });

  it("reproduces the accepted Good and Again golden cards", async () => {
    const good = await replayFsrsSchedule(
      [evidence(ids.attempt0, "2026-07-23T17:00:00.000Z", 3)],
      deliveryPreference,
    );
    const again = await replayFsrsSchedule(
      [evidence(ids.attempt0, "2026-07-23T17:00:00.000Z", 1)],
      deliveryPreference,
    );

    expect(good?.profileId).toBe(FSRS_PROFILE_ID);
    expect(good?.currentCard).toEqual({
      difficulty: "2.11810397",
      due: "2026-07-26T17:00:00.000Z",
      elapsedDays: 0,
      lapses: 0,
      lastReview: "2026-07-23T17:00:00.000Z",
      learningSteps: 0,
      reps: 1,
      scheduledDays: 3,
      stability: "2.30650000",
      state: 2,
    });
    expect(again?.currentCard).toEqual({
      difficulty: "6.41330000",
      due: "2026-07-24T17:00:00.000Z",
      elapsedDays: 0,
      lapses: 0,
      lastReview: "2026-07-23T17:00:00.000Z",
      learningSteps: 0,
      reps: 1,
      scheduledDays: 1,
      stability: "0.21200000",
      state: 2,
    });
  });

  it("is invariant to arrival order and returns stable content identities", async () => {
    const inputs = [
      evidence(ids.attempt1, "2026-07-24T17:00:00.000Z", 1),
      evidence(ids.attempt0, "2026-07-23T17:00:00.000Z", 3),
    ];
    const expected = await replayFsrsSchedule(inputs, deliveryPreference);

    for (let index = 0; index < 10; index += 1) {
      expect(
        await replayFsrsSchedule([...inputs].reverse(), deliveryPreference),
      ).toEqual(expected);
    }
    expect(expected?.transitions).toHaveLength(2);
    expect(expected?.currentCard).toEqual({
      difficulty: "7.39450274",
      due: "2026-07-25T17:00:00.000Z",
      elapsedDays: 1,
      lapses: 1,
      lastReview: "2026-07-24T17:00:00.000Z",
      learningSteps: 0,
      reps: 2,
      scheduledDays: 1,
      stability: "0.57129918",
      state: 2,
    });
  });

  it("uses microsecond timestamp ordering before attempt IDs", async () => {
    const earlier = {
      ...evidence(ids.attempt1, "2026-07-23T17:00:00.000Z", 1),
      attemptCreatedAtOrder: "2026-07-23T17:00:00.000001Z",
    };
    const later = {
      ...evidence(ids.attempt0, "2026-07-23T17:00:00.000Z", 3),
      attemptCreatedAtOrder: "2026-07-23T17:00:00.000002Z",
    };
    const result = await replayFsrsSchedule(
      [later, earlier],
      deliveryPreference,
    );

    expect(result?.transitions.map((transition) => transition.rating)).toEqual([
      1, 3,
    ]);
  });

  it("uses UUID tie ordering and preserves exact direction-sensitive vectors", async () => {
    const timestamp = "2026-07-23T17:00:00.000Z";
    const order = "2026-07-23T17:00:00.000000Z";
    const goodThenAgain = await replayFsrsSchedule(
      [
        {
          ...evidence(ids.attempt1, timestamp, 1),
          attemptCreatedAtOrder: order,
        },
        {
          ...evidence(ids.attempt0, timestamp, 3),
          attemptCreatedAtOrder: order,
        },
      ],
      deliveryPreference,
    );
    const againThenGood = await replayFsrsSchedule(
      [
        {
          ...evidence(ids.attempt0, timestamp, 1),
          attemptCreatedAtOrder: order,
        },
        {
          ...evidence(ids.attempt1, timestamp, 3),
          attemptCreatedAtOrder: order,
        },
      ],
      deliveryPreference,
    );

    expect(goodThenAgain?.currentCard).toEqual({
      difficulty: "7.39450274",
      due: "2026-07-24T17:00:00.000Z",
      elapsedDays: 0,
      lapses: 1,
      lastReview: timestamp,
      learningSteps: 0,
      reps: 2,
      scheduledDays: 1,
      stability: "0.52337685",
      state: 2,
    });
    expect(goodThenAgain?.currentCardDigest).toBe(
      "72bccaac468cc952bfcb23131f549cca312e36f11c58a00d44f18d0a220d3347",
    );
    expect(againThenGood?.currentCard).toEqual({
      difficulty: "6.40211507",
      due: "2026-07-26T17:00:00.000Z",
      elapsedDays: 0,
      lapses: 0,
      lastReview: timestamp,
      learningSteps: 0,
      reps: 2,
      scheduledDays: 3,
      stability: "0.21200000",
      state: 2,
    });
  });

  it("uses UTC calendar dates for elapsed days and caps long intervals", async () => {
    const midnightCrossing = await replayFsrsSchedule(
      [
        evidence(ids.attempt0, "2026-07-23T23:59:00.000Z", 3),
        evidence(ids.attempt1, "2026-07-24T00:01:00.000Z", 3),
      ],
      deliveryPreference,
    );
    const sameDate = await replayFsrsSchedule(
      [
        evidence(ids.attempt0, "2026-07-23T00:01:00.000Z", 3),
        evidence(ids.attempt1, "2026-07-23T23:59:00.000Z", 3),
      ],
      deliveryPreference,
    );
    const longInterval = await replayFsrsSchedule(
      Array.from({ length: 100 }, (_, index) =>
        evidence(
          `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          `${2026 + index}-07-23T17:00:00.000Z`,
          3,
        ),
      ),
      deliveryPreference,
    );

    expect(midnightCrossing?.currentCard.elapsedDays).toBe(1);
    expect(sameDate?.currentCard.elapsedDays).toBe(0);
    expect(longInterval?.currentCard.stability).toBe("36500.00000000");
    expect(longInterval?.currentCard.scheduledDays).toBe(36_500);
    expect(
      Date.parse(longInterval?.currentCard.due ?? "") -
        Date.parse(longInterval?.currentCard.lastReview ?? ""),
    ).toBe(36_500 * 86_400_000);
  });

  it("does not schedule ineligible evidence and rejects mixed concepts", async () => {
    await expect(
      replayFsrsSchedule(
        [
          {
            ...evidence(ids.attempt0, "2026-07-23T17:00:00.000Z", 3),
            eligibleForMastery: false,
            fsrsRating: null,
            score: null,
          },
        ],
        deliveryPreference,
      ),
    ).resolves.toBeNull();

    await expect(
      replayFsrsSchedule(
        [
          evidence(ids.attempt0, "2026-07-23T17:00:00.000Z", 3),
          {
            ...evidence(ids.attempt1, "2026-07-24T17:00:00.000Z", 1),
            conceptId: "20000000-0000-4000-8000-000000000001",
          },
        ],
        deliveryPreference,
      ),
    ).rejects.toMatchObject<Partial<SchedulerError>>({
      code: "invalid_evidence",
    });
  });

  it("completes the recorded replay bound and rejects one item beyond it", async () => {
    const inputs = Array.from(
      { length: MAX_REPLAY_EVIDENCE_PER_CONCEPT + 1 },
      (_, index) =>
        evidence(
          `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          "2026-07-23T17:00:00.000Z",
          3,
        ),
    );
    const atBound = await replayFsrsSchedule(
      inputs.slice(0, -1),
      deliveryPreference,
    );
    expect(atBound?.transitions).toHaveLength(MAX_REPLAY_EVIDENCE_PER_CONCEPT);
    await expect(
      replayFsrsSchedule(inputs, deliveryPreference),
    ).rejects.toMatchObject<Partial<SchedulerError>>({
      code: "replay_limit_exceeded",
    });
  });

  it("pins the reviewed package integrity in the lockfile", async () => {
    const lockfile = await readFile("../../pnpm-lock.yaml", "utf8");
    expect(lockfile).toContain(`integrity: ${FSRS_PACKAGE_INTEGRITY}`);
  });

  it("keeps the side-effecting dependency behind the sole adapter", async () => {
    const packageName = ["ts", "fsrs"].join("-");
    const sourceFiles = (
      await Promise.all(
        ["../../apps", "../../packages", "../../scripts"].map(
          collectSourceFiles,
        ),
      )
    )
      .flat()
      .filter((name) => !name.endsWith("/fsrs-adapter.ts"));
    const forbiddenImports = (
      await Promise.all(
        sourceFiles.map(async (sourceFile) => ({
          source: await readFile(sourceFile, "utf8"),
          sourceFile,
        })),
      )
    )
      .filter(({ source }) =>
        new RegExp(
          `(?:from\\s+["']${packageName}["']|import\\(["']${packageName}["']\\))`,
        ).test(source),
      )
      .map(({ sourceFile }) => sourceFile);
    expect(forbiddenImports).toEqual([]);
  });
});

describe("deterministic local delivery resolution", () => {
  it("selects the first chosen wall time at or after the FSRS due time", () => {
    expect(
      resolveNextDeliveryAt("2026-07-26T08:00:00.000Z", deliveryPreference),
    ).toEqual({
      chosenLocalTime: "09:00",
      disambiguation: "exact",
      nextDeliveryAt: "2026-07-26T09:00:00.000Z",
      profileId: "delivery-time-profile-v1",
      timeZone: "UTC",
      tzdbVersion: "2026b",
    });
    expect(
      resolveNextDeliveryAt("2026-07-26T10:00:00.000Z", deliveryPreference)
        .nextDeliveryAt,
    ).toBe("2026-07-27T09:00:00.000Z");
  });

  it("shifts nonexistent spring wall times forward by the DST gap", () => {
    expect(
      resolveNextDeliveryAt("2026-03-08T00:00:00.000Z", {
        chosenLocalTime: "02:30",
        timeZone: "America/Los_Angeles",
      }),
    ).toMatchObject({
      disambiguation: "gap_forward",
      nextDeliveryAt: "2026-03-08T10:30:00.000Z",
    });
  });

  it("selects the first qualifying instant in a fall fold", () => {
    const preference = {
      chosenLocalTime: "01:30",
      timeZone: "America/Los_Angeles",
    } as const;

    expect(
      resolveNextDeliveryAt("2026-11-01T00:00:00.000Z", preference),
    ).toMatchObject({
      disambiguation: "fold_earlier",
      nextDeliveryAt: "2026-11-01T08:30:00.000Z",
    });
    expect(
      resolveNextDeliveryAt("2026-11-01T09:00:00.000Z", preference),
    ).toMatchObject({
      disambiguation: "fold_later",
      nextDeliveryAt: "2026-11-01T09:30:00.000Z",
    });
  });

  it.each([
    ["2026-07-26T08:00:00Z", deliveryPreference],
    ["2026-07-26T08:00:00.000Z", { chosenLocalTime: "9:00", timeZone: "UTC" }],
    [
      "2026-07-26T08:00:00.000Z",
      { chosenLocalTime: "09:00", timeZone: "Not/A_Zone" },
    ],
  ])("rejects invalid timestamp or delivery input", (due, preference) => {
    expect(() => resolveNextDeliveryAt(due, preference)).toThrowError(
      expect.objectContaining<Partial<SchedulerError>>({
        code: expect.stringMatching(
          /^invalid_(?:delivery_preference|timestamp)$/,
        ),
      }),
    );
  });
});

const ignoredSourceDirectories = new Set([
  ".artifacts",
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
]);

async function collectSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return ignoredSourceDirectories.has(entry.name)
          ? []
          : collectSourceFiles(entryPath);
      }
      return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)
        ? [entryPath]
        : [];
    }),
  );
  return paths.flat();
}

function evidence(
  attemptId: string,
  attemptCreatedAt: string,
  fsrsRating: 1 | 3,
): PerConceptEvidence {
  return {
    attemptCreatedAt,
    attemptCreatedAtOrder: attemptCreatedAt.replace(".000Z", ".000000Z"),
    attemptId,
    attemptOutcome: "graded",
    conceptId: ids.concept,
    eligibleForMastery: true,
    fsrsRating,
    gradingPolicyVersion: "grading-policy-v1",
    knowledgeAlgorithmVersion: "knowledge-model-v1",
    knowledgeConfigurationId: "beta-1-3-unit-mass-score-5dp-v1",
    ownerScopeId: ids.ownerScope,
    ratingMappingVersion: "rating-map-v1",
    score: fsrsRating === 3 ? "1.00000" : "0.00000",
    userId: ids.user,
  };
}
