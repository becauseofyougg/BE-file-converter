import { MailDeliveryError } from './mail-delivery.error';

const smtpError = (fields: { message?: string } & Record<string, unknown>) =>
  Object.assign(new Error(fields.message ?? 'failed'), fields);

describe('MailDeliveryError', () => {
  describe('retryable', () => {
    it.each([
      [
        'a 4xx reply — the server saying "not now"',
        { code: 'EENVELOPE', responseCode: 451 },
        true,
      ],
      [
        'a 5xx reply — the server saying "not ever"',
        { code: 'EENVELOPE', responseCode: 550 },
        false,
      ],
      ['a refused connection', { code: 'ECONNECTION' }, true],
      ['a timeout', { code: 'ETIMEDOUT' }, true],
      ['a DNS failure', { code: 'EDNS' }, true],
      ['a malformed message', { code: 'EMESSAGE' }, false],
      ['an envelope rejected before any reply', { code: 'EENVELOPE' }, false],
      ['an error nobody classified', {}, true],
    ])('%s → %s', (_label, fields, expected) => {
      expect(MailDeliveryError.from(smtpError(fields)).retryable).toBe(
        expected,
      );
    });

    /**
     * A wrong SMTP password answers 535. That is our configuration, not the
     * message — treating it as permanent would discard every mail until
     * someone noticed.
     */
    it('retries an authentication failure even though it carries a 5xx', () => {
      expect(
        MailDeliveryError.from(smtpError({ code: 'EAUTH', responseCode: 535 }))
          .retryable,
      ).toBe(true);
    });

    it('retries something that is not an error at all', () => {
      expect(MailDeliveryError.from(undefined).retryable).toBe(true);
    });
  });

  describe('summary', () => {
    /** It is stored in the send log and logged — neither may hold an address. */
    it('masks the addresses an SMTP reply quotes back', () => {
      const { summary } = MailDeliveryError.from(
        smtpError({
          code: 'EENVELOPE',
          responseCode: 550,
          response:
            '550 5.1.1 <jane.doe+tag@example.com>: Recipient address rejected',
        }),
      );

      expect(summary).toBe(
        'EENVELOPE 550 550 5.1.1 <[address]>: Recipient address rejected',
      );
      expect(summary).not.toContain('example.com');
    });

    it('keeps the first line of a multi-line reply', () => {
      const { summary } = MailDeliveryError.from(
        smtpError({ response: '421 busy\r\nmore detail' }),
      );

      expect(summary).toBe('421 busy');
    });

    it('falls back to the message when there is no reply', () => {
      expect(
        MailDeliveryError.from(
          smtpError({ code: 'ECONNECTION', message: 'connect ECONNREFUSED' }),
        ).summary,
      ).toBe('ECONNECTION connect ECONNREFUSED');
    });

    it('stays inside the column it is stored in', () => {
      const { summary } = MailDeliveryError.from(
        smtpError({ response: 'x'.repeat(1_000) }),
      );

      expect(summary.length).toBeLessThanOrEqual(200);
    });

    it('says something even about nothing', () => {
      expect(MailDeliveryError.from(null).summary).toBe('unknown error');
    });
  });

  it('passes an already-classified error through untouched', () => {
    const original = new MailDeliveryError(false, 'already decided');

    expect(MailDeliveryError.from(original)).toBe(original);
  });
});
