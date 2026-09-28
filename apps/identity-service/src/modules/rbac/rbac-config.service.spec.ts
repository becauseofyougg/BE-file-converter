import type { TransactionHost } from '@nestjs-cls/transactional';

import { DOMAIN_EVENTS } from '@contracts/events/domain.events';

import type { OutboxService } from '../outbox/outbox.service';
import { RbacConfigService } from './rbac-config.service';

describe('RbacConfigService', () => {
  let permission: { findMany: jest.Mock };
  let role: { findMany: jest.Mock };
  let outbox: jest.Mocked<OutboxService>;
  let service: RbacConfigService;

  const notice = {
    entity: 'grant' as const,
    operation: 'update' as const,
    actorUserId: 'admin-1',
    correlationId: 'correlation-1',
  };

  beforeEach(() => {
    permission = {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { name: 'users', actions: ['update', 'read', 'delete'] },
        ]),
    };
    role = {
      findMany: jest.fn().mockResolvedValue([
        {
          name: 'ADMIN',
          grants: [{ actions: [], permission: { name: 'users' } }],
        },
      ]),
    };

    outbox = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OutboxService>;

    service = new RbacConfigService(
      { tx: { permission, role } } as unknown as TransactionHost<never>,
      outbox,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  describe('getConfig', () => {
    it('builds the config from the tables', async () => {
      const config = await service.getConfig();

      expect(config.permissions).toEqual([
        { name: 'users', actions: ['delete', 'read', 'update'] },
      ]);
      expect(config.roles).toEqual([
        { name: 'ADMIN', grants: [{ permission: 'users', actions: [] }] },
      ]);
    });

    /**
     * `rbac.check` would otherwise be three joins per call, and the gateway's
     * `get-config` is on the boot path of every replica.
     */
    it('reads the tables once and serves the cache after', async () => {
      await service.getConfig();
      await service.getConfig();

      expect(role.findMany).toHaveBeenCalledTimes(1);
    });

    /**
     * A digest of the content, not a counter: two replicas building the same
     * rules independently produce the same version, so "are these gateways
     * agreeing?" is answerable by comparing one string.
     */
    it('versions by content, so identical rules version identically', async () => {
      const first = await service.getConfig();

      const other = new RbacConfigService(
        { tx: { permission, role } } as unknown as TransactionHost<never>,
        outbox,
      );
      jest.spyOn(other['logger'], 'log').mockImplementation(() => undefined);

      expect((await other.getConfig()).version).toBe(first.version);
    });

    it('versions differently when the rules differ', async () => {
      const before = await service.getConfig();

      role.findMany.mockResolvedValue([
        {
          name: 'ADMIN',
          grants: [{ actions: ['read'], permission: { name: 'users' } }],
        },
      ]);
      await service.invalidate(notice);

      expect((await service.getConfig()).version).not.toBe(before.version);
    });

    /** Sorted on both sides, or the digest would depend on row order. */
    it('sorts actions so the digest is stable', async () => {
      const config = await service.getConfig();

      expect(config.permissions[0].actions).toEqual([
        'delete',
        'read',
        'update',
      ]);
    });
  });

  describe('check', () => {
    it('allows what an empty-actions grant covers', async () => {
      await expect(service.check(['ADMIN'], 'users', 'read')).resolves.toEqual(
        expect.objectContaining({ allowed: true }),
      );
    });

    it('denies a role that holds nothing', async () => {
      await expect(
        service.check(['STRANGER'], 'users', 'read'),
      ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    });

    it('denies an action the permission does not define', async () => {
      await expect(
        service.check(['ADMIN'], 'users', 'incinerate'),
      ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    });
  });

  describe('invalidate', () => {
    /**
     * Through the outbox, not a direct publish, so a rolled-back change cannot
     * announce itself.
     */
    it('announces the change with the version listeners will fetch', async () => {
      await service.invalidate(notice);

      const [eventName, payload] = outbox.publish.mock.calls[0] as [
        string,
        { version: string },
      ];

      expect(eventName).toBe(DOMAIN_EVENTS.RBAC_UPDATED);
      expect(payload.version).toBe((await service.getConfig()).version);
    });

    it('carries who did it and what changed', async () => {
      await service.invalidate(notice);

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.RBAC_UPDATED,
        expect.objectContaining({
          entity: 'grant',
          operation: 'update',
          actorUserId: 'admin-1',
        }),
        'correlation-1',
      );
    });

    /** Rebuilt rather than merely dropped: the next reader wants exactly this. */
    it('leaves the rebuilt config cached', async () => {
      await service.invalidate(notice);
      role.findMany.mockClear();

      await service.getConfig();

      expect(role.findMany).not.toHaveBeenCalled();
    });
  });
});
