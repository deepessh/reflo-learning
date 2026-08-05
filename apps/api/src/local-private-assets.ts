import { createHash, randomBytes } from "node:crypto";

import {
  PRIVATE_DELIVERY_CONTRACT_VERSION,
  SIGNED_URL_TTL_SECONDS,
  assertResourceMatchesCanonicalKey,
  type AuthorizedDelivery,
} from "@reflo/asset-delivery";
import type { ConnectedPrivateAsset } from "@reflo/db";
import type { ScopeAuthorizationContext } from "@reflo/retrieval";

import type { ConnectedObjectStore } from "./ali-oss-object-store.js";

export interface LocalPrivateAssetRepository {
  resolvePrivateAsset(
    authorization: ScopeAuthorizationContext,
    assetId: string,
  ): Promise<ConnectedPrivateAsset | null>;
}

interface LocalGrant {
  readonly asset: ConnectedPrivateAsset;
  readonly authorization: ScopeAuthorizationContext;
  readonly expiresAt: Date;
}

export interface LocalPrivateAssetRead {
  readonly bytes: Uint8Array;
  readonly contentRange: string | null;
  readonly contentType: string;
  readonly etag: string;
  readonly status: 200 | 206;
  readonly totalBytes: number;
}

export class LocalPrivateAssetDelivery {
  readonly #clock: () => Date;
  readonly #grants = new Map<string, LocalGrant>();
  readonly #objects: Pick<ConnectedObjectStore, "read">;
  readonly #repository: LocalPrivateAssetRepository;

  constructor(input: {
    readonly clock?: () => Date;
    readonly objects: Pick<ConnectedObjectStore, "read">;
    readonly repository: LocalPrivateAssetRepository;
  }) {
    this.#clock = input.clock ?? (() => new Date());
    this.#objects = input.objects;
    this.#repository = input.repository;
  }

  async authorize(
    authorization: ScopeAuthorizationContext,
    assetId: string,
    publicOrigin: string,
  ): Promise<AuthorizedDelivery | null> {
    const origin = localOrigin(publicOrigin);
    if (origin === null) {
      return null;
    }
    const asset = await this.#repository.resolvePrivateAsset(
      authorization,
      assetId,
    );
    if (asset === null || !validAsset(asset)) {
      return null;
    }
    const issuedAt = this.#clock();
    if (!Number.isFinite(issuedAt.getTime())) {
      return null;
    }
    const expiresAt = new Date(
      Math.floor(issuedAt.getTime() / 1_000) * 1_000 +
        SIGNED_URL_TTL_SECONDS * 1_000,
    );
    const token = randomBytes(32).toString("base64url");
    this.#grants.set(tokenDigest(token), {
      asset,
      authorization: { ...authorization },
      expiresAt,
    });
    this.#removeExpired(issuedAt);
    const url = new URL(
      `/v1/private-assets/${encodeURIComponent(asset.assetId)}`,
      origin,
    );
    url.searchParams.set("auth_key", token);
    return {
      contractVersion: PRIVATE_DELIVERY_CONTRACT_VERSION,
      expiresAt: expiresAt.toISOString(),
      metadata: {
        byteSize: asset.byteSize,
        contentType: asset.contentType,
        etag: asset.etag,
        resourceId: asset.assetId,
        resourceKind: "asset",
      },
      playback: {
        acceptsByteRanges: true,
        cacheControl: "private, no-store, max-age=0",
        refreshOnForbidden: true,
        resumeSupported: true,
      },
      url: url.toString(),
    };
  }

  async read(
    assetId: string,
    token: string | null,
    range: string | undefined,
  ): Promise<LocalPrivateAssetRead | null> {
    if (!validToken(token)) {
      return null;
    }
    const now = this.#clock();
    const grant = this.#grants.get(tokenDigest(token));
    if (
      grant === undefined ||
      grant.asset.assetId !== assetId ||
      !Number.isFinite(now.getTime()) ||
      now >= grant.expiresAt
    ) {
      if (grant !== undefined && now >= grant.expiresAt) {
        this.#grants.delete(tokenDigest(token));
      }
      return null;
    }
    const current = await this.#repository.resolvePrivateAsset(
      grant.authorization,
      assetId,
    );
    if (current === null || !sameAsset(grant.asset, current)) {
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.#objects.read(current.objectKey);
    } catch {
      return null;
    }
    if (
      bytes.byteLength !== current.byteSize ||
      sha256(bytes) !== current.contentHash
    ) {
      return null;
    }
    const selected = selectRange(range, bytes.byteLength);
    if (selected === null) {
      return null;
    }
    return {
      bytes: bytes.subarray(selected.start, selected.end + 1),
      contentRange: selected.partial
        ? `bytes ${selected.start}-${selected.end}/${bytes.byteLength}`
        : null,
      contentType: current.contentType,
      etag: current.etag,
      status: selected.partial ? 206 : 200,
      totalBytes: bytes.byteLength,
    };
  }

  #removeExpired(now: Date): void {
    for (const [digest, grant] of this.#grants) {
      if (now >= grant.expiresAt) {
        this.#grants.delete(digest);
      }
    }
  }
}

function validAsset(asset: ConnectedPrivateAsset): boolean {
  try {
    assertResourceMatchesCanonicalKey({
      byteSize: asset.byteSize,
      contentType: asset.contentType,
      courseId: asset.courseId,
      deliveryState: "deliverable",
      etag: asset.etag,
      objectKey: asset.objectKey,
      ownerScopeId: asset.ownerScopeId,
      reference: { assetId: asset.assetId, kind: "asset" },
    });
    return (
      Number.isSafeInteger(asset.byteSize) &&
      asset.byteSize > 0 &&
      /^[a-f0-9]{64}$/.test(asset.contentHash) &&
      /^(audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(asset.contentType) &&
      asset.etag.length > 0 &&
      asset.etag.length <= 256
    );
  } catch {
    return false;
  }
}

function sameAsset(
  issued: ConnectedPrivateAsset,
  current: ConnectedPrivateAsset,
): boolean {
  return (
    validAsset(current) &&
    issued.assetId === current.assetId &&
    issued.byteSize === current.byteSize &&
    issued.contentHash === current.contentHash &&
    issued.contentType === current.contentType &&
    issued.courseId === current.courseId &&
    issued.etag === current.etag &&
    issued.objectKey === current.objectKey &&
    issued.ownerScopeId === current.ownerScopeId
  );
}

function localOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function validToken(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function selectRange(
  header: string | undefined,
  byteLength: number,
): {
  readonly end: number;
  readonly partial: boolean;
  readonly start: number;
} | null {
  if (header === undefined) {
    return { end: byteLength - 1, partial: false, start: 0 };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return null;
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") {
    return null;
  }
  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
      return null;
    }
    return {
      end: byteLength - 1,
      partial: true,
      start: Math.max(0, byteLength - suffixLength),
    };
  }
  const start = Number(startText);
  const requestedEnd = endText === "" ? byteLength - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= byteLength ||
    requestedEnd < start
  ) {
    return null;
  }
  return {
    end: Math.min(requestedEnd, byteLength - 1),
    partial: true,
    start,
  };
}
