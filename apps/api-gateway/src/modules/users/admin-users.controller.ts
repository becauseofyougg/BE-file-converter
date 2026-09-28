import { randomUUID } from 'node:crypto';

import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

import {
  ErrorResponseDto,
  UserListResponseDto,
} from '../shared/api-responses.dto';

import type {
  ListUsersResponse,
  UserListItem,
} from '@contracts/messages/users.messages';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';
import {
  CurrentUser,
  JwtAuthGuard,
  type RequestUser,
} from '../auth/jwt-auth.guard';
import { Permissions, RbacGuard } from '../rbac/rbac.guard';
import { ListUsersQueryDto } from './dto/list-users.dto';
import { UsersService } from './users.service';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The administrative user list — docs/USER-LIST.md.
 *
 * `/admin/users` rather than `GET /users` with a role check, which §1.3.1 left
 * open. It sits beside `/admin/rbac/*`, so the administrative surface is one
 * prefix a reverse proxy or a WAF can treat as a unit; and `/users/:userId`
 * already means "a profile, self or otherwise", which is a different thing from
 * a directory of everyone.
 *
 * This is also the one users route whose rule a decorator *can* express. The
 * others turn on whether the target happens to be the caller, which the gateway
 * cannot weigh; here there is no self case at all, so `users@list` is declared
 * on the route in the ordinary way ([RBAC.md](../../../../../docs/RBAC.md) §9).
 * Identity checks it again — a value the gateway puts in a message is not a
 * credential.
 */
@ApiTags('admin')
@ApiCookieAuth('access_token')
@ApiResponse({
  status: 401,
  description: 'No session.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 403,
  description: 'The caller does not hold `users@list`.',
  type: ErrorResponseDto,
})
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RbacGuard)
@Permissions('users@list')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * Paginated by cursor, never by offset. `?limit=` is bounded at both ends by
   * the DTO, so no single request can ask for the whole table.
   */
  @ApiOperation({
    summary: 'List accounts',
    description:
      'Cursor-paginated, never offset. `nextCursor` is opaque and only valid for the sort it was issued under — changing `sort` mid-pagination is a `400`, because a position in one ordering means nothing in another.',
  })
  @ApiResponse({ status: 200, type: UserListResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'A malformed cursor, one from a different sort, or a value outside one of the closed sets.',
    type: ErrorResponseDto,
  })
  @Get()
  @Throttle({ default: { limit: 120, ttl: HOUR_MS } })
  listUsers(
    @Query() query: ListUsersQueryDto,
    @CurrentUser() viewer: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<ListUsersResponse<UserListItem>> {
    return this.users.listUsers({
      viewerUserId: viewer.id,
      viewerRoles: viewer.roles,
      cursor: query.cursor,
      limit: query.limit,
      q: query.q,
      status: query.status,
      sort: query.sort,
      order: query.order,
      correlationId:
        (request.headers[CORRELATION_ID_HEADER] as string | undefined) ??
        String(request.id ?? randomUUID()),
    });
  }
}
