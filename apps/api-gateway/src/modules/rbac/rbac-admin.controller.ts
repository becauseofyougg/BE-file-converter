import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';

import {
  RBAC_PATTERNS,
  type GrantDto,
  type PermissionDto,
  type RbacConfig,
  type RoleDto,
} from '@contracts/messages/rbac.messages';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';
import { IDENTITY_CLIENT } from '../../messaging/messaging.module';
import { sendRpc } from '../../messaging/rpc';
import {
  CurrentUser,
  JwtAuthGuard,
  type RequestUser,
} from '../auth/jwt-auth.guard';
import {
  AssignUserRolesDto,
  CreateGrantDto,
  CreatePermissionDto,
  CreateRoleDto,
  UpdateGrantDto,
  UpdatePermissionDto,
  UpdateRoleDto,
} from './dto/rbac.dto';
import { Permissions, RbacGuard } from './rbac.guard';

/**
 * The administrative surface of docs/RBAC.md §1.3.2–1.3.4.
 *
 * Every route needs `rbac@manage`, which only ADMIN is granted — and the
 * requirement is declared here rather than assumed from a role name, so
 * handing a new role the same power is a data change, not a deploy.
 *
 * The gateway forwards; identity decides and owns the tables. `actorUserId`
 * travels with each call for the audit trail only — identity never authorises
 * on it, because a value the gateway puts in a message is not a credential.
 */
@Controller('admin/rbac')
@UseGuards(JwtAuthGuard, RbacGuard)
@Permissions('rbac@manage')
export class RbacAdminController {
  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: ClientProxy,
  ) {}

  @Get('config')
  @Permissions('rbac@read')
  getConfig(@Req() request: FastifyRequest): Promise<RbacConfig> {
    return this.call<RbacConfig>(RBAC_PATTERNS.GET_CONFIG, {}, request);
  }

  // --- roles ---------------------------------------------------------------

  @Get('roles')
  @Permissions('rbac@read')
  listRoles(@Req() request: FastifyRequest): Promise<RoleDto[]> {
    return this.call<RoleDto[]>(RBAC_PATTERNS.LIST_ROLES, {}, request);
  }

  @Post('roles')
  createRole(
    @Body() dto: CreateRoleDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<RoleDto> {
    return this.call<RoleDto>(RBAC_PATTERNS.CREATE_ROLE, dto, request, user);
  }

  @Put('roles/:id')
  updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<RoleDto> {
    return this.call<RoleDto>(
      RBAC_PATTERNS.UPDATE_ROLE,
      { ...dto, id },
      request,
      user,
    );
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRole(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.call(RBAC_PATTERNS.DELETE_ROLE, { id }, request, user);
  }

  // --- permissions ---------------------------------------------------------

  @Get('permissions')
  @Permissions('rbac@read')
  listPermissions(@Req() request: FastifyRequest): Promise<PermissionDto[]> {
    return this.call<PermissionDto[]>(
      RBAC_PATTERNS.LIST_PERMISSIONS,
      {},
      request,
    );
  }

  @Post('permissions')
  createPermission(
    @Body() dto: CreatePermissionDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<PermissionDto> {
    return this.call<PermissionDto>(
      RBAC_PATTERNS.CREATE_PERMISSION,
      dto,
      request,
      user,
    );
  }

  @Put('permissions/:id')
  updatePermission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePermissionDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<PermissionDto> {
    return this.call<PermissionDto>(
      RBAC_PATTERNS.UPDATE_PERMISSION,
      { ...dto, id },
      request,
      user,
    );
  }

  @Delete('permissions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePermission(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.call(RBAC_PATTERNS.DELETE_PERMISSION, { id }, request, user);
  }

  // --- grants --------------------------------------------------------------

  @Get('grants')
  @Permissions('rbac@read')
  listGrants(@Req() request: FastifyRequest): Promise<GrantDto[]> {
    return this.call<GrantDto[]>(RBAC_PATTERNS.LIST_GRANTS, {}, request);
  }

  @Post('grants')
  createGrant(
    @Body() dto: CreateGrantDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<GrantDto> {
    return this.call<GrantDto>(RBAC_PATTERNS.CREATE_GRANT, dto, request, user);
  }

  @Put('grants/:id')
  updateGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGrantDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<GrantDto> {
    return this.call<GrantDto>(
      RBAC_PATTERNS.UPDATE_GRANT,
      { ...dto, id },
      request,
      user,
    );
  }

  @Delete('grants/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.call(RBAC_PATTERNS.DELETE_GRANT, { id }, request, user);
  }

  // --- user roles ----------------------------------------------------------

  @Get('users/:userId/roles')
  @Permissions('rbac@read')
  getUserRoles(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() request: FastifyRequest,
  ): Promise<string[]> {
    return this.call<string[]>(
      RBAC_PATTERNS.GET_USER_ROLES,
      { userId },
      request,
    );
  }

  /**
   * Replaces the user's roles. Note the lag this introduces: their existing
   * access token still carries the old set until it expires — see
   * docs/RBAC.md §1.3.1.
   */
  @Put('users/:userId/roles')
  assignUserRoles(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AssignUserRolesDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<string[]> {
    return this.call<string[]>(
      RBAC_PATTERNS.ASSIGN_USER_ROLES,
      { userId, roles: dto.roles },
      request,
      user,
    );
  }

  private call<T>(
    pattern: string,
    payload: object,
    request: FastifyRequest,
    user?: RequestUser,
  ): Promise<T> {
    return sendRpc<T, Record<string, unknown>>(this.identity, pattern, {
      ...payload,
      correlationId:
        (request.headers[CORRELATION_ID_HEADER] as string | undefined) ??
        String(request.id ?? randomUUID()),
      ...(user ? { actorUserId: user.id } : {}),
    });
  }
}
