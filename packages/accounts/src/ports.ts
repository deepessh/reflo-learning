import type {
  AuthenticatedAccount,
  CourseProgress,
  LibraryCourse,
  LoginTokenIssue,
  MagicLinkMessage,
  SessionHistoryItem,
  SessionIssue,
} from "./contracts.js";

export interface AccountRepository {
  archiveCourse(
    account: AuthenticatedAccount,
    courseId: string,
    now: Date,
  ): Promise<boolean>;
  authenticateSession(
    sessionDigest: string,
    now: Date,
  ): Promise<AuthenticatedAccount | null>;
  beginDeletion(userId: string, now: Date): Promise<void>;
  issueLoginToken(issue: LoginTokenIssue): Promise<void>;
  getCourseProgress(
    account: AuthenticatedAccount,
    courseId: string,
  ): Promise<CourseProgress | null>;
  listLibrary(account: AuthenticatedAccount): Promise<readonly LibraryCourse[]>;
  listSessionHistory(
    account: AuthenticatedAccount,
  ): Promise<readonly SessionHistoryItem[]>;
  reserveMagicLinkDelivery(
    now: Date,
    dailyLimit: number,
    totalLimit: number,
  ): Promise<boolean>;
  redeemLoginToken(
    tokenDigest: string,
    now: Date,
    session: SessionIssue,
  ): Promise<AuthenticatedAccount | null>;
  revokeSession(sessionDigest: string, now: Date): Promise<void>;
}

export interface TransactionalEmailPort {
  sendMagicLink(message: MagicLinkMessage): Promise<void>;
}

export interface AccountClock {
  now(): Date;
}

export interface AccountIdGenerator {
  createId(): string;
}

export interface AuthAbuseLimiter {
  allow(destinationKey: string, originKey: string, now: Date): boolean;
}
