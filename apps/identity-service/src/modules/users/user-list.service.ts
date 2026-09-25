import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma-clients/identity';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  USER_LIST_LIMITS,
  USER_LIST_PERMISSION,
  USER_LIST_SORTS,
  USER_STATUSES,
  type ListUsersRequest,
  type ListUsersResponse,
  type SortOrder,
  type UserListItemRecord,
  type UserListSort,
  type UserStatus,
} from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';
import { RbacConfigService } from '../rbac/rbac-config.service';
import { encodeCursor, decodeCursor } from './user-list.cursor';
import { UsersService, type User } from './users.service';

/**
 * The administrative user list — docs/USER-LIST.md.
 *
 * Unlike every other route in this module there is no "self" case: nobody lists
 * their own account. That makes this the one users endpoint whose rule a route
 * decorator *can* express, and the gateway declares `users@list` on it
 * directly. The check is repeated here because identity does not take the
 * gateway's word for an authorisation — see §3.
 */
@Injectable()
export class UserListService {
  private readonly logger = new Logger(UserListService.name);

  constructor(
    private readonly users: UsersService,
    private readonly rbac: RbacConfigService,
  ) {}

  async listUsers(
    input: ListUsersRequest,
  ): Promise<ListUsersResponse<UserListItemRecord>> {
    await this.assertMayList(input);

    const sort = input.sort ?? USER_LIST_SORTS.CREATED_AT;
    const order = input.order ?? 'desc';
    const limit = clampLimit(input.limit);

    const cursor = input.cursor
      ? decodeCursor(input.cursor, { sort, order })
      : null;

    // One row more than asked for. Its presence is the answer to "is there
    // another page", which a count query would also answer — at the cost of a
    // second scan of everything the filter matches, on every page.
    const rows = await this.users.findManyForList({
      where: buildWhere(input.q, input.status),
      orderBy: buildOrderBy(sort, order),
      take: limit + 1,
      cursorId: cursor?.id,
    });

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page.at(-1);

    this.logger.log({
      event: 'users.list.read',
      actorUserId: input.viewerUserId,
      // The filters, but never the search string: `q` is whatever an
      // administrator typed, and that is routinely somebody's address.
      status: input.status,
      searched: input.q !== undefined,
      sort,
      order,
      limit,
      returned: page.length,
    });

    return {
      items: page.map(toListItem),
      nextCursor:
        hasMore && last ? encodeCursor({ id: last.id, sort, order }) : null,
    };
  }

  private async assertMayList(input: ListUsersRequest): Promise<void> {
    const decision = await this.rbac.check(
      input.viewerRoles,
      USER_LIST_PERMISSION.resource,
      USER_LIST_PERMISSION.action,
    );

    if (!decision.allowed) {
      this.logger.warn({
        event: 'users.list.forbidden',
        actorUserId: input.viewerUserId,
        reason: decision.reason,
      });

      throw new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403);
    }
  }
}

/**
 * Names every field explicitly and never spreads the row — the same rule the
 * profile projection follows. A column added to `users` later cannot appear
 * here by accident, which is what §1.4's "no sensitive fields" needs in order
 * to hold without anyone remembering it.
 */
function toListItem(user: User): UserListItemRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    photoKey: user.photoKey,
    status: statusOf(user),
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

/** The four states of docs/USER-LIST.md §4, in the order they take precedence. */
export function statusOf(user: User): UserStatus {
  if (user.deletedAt !== null) {
    return USER_STATUSES.DELETED;
  }

  if (user.emailVerifiedAt === null) {
    return USER_STATUSES.UNVERIFIED;
  }

  if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
    return USER_STATUSES.LOCKED;
  }

  return USER_STATUSES.ACTIVE;
}

/**
 * §1.4 asks for the searchable fields to be limited so a query cannot get
 * heavy, and this is where that is honoured.
 *
 * `q` matches an exact id, an exact address, or a substring of the display
 * name — every one of those index-backed. Substring search *on the address* is
 * deliberately not offered: `ILIKE '%…%'` over a `citext` column cannot use the
 * unique index, and adding a second trigram index over the addresses of every
 * user in the system to support a convenience is the wrong trade. An
 * administrator searching by email has the whole address in front of them, on a
 * ticket.
 */
function buildWhere(q?: string, status?: UserStatus): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {};
  const term = q?.trim();

  if (term) {
    where.OR = [
      // citext, so this is already case-insensitive and uses the unique index.
      { email: term },
      { displayName: { contains: term, mode: 'insensitive' } },
      ...(UUID_PATTERN.test(term) ? [{ id: term }] : []),
    ];
  }

  return { ...where, ...statusFilter(status) };
}

/**
 * No filter means live accounts only. Erased ones are tombstones, and every
 * other read path in the service already treats them as absent — a list that
 * mixed them in by default would be the one place that disagrees.
 */
function statusFilter(status?: UserStatus): Prisma.UserWhereInput {
  const now = new Date();

  switch (status) {
    case USER_STATUSES.DELETED:
      return { deletedAt: { not: null } };
    case USER_STATUSES.UNVERIFIED:
      return { deletedAt: null, emailVerifiedAt: null };
    case USER_STATUSES.LOCKED:
      return { deletedAt: null, lockedUntil: { gt: now } };
    case USER_STATUSES.ACTIVE:
      return {
        deletedAt: null,
        emailVerifiedAt: { not: null },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      };
    default:
      return { deletedAt: null };
  }
}

/**
 * Always two keys. The second is the tie-break that makes the ordering total:
 * without it two rows sharing a `created_at` have no defined order between
 * them, and a cursor sitting on that boundary can skip one and repeat another
 * on the next page. That is exactly the instability §1.6 asks to avoid.
 *
 * Nulls sort last whichever direction is asked for — an account that has never
 * signed in belongs at the end of "most recent" and at the end of "least
 * recent" too, because "never" is not a date and pretending it is the smallest
 * one puts every dormant account first.
 */
function buildOrderBy(
  sort: UserListSort,
  order: SortOrder,
): Prisma.UserOrderByWithRelationInput[] {
  switch (sort) {
    case USER_LIST_SORTS.EMAIL:
      return [{ email: order }, { id: order }];
    case USER_LIST_SORTS.LAST_LOGIN:
      return [{ lastLoginAt: { sort: order, nulls: 'last' } }, { id: order }];
    case USER_LIST_SORTS.CREATED_AT:
    default:
      return [{ createdAt: order }, { id: order }];
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined) {
    return USER_LIST_LIMITS.DEFAULT;
  }

  // The DTO has already refused anything outside the range; this is the
  // backstop for a caller that is not the gateway.
  return Math.min(
    Math.max(Math.trunc(limit), USER_LIST_LIMITS.MIN),
    USER_LIST_LIMITS.MAX,
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
