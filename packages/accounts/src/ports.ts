import type {
  AuthenticatedAccount,
  LibraryCourse,
  LoginTokenIssue,
  MagicLinkMessage,
  SessionHistoryItem,
  SessionIssue,
} from "./contracts.js";

export interface AccountRepository {
  authenticateSession(
    sessionDigest: string,
    now: Date,
  ): Promise<AuthenticatedAccount | null>;
  beginDeletion(userId: string, now: Date): Promise<void>;
  issueLoginToken(issue: LoginTokenIssue): Promise<void>;
  listLibrary(account: AuthenticatedAccount): Promise<readonly LibraryCourse[]>;
  listSessionHistory(
    account: AuthenticatedAccount,
  ): Promise<readonly SessionHistoryItem[]>;
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
