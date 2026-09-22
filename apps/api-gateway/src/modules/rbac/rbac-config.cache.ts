import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  RBAC_PATTERNS,
  type RbacConfig,
} from '@contracts/messages/rbac.messages';
import { emptyRbacConfig } from '@core/rbac/rbac-policy';
import { IDENTITY_CLIENT } from '../../messaging/messaging.module';
import { sendRpc } from '../../messaging/rpc';

const RELOAD_TIMEOUT_MS = 5_000;

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
export class RbacConfigCache implements OnModuleInit {
  private readonly logger = new Logger(RbacConfigCache.name);
  private config: RbacConfig = emptyRbacConfig();
  private loading: Promise<void> | null = null;

  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: ClientProxy,
  ) {}

  async onModuleInit(): Promise<void> {
    // A failure here must not stop the gateway booting: identity may simply be
    // slower to start. The config stays empty — denying — and the next
    // `rbac.updated`, or the retry below, fills it in.
    await this.reload('boot').catch(() => undefined);
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

      throw error;
    }
  }
}
