import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  RBAC_PATTERNS,
  type RbacConfig,
} from '@contracts/messages/rbac.messages';
import { emptyRbacConfig } from '@core/rbac/rbac-policy';
import { IDENTITY_CLIENT } from '../../messaging/messaging.module';
import { sendRpc } from '../../messaging/rpc';

const RELOAD_TIMEOUT_MS = 5_000;

/** Doubling from one second, capped at thirty — see `scheduleRetry`. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/**
 * The gateway's copy of the RBAC config.
 *
 * Loaded once at boot and reloaded when identity announces a change, so a
 * decision costs no I/O — the alternative, asking identity per request, puts a
 * broker round trip in front of every authorised call.
 *
 * It starts **empty**, and an empty config denies everything. A gateway that
 * came up without rules would otherwise have to choose between allowing
 * everything and pretending; denying is the only safe reading, and the
 * `/health` route is public so the failure is visible rather than silent.
 */
@Injectable()
export class RbacConfigCache implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RbacConfigCache.name);
  private config: RbacConfig = emptyRbacConfig();
  private loading: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;

  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: ClientProxy,
  ) {}

  async onModuleInit(): Promise<void> {
    // A failure here must not stop the gateway booting: identity may simply be
    // slower to start. The config stays empty — denying — and the retry
    // scheduled by the failed fetch fills it in.
    await this.reload('boot').catch(() => undefined);
  }

  onModuleDestroy(): void {
    this.cancelRetry();
  }

  current(): RbacConfig {
    return this.config;
  }

  isLoaded(): boolean {
    return this.config.version !== emptyRbacConfig().version;
  }

  /**
   * Concurrent triggers collapse into one in-flight fetch — several
   * `rbac.updated` messages arriving together should not mean several
   * round trips for the same answer.
   */
  async reload(trigger: string, expectedVersion?: string): Promise<void> {
    if (expectedVersion && this.config.version === expectedVersion) {
      return;
    }

    if (this.loading) {
      return this.loading;
    }

    this.loading = this.fetch(trigger).finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  private async fetch(trigger: string): Promise<void> {
    try {
      const config = await sendRpc<RbacConfig, Record<string, never>>(
        this.identity,
        RBAC_PATTERNS.GET_CONFIG,
        {},
        RELOAD_TIMEOUT_MS,
      );

      const previous = this.config.version;
      this.config = config;
      this.retryAttempt = 0;
      this.cancelRetry();

      this.logger.log({
        event: 'rbac.config.reloaded',
        trigger,
        from: previous,
        to: config.version,
        roles: config.roles.length,
        permissions: config.permissions.length,
      });
    } catch (error) {
      // The previous config is kept: stale rules are better than none, and
      // none would lock every user out because the evaluator fails closed.
      this.logger.error({
        event: 'rbac.config.reload_failed',
        trigger,
        keptVersion: this.config.version,
        reason: error instanceof Error ? error.message : 'unknown',
      });

      this.scheduleRetry();

      throw error;
    }
  }

  /**
   * Waiting for the next `rbac.updated` is not a recovery plan. An empty
   * config denies `rbac@manage` too, so the admin change that would trigger
   * the event is itself refused — without a retry, a gateway that booted
   * before identity stayed locked out until restarted. A failed reload after a
   * change is the milder case of the same thing: stale rules until the next
   * change, whenever that is.
   *
   * At most one retry is pending; a fetch that succeeds in the meantime, by
   * whatever trigger, cancels it.
   */
  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }

    const delayMs = Math.min(
      RETRY_BASE_MS * 2 ** this.retryAttempt,
      RETRY_MAX_MS,
    );
    this.retryAttempt += 1;

    this.logger.warn({
      event: 'rbac.config.retry_scheduled',
      attempt: this.retryAttempt,
      delayMs,
    });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // A failure schedules the next attempt from inside `fetch`.
      void this.reload('retry').catch(() => undefined);
    }, delayMs);

    // Never the reason the process stays up.
    this.retryTimer.unref();
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
