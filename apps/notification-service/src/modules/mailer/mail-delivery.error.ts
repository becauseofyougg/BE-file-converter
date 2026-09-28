import type { NodemailerError } from 'nodemailer';

/**
 * Failures that are about *our* side of the conversation — the connection, the
 * credentials, the TLS handshake — and say nothing about the message. They are
 * retried even when the server attached a 5xx: a wrong SMTP password answers
 * `535`, and treating that as "this mail can never be delivered" would discard
 * every notification until someone fixed the config.
 */
const TRANSIENT_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ETLS',
  'EPROXY',
  'EAUTH',
  'ENOAUTH',
  'EOAUTH2',
  'EMAXLIMIT',
]);

/** Failures of the message itself, which a retry would reproduce exactly. */
const PERMANENT_CODES = new Set([
  'EENVELOPE',
  'EMESSAGE',
  'EMAXRECIPIENTS',
  'EREQUIRETLS',
  'ECONFIG',
]);

const MAX_SUMMARY_LENGTH = 200;

/**
 * An SMTP reply routinely quotes the recipient back —
 * `550 5.1.1 <jane@example.com>: Recipient address rejected`. The summary ends
 * up in the send log and in log lines, neither of which may hold an address.
 */
const ADDRESS = /[^\s<>"'@]+@[^\s<>"']+/g;

/**
 * A send that did not happen, and whether trying again could change that.
 *
 * The SMTP reply class is the signal: 4xx is the server saying "not now", 5xx
 * is "not ever". Where there is no reply at all, the socket never got that far,
 * and the failure is presumed to be the network's rather than the message's.
 */
export class MailDeliveryError extends Error {
  constructor(
    readonly retryable: boolean,
    /** Code and first reply line, with any address masked. Safe to store. */
    readonly summary: string,
  ) {
    super(summary);
    this.name = MailDeliveryError.name;
  }

  static from(error: unknown): MailDeliveryError {
    if (error instanceof MailDeliveryError) {
      return error;
    }

    const failure = (error ?? {}) as NodemailerError;

    return new MailDeliveryError(
      MailDeliveryError.isRetryable(failure),
      MailDeliveryError.summarise(failure),
    );
  }

  private static isRetryable({ code, responseCode }: NodemailerError): boolean {
    if (code && TRANSIENT_CODES.has(code)) {
      return true;
    }

    if (typeof responseCode === 'number') {
      return responseCode < 500;
    }

    return !(code && PERMANENT_CODES.has(code));
  }

  private static summarise({
    code,
    responseCode,
    response,
    message,
  }: NodemailerError): string {
    const reply = (response ?? message ?? 'unknown error').split(/\r?\n/)[0];

    return [code, responseCode, reply.replace(ADDRESS, '[address]')]
      .filter((part) => part !== undefined && part !== '')
      .join(' ')
      .slice(0, MAX_SUMMARY_LENGTH);
  }
}
