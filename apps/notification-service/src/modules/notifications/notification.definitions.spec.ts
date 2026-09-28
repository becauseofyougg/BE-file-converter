// The DTOs are decorated, and nothing else here would load the polyfill.
import 'reflect-metadata';

import { DOMAIN_EVENTS } from '@contracts/events/domain.events';
import type { TemplatesService } from '../templates/templates.service';
import { NOTIFICATION_DEFINITIONS as N } from './notification.definitions';

const USER_ID = '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90';
const confirmation = {
  method: 'otp' as const,
  secret: '482915',
  expiresAt: '2026-09-28T12:10:00.000Z',
};

describe('notification definitions', () => {
  let templates: jest.Mocked<TemplatesService>;
  const rendered = { subject: 's', text: 't', html: 'h' };

  beforeEach(() => {
    templates = {
      emailVerification: jest.fn().mockReturnValue(rendered),
      registrationAttempted: jest.fn().mockReturnValue(rendered),
      loginConfirmation: jest.fn().mockReturnValue(rendered),
      emailChangeConfirmation: jest.fn().mockReturnValue(rendered),
      emailChanged: jest.fn().mockReturnValue(rendered),
      deletionConfirmation: jest.fn().mockReturnValue(rendered),
      accountDeleted: jest.fn().mockReturnValue(rendered),
    } as unknown as jest.Mocked<TemplatesService>;
  });

  it('answers each event it names, and names each one once', () => {
    const events = Object.values(N).map((definition) => definition.event);

    expect(new Set(events).size).toBe(events.length);
    expect(events).toEqual(
      expect.arrayContaining([
        DOMAIN_EVENTS.USER_REGISTERED,
        DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
        DOMAIN_EVENTS.USER_REGISTRATION_ATTEMPTED,
        DOMAIN_EVENTS.USER_LOGIN_CONFIRMATION_REQUESTED,
        DOMAIN_EVENTS.USER_EMAIL_CHANGE_REQUESTED,
        DOMAIN_EVENTS.USER_EMAIL_CHANGED,
        DOMAIN_EVENTS.USER_DELETION_REQUESTED,
        DOMAIN_EVENTS.USER_DELETED,
      ]),
    );
  });

  describe('registration', () => {
    const payload = {
      userId: USER_ID,
      email: 'jane@example.com',
      confirmation,
    };

    it('mails the code to the address that registered', () => {
      expect(N.userRegistered.recipient(payload)).toBe('jane@example.com');
      expect(N.userRegistered.expiresAt?.(payload)).toBe(
        confirmation.expiresAt,
      );
      expect(N.userRegistered.render(payload, templates)).toBe(rendered);
      expect(templates.emailVerification).toHaveBeenCalledWith(confirmation);
    });

    /** Confirmation off: the user was signed straight in. */
    it('sends nothing when there is nothing to confirm', () => {
      const bare = { userId: USER_ID, email: 'jane@example.com' };

      expect(N.userRegistered.render(bare, templates)).toBeNull();
      expect(N.userRegistered.expiresAt?.(bare)).toBeUndefined();
    });

    it('sends a resend exactly like the first one', () => {
      expect(N.verificationResent.render(payload, templates)).toBe(rendered);
      expect(N.verificationResent.payload).toBe(N.userRegistered.payload);
    });
  });

  it('tells the owner of an address that someone tried to register it', () => {
    const payload = { userId: USER_ID, email: 'jane@example.com' };

    expect(N.registrationAttempted.recipient(payload)).toBe('jane@example.com');
    expect(N.registrationAttempted.render(payload, templates)).toBe(rendered);
    expect(N.registrationAttempted.expiresAt).toBeUndefined();
  });

  it('passes the sign-in origin to the login mail', () => {
    const payload = {
      userId: USER_ID,
      email: 'jane@example.com',
      ...confirmation,
      userAgent: 'Firefox',
      ip: '203.0.113.7',
    };

    expect(N.loginConfirmationRequested.recipient(payload)).toBe(
      'jane@example.com',
    );
    expect(N.loginConfirmationRequested.expiresAt?.(payload)).toBe(
      confirmation.expiresAt,
    );

    N.loginConfirmationRequested.render(payload, templates);

    expect(templates.loginConfirmation).toHaveBeenCalledWith(payload, {
      userAgent: 'Firefox',
      ip: '203.0.113.7',
    });
  });

  describe('email change', () => {
    const requested = {
      userId: USER_ID,
      newEmail: 'new@example.com',
      ...confirmation,
    };
    const changed = {
      userId: USER_ID,
      previousEmail: 'old@example.com',
      newEmail: 'new@example.com',
    };

    /** The point is to prove the new mailbox can be read. */
    it('sends the confirmation to the new address', () => {
      expect(N.emailChangeRequested.recipient(requested)).toBe(
        'new@example.com',
      );
      expect(N.emailChangeRequested.expiresAt?.(requested)).toBe(
        confirmation.expiresAt,
      );
      N.emailChangeRequested.render(requested, templates);
      expect(templates.emailChangeConfirmation).toHaveBeenCalledWith(
        USER_ID,
        requested,
      );
    });

    /** The only address an account takeover does not control. */
    it('sends the notice of the change to the old address', () => {
      expect(N.emailChanged.recipient(changed)).toBe('old@example.com');
    });

    it('says whether an administrator made the change', () => {
      N.emailChanged.render(changed, templates);
      N.emailChanged.render({ ...changed, actorUserId: USER_ID }, templates);

      expect(templates.emailChanged.mock.calls).toEqual([[false], [true]]);
    });
  });

  describe('deletion', () => {
    it('asks the account owner to confirm', () => {
      const payload = {
        userId: USER_ID,
        email: 'jane@example.com',
        ...confirmation,
      };

      expect(N.deletionRequested.recipient(payload)).toBe('jane@example.com');
      expect(N.deletionRequested.expiresAt?.(payload)).toBe(
        confirmation.expiresAt,
      );
      N.deletionRequested.render(payload, templates);
      expect(templates.deletionConfirmation).toHaveBeenCalledWith(
        USER_ID,
        payload,
      );
    });

    it('says goodbye to the address the account had', () => {
      const payload = {
        userId: USER_ID,
        email: 'jane@example.com',
        deletedAt: '2026-09-28T12:00:00.000Z',
      };

      expect(N.userDeleted.recipient(payload)).toBe('jane@example.com');
      N.userDeleted.render(payload, templates);
      N.userDeleted.render({ ...payload, actorUserId: USER_ID }, templates);

      expect(templates.accountDeleted.mock.calls).toEqual([[false], [true]]);
    });
  });
});
