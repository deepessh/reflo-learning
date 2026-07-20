export const P1_FLAG_REGISTRY_VERSION = "p1-flags-v1" as const;

export const P1_FLAG_KEYS = [
  "p1.media.video",
  "p1.tutor.voice",
  "p1.auth.oauth",
  "p1.delivery.whatsapp",
  "p1.billing.stripe",
  "p1.export.self_service",
] as const;

export type P1FlagKey = (typeof P1_FLAG_KEYS)[number];

export type VideoOperationKind = "chapter_explainer" | "full_course";

export interface PrerequisitePolicyDefinition {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly version: string;
}

export type ResourceAdmissionPolicy =
  | {
      readonly id: string;
      readonly mode: "isolated";
      readonly version: string;
    }
  | {
      readonly id: string;
      readonly maxP1Concurrent: number;
      readonly mode: "shared";
      readonly p0ReservedConcurrent: number;
      readonly version: string;
    };

export interface P1FlagDefinition {
  readonly capability: string;
  readonly default: false;
  readonly key: P1FlagKey;
  readonly prerequisitePolicy: PrerequisitePolicyDefinition;
  readonly registryVersion: typeof P1_FLAG_REGISTRY_VERSION;
  readonly resourceAdmissionPolicy: ResourceAdmissionPolicy;
  readonly videoOperationPolicies?: Readonly<
    Partial<Record<VideoOperationKind, PrerequisitePolicyDefinition>>
  >;
}

export const P1_FLAG_REGISTRY: Readonly<Record<P1FlagKey, P1FlagDefinition>> =
  deepFreeze({
    "p1.auth.oauth": definition({
      capability: "accounts.oauth",
      key: "p1.auth.oauth",
      prerequisitePolicy: prerequisite("p1-auth-oauth-prerequisites", "1", [
        "week-2-p0-exit-current",
        "provider-security-and-privacy-eligibility-current",
        "owner-scope-authorization-current",
      ]),
      resourceAdmissionPolicy: isolated("p1-auth-oauth-isolated-v1"),
    }),
    "p1.billing.stripe": definition({
      capability: "billing.stripe",
      key: "p1.billing.stripe",
      prerequisitePolicy: prerequisite("p1-billing-stripe-prerequisites", "1", [
        "human-pricing-verdict-current",
        "human-spending-approval-current",
        "provider-security-and-privacy-eligibility-current",
      ]),
      resourceAdmissionPolicy: isolated("p1-billing-stripe-isolated-v1"),
    }),
    "p1.delivery.whatsapp": definition({
      capability: "delivery.whatsapp",
      key: "p1.delivery.whatsapp",
      prerequisitePolicy: prerequisite(
        "p1-delivery-whatsapp-prerequisites",
        "1",
        [
          "business-approval-current",
          "provider-retention-training-and-deletion-settings-verified",
          "learner-opt-in-and-consent-current",
          "telegram-p0-capacity-preserved",
        ],
      ),
      resourceAdmissionPolicy: shared(
        "p1-delivery-whatsapp-admission-v1",
        2,
        4,
      ),
    }),
    "p1.export.self_service": definition({
      capability: "accounts.export.self-service",
      key: "p1.export.self_service",
      prerequisitePolicy: prerequisite(
        "p1-export-self-service-prerequisites",
        "1",
        [
          "authenticated-export-authorization-current",
          "privacy-and-deletion-policy-current",
          "p0-capacity-preserved",
        ],
      ),
      resourceAdmissionPolicy: shared(
        "p1-export-self-service-admission-v1",
        1,
        2,
      ),
    }),
    "p1.media.video": definition({
      capability: "media.video",
      key: "p1.media.video",
      prerequisitePolicy: prerequisite("p1-media-video-prerequisites", "1", [
        "wanx-provider-eligibility-current",
        "privacy-security-and-quality-gates-current",
        "p0-audio-and-text-capacity-preserved",
      ]),
      resourceAdmissionPolicy: shared("p1-media-video-admission-v1", 1, 4),
      videoOperationPolicies: {
        chapter_explainer: prerequisite(
          "p1-media-video-chapter-explainer-prerequisites",
          "1",
          ["chapter-explainer-policy-current"],
        ),
        full_course: prerequisite(
          "p1-media-video-full-course-prerequisites",
          "1",
          ["week-2-p0-exit-current", "full-course-video-policy-current"],
        ),
      },
    }),
    "p1.tutor.voice": definition({
      capability: "tutor.voice",
      key: "p1.tutor.voice",
      prerequisitePolicy: prerequisite("p1-tutor-voice-prerequisites", "1", [
        "week-2-p0-exit-current",
        "both-tts-paths-current",
        "privacy-security-and-quality-gates-current",
        "p0-audio-capacity-preserved",
      ]),
      resourceAdmissionPolicy: shared("p1-tutor-voice-admission-v1", 2, 4),
    }),
  });

export function isP1FlagKey(value: string): value is P1FlagKey {
  return (P1_FLAG_KEYS as readonly string[]).includes(value);
}

function definition(
  value: Omit<P1FlagDefinition, "default" | "registryVersion">,
): P1FlagDefinition {
  return {
    ...value,
    default: false,
    registryVersion: P1_FLAG_REGISTRY_VERSION,
  };
}

function prerequisite(
  id: string,
  version: string,
  requirements: readonly string[],
): PrerequisitePolicyDefinition {
  return { id, requirements, version };
}

function isolated(id: string): ResourceAdmissionPolicy {
  return { id, mode: "isolated", version: "1" };
}

function shared(
  id: string,
  maxP1Concurrent: number,
  p0ReservedConcurrent: number,
): ResourceAdmissionPolicy {
  return {
    id,
    maxP1Concurrent,
    mode: "shared",
    p0ReservedConcurrent,
    version: "1",
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
  }
  return value;
}
