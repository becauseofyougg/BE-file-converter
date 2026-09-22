import { Injectable, Logger } from '@nestjs/common';
import { Transactional, TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { Role } from '@prisma-clients/identity';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { RoleDto } from '@contracts/messages/rbac.messages';
import { AppError } from '@core/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { RbacConfigService } from './rbac-config.service';

export interface RoleWriteInput {
  name?: string;
  description?: string | null;
  actorUserId?: string;
  correlationId: string;
}

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
    private readonly config: RbacConfigService,
  ) {}

  private get db() {
    return this.txHost.tx;
  }

  async list(): Promise<RoleDto[]> {
    const roles = await this.db.role.findMany({ orderBy: { name: 'asc' } });

    return roles.map(toDto);
  }

  @Transactional()
  async create(input: RoleWriteInput & { name: string }): Promise<RoleDto> {
    await this.assertNameFree(input.name);

    const role = await this.db.role.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        isSystem: false,
      },
    });

    await this.config.invalidate({
      entity: 'role',
      operation: 'create',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('create', role, input.actorUserId);

    return toDto(role);
  }

  @Transactional()
  async update(id: string, input: RoleWriteInput): Promise<RoleDto> {
    const existing = await this.require(id);

    // A system role may be granted and revoked freely; what it must not do is
    // change its name, because the seeded grants and the tokens already issued
    // refer to it by name.
    if (existing.isSystem && input.name && input.name !== existing.name) {
      throw new AppError(
        ERROR_CODES.ENTITY_IMMUTABLE,
        'A system role cannot be renamed',
        409,
      );
    }

    if (input.name && input.name !== existing.name) {
      await this.assertNameFree(input.name);
    }

    const role = await this.db.role.update({
      where: { id },
      data: {
        name: input.name ?? existing.name,
        description:
          input.description === undefined
            ? existing.description
            : input.description,
      },
    });

    await this.config.invalidate({
      entity: 'role',
      operation: 'update',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('update', role, input.actorUserId);

    return toDto(role);
  }

  /**
   * §1.3.2 leaves "refuse or cascade" open. It refuses.
   *
   * Cascading would silently revoke access from everyone holding the role, and
   * the one thing an access-control change must never be is silent. The
   * `user_roles` foreign key is `RESTRICT` so the database says no even if this
   * check is bypassed; grants cascade, because a grant has no meaning without
   * its role.
   */
  @Transactional()
  async remove(
    id: string,
    input: Pick<RoleWriteInput, 'actorUserId' | 'correlationId'>,
  ): Promise<void> {
    const existing = await this.require(id);

    if (existing.isSystem) {
      throw new AppError(
        ERROR_CODES.ENTITY_IMMUTABLE,
        'A system role cannot be deleted',
        409,
      );
    }

    const holders = await this.db.userRoleAssignment.count({
      where: { roleId: id },
    });

    if (holders > 0) {
      throw new AppError(
        ERROR_CODES.ENTITY_IN_USE,
        `This role is still assigned to ${holders} user(s); revoke it first`,
        409,
        { users: holders },
      );
    }

    await this.db.role.delete({ where: { id } });

    await this.config.invalidate({
      entity: 'role',
      operation: 'delete',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('delete', existing, input.actorUserId);
  }

  async require(id: string): Promise<Role> {
    const role = await this.db.role.findUnique({ where: { id } });

    if (!role) {
      throw new AppError(ERROR_CODES.ROLE_NOT_FOUND, 'Role not found', 404);
    }

    return role;
  }

  private async assertNameFree(name: string): Promise<void> {
    const clash = await this.db.role.findUnique({ where: { name } });

    if (clash) {
      throw new AppError(
        ERROR_CODES.ROLE_ALREADY_EXISTS,
        'A role with this name already exists',
        409,
      );
    }
  }

  private audit(
    operation: string,
    role: Role,
    actorUserId: string | undefined,
  ): void {
    this.logger.log({
      event: `rbac.role.${operation}`,
      actorUserId,
      roleId: role.id,
      roleName: role.name,
    });
  }
}

function toDto(role: Role): RoleDto {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
  };
}
