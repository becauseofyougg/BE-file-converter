import { ConfigService } from '@core/config/config.service';
import type { NotificationConfig } from '../../config/notification.config';
import { LinkService } from './link.service';
import {
  type Confirmation,
  describeLifetime,
  TemplatesService,
} from './templates.service';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const IN_10_MINUTES = '2026-09-28T12:10:00.000Z';
const USER_ID = '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90';

const otp: Confirmation = {
  method: 'otp',
  secret: '482915',
  expiresAt: IN_10_MINUTES,
};
const link: Confirmation = {
  method: 'link',
  secret: 'tok_abc-123',
  expiresAt: IN_10_MINUTES,
};

describe('TemplatesService', () => {
  let templates: TemplatesService;

  beforeEach(() => {
    templates = new TemplatesService(
      new LinkService(
        new ConfigService<NotificationConfig>({
          APP_PUBLIC_URL: 'https://app.example.com',
        }),
      ),
    );
  });

  describe('a confirmation mail', () => {
    it('shows a code, and says when it stops working', () => {
      const mail = templates.emailVerification(otp, NOW);

      expect(mail.subject).toBe('Confirm your email address');
      expect(mail.text).toContain('482915');
      expect(mail.text).toContain('expires in 10 minutes');
      expect(mail.html).not.toContain('href=');
    });

    it('or a link to the frontend page, instead of the code', () => {
      const mail = templates.emailVerification(link, NOW);

      expect(mail.text).toContain(
        'https://app.example.com/verify-email?token=tok_abc-123',
      );
      expect(mail.text).toContain('works once and expires in 10 minutes');
    });

    /** The confirm endpoints for these two are scoped to the account. */
    it.each([
      [
        'email change',
        () => templates.emailChangeConfirmation(USER_ID, link, NOW),
        `https://app.example.com/account/email/confirm?userId=${USER_ID}&token=tok_abc-123`,
      ],
      [
        'deletion',
        () => templates.deletionConfirmation(USER_ID, link, NOW),
        `https://app.example.com/account/delete/confirm?userId=${USER_ID}&token=tok_abc-123`,
      ],
      [
        'login',
        () => templates.loginConfirmation(link, {}, NOW),
        'https://app.example.com/login/confirm?token=tok_abc-123',
      ],
    ])('carries the account in a %s link', (_label, render, url) => {
      expect(render().text).toContain(url);
    });

    it('defaults to the current time', () => {
      const soon = new Date(Date.now() + 5 * 60_000).toISOString();

      expect(
        templates.deletionConfirmation(USER_ID, { ...otp, expiresAt: soon })
          .text,
      ).toContain('expires in 5 minutes');
    });
  });

  describe('login confirmation', () => {
    it('shows where the sign-in came from, so the owner can recognise it', () => {
      const mail = templates.loginConfirmation(
        otp,
        { userAgent: 'Firefox on Linux', ip: '203.0.113.7' },
        NOW,
      );

      expect(mail.text).toContain('Device: Firefox on Linux');
      expect(mail.text).toContain('IP address: 203.0.113.7');
      expect(mail.text).toContain('change it');
    });

    it('leaves the origin out when it is not known', () => {
      const mail = templates.loginConfirmation(otp, {}, NOW);

      expect(mail.text).not.toContain('Device:');
      expect(mail.text).not.toContain('IP address:');
    });
  });

  it('tells the owner about a registration attempt without asking them to act', () => {
    const mail = templates.registrationAttempted();

    expect(mail.subject).toBe('Someone tried to register with your email');
    expect(mail.text).toContain('Nothing was changed');
  });

  describe('email changed', () => {
    it('says who made the change', () => {
      expect(templates.emailChanged(true).text).toContain('An administrator');
      expect(templates.emailChanged(false).text).not.toContain(
        'An administrator',
      );
    });

    it('tells the old address it no longer signs in', () => {
      expect(templates.emailChanged(false).text).toContain(
        'no longer signs in',
      );
    });
  });

  describe('account deleted', () => {
    it('says who deleted it, and that no more mail follows', () => {
      const byAdmin = templates.accountDeleted(true);
      const bySelf = templates.accountDeleted(false);

      expect(byAdmin.text).toContain('An administrator deleted');
      expect(bySelf.text).not.toContain('An administrator');
      expect(bySelf.text).toContain('last email');
    });
  });
});

describe('describeLifetime', () => {
  const after = (minutes: number) =>
    new Date(NOW.getTime() + minutes * 60_000).toISOString();

  it.each([
    [0.5, 'in about a minute'],
    [1, 'in about a minute'],
    [10, 'in 10 minutes'],
    [89, 'in 89 minutes'],
    [90, 'in 2 hours'],
    [24 * 60, 'in 24 hours'],
    [7 * 24 * 60, 'in 7 days'],
  ])('%d minutes reads as "%s"', (minutes, expected) => {
    expect(describeLifetime(after(minutes), NOW)).toBe(expected);
  });
});
