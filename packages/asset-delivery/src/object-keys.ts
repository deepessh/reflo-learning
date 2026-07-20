import type {
  AuthorizedDeliveryResource,
  PrivateResourceReference,
} from "./contracts.js";
import { PrivateDeliveryError } from "./errors.js";

const OPAQUE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;
const SOURCE_KEY_PATTERN =
  /^owners\/([0-9a-f-]{36})\/sources\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})\/original\.([a-z0-9]{1,10})$/;
const ASSET_KEY_PATTERN =
  /^owners\/([0-9a-f-]{36})\/courses\/([0-9a-f-]{36})\/assets\/([0-9a-f-]{36})\/generations\/([0-9a-f-]{36})\/payload\.([a-z0-9]{1,10})$/;

export interface SourceObjectKeyInput {
  readonly extension: string;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
  readonly versionId: string;
}

export interface AssetObjectKeyInput {
  readonly assetId: string;
  readonly courseId: string;
  readonly extension: string;
  readonly generationId: string;
  readonly ownerScopeId: string;
}

export function buildSourceObjectKey(input: SourceObjectKeyInput): string {
  assertOpaqueId(input.ownerScopeId);
  assertOpaqueId(input.sourceDocumentId);
  assertOpaqueId(input.versionId);
  const extension = normalizeExtension(input.extension);
  return `owners/${input.ownerScopeId}/sources/${input.sourceDocumentId}/versions/${input.versionId}/original.${extension}`;
}

export function buildAssetObjectKey(input: AssetObjectKeyInput): string {
  assertOpaqueId(input.ownerScopeId);
  assertOpaqueId(input.courseId);
  assertOpaqueId(input.assetId);
  assertOpaqueId(input.generationId);
  const extension = normalizeExtension(input.extension);
  return `owners/${input.ownerScopeId}/courses/${input.courseId}/assets/${input.assetId}/generations/${input.generationId}/payload.${extension}`;
}

export function canonicalDeliveryPath(objectKey: string): string {
  parseCanonicalObjectKey(objectKey);
  return `/${objectKey}`;
}

export function assertResourceMatchesCanonicalKey(
  resource: AuthorizedDeliveryResource,
): void {
  const parsed = parseCanonicalObjectKey(resource.objectKey);
  if (
    parsed.ownerScopeId !== resource.ownerScopeId ||
    !sameReference(parsed.reference, resource.reference) ||
    (parsed.kind === "asset" && parsed.courseId !== resource.courseId)
  ) {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
}

export function assertOpaqueId(value: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
}

interface ParsedSourceKey {
  readonly extension: string;
  readonly kind: "source";
  readonly ownerScopeId: string;
  readonly reference: Extract<PrivateResourceReference, { kind: "source" }>;
  readonly versionId: string;
}

interface ParsedAssetKey {
  readonly courseId: string;
  readonly extension: string;
  readonly generationId: string;
  readonly kind: "asset";
  readonly ownerScopeId: string;
  readonly reference: Extract<PrivateResourceReference, { kind: "asset" }>;
}

export function parseCanonicalObjectKey(
  objectKey: string,
): ParsedSourceKey | ParsedAssetKey {
  const source = SOURCE_KEY_PATTERN.exec(objectKey);
  if (source !== null) {
    const ownerScopeId = requiredCapture(source, 1);
    const sourceDocumentId = requiredCapture(source, 2);
    const versionId = requiredCapture(source, 3);
    const extension = requiredCapture(source, 4);
    assertOpaqueId(ownerScopeId);
    assertOpaqueId(sourceDocumentId);
    assertOpaqueId(versionId);
    normalizeExtension(extension);
    return {
      extension,
      kind: "source",
      ownerScopeId,
      reference: { kind: "source", sourceDocumentId },
      versionId,
    };
  }

  const asset = ASSET_KEY_PATTERN.exec(objectKey);
  if (asset !== null) {
    const ownerScopeId = requiredCapture(asset, 1);
    const courseId = requiredCapture(asset, 2);
    const assetId = requiredCapture(asset, 3);
    const generationId = requiredCapture(asset, 4);
    const extension = requiredCapture(asset, 5);
    assertOpaqueId(ownerScopeId);
    assertOpaqueId(courseId);
    assertOpaqueId(assetId);
    assertOpaqueId(generationId);
    normalizeExtension(extension);
    return {
      courseId,
      extension,
      generationId,
      kind: "asset",
      ownerScopeId,
      reference: { assetId, kind: "asset" },
    };
  }

  throw new PrivateDeliveryError("integrity_check_failed");
}

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
  return value;
}

function normalizeExtension(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized !== value || !EXTENSION_PATTERN.test(normalized)) {
    throw new PrivateDeliveryError("integrity_check_failed");
  }
  return normalized;
}

function sameReference(
  left: PrivateResourceReference,
  right: PrivateResourceReference,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === "asset"
    ? left.assetId ===
        (right as Extract<PrivateResourceReference, { kind: "asset" }>).assetId
    : left.sourceDocumentId ===
        (right as Extract<PrivateResourceReference, { kind: "source" }>)
          .sourceDocumentId;
}
