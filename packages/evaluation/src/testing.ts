import type { DatasetManifest, GateAttestation } from "./contracts.js";
import type {
  GateAttestationIndexPort,
  PublisherAuthorizationPort,
} from "./attestation.js";

export class InMemoryGateAttestationIndex implements GateAttestationIndexPort {
  readonly attestations = new Map<string, GateAttestation>();

  async publish(attestation: GateAttestation): Promise<void> {
    this.attestations.set(
      `${attestation.environment}:${attestation.gateId}`,
      attestation,
    );
  }

  async readCurrent(
    environment: GateAttestation["environment"],
    gateId: GateAttestation["gateId"],
  ): Promise<GateAttestation | null> {
    return this.attestations.get(`${environment}:${gateId}`) ?? null;
  }
}

export class FixedPublisherAuthorization implements PublisherAuthorizationPort {
  constructor(readonly authorized: boolean) {}

  async authorize(): Promise<boolean> {
    return this.authorized;
  }
}

export function manifestFixture(
  overrides: Partial<DatasetManifest> = {},
): DatasetManifest {
  return {
    authority: "fixture",
    contractVersion: "evaluation-contract-v1",
    datasetId: "fixture.dataset",
    datasetVersion: "fixture-v1",
    heldOut: true,
    intendedGates: ["week1.upload-security"],
    items: [],
    manifestSchemaVersion: "dataset-manifest-v1",
    preRunExclusions: [],
    protocols: {
      adjudication: "fixture-adjudication-v1",
      annotation: "fixture-annotation-v1",
      reviewer: "fixture-reviewer-v1",
      rubric: "fixture-rubric-v1",
    },
    rightsApprovalReferences: ["fixture:rights-v1"],
    selection: { method: "fixture", seed: 35 },
    ...overrides,
  };
}
