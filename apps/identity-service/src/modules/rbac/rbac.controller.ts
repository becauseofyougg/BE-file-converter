import { randomUUID } from 'node:crypto';

import { Controller, Logger, UseFilters, ValidationPipe } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';

import {
  RBAC_PATTERNS,
  type CheckAccessResponse,
  type GrantDto,
  type PermissionDto,
  type RbacConfig,
  type RoleDto,
} from '@contracts/messages/rbac.messages';
import { AppError } from '@core/errors/app-error';
import { RpcAppExceptionFilter } from '@core/errors/rpc-app-exception.filter';
import { settleRpc } from '@core/messaging/rmq-ack';
import { GrantsService } from './grants.service';
import { PermissionsService } from './permissions.service';
import { RbacConfigService } from './rbac-config.service';
import { RolesService } from './roles.service';
import { UserRolesService } from './user-roles.service';
import {
  AssignUserRolesMessageDto,
  CheckAccessMessageDto,
  CreateGrantMessageDto,
  CreatePermissionMessageDto,
  CreateRoleMessageDto,
  EntityIdMessageDto,
  UpdateGrantMessageDto,
  UpdatePermissionMessageDto,
  UpdateRoleMessageDto,
  UserIdMessageDto,
} from './dto/rbac.dto';

/** Mirrors the gateway's global pipe; this boundary validates independently. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

/**
 * The RBAC surface. Authorisation for these operations happens at the gateway,
 * which is the only caller and the only place that has a token to check —
 * identity trusts `actorUserId` for the audit trail alone, never for a
 * decision.
 */
@Controller()
@UseFilters(RpcAppExceptionFilter)
export class RbacController {
  private readonly logger = new Logger(RbacController.name);

  constructor(
    private readonly config: RbacConfigService,
    private readonly roles: RolesService,
    private readonly permissions: PermissionsService,
    private readonly grants: GrantsService,
    private readonly userRoles: UserRolesService,
  ) {}

  @MessagePattern(RBAC_PATTERNS.GET_CONFIG)
  getConfig(@Ctx() context: RmqContext): Promise<RbacConfig> {
    return settleRpc(context, () => this.config.getConfig());
  }

