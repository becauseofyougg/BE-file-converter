import { Injectable, Logger } from '@nestjs/common';
import { Transactional, TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { SYSTEM_ROLES } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { RbacConfigService } from './rbac-config.service';

@Injectable()
export class UserRolesService {
  private readonly logger = new Logger(UserRolesService.name);

  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
    private readonly config: RbacConfigService,
  ) {}

  private get db() {
    return this.txHost.tx;
  }

  /** Role *names*, which is what goes into the access token. */
  async namesFor(userId: string): Promise<string[]> {
    const assignments = await this.db.userRoleAssignment.findMany({
      where: { userId },
      include: { role: { select: { name: true } } },
    });

    return assignments.map((assignment) => assignment.role.name).sort();
  }

  /**
   * Every new account gets `USER`. Without it a fresh registration would hold
   * no roles at all, and the evaluator — which fails closed — would refuse it
   * even its own profile.
   */
  @Transactional()
  async assignDefault(userId: string): Promise<string[]> {
    const role = await this.db.role.findUnique({
      where: { name: SYSTEM_ROLES.USER },
    });

    if (!role) {
      // The seed migration creates it; its absence means the database was
      // migrated by hand into a state the application cannot work in.
      throw new AppError(
        ERROR_CODES.ROLE_NOT_FOUND,
        'The default role is missing',
        500,
      );
    }

    await this.db.userRoleAssignment.create({
      data: { userId, roleId: role.id },
    });

    return [role.name];
  }

  /**
   * Replaces a user's roles wholesale. Whole-set rather than add/remove so the
   * caller cannot race itself into a half-applied state, and so the audit line
   * records what the user ended up with rather than a delta.
   */
  @Transactional()
  async replace(
    userId: string,
    roleNames: string[],
    actor: { actorUserId?: string; correlationId: string },
  ): Promise<string[]> {
    const wanted = [...new Set(roleNames)];

    const roles = await this.db.role.findMany({
      where: { name: { in: wanted } },
    });

    if (roles.length !== wanted.length) {
      const found = roles.map((role) => role.name);

      throw new AppError(
        ERROR_CODES.ROLE_NOT_FOUND,
        'One or more roles do not exist',
        404,
        { unknown: wanted.filter((name) => !found.includes(name)) },
      );
    }

    const before = await this.namesFor(userId);

    await this.db.userRoleAssignment.deleteMany({ where: { userId } });
    await this.db.userRoleAssignment.createMany({
      data: roles.map((role) => ({ userId, roleId: role.id })),
    });

    await this.config.invalidate({
      entity: 'user_roles',
      operation: 'update',
      actorUserId: actor.actorUserId,
      correlationId: actor.correlationId,
    });

    this.logger.log({
      event: 'rbac.user_roles.replaced',
      actorUserId: actor.actorUserId,
      userId,
      before,
      after: roles.map((role) => role.name).sort(),
    });

    return roles.map((role) => role.name).sort();
  }
}
