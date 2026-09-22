import { Injectable, Logger } from '@nestjs/common';
import { Transactional, TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { Permission } from '@prisma-clients/identity';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { PermissionDto } from '@contracts/messages/rbac.messages';
import { AppError } from '@core/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { RbacConfigService } from './rbac-config.service';

export interface PermissionWriteInput {
  name?: string;
  actions?: string[];
  actorUserId?: string;
  correlationId: string;
}

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
    private readonly config: RbacConfigService,
  ) {}

  private get db() {
    return this.txHost.tx;
  }

  async list(): Promise<PermissionDto[]> {
    const permissions = await this.db.permission.findMany({
      orderBy: { name: 'asc' },
    });

    return permissions.map(toDto);
  }

  @Transactional()
  async create(
    input: PermissionWriteInput & { name: string; actions: string[] },
  ): Promise<PermissionDto> {
    await this.assertNameFree(input.name);

    const permission = await this.db.permission.create({
      data: { name: input.name, actions: normalizeActions(input.actions) },
    });

    await this.config.invalidate({
      entity: 'permission',
      operation: 'create',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('create', permission, input.actorUserId);

    return toDto(permission);
  }

  /**
   * Narrowing a permission's action list can orphan actions that grants still
   * name. Those grants are pruned in the same transaction rather than left
   * pointing at something that no longer exists — a grant naming an unknown
   * action is dead weight the evaluator would silently ignore.
   */
  @Transactional()
  async update(
    id: string,
    input: PermissionWriteInput,
  ): Promise<PermissionDto> {
    const existing = await this.require(id);

    if (input.name && input.name !== existing.name) {
      await this.assertNameFree(input.name);
    }

    const actions =
      input.actions === undefined
        ? existing.actions
        : normalizeActions(input.actions);

    const permission = await this.db.permission.update({
      where: { id },
      data: { name: input.name ?? existing.name, actions },
    });

    const removed = existing.actions.filter(
      (action) => !actions.includes(action),
    );

    if (removed.length > 0) {
      await this.pruneGrantActions(id, actions, removed);
    }

    await this.config.invalidate({
      entity: 'permission',
      operation: 'update',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('update', permission, input.actorUserId, { removed });

    return toDto(permission);
  }

  @Transactional()
  async remove(
    id: string,
    input: Pick<PermissionWriteInput, 'actorUserId' | 'correlationId'>,
  ): Promise<void> {
    const existing = await this.require(id);

    const grants = await this.db.grant.count({ where: { permissionId: id } });

    if (grants > 0) {
      throw new AppError(
        ERROR_CODES.ENTITY_IN_USE,
        `This permission is still used by ${grants} grant(s); remove them first`,
        409,
        { grants },
      );
    }

    await this.db.permission.delete({ where: { id } });

    await this.config.invalidate({
      entity: 'permission',
      operation: 'delete',
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    this.audit('delete', existing, input.actorUserId);
  }

  async require(id: string): Promise<Permission> {
    const permission = await this.db.permission.findUnique({ where: { id } });

    if (!permission) {
      throw new AppError(
        ERROR_CODES.PERMISSION_NOT_FOUND,
        'Permission not found',
        404,
      );
    }

    return permission;
  }

  /**
   * A grant listing only removed actions would become "all actions" if it were
   * simply emptied — the opposite of what its author meant — so it is deleted
   * instead.
   */
  private async pruneGrantActions(
    permissionId: string,
    surviving: string[],
    removed: string[],
  ): Promise<void> {
    const grants = await this.db.grant.findMany({ where: { permissionId } });

    for (const grant of grants) {
      if (grant.actions.length === 0) {
        continue;
      }

      const kept = grant.actions.filter((action) => surviving.includes(action));

      if (kept.length === grant.actions.length) {
        continue;
      }

      if (kept.length === 0) {
        await this.db.grant.delete({ where: { id: grant.id } });

        this.logger.warn({
          event: 'rbac.grant.dropped_by_permission_change',
          grantId: grant.id,
          removed,
        });

        continue;
      }

      await this.db.grant.update({
        where: { id: grant.id },
        data: { actions: kept },
      });
    }
  }

  private audit(
    operation: string,
    permission: Permission,
    actorUserId: string | undefined,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.log({
      event: `rbac.permission.${operation}`,
      actorUserId,
      permissionId: permission.id,
      permissionName: permission.name,
      ...extra,
    });
  }

  private async assertNameFree(name: string): Promise<void> {
    const clash = await this.db.permission.findUnique({ where: { name } });

    if (clash) {
      throw new AppError(
        ERROR_CODES.PERMISSION_ALREADY_EXISTS,
        'A permission with this name already exists',
        409,
      );
    }
  }
}

/** Deduplicated and sorted, so the config hash does not move on a reorder. */
function normalizeActions(actions: string[]): string[] {
  return [...new Set(actions.map((action) => action.trim()))]
    .filter(Boolean)
    .sort();
}

function toDto(permission: Permission): PermissionDto {
  return {
    id: permission.id,
    name: permission.name,
    actions: permission.actions,
  };
}
