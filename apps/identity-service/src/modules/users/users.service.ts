import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { Prisma, User } from '@prisma-clients/identity';

import { anonymizedEmail } from '@contracts/messages/users.messages';
import { PrismaService } from '../../database/prisma.service';

export type { User };

/**
 * Deliberately not a valid argon2 encoding, so `PasswordService.verify` throws
 * internally and returns false rather than ever comparing anything.
 */
const ERASED_PASSWORD_HASH = 'erased';

/**
 * Every column except `password_hash` — NON-FUNCTIONAL-REQUIREMENTS.md §1.
 *
 * Reading the hash into memory on a path that has no use for it is a needless
 * copy of the most sensitive value in the database, and it travels: a profile
 * read crosses a queue into the gateway. Only the login path selects it, and
 * only because it is about to verify against it.
 *
 * `satisfies` rather than a type annotation, so the literal stays narrow enough
 * for `UserGetPayload` to derive the row type from it — annotate it and every
 * consumer is back to `User`.
 */
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  photoKey: true,
  emailVerifiedAt: true,
  failedLoginAttempts: true,
  lockedUntil: true,
  deletedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

/** A user row with no password hash on it — the shape most of the app sees. */
export type SafeUser = Prisma.UserGetPayload<{
  select: typeof SAFE_USER_SELECT;
}>;

/**
 * Narrower still: exactly the columns the admin list projects, and nothing
 * else. The list is the one query that reads many rows at once, so it is the
 * one where carrying unused columns actually costs something.
 */
const LIST_USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  photoKey: true,
  emailVerifiedAt: true,
  lockedUntil: true,
  deletedAt: true,
  createdAt: true,
  lastLoginAt: true,
} satisfies Prisma.UserSelect;

export type ListUser = Prisma.UserGetPayload<{
  select: typeof LIST_USER_SELECT;
}>;

/**
 * Normalising here rather than at each call site is what keeps `User@x.com`
 * and `user@x.com` one account. The `citext` unique index is the backstop, not
 * the primary mechanism — but it is the one that holds under concurrency.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmailVerified(user: Pick<User, 'emailVerifiedAt'>): boolean {
  return user.emailVerifiedAt !== null;
}

/**
 * An erased account — docs/ACCOUNT-DELETION.md. The row is still there, and
 * every read path outside the deletion flow treats this as "no such user".
 */
