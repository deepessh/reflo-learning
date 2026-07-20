import type {
  FlagEnvironment,
  PrerequisiteVerdict,
  PrerequisiteVerdictSource,
  RequestedFlagState,
  RequestedFlagStateSource,
  ResourceAdmissionSource,
} from "./evaluator.js";
import type { P1FlagKey, PrerequisitePolicyDefinition } from "./registry.js";

export class InMemoryRequestedFlagStateSource implements RequestedFlagStateSource {
  readonly states = new Map<string, RequestedFlagState>();

  async read(
    key: P1FlagKey,
    environment: FlagEnvironment,
  ): Promise<RequestedFlagState | null> {
    return this.states.get(`${environment}:${key}`) ?? null;
  }

  set(
    environment: FlagEnvironment,
    key: P1FlagKey,
    state: RequestedFlagState,
  ): void {
    this.states.set(`${environment}:${key}`, state);
  }
}

export class InMemoryPrerequisiteVerdictSource implements PrerequisiteVerdictSource {
  readonly verdicts = new Map<string, PrerequisiteVerdict>();

  async read(
    policy: PrerequisitePolicyDefinition,
    environment: FlagEnvironment,
  ): Promise<PrerequisiteVerdict | null> {
    return (
      this.verdicts.get(`${environment}:${policy.id}:${policy.version}`) ?? null
    );
  }

  satisfy(
    environment: FlagEnvironment,
    policy: PrerequisitePolicyDefinition,
    validUntilMs: number,
  ): void {
    this.verdicts.set(`${environment}:${policy.id}:${policy.version}`, {
      evidenceRefs: [`evidence:${policy.id}:${policy.version}`],
      policyId: policy.id,
      policyVersion: policy.version,
      satisfied: true,
      validUntilMs,
    });
  }
}

export class InMemoryResourceAdmissionSource implements ResourceAdmissionSource {
  admitted = true;

  async admit(): Promise<boolean> {
    return this.admitted;
  }
}