  @MessagePattern(RBAC_PATTERNS.CHECK)
  check(
    @Payload(pipe) dto: CheckAccessMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<CheckAccessResponse> {
    return settleRpc(context, async () => {
      const decision = await this.config.check(
        dto.roles,
        dto.permission,
        dto.action,
      );

      return { allowed: decision.allowed, reason: decision.reason };
    });
  }

  // --- roles ---------------------------------------------------------------

  @MessagePattern(RBAC_PATTERNS.LIST_ROLES)
  listRoles(@Ctx() context: RmqContext): Promise<RoleDto[]> {
    return settleRpc(context, () => this.roles.list());
  }

  @MessagePattern(RBAC_PATTERNS.CREATE_ROLE)
  createRole(
    @Payload(pipe) dto: CreateRoleMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<RoleDto> {
    return settleRpc(
      context,
      this.audited('role', 'create', dto, () =>
        this.roles.create({
          name: dto.name,
          description: dto.description ?? null,
          ...actor(dto),
        }),
      ),
    );
  }

  @MessagePattern(RBAC_PATTERNS.UPDATE_ROLE)
  updateRole(
    @Payload(pipe) dto: UpdateRoleMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<RoleDto> {
    return settleRpc(
      context,
      this.audited('role', 'update', dto, () =>
        this.roles.update(dto.id, {
          name: dto.name,
          description: dto.description,
          ...actor(dto),
        }),
      ),
    );
  }

  @MessagePattern(RBAC_PATTERNS.DELETE_ROLE)
  deleteRole(
    @Payload(pipe) dto: EntityIdMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<{ deleted: true }> {
    return settleRpc(
      context,
      this.audited('role', 'delete', dto, async () => {
        await this.roles.remove(dto.id, actor(dto));

        return { deleted: true as const };
      }),
    );
  }

  // --- permissions ---------------------------------------------------------

  @MessagePattern(RBAC_PATTERNS.LIST_PERMISSIONS)
  listPermissions(@Ctx() context: RmqContext): Promise<PermissionDto[]> {
    return settleRpc(context, () => this.permissions.list());
  }

  @MessagePattern(RBAC_PATTERNS.CREATE_PERMISSION)
  createPermission(
    @Payload(pipe) dto: CreatePermissionMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<PermissionDto> {
    return settleRpc(
      context,
      this.audited('permission', 'create', dto, () =>
        this.permissions.create({
          name: dto.name,
          actions: dto.actions,
          ...actor(dto),
        }),
      ),
    );
  }

  @MessagePattern(RBAC_PATTERNS.UPDATE_PERMISSION)
  updatePermission(
    @Payload(pipe) dto: UpdatePermissionMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<PermissionDto> {
    return settleRpc(
      context,
      this.audited('permission', 'update', dto, () =>
        this.permissions.update(dto.id, {
          name: dto.name,
          actions: dto.actions,
          ...actor(dto),
        }),
      ),
    );
  }

  @MessagePattern(RBAC_PATTERNS.DELETE_PERMISSION)
  deletePermission(
    @Payload(pipe) dto: EntityIdMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<{ deleted: true }> {
    return settleRpc(
      context,
      this.audited('permission', 'delete', dto, async () => {
        await this.permissions.remove(dto.id, actor(dto));

        return { deleted: true as const };
      }),
    );
  }

  // --- grants --------------------------------------------------------------

  @MessagePattern(RBAC_PATTERNS.LIST_GRANTS)
  listGrants(@Ctx() context: RmqContext): Promise<GrantDto[]> {
    return settleRpc(context, () => this.grants.list());
  }

  @MessagePattern(RBAC_PATTERNS.CREATE_GRANT)
  createGrant(
    @Payload(pipe) dto: CreateGrantMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<GrantDto> {
    return settleRpc(
      context,
      this.audited('grant', 'create', dto, () =>
        this.grants.create({
          roleId: dto.roleId,
          permissionId: dto.permissionId,
          actions: dto.actions,
          ...actor(dto),
        }),
      ),
    );
  }

  @MessagePattern(RBAC_PATTERNS.UPDATE_GRANT)
  updateGrant(
    @Payload(pipe) dto: UpdateGrantMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<GrantDto> {
    return settleRpc(
      context,
      this.audited('grant', 'update', dto, () =>
        this.grants.update(dto.id, {
          roleId: dto.roleId,
          permissionId: dto.permissionId,
          actions: dto.actions,
          ...actor(dto),
        }),
      ),
    );
  }

  @MessagePattern(RBAC_PATTERNS.DELETE_GRANT)
  deleteGrant(
    @Payload(pipe) dto: EntityIdMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<{ deleted: true }> {
    return settleRpc(
      context,
      this.audited('grant', 'delete', dto, async () => {
        await this.grants.remove(dto.id, actor(dto));

        return { deleted: true as const };
      }),
    );
  }

  // --- user roles ----------------------------------------------------------

  @MessagePattern(RBAC_PATTERNS.GET_USER_ROLES)
  getUserRoles(
    @Payload(pipe) dto: UserIdMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<string[]> {
    return settleRpc(context, () => this.userRoles.namesFor(dto.userId));
  }

  @MessagePattern(RBAC_PATTERNS.ASSIGN_USER_ROLES)
  assignUserRoles(
    @Payload(pipe) dto: AssignUserRolesMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<string[]> {
    return settleRpc(
      context,
      this.audited('user_roles', 'replace', dto, () =>
        this.userRoles.replace(dto.userId, dto.roles, actor(dto)),
      ),
    );
  }

  /**
   * docs/RBAC.md §10: the result of every write, not only the ones that
   * succeed. A success is logged by the service that made it, with the detail
   * only it has; a refusal — 400, 404, 409 — is only thrown there, so it is
   * logged here, where the entity, the operation and the actor are all in
   * hand. Anything that is not an `AppError` is a crash, and the RPC filter
   * logs those with their stack.
   */
  private audited<T>(
    entity: 'role' | 'permission' | 'grant' | 'user_roles',
    operation: 'create' | 'update' | 'delete' | 'replace',
    dto: { actorUserId?: string; id?: string; userId?: string },
    write: () => Promise<T>,
  ): () => Promise<T> {
    return async () => {
      try {
        return await write();
      } catch (error) {
        if (error instanceof AppError) {
          this.logger.warn({
            event: `rbac.${entity}.${operation}.rejected`,
            actorUserId: dto.actorUserId,
            targetId: dto.id ?? dto.userId,
            code: error.code,
            status: error.httpStatus,
          });
        }

        throw error;
      }
    };
  }
}

function actor(dto: { actorUserId?: string; correlationId?: string }): {
  actorUserId?: string;
  correlationId: string;
} {
  return {
    actorUserId: dto.actorUserId,
    correlationId: dto.correlationId ?? randomUUID(),
  };
}
