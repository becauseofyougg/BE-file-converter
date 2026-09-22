import { Injectable, Logger } from '@nestjs/common';
import { Transactional, TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { GrantDto } from '@contracts/messages/rbac.messages';
import { AppError } from '@core/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { PermissionsService } from './permissions.service';
import { RbacConfigService } from './rbac-config.service';
import { RolesService } from './roles.service';

export interface GrantWriteInput {
  roleId?: string;
  permissionId?: string;
  /** Omitted or empty means every action the permission defines. */
  actions?: string[];
  actorUserId?: string;
  correlationId: string;
}

const WITH_NAMES = {
  role: { select: { name: true } },
  permission: { select: { name: true } },
} as const;

@Injectable()
export class GrantsService {
  private readonly logger = new Logger(GrantsService.name);

  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
    private readonly roles: RolesService,
    private readonly permissions: PermissionsService,
    private readonly config: RbacConfigService,
  ) {}

  private get db() {
    return this.txHost.tx;
  }

  async list(): Promise<GrantDto[]> {
    const grants = await this.db.grant.findMany({
      include: WITH_NAMES,
      orderBy: [{ roleId: 'asc' }, { permissionId: 'asc' }],
    });

    return grants.map(toDto);
  }

  @Transactional()
  async create(
    input: GrantWriteInput & { roleId: string; permissionId: string },
  ): Promise<GrantDto> {
    await this.roles.require(input.roleId);
    const permission = await this.permissions.require(input.permissionId);

    const actions = this.validateActions(input.actions, permission.actions);

    const duplicate = await this.db.grant.findUnique({
      where: {
        roleId_permissionId: {
          roleId: input.roleId,
          permissionId: input.permissionId,
        },
      },
    });

    if (duplicate) {
      throw new AppError(
        ERROR_CODES.GRANT_ALREADY_EXISTS,
        'This role already has a grant for this permission; update it instead',
        409,
      );
    }

    const grant = await this.db.grant.create({
      data: {
        roleId: input.roleId,
        permissionId: input.permissionId,
        actions,
      },
      include: WITH_NAMES,
    });

    await this.config.invalidate({
      entity: 'grant',
      operation: 'create',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('create', grant.id, input.actorUserId, {
      role: grant.role.name,
      permission: grant.permission.name,
      actions,
    });

    return toDto(grant);
  }

  @Transactional()
  async update(id: string, input: GrantWriteInput): Promise<GrantDto> {
    const existing = await this.require(id);

    const roleId = input.roleId ?? existing.roleId;
    const permissionId = input.permissionId ?? existing.permissionId;

    if (roleId !== existing.roleId) {
      await this.roles.require(roleId);
    }

    const permission = await this.permissions.require(permissionId);

    const actions =
      input.actions === undefined
        ? this.validateActions(existing.actions, permission.actions)
        : this.validateActions(input.actions, permission.actions);

    if (roleId !== existing.roleId || permissionId !== existing.permissionId) {
      const clash = await this.db.grant.findUnique({
        where: { roleId_permissionId: { roleId, permissionId } },
      });

      if (clash && clash.id !== id) {
        throw new AppError(
          ERROR_CODES.GRANT_ALREADY_EXISTS,
          'Another grant already pairs this role with this permission',
          409,
        );
      }
    }

    const grant = await this.db.grant.update({
      where: { id },
      data: { roleId, permissionId, actions },
      include: WITH_NAMES,
    });

    await this.config.invalidate({
      entity: 'grant',
      operation: 'update',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('update', id, input.actorUserId, {
      role: grant.role.name,
      permission: grant.permission.name,
      actions,
    });

    return toDto(grant);
  }

  @Transactional()
  async remove(
    id: string,
    input: Pick<GrantWriteInput, 'actorUserId' | 'correlationId'>,
  ): Promise<void> {
    const existing = await this.require(id);

    await this.db.grant.delete({ where: { id } });

    await this.config.invalidate({
      entity: 'grant',
      operation: 'delete',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('delete', id, input.actorUserId, {
      role: existing.role.name,
      permission: existing.permission.name,
    });
  }

  private async require(id: string) {
    const grant = await this.db.grant.findUnique({
      where: { id },
      include: WITH_NAMES,
    });

    if (!grant) {
      throw new AppError(ERROR_CODES.GRANT_NOT_FOUND, 'Grant not found', 404);
    }

    return grant;
  }

  /**
   * §1.3.4: an action a grant names must be one the permission defines.
   * Rejecting at write time rather than silently ignoring at evaluation time
   * is the difference between an administrator seeing their typo and believing
   * they granted something they did not.
   */
  private validateActions(
    requested: string[] | undefined,
    available: string[],
  ): string[] {
    if (!requested || requested.length === 0) {
      return [];
    }

    const actions = [...new Set(requested.map((a) => a.trim()))].filter(
      Boolean,
    );
    const unknown = actions.filter((action) => !available.includes(action));

    if (unknown.length > 0) {
      throw new AppError(
        ERROR_CODES.INVALID_ACTION,
        `Unknown action(s) for this permission: ${unknown.join(', ')}`,
        400,
        { unknown, available },
      );
    }

    // Naming every action is the same thing as naming none, and storing it as
    // "none" means a later addition to the permission is picked up too.
    return actions.length === available.length ? [] : actions.sort();
  }

  private audit(
    operation: string,
    grantId: string,
    actorUserId: string | undefined,
    extra: Record<string, unknown>,
  ): void {
    this.logger.log({
      event: `rbac.grant.${operation}`,
      actorUserId,
      grantId,
      ...extra,
    });
  }
}

interface GrantWithNames {
  id: string;
  roleId: string;
  permissionId: string;
  actions: string[];
  role: { name: string };
  permission: { name: string };
}

function toDto(grant: GrantWithNames): GrantDto {
  return {
    id: grant.id,
    roleId: grant.roleId,
    roleName: grant.role.name,
    permissionId: grant.permissionId,
    permissionName: grant.permission.name,
    actions: grant.actions,
  };
}
