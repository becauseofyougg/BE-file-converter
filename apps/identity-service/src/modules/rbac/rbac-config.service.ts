import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';

import {
  DOMAIN_EVENTS,
  type RbacUpdatedPayload,
} from '@contracts/events/domain.events';
import type { RbacConfig } from '@contracts/messages/rbac.messages';
import { decideAccess, type AccessDecision } from '@core/rbac/rbac-policy';
import { PrismaService } from '../../database/prisma.service';
import { OutboxService } from '../outbox/outbox.service';

export interface RbacChangeNotice {
  entity: RbacUpdatedPayload['entity'];
  operation: RbacUpdatedPayload['operation'];
  actorUserId?: string;
  correlationId: string;
}

/**
 * Builds, caches and invalidates the RBAC config.
 *
 * identity-service holds a cache of its own even though it owns the tables:
 * `rbac.check` would otherwise be three joins per call, and the gateway's
 * `get-config` is on the boot path of every replica.
 *
 * The cache is dropped on any write and rebuilt on the next read, rather than
 * rebuilt eagerly — a burst of admin edits then costs one rebuild, not one per
 * statement.
 */
@Injectable()
export class RbacConfigService {
  private readonly logger = new Logger(RbacConfigService.name);
  private cached: RbacConfig | null = null;

  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
    private readonly outbox: OutboxService,
  ) {}

  private get db() {
    return this.txHost.tx;
  }

  async getConfig(): Promise<RbacConfig> {
    if (this.cached) {
      return this.cached;
    }

    const config = await this.build();
    this.cached = config;

    this.logger.log({
      event: 'rbac.config.loaded',
      version: config.version,
      roles: config.roles.length,
      permissions: config.permissions.length,
    });

    return config;
  }

  async check(
    roles: string[],
    permission: string,
    action: string,
  ): Promise<AccessDecision> {
    return decideAccess(await this.getConfig(), roles, permission, action);
  }

  /**
   * Called by every mutating RBAC operation. Drops the local cache and puts
   * `rbac.updated` in the outbox so the gateways reload theirs — the outbox,
   * not a direct publish, so a rolled-back change cannot announce itself.
   */
  async invalidate(notice: RbacChangeNotice): Promise<void> {
    // Rebuilt rather than merely dropped, because the event has to carry the
    // version the listeners are about to fetch. The result is cached: the next
    // reader wants exactly this.
    const config = await this.build();
    this.cached = config;
    const { version } = config;

    await this.outbox.publish<RbacUpdatedPayload>(
      DOMAIN_EVENTS.RBAC_UPDATED,
      {
        version,
        entity: notice.entity,
        operation: notice.operation,
        actorUserId: notice.actorUserId,
      },
      notice.correlationId,
    );

    this.logger.log({
      event: 'rbac.config.invalidated',
      version,
      entity: notice.entity,
      operation: notice.operation,
      actorUserId: notice.actorUserId,
    });
  }

  private async build(): Promise<RbacConfig> {
    const [permissions, roles] = await Promise.all([
      this.db.permission.findMany({ orderBy: { name: 'asc' } }),
      this.db.role.findMany({
        orderBy: { name: 'asc' },
        include: {
          grants: {
            include: { permission: { select: { name: true } } },
            orderBy: { permissionId: 'asc' },
          },
        },
      }),
    ]);

    const shape = {
      permissions: permissions.map((permission) => ({
        name: permission.name,
        actions: [...permission.actions].sort(),
      })),
      roles: roles.map((role) => ({
        name: role.name,
        grants: role.grants.map((grant) => ({
          permission: grant.permission.name,
          actions: [...grant.actions].sort(),
        })),
      })),
    };

    return {
      ...shape,
      // A digest of the content, not a counter: two replicas building the same
      // rules independently produce the same version, so "are these gateways
      // agreeing?" is answerable by comparing one string.
      version: createHash('sha256')
        .update(JSON.stringify(shape))
        .digest('hex')
        .slice(0, 16),
      generatedAt: new Date().toISOString(),
    };
  }
}
