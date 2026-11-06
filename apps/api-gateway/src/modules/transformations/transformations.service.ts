import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';

import { AppError } from '@core/errors/app-error';
import { decideAccess } from '@core/rbac/rbac-policy';
import { StorageResolver } from '@storage/storage-resolver';
import {
  CONVERSION_RPC_PATTERNS,
  type ConversionOperationRecord,
  type ConversionOperationRequest,
  type ConversionResultFile,
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
import {
  type DownloadableResult,
  openResult,
} from '../conversions/result-stream';
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
    private readonly resolver: StorageResolver,
  ) {}

  async history(
    actor: RequestUser,
    scope: HistoryScope,
    query: HistoryQuery,
    correlationId: string,
  ): Promise<TransformationHistoryPage> {
    const targetUserId = scope.kind === 'self' ? actor.id : scope.targetUserId;

    try {
      await this.authorise(actor, scope, targetUserId, correlationId);

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

  /** One of the caller's own operations, in full — docs/SAVED-RESULTS.md §2. */
  operation(
    actor: RequestUser,
    operationId: string,
    correlationId: string,
  ): Promise<ConversionOperationRecord> {
    return sendRpc<ConversionOperationRecord, ConversionOperationRequest>(
      this.conversion,
      CONVERSION_RPC_PATTERNS.HISTORY_GET,
      { userId: actor.id, operationId, correlationId },
    );
  }

  /**
   * A saved result, own or — with `transformations@read` — anyone's:
   * docs/SAVED-RESULTS.md. The same order as the list: authority, then the
   * user, then the record, looked up by owner **and** id, so an id belonging
   * to someone else is the same 404 as one that does not exist.
   *
   * Audited once the transfer ends, with how many bytes went and how long it
   * took; a refusal is audited at once.
   */
  async download(
    actor: RequestUser,
    scope: HistoryScope,
    operationId: string,
    correlationId: string,
  ): Promise<DownloadableResult> {
    const targetUserId = scope.kind === 'self' ? actor.id : scope.targetUserId;
    const startedAt = Date.now();
    const audit = { actor, scope, targetUserId, operationId, startedAt };

    try {
      await this.authorise(actor, scope, targetUserId, correlationId);

      const file = await sendRpc<
        ConversionResultFile,
        ConversionOperationRequest
      >(this.conversion, CONVERSION_RPC_PATTERNS.HISTORY_RESULT, {
        userId: targetUserId,
        operationId,
        correlationId,
      });
      const stream = await openResult(this.resolver, file, this.logger);

      let completed = false;

      stream.once('end', () => {
        completed = true;
      });
      stream.once('close', () =>
        this.auditDownload(audit, completed ? 200 : 499, file),
      );

      return { file, stream, operationId };
    } catch (error) {
      this.auditDownload(
        audit,
        error instanceof AppError ? error.httpStatus : 500,
      );

      throw error;
    }
  }

  /**
   * The access order shared by every read: authority first (another user's
   * records need `transformations@read`), existence only then.
   */
  private async authorise(
    actor: RequestUser,
    scope: HistoryScope,
    targetUserId: string,
    correlationId: string,
  ): Promise<void> {
    if (scope.kind === 'admin') {
      this.assertMayReadOthers(actor);
    }

    await this.assertActive(targetUserId, scope, correlationId);
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

  /**
   * The download's audit line. `status` 499 is a transfer the client gave up
   * on part-way — the response had started, so it is not an error status the
   * client saw, but it is not a completed download either.
   */
  private auditDownload(
    context: {
      actor: RequestUser;
      scope: HistoryScope;
      targetUserId: string;
      operationId: string;
      startedAt: number;
    },
    status: number,
    file?: ConversionResultFile,
  ): void {
    const entry = {
      event: 'transformations.file.download',
      actorUserId: context.actor.id,
      ...(context.scope.kind === 'admin'
        ? { targetUserId: context.targetUserId }
        : {}),
      scope: context.scope.kind,
      transformationId: context.operationId,
      fileId: file?.fileId ?? null,
      fileSize: file?.size ?? null,
      status,
      result: status === 200 ? 'success' : 'failure',
      durationMs: Date.now() - context.startedAt,
    };

    if (status === 200) {
      this.logger.log(entry);
    } else {
      this.logger.warn(entry);
    }
  }
}
