import { randomUUID } from 'node:crypto';

import { Controller, UseFilters, ValidationPipe } from '@nestjs/common';
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
    return settleRpc(context, () =>
      this.roles.create({
        name: dto.name,
        description: dto.description ?? null,
        ...actor(dto),
      }),
    );
  }

  @MessagePattern(RBAC_PATTERNS.UPDATE_ROLE)
  updateRole(
    @Payload(pipe) dto: UpdateRoleMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<RoleDto> {
    return settleRpc(context, () =>
      this.roles.update(dto.id, {
        name: dto.name,
        description: dto.description,
        ...actor(dto),
      }),
    );
  }

  @MessagePattern(RBAC_PATTERNS.DELETE_ROLE)
  deleteRole(
    @Payload(pipe) dto: EntityIdMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<{ deleted: true }> {
    return settleRpc(context, async () => {
      await this.roles.remove(dto.id, actor(dto));

      return { deleted: true as const };
    });
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
    return settleRpc(context, () =>
      this.permissions.create({
        name: dto.name,
        actions: dto.actions,
        ...actor(dto),
      }),
    );
  }

  @MessagePattern(RBAC_PATTERNS.UPDATE_PERMISSION)
  updatePermission(
    @Payload(pipe) dto: UpdatePermissionMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<PermissionDto> {
    return settleRpc(context, () =>
      this.permissions.update(dto.id, {
        name: dto.name,
        actions: dto.actions,
        ...actor(dto),
      }),
    );
  }

  @MessagePattern(RBAC_PATTERNS.DELETE_PERMISSION)
  deletePermission(
    @Payload(pipe) dto: EntityIdMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<{ deleted: true }> {
    return settleRpc(context, async () => {
      await this.permissions.remove(dto.id, actor(dto));

      return { deleted: true as const };
    });
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
    return settleRpc(context, () =>
      this.grants.create({
        roleId: dto.roleId,
        permissionId: dto.permissionId,
        actions: dto.actions,
        ...actor(dto),
      }),
    );
  }

  @MessagePattern(RBAC_PATTERNS.UPDATE_GRANT)
  updateGrant(
    @Payload(pipe) dto: UpdateGrantMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<GrantDto> {
    return settleRpc(context, () =>
      this.grants.update(dto.id, {
        roleId: dto.roleId,
        permissionId: dto.permissionId,
        actions: dto.actions,
        ...actor(dto),
      }),
    );
  }

  @MessagePattern(RBAC_PATTERNS.DELETE_GRANT)
  deleteGrant(
    @Payload(pipe) dto: EntityIdMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<{ deleted: true }> {
    return settleRpc(context, async () => {
      await this.grants.remove(dto.id, actor(dto));

      return { deleted: true as const };
    });
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
    return settleRpc(context, () =>
      this.userRoles.replace(dto.userId, dto.roles, actor(dto)),
    );
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
