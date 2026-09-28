import type { ClassConstructor } from 'class-transformer';

import {
  DOMAIN_EVENTS,
  type DomainEventName,
} from '@contracts/events/domain.events';
import type { RenderedMail } from '../templates/rendered-mail';
import type { TemplatesService } from '../templates/templates.service';
import {
  DeletionRequestedDto,
  EmailChangedDto,
  EmailChangeRequestedDto,
  LoginConfirmationRequestedDto,
  RegistrationAttemptedDto,
  UserDeletedDto,
  UserRegisteredDto,
} from './dto/event.dto';

/**
 * Everything the delivery pipeline needs to know about one kind of event: how
 * to validate it, who it goes to, and what it says. Adding a mail is one entry
 * here and one `@EventPattern` in the controller.
 */
export interface NotificationDefinition<P extends { userId: string }> {
  event: DomainEventName;
  payload: ClassConstructor<P>;
  recipient: (payload: P) => string;
  /**
   * When the code or link inside stops working. Past it, the mail is dropped
   * rather than sent: an expired code arriving late is worse than none, since
   * the user types it, fails, and concludes the product is broken.
   */
  expiresAt?: (payload: P) => string | undefined;
  /** `null` when this event needs no mail at all. */
  render: (payload: P, templates: TemplatesService) => RenderedMail | null;
}

function define<P extends { userId: string }>(
  definition: NotificationDefinition<P>,
): NotificationDefinition<P> {
  return definition;
}

/** Same data, same mail — a resend differs only in the code it carries. */
const verification = (event: DomainEventName) =>
  define({
    event,
    payload: UserRegisteredDto,
    recipient: (p) => p.email,
    expiresAt: (p) => p.confirmation?.expiresAt,
    // No confirmation means confirmation is switched off: the user was signed
    // straight in, and there is nothing to send.
    render: (p, t) =>
      p.confirmation ? t.emailVerification(p.confirmation) : null,
  });

export const NOTIFICATION_DEFINITIONS = {
  userRegistered: verification(DOMAIN_EVENTS.USER_REGISTERED),

  verificationResent: verification(DOMAIN_EVENTS.USER_VERIFICATION_RESENT),

  registrationAttempted: define({
    event: DOMAIN_EVENTS.USER_REGISTRATION_ATTEMPTED,
    payload: RegistrationAttemptedDto,
    recipient: (p) => p.email,
    render: (_p, t) => t.registrationAttempted(),
  }),

  loginConfirmationRequested: define({
    event: DOMAIN_EVENTS.USER_LOGIN_CONFIRMATION_REQUESTED,
    payload: LoginConfirmationRequestedDto,
    recipient: (p) => p.email,
    expiresAt: (p) => p.expiresAt,
    render: (p, t) =>
      t.loginConfirmation(p, { userAgent: p.userAgent, ip: p.ip }),
  }),

  emailChangeRequested: define({
    event: DOMAIN_EVENTS.USER_EMAIL_CHANGE_REQUESTED,
    payload: EmailChangeRequestedDto,
    // The new address — the point is to prove it can be read.
    recipient: (p) => p.newEmail,
    expiresAt: (p) => p.expiresAt,
    render: (p, t) => t.emailChangeConfirmation(p.userId, p),
  }),

  emailChanged: define({
    event: DOMAIN_EVENTS.USER_EMAIL_CHANGED,
    payload: EmailChangedDto,
    // The old address — the only one an account takeover does not control.
    recipient: (p) => p.previousEmail,
    render: (p, t) => t.emailChanged(p.actorUserId !== undefined),
  }),

  deletionRequested: define({
    event: DOMAIN_EVENTS.USER_DELETION_REQUESTED,
    payload: DeletionRequestedDto,
    recipient: (p) => p.email,
    expiresAt: (p) => p.expiresAt,
    render: (p, t) => t.deletionConfirmation(p.userId, p),
  }),

  userDeleted: define({
    event: DOMAIN_EVENTS.USER_DELETED,
    payload: UserDeletedDto,
    recipient: (p) => p.email,
    render: (p, t) => t.accountDeleted(p.actorUserId !== undefined),
  }),
} as const;
