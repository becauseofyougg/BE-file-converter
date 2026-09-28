import { FormatFamily } from '../enums/conversion.enums';

import {
  CORRELATION_ID_HEADER,
  EXCHANGES,
  NOTIFICATION_RETRY_DELAYS_MS,
  QUEUES,
  RETRY_COUNT_HEADER,
  RETRY_DELAYS_MS,
  ROUTING_KEYS,
} from './topology';

/**
 * These names are a contract between a publisher and a consumer that never see
 * each other's code. A typo on one side is a message that silently goes
 * nowhere — which is exactly the failure a test catches and a code review
 * does not.
 */
describe('broker topology', () => {
  it('names the two exchanges', () => {
    expect(EXCHANGES).toEqual({
      CONVERSION_COMMANDS: 'conversion.commands',
      DOMAIN_EVENTS: 'domain.events',
    });
  });

  it('derives one work queue per format family', () => {
    expect(QUEUES.conversionJobs(FormatFamily.IMAGE)).toBe(
      `conversion.jobs.${FormatFamily.IMAGE}`,
    );
    expect(QUEUES.conversionJobs(FormatFamily.DOCUMENT)).not.toBe(
      QUEUES.conversionJobs(FormatFamily.IMAGE),
    );
  });

  it('derives one retry queue per attempt', () => {
    expect(QUEUES.conversionRetry(1)).toBe('conversion.retry.1');
    expect(QUEUES.conversionRetry(2)).toBe('conversion.retry.2');
  });

  it('routes a command by its family', () => {
    expect(ROUTING_KEYS.convert(FormatFamily.AUDIO)).toBe(
      `convert.${FormatFamily.AUDIO}`,
    );
  });

  /** One delay per attempt, or the ladder runs off its end. */
  it('has a backoff step for every retry the ladder allows', () => {
    expect(RETRY_DELAYS_MS).toHaveLength(3);
    expect([...RETRY_DELAYS_MS]).toEqual(
      [...RETRY_DELAYS_MS].sort((a, b) => a - b),
    );
  });

  /**
   * The retry queues dead-letter back to the work queue by name, so the two
   * must share a prefix an operator can find them by, and the ladder must only
   * ever wait longer.
   */
  it('derives one notification retry queue per step, backing off', () => {
    expect(QUEUES.notificationRetry(1)).toBe('notification.events.retry.1');
    expect(QUEUES.notificationRetry(1).startsWith(QUEUES.NOTIFICATIONS)).toBe(
      true,
    );
    expect(QUEUES.NOTIFICATIONS_DLQ).toBe('notification.events.dlq');
    expect([...NOTIFICATION_RETRY_DELAYS_MS]).toEqual(
      [...NOTIFICATION_RETRY_DELAYS_MS].sort((a, b) => a - b),
    );
    expect(RETRY_COUNT_HEADER).toBe('x-retry-count');
  });

  it('agrees with the header the logger and the filters read', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
  });
});
