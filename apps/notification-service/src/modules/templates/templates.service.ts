import { Injectable } from '@nestjs/common';

import { compose, PRODUCT_NAME, type MailContent } from './compose';
import {
  FRONTEND_ROUTES,
  type FrontendRoute,
  LinkService,
} from './link.service';
import type { RenderedMail } from './rendered-mail';

/** A code or a link token, and when it stops working. */
export interface Confirmation {
  method: 'otp' | 'link';
  secret: string;
  expiresAt: string;
}

interface ConfirmationTarget {
  route: FrontendRoute;
  /** Extra query parameters the page needs besides the token. */
  params?: Record<string, string>;
}

/**
 * One method per mail. Each takes only what that mail shows — never a whole
 * event — so what can end up in a user's inbox is visible from the signature.
 *
 * English only for now; the wording is kept to one place so a locale lookup
 * can replace it without touching the handlers.
 */
@Injectable()
export class TemplatesService {
  constructor(private readonly links: LinkService) {}

  emailVerification(
    confirmation: Confirmation,
    now = new Date(),
  ): RenderedMail {
    return this.confirmationMail(
      {
        subject: 'Confirm your email address',
        heading: 'Confirm your email address',
        paragraphs: [
          `Welcome to ${PRODUCT_NAME}. Confirm this address to finish creating your account.`,
        ],
        footer: [
          'If you did not create an account, ignore this email — without confirmation nothing happens.',
        ],
      },
      confirmation,
      { route: FRONTEND_ROUTES.VERIFY_EMAIL },
      now,
    );
  }

  /**
   * Somebody registered with an address that already has an account. The
   * register endpoint answered them exactly as it would a new address; this
   * mail is the only place the difference shows, and it goes to the owner.
   */
  registrationAttempted(): RenderedMail {
    return compose({
      subject: `Someone tried to register with your email`,
      heading: 'An account already exists for this address',
      paragraphs: [
        `Someone just tried to create a new ${PRODUCT_NAME} account with this email address. Nothing was changed — your existing account is exactly as it was.`,
        'If that was you, sign in instead of registering.',
      ],
      footer: [
        'If it was not you, you can ignore this email. Nobody can register this address while your account holds it.',
      ],
    });
  }

  loginConfirmation(
    confirmation: Confirmation,
    origin: { userAgent?: string; ip?: string },
    now = new Date(),
  ): RenderedMail {
    const details: Array<[string, string]> = [];

    if (origin.userAgent) {
      details.push(['Device', origin.userAgent]);
    }

    if (origin.ip) {
      details.push(['IP address', origin.ip]);
    }

    return this.confirmationMail(
      {
        subject: 'Confirm your sign-in',
        heading: 'Confirm your sign-in',
        paragraphs: [
          `Someone is signing in to your ${PRODUCT_NAME} account. If it is you, confirm it below.`,
        ],
        details,
        footer: [
          'If this was not you, do not share the code. Whoever is signing in already knows your password — change it.',
        ],
      },
      confirmation,
      { route: FRONTEND_ROUTES.CONFIRM_LOGIN },
      now,
    );
  }

  /** Sent to the address being claimed, which is what proves it can be read. */
  emailChangeConfirmation(
    userId: string,
    confirmation: Confirmation,
    now = new Date(),
  ): RenderedMail {
    return this.confirmationMail(
      {
        subject: 'Confirm your new email address',
        heading: 'Confirm your new email address',
        paragraphs: [
          `You asked to move your ${PRODUCT_NAME} account to this address. Confirm it to finish the change.`,
        ],
        footer: [
          'If you did not ask for this, ignore this email. The account stays on its current address.',
        ],
      },
      confirmation,
      { route: FRONTEND_ROUTES.CONFIRM_EMAIL_CHANGE, params: { userId } },
      now,
    );
  }

  /**
   * Sent to the address that just **lost** the account. It deliberately does
   * not name the new one: the reader may be the victim of a takeover, but
   * equally may be someone who no longer owns this mailbox.
   */
  emailChanged(byAdministrator: boolean): RenderedMail {
    return compose({
      subject: 'Your email address was changed',
      heading: 'Your email address was changed',
      paragraphs: [
        byAdministrator
          ? `An administrator changed the email address on your ${PRODUCT_NAME} account. This address no longer signs in to it.`
          : `The email address on your ${PRODUCT_NAME} account was changed. This address no longer signs in to it.`,
      ],
      footer: [
        'If you did not expect this, contact support straight away — someone else may have access to your account.',
      ],
    });
  }

  deletionConfirmation(
    userId: string,
    confirmation: Confirmation,
    now = new Date(),
  ): RenderedMail {
    return this.confirmationMail(
      {
        subject: 'Confirm account deletion',
        heading: 'Confirm account deletion',
        paragraphs: [
          `You asked to delete your ${PRODUCT_NAME} account. This cannot be undone: your profile and personal data will be erased.`,
        ],
        footer: [
          'If you did not ask for this, ignore this email and your account stays. Whoever asked was signed in as you — change your password.',
        ],
      },
      confirmation,
      { route: FRONTEND_ROUTES.CONFIRM_DELETION, params: { userId } },
      now,
    );
  }

  accountDeleted(byAdministrator: boolean): RenderedMail {
    return compose({
      subject: 'Your account has been deleted',
      heading: 'Your account has been deleted',
      paragraphs: [
        byAdministrator
          ? `An administrator deleted your ${PRODUCT_NAME} account, and its personal data has been erased.`
          : `Your ${PRODUCT_NAME} account has been deleted, and its personal data has been erased.`,
        'This is the last email we will send to this address.',
      ],
    });
  }

  /**
   * The one part every confirmation mail shares: a code to type, or a button
   * to press, and how long either lasts.
   */
  private confirmationMail(
    content: Omit<MailContent, 'code' | 'action'>,
    confirmation: Confirmation,
    target: ConfirmationTarget,
    now: Date,
  ): RenderedMail {
    const lifetime = describeLifetime(confirmation.expiresAt, now);

    if (confirmation.method === 'otp') {
      return compose({
        ...content,
        paragraphs: [
          ...content.paragraphs,
          `Your code is below. It expires ${lifetime}.`,
        ],
        code: confirmation.secret,
      });
    }

    return compose({
      ...content,
      paragraphs: [
        ...content.paragraphs,
        `The link works once and expires ${lifetime}.`,
      ],
      action: {
        label: 'Confirm',
        url: this.links.build(target.route, {
          ...target.params,
          token: confirmation.secret,
        }),
      },
    });
  }
}

/**
 * "in 10 minutes", not a timestamp: the mail cannot know the reader's time
 * zone, and a relative time is what they need to act on anyway.
 */
export function describeLifetime(expiresAt: string, now: Date): string {
  const minutes = Math.ceil((Date.parse(expiresAt) - now.getTime()) / 60_000);

  if (minutes <= 1) {
    return 'in about a minute';
  }

  if (minutes < 90) {
    return `in ${minutes} minutes`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 36 ? `in ${hours} hours` : `in ${Math.round(hours / 24)} days`;
}
