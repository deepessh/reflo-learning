export const AUTH_CONTRACT_VERSION = "auth-v1" as const;

export type CourseGenerationStatus =
  "generating" | "ready" | "failed" | "archived";

export type SourceIngestionStatus =
  | "quarantined"
  | "validating"
  | "queued"
  | "parsing"
  | "parsed"
  | "ocr_required"
  | "failed";

export interface AuthenticatedAccount {
  readonly authenticatedAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly idleExpiresAt: Date;
  readonly ownerScopeId: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface LoginTokenIssue {
  readonly emailCiphertext: string;
  readonly emailLookupDigest: string;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
  readonly tokenDigest: string;
  readonly tokenId: string;
  readonly userId: string;
}

export interface SessionIssue {
  readonly absoluteExpiresAt: Date;
  readonly authenticatedAt: Date;
  readonly idleExpiresAt: Date;
  readonly membershipId: string;
  readonly ownerScopeId: string;
  readonly sessionDigest: string;
  readonly sessionId: string;
}

export interface LibraryCourse {
  readonly chapterCount: number;
  readonly chaptersReady: number;
  readonly courseId: string;
  readonly courseStatus: CourseGenerationStatus;
  readonly sourceStatus: SourceIngestionStatus;
  readonly title: string;
  readonly updatedAt: Date;
}

export interface SessionHistoryItem {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly endedAt: Date | null;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly status: "active" | "completed" | "abandoned";
  readonly summary: Readonly<Record<string, unknown>> | null;
}

export interface MagicLinkMessage {
  readonly destination: string;
  readonly expiresAt: Date;
  readonly loginUrl: string;
}

export interface RedeemedSession extends AuthenticatedAccount {
  readonly csrfToken: string;
  readonly sessionSecret: string;
}
