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

export const CORRELATION_ID_HEADER = 'x-correlation-id';