export function isDeleted(user: Pick<User, 'deletedAt'>): boolean {
  return user.deletedAt !== null;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
  ) {}

  /** The ambient transaction when inside one, the base client otherwise. */
  private get db() {
    return this.txHost.tx;
  }

  /**
   * The one query that selects the password hash, because it is the one whose
   * caller verifies against it. Everything else goes through `findById`.
   */
  findByEmail(email: string): Promise<User | null> {
    return this.db.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
  }

  findById(id: string): Promise<SafeUser | null> {
    return this.db.user.findUnique({
      where: { id },
      select: SAFE_USER_SELECT,
    });
  }

  create(input: {
    email: string;
    passwordHash: string;
    emailVerified: boolean;
  }): Promise<SafeUser> {
    return this.db.user.create({
      data: {
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        emailVerifiedAt: input.emailVerified ? new Date() : null,
      },
      // The caller just supplied the hash; reading it back would be absurd.
      select: SAFE_USER_SELECT,
    });
  }

  /**
   * One page of the admin list — docs/USER-LIST.md §5.
   *
   * Cursor pagination rather than offset: `skip` makes the database count past
   * every row it is skipping, so page 500 costs five hundred pages of work, and
   * a row inserted or deleted meanwhile shifts every later page by one. A
   * cursor resumes from a position instead, which is both cheap and stable.
   *
   * `skip: 1` steps past the cursor row itself, which the caller already has.
   */
  findManyForList(input: {
    where: Prisma.UserWhereInput;
    orderBy: Prisma.UserOrderByWithRelationInput[];
    take: number;
    cursorId?: string;
  }): Promise<ListUser[]> {
    return this.db.user.findMany({
      where: input.where,
      orderBy: input.orderBy,
      take: input.take,
      // The narrowest projection in the codebase, on the only query that reads
      // a hundred rows at a time.
      select: LIST_USER_SELECT,
      ...(input.cursorId ? { cursor: { id: input.cursorId }, skip: 1 } : {}),
    });
  }

  /**
   * A session was issued. Folded into the same statement that clears the
   * failure count, so a successful login is one write rather than two.
   */
  async recordSuccessfulLogin(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });
  }

  async recordLoginFailure(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
    });
  }

  async lockLogin(userId: string, until: Date): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 }, lockedUntil: until },
    });
  }

  /** Any successful password clears both the count and any expired lock. */
  async resetLoginFailures(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  /**
   * Applies an already-authorised, already-validated patch — docs/PROFILE-UPDATE.md §3.
   *
   * One statement, so the read-back is the committed row rather than a second
   * query racing the first. Deciding *what* may be written is the caller's job;
   * by the time anything reaches here the field policy has run.
   */
  update(
    userId: string,
    data: { displayName?: string | null; email?: string },
  ): Promise<SafeUser> {
    return this.db.user.update({
      where: { id: userId },
      data: {
        ...data,
        ...(data.email === undefined
          ? {}
          : {
              email: normalizeEmail(data.email),
              // A new address is unproven by definition. The one path that
              // *has* proved it sets the timestamp itself, immediately after.
              emailVerifiedAt: null,
            }),
      },
      select: SAFE_USER_SELECT,
    });
  }

  /**
   * Moves the account to an address whose owner has just proved they hold it,
   * so unlike `update` this marks it verified in the same statement.
   */
  changeEmail(userId: string, email: string): Promise<SafeUser> {
    return this.db.user.update({
      where: { id: userId },
      data: { email: normalizeEmail(email), emailVerifiedAt: new Date() },
      select: SAFE_USER_SELECT,
    });
  }

  /** Whether some *other* account already holds this address. */
  async isEmailTaken(email: string, exceptUserId: string): Promise<boolean> {
    const existing = await this.db.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { id: true },
    });

    return existing !== null && existing.id !== exceptUserId;
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
  }

  /**
   * Empties the row of everything personal and marks it erased —
   * docs/ACCOUNT-DELETION.md §5.
   *
   * One statement. Every column that says anything about a person is
   * overwritten rather than left to a later pass: a two-step erasure has a
   * window in which the data is still there and the account already looks gone,
   * and nothing guarantees the second step ever runs.
   *
   * The address becomes a unique unroutable placeholder rather than null, so
   * the `citext` unique index still holds and the address the account used is
   * free for somebody else to register.
   */
  anonymize(userId: string): Promise<SafeUser> {
    return this.db.user.update({
      where: { id: userId },
      data: {
        email: anonymizedEmail(userId),
        displayName: null,
        photoKey: null,
        // Not a valid argon2 string, so `verify` refuses it outright. The
        // account is unreachable anyway — the address it used no longer
        // matches — but leaving a real hash of a real password in a row that
        // has supposedly been erased would defeat the whole exercise.
        passwordHash: ERASED_PASSWORD_HASH,
        emailVerifiedAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
        deletedAt: new Date(),
      },
      select: SAFE_USER_SELECT,
    });
  }

  /**
   * Every live challenge the user holds, spent at once. A code mailed before
   * the erasure must not still be usable after it.
   *
   * `newEmail` is cleared on all of them, spent or not: an abandoned
   * `email_change` challenge holds an address the user typed, which is personal
   * data that would otherwise outlive the account it belongs to.
   */
  async invalidateChallenges(userId: string): Promise<number> {
    await this.db.verificationToken.updateMany({
      where: { userId, newEmail: { not: null } },
      data: { newEmail: null },
    });

    const result = await this.db.verificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    return result.count;
  }

  /** Strips the user of every role, so nothing is granted to a dead account. */
  async clearRoles(userId: string): Promise<number> {
    const result = await this.db.userRoleAssignment.deleteMany({
      where: { userId },
    });

    return result.count;
  }

  /**
   * Unverified accounts older than the cutoff, deleted so a typo'd address
   * does not hold an email hostage forever. Cascades to their tokens.
   */
  async deleteUnverifiedBefore(cutoff: Date): Promise<number> {
    const result = await this.db.user.deleteMany({
      where: {
        emailVerifiedAt: null,
        createdAt: { lt: cutoff },
      },
    });

    return result.count;
  }
}
