import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { User } from '@prisma-clients/identity';

import { PrismaService } from '../../database/prisma.service';

export type { User };

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

  findByEmail(email: string): Promise<User | null> {
    return this.db.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { id } });
  }

  create(input: {
    email: string;
    passwordHash: string;
    emailVerified: boolean;
  }): Promise<User> {
    return this.db.user.create({
      data: {
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        emailVerifiedAt: input.emailVerified ? new Date() : null,
      },
    });
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
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
