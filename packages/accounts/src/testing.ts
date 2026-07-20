import type {
  AuthenticatedAccount,
  LibraryCourse,
  LoginTokenIssue,
  MagicLinkMessage,
  SessionHistoryItem,
  SessionIssue,
} from "./contracts.js";
import type {
  AccountClock,
  AccountIdGenerator,
  AccountRepository,
  TransactionalEmailPort,
} from "./ports.js";

export class FixedAccountClock implements AccountClock {
  constructor(public value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
}

export class SequentialAccountIdGenerator implements AccountIdGenerator {
  #next = 1;
  createId(): string {
    const suffix = String(this.#next++).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

export class RecordingEmailPort implements TransactionalEmailPort {
  readonly messages: MagicLinkMessage[] = [];
  async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    this.messages.push(message);
  }
}

export class InMemoryAccountRepository implements AccountRepository {
  readonly issues: LoginTokenIssue[] = [];
  readonly library: LibraryCourse[] = [];
  readonly history: SessionHistoryItem[] = [];
  readonly sessions = new Map<string, AuthenticatedAccount>();
  readonly deletedUsers = new Set<string>();
  readonly magicLinkDeliveryReservations: Date[] = [];

  async reserveMagicLinkDelivery(
    now: Date,
    dailyLimit: number,
    totalLimit: number,
  ): Promise<boolean> {
    const dailyCount = this.magicLinkDeliveryReservations.filter(
      (reservation) =>
        reservation > new Date(now.getTime() - 24 * 60 * 60 * 1_000) &&
        reservation <= now,
    ).length;
    if (
      this.magicLinkDeliveryReservations.length >= totalLimit ||
      dailyCount >= dailyLimit
    ) {
      return false;
    }
    this.magicLinkDeliveryReservations.push(new Date(now));
    return true;
  }

  async issueLoginToken(issue: LoginTokenIssue): Promise<void> {
    for (const candidate of this.issues) {
      if (
        candidate.emailLookupDigest === issue.emailLookupDigest &&
        candidate.issuedAt <= issue.issuedAt
      ) {
        Object.assign(candidate, { expiresAt: candidate.issuedAt });
      }
    }
    this.issues.push(issue);
  }

  async redeemLoginToken(
    tokenDigest: string,
    now: Date,
    session: SessionIssue,
  ): Promise<AuthenticatedAccount | null> {
    const issue = this.issues.find(
      (candidate) =>
        candidate.tokenDigest === tokenDigest && candidate.expiresAt > now,
    );
    if (issue === undefined) {
      return null;
    }
    Object.assign(issue, { expiresAt: now });
    const account: AuthenticatedAccount = {
      absoluteExpiresAt: session.absoluteExpiresAt,
      authenticatedAt: session.authenticatedAt,
      idleExpiresAt: session.idleExpiresAt,
      ownerScopeId: session.ownerScopeId,
      sessionId: session.sessionId,
      userId: issue.userId,
    };
    this.sessions.set(session.sessionDigest, account);
    return account;
  }

  async authenticateSession(
    sessionDigest: string,
    now: Date,
  ): Promise<AuthenticatedAccount | null> {
    const account = this.sessions.get(sessionDigest);
    if (
      account === undefined ||
      this.deletedUsers.has(account.userId) ||
      account.idleExpiresAt <= now ||
      account.absoluteExpiresAt <= now
    ) {
      return null;
    }
    return account;
  }

  async revokeSession(sessionDigest: string): Promise<void> {
    this.sessions.delete(sessionDigest);
  }

  async beginDeletion(userId: string): Promise<void> {
    this.deletedUsers.add(userId);
    for (const [digest, account] of this.sessions) {
      if (account.userId === userId) {
        this.sessions.delete(digest);
      }
    }
  }

  async listLibrary(): Promise<readonly LibraryCourse[]> {
    return this.library;
  }

  async listSessionHistory(): Promise<readonly SessionHistoryItem[]> {
    return this.history;
  }
}
