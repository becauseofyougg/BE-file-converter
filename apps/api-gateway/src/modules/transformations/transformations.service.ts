import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';

import { AppError } from '@core/errors/app-error';
import { decideAccess } from '@core/rbac/rbac-policy';
import {
  CONVERSION_RPC_PATTERNS,
  TRANSFORMATIONS_READ_PERMISSION,
  type TransformationHistoryFilters,
  type TransformationHistoryPage,
  type TransformationHistoryRequest,
} from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  USERS_PATTERNS,
  type GetUserStatusRequest,
  type UserStatusRecord,
} from '@contracts/messages/users.messages';
import type { RequestUser } from '../auth/request-user';
import {
  CONVERSION_CLIENT,
  IDENTITY_CLIENT,
} from '../../messaging/messaging.module';
import { sendRpc } from '../../messaging/rpc';
import { RbacConfigCache } from '../rbac/rbac-config.cache';

export interface HistoryQuery extends TransformationHistoryFilters {
  cursor?: string;
  limit?: number;
}

/** Whose history, and on what authority. */
export type HistoryScope =
  | { kind: 'self' }
  | { kind: 'admin'; targetUserId: string };

/**
 * The transformation history, own or another user's —
 * docs/TRANSFORMATION-HISTORY.md.
 *
 * The order is the defence, and it is fixed:
 *
 * 1. **Authority.** Another user's history needs `transformations@read`,
 *    checked here against the cached RBAC config rather than by the route
 *    guard, so that a refusal is audited like every other outcome.
 * 2. **Existence**, only then. Answering 404 before 403 would let anyone
 *    learn which user ids are real.
 * 3. **The query**, always for exactly one `userId`: the caller's own, or
 *    the one the permission was checked for. Nothing else reaches the
 *    conversion service.
 *
 * Every request ends in one audit line: who asked, about whom, with which
 * filters, how it ended, how many records went out — never the records.
 */
@Injectable()
export class TransformationsService {
  private readonly logger = new Logger(TransformationsService.name);

  constructor(
    @Inject(CONVERSION_CLIENT) private readonly conversion: ClientProxy,
    @Inject(IDENTITY_CLIENT) private readonly identity: ClientProxy,
    private readonly rbac: RbacConfigCache,
  ) {}

  async history(
    actor: RequestUser,
    scope: HistoryScope,
    query: HistoryQuery,
    correlationId: string,
  ): Promise<TransformationHistoryPage> {
    const targetUserId = scope.kind === 'self' ? actor.id : scope.targetUserId;

    try {
      if (scope.kind === 'admin') {
        this.assertMayReadOthers(actor);
      }

      await this.assertActive(targetUserId, scope, correlationId);

      const page = await sendRpc<
        TransformationHistoryPage,
        TransformationHistoryRequest
      >(this.conversion, CONVERSION_RPC_PATTERNS.TRANSFORMATIONS, {
        ...query,
        userId: targetUserId,
        correlationId,
      });

      this.audit(actor, scope, targetUserId, query, 200, page.items.length);

      return page;
    } catch (error) {
      this.audit(
        actor,
        scope,
        targetUserId,
        query,
        error instanceof AppError ? error.httpStatus : 500,
        0,
      );

      throw error;
    }
  }

  private assertMayReadOthers(actor: RequestUser): void {
    const decision = decideAccess(
      this.rbac.current(),
      actor.roles,
      TRANSFORMATIONS_READ_PERMISSION.resource,
      TRANSFORMATIONS_READ_PERMISSION.action,
    );

    if (!decision.allowed) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403);
    }
  }

  /**
   * The account must exist and not be erased. For an administrator's request
   * a missing user is the spec's 404. For a user's own, it means a session
   * outliving its account (an access token lives 15 minutes past erasure):
   * that is a 401, not a "your history is not found".
   */
  private async assertActive(
    userId: string,
    scope: HistoryScope,
    correlationId: string,
  ): Promise<void> {
    try {
      await sendRpc<UserStatusRecord, GetUserStatusRequest>(
        this.identity,
        USERS_PATTERNS.GET_STATUS,
        { userId, correlationId },
      );
    } catch (error) {
      if (
        scope.kind === 'self' &&
        error instanceof AppError &&
        error.code === ERROR_CODES.USER_NOT_FOUND
      ) {
        throw new AppError(
          ERROR_CODES.UNAUTHENTICATED,
          'The account no longer exists',
          401,
        );
      }

      throw error;
    }
  }

  private audit(
    actor: RequestUser,
    scope: HistoryScope,
    targetUserId: string,
    query: HistoryQuery,
    status: number,
    returned: number,
  ): void {
    const entry = {
      event: 'transformations.history.read',
      actorUserId: actor.id,
      ...(scope.kind === 'admin' ? { targetUserId } : {}),
      scope: scope.kind,
      // The filters are formats, statuses and dates — nothing personal. The
      // cursor is only noted as present: it is a position, and noise.
      query: {
        ...query,
        cursor: query.cursor === undefined ? undefined : '[present]',
      },
      status,
      returned,
    };

    if (status === 200) {
      this.logger.log(entry);
    } else {
      this.logger.warn(entry);
    }
  }
}
