import { FormatFamily } from '../enums/conversion.enums';

/**
 * Broker topology — see ARCHITECTURE.md §4. Exchange, queue and routing-key
 * names live here because both the publisher and the consumer must agree on
 * them, and a typo on one side is otherwise a message that silently goes nowhere.
 */

export const EXCHANGES = {
  /** direct — commands that must happen exactly once, load-balanced */
  CONVERSION_COMMANDS: 'conversion.commands',
  /** topic — facts other services may react to, fan-out */
  DOMAIN_EVENTS: 'domain.events',
} as const;

export const QUEUES = {
  /** request/response RPC surface of identity-service */
  IDENTITY_RPC: 'identity.rpc',
  /** one work queue per format family, one deployment per work queue */
  conversionJobs: (family: FormatFamily) => `conversion.jobs.${family}`,
  /** retry ladder: x-message-ttl + DLX back to the work queue */
  conversionRetry: (attempt: number) => `conversion.retry.${attempt}`,
  CONVERSION_DLQ: 'conversion.jobs.dlq',
  /** fan-out subscribers of domain.events */
  NOTIFICATIONS: 'notification.events',
  /**
   * Notification retry ladder, one queue per step: a message waits out the
   * queue's TTL and is dead-lettered straight back to `notification.events`.
   * Waiting there rather than in the consumer is what stops one greylisted
   * recipient from holding up everyone else's mail.
   */
  notificationRetry: (step: number) => `notification.events.retry.${step}`,
  /** Where a notification goes once the ladder is exhausted, for an operator. */
  NOTIFICATIONS_DLQ: 'notification.events.dlq',
  GATEWAY_EVENTS: 'gateway.events',
} as const;

export const ROUTING_KEYS = {
  convert: (family: FormatFamily) => `convert.${family}`,
} as const;

/**
 * Retry backoff in milliseconds, one entry per attempt. Retryable failures
 * only — a corrupt input never burns three attempts.
 */
export const RETRY_DELAYS_MS: readonly number[] = [10_000, 60_000, 300_000];

/**
 * Notification backoff, one entry per step of `notificationRetry`. Longer than
 * the conversion ladder because what fails here is somebody else's server:
 * a mail provider that is rate-limiting or restarting recovers in minutes, not
 * seconds. Four steps span ~42 minutes — past any code's lifetime, which is
 * fine, because an expired code is dropped rather than sent.
 */
export const NOTIFICATION_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 120_000, 600_000, 1_800_000,
];

/** How many times a message has been through a retry ladder. */
export const RETRY_COUNT_HEADER = 'x-retry-count';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
