import type {
  AdversarialDatasetItem,
  AdversarialObservation,
  AudioObservation,
  AudioScriptDatasetItem,
  DatasetItem,
  DatasetManifest,
  PerformanceObservation,
  UploadSecurityDatasetItem,
  UploadSecurityObservation,
} from "./contracts.js";

export interface PerformanceExecutor {
  execute(input: {
    readonly coldApplicationCache: true;
    readonly coldModelCache: true;
    readonly item: Extract<DatasetItem, { readonly kind: "document" }>;
    readonly repetition: number;
  }): Promise<Omit<PerformanceObservation, "itemId" | "repetition">>;
}

export interface AudioExecutor {
  execute(input: {
    readonly adapter: AudioObservation["adapter"];
    readonly item: AudioScriptDatasetItem;
  }): Promise<Omit<AudioObservation, "adapter" | "itemId">>;
}

export interface UploadSecurityExecutor {
  execute(
    item: UploadSecurityDatasetItem,
  ): Promise<Omit<UploadSecurityObservation, "itemId">>;
}

export interface AdversarialExecutor {
  execute(
    item: AdversarialDatasetItem,
  ): Promise<Omit<AdversarialObservation, "itemId">>;
}

export async function runPerformanceDataset(
  manifest: DatasetManifest,
  repetitions: number,
  executor: PerformanceExecutor,
): Promise<readonly PerformanceObservation[]> {
  const items = eligibleItems(manifest).filter(
    (item) => item.kind === "document",
  );
  const work = items.flatMap((item) =>
    Array.from({ length: repetitions }, (_, index) => ({
      item,
      repetition: index + 1,
    })),
  );
  return runWithConcurrency(work, 5, async ({ item, repetition }) => {
    try {
      return {
        ...(await executor.execute({
          coldApplicationCache: true,
          coldModelCache: true,
          item,
          repetition,
        })),
        itemId: item.id,
        repetition,
      };
    } catch {
      return {
        activationPackageMs: null,
        activationPackageUsable: false,
        audioMs: null,
        audioPlayableAuthorized: false,
        diagnostics: ["executor_failure"],
        itemId: item.id,
        outlineMs: null,
        outlineUsable: false,
        outcome: "failed" as const,
        repetition,
        retries: 0,
      };
    }
  });
}

export async function runAudioDataset(
  manifest: DatasetManifest,
  executor: AudioExecutor,
): Promise<readonly AudioObservation[]> {
  const items = eligibleItems(manifest).filter(
    (item): item is AudioScriptDatasetItem => item.kind === "audio-script",
  );
  const work = items.flatMap((item) =>
    (["qwen-tts.primary", "piper-tts.cpu"] as const).map((adapter) => ({
      adapter,
      item,
    })),
  );
  return runWithConcurrency(work, 5, async ({ adapter, item }) => {
    try {
      return {
        ...(await executor.execute({ adapter, item })),
        adapter,
        itemId: item.id,
      };
    } catch {
      return {
        adapter,
        authorizedPrivateAsset: false,
        diagnostics: ["executor_failure"],
        itemId: item.id,
        latencyMs: null,
        listeningReviews: [],
        outcome: "failed" as const,
        playable: false,
        rangePlayback: false,
        retries: 0,
      };
    }
  });
}

export async function runUploadSecurityDataset(
  manifest: DatasetManifest,
  executor: UploadSecurityExecutor,
): Promise<readonly UploadSecurityObservation[]> {
  const items = eligibleItems(manifest).filter(
    (item): item is UploadSecurityDatasetItem =>
      item.kind === "upload-security",
  );
  return runWithConcurrency(items, 5, async (item) => {
    try {
      return { ...(await executor.execute(item)), itemId: item.id };
    } catch {
      return {
        actualOutcome: "executor_failure",
        ambientCredentialsAbsent: false,
        diagnostics: ["executor_failure"],
        idempotentRetry: false,
        itemId: item.id,
        networkDenied: false,
        outcome: "failed" as const,
        ownerScopeEnforced: false,
        retries: 0,
      };
    }
  });
}

export async function runAdversarialDataset(
  manifest: DatasetManifest,
  executor: AdversarialExecutor,
): Promise<readonly AdversarialObservation[]> {
  const items = eligibleItems(manifest).filter(
    (item): item is AdversarialDatasetItem =>
      item.kind === "adversarial-document",
  );
  return runWithConcurrency(items, 5, async (item) => {
    try {
      return { ...(await executor.execute(item)), itemId: item.id };
    } catch {
      return {
        authorizationPolicyChanged: false,
        citationResolvedToAuthorizedSpan: false,
        crossScopeDisclosure: false,
        diagnostics: ["executor_failure"],
        gradingPolicyChanged: false,
        itemId: item.id,
        outcome: "failed" as const,
        retries: 0,
        sourceInstructionExecuted: false,
        toolPolicyChanged: false,
      };
    }
  });
}

function eligibleItems(manifest: DatasetManifest): readonly DatasetItem[] {
  const excluded = new Set(
    manifest.preRunExclusions.map((exclusion) => exclusion.itemId),
  );
  return manifest.items.filter((item) => !excluded.has(item.id));
}

async function runWithConcurrency<Input, Output>(
  work: readonly Input[],
  concurrency: number,
  execute: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(work.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, work.length) },
    async () => {
      while (next < work.length) {
        const index = next;
        next += 1;
        const input = work[index];
        if (input !== undefined) {
          results[index] = await execute(input);
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}
