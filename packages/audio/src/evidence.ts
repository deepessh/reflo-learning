export const AUDIO_GATE_EVIDENCE_VERSION = "audio-gate-evidence-v1" as const;

export interface AudioGateSample {
  readonly adapter: "piper-tts.cpu" | "qwen-tts.primary";
  readonly authorizedPrivateAsset: true;
  readonly courseId: string;
  readonly finalizedAt: string;
  readonly listeningReviews: readonly [
    {
      readonly intelligibleAt1x: true;
      readonly intelligibleAt1_5x: true;
      readonly reviewerId: string;
    },
    {
      readonly intelligibleAt1x: true;
      readonly intelligibleAt1_5x: true;
      readonly reviewerId: string;
    },
  ];
  readonly playable: true;
  readonly rangePlayback: true;
  readonly scriptId: string;
  readonly startedAt: string;
}

export interface AudioGateEvidence {
  readonly capacity: {
    readonly concurrencyLimit: number;
    readonly cpuProfile: string;
    readonly existingOrApprovedCapacity: true;
    readonly memoryMiB: number;
    readonly queueReservation: string;
    readonly vCpu: number;
    readonly workerCount: number;
  };
  readonly contractVersion: typeof AUDIO_GATE_EVIDENCE_VERSION;
  readonly environment: "pilot" | "staging";
  readonly primaryQuotaEvidenceReference: string;
  readonly samples: readonly AudioGateSample[];
  readonly workerImageDigest: string;
}

export type AudioGateResult =
  | {
      readonly chapterOneP95Ms: Readonly<
        Record<"piper-tts.cpu" | "qwen-tts.primary", number>
      >;
      readonly sampleCountPerAdapter: 30;
      readonly status: "passed";
    }
  | {
      readonly reasons: readonly string[];
      readonly status: "failed";
    };

export function evaluateAudioGate(
  evidence: AudioGateEvidence,
): AudioGateResult {
  const reasons: string[] = [];
  if (
    evidence.contractVersion !== AUDIO_GATE_EVIDENCE_VERSION ||
    !/^sha256:[a-f0-9]{64}$/.test(evidence.workerImageDigest)
  ) {
    reasons.push("evidence_identity_invalid");
  }
  if (
    evidence.capacity.concurrencyLimit < 5 ||
    evidence.capacity.workerCount < 1 ||
    evidence.capacity.vCpu <= 0 ||
    evidence.capacity.memoryMiB <= 0 ||
    evidence.capacity.cpuProfile.length === 0 ||
    evidence.capacity.queueReservation.length === 0 ||
    evidence.primaryQuotaEvidenceReference.length === 0
  ) {
    reasons.push("capacity_evidence_incomplete");
  }
  const p95 = {} as Record<AudioGateSample["adapter"], number>;
  for (const adapter of ["qwen-tts.primary", "piper-tts.cpu"] as const) {
    const samples = evidence.samples.filter(
      (sample) => sample.adapter === adapter,
    );
    if (
      samples.length < 30 ||
      new Set(samples.map((sample) => sample.scriptId)).size < 30 ||
      new Set(samples.map((sample) => sample.courseId)).size < 5
    ) {
      reasons.push(`${adapter}_sample_profile_incomplete`);
      continue;
    }
    const latencies = samples
      .map(
        (sample) =>
          Date.parse(sample.finalizedAt) - Date.parse(sample.startedAt),
      )
      .sort((left, right) => left - right);
    if (latencies.some((latency) => !Number.isFinite(latency) || latency < 0)) {
      reasons.push(`${adapter}_latency_invalid`);
      continue;
    }
    const index = Math.ceil(latencies.length * 0.95) - 1;
    p95[adapter] = latencies[index] ?? Number.POSITIVE_INFINITY;
    if (p95[adapter] > 10 * 60_000) {
      reasons.push(`${adapter}_p95_exceeds_ten_minutes`);
    }
    for (const sample of samples) {
      const reviewers = sample.listeningReviews.map(
        (review) => review.reviewerId,
      );
      if (
        !sample.authorizedPrivateAsset ||
        !sample.playable ||
        !sample.rangePlayback ||
        reviewers.some(
          (reviewer) => !/^[a-zA-Z0-9_-]{8,128}$/.test(reviewer),
        ) ||
        new Set(reviewers).size !== 2 ||
        sample.listeningReviews.some(
          (review) => !review.intelligibleAt1x || !review.intelligibleAt1_5x,
        )
      ) {
        reasons.push(`${adapter}_quality_or_authorization_failure`);
        break;
      }
    }
  }
  if (reasons.length > 0) {
    return { reasons: [...new Set(reasons)], status: "failed" };
  }
  return {
    chapterOneP95Ms: p95,
    sampleCountPerAdapter: 30,
    status: "passed",
  };
}
