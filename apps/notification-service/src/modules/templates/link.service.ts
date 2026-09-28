import { Injectable } from '@nestjs/common';

import { ConfigService } from '@core/config/config.service';
import { NotificationConfig } from '../../config/notification.config';

/**
 * The frontend pages a magic link opens. The page reads the token from the
 * query string and posts it to the API — the link itself never calls the API,
 * since a mail scanner that prefetches links would otherwise confirm the
 * action on the user's behalf.
 *
 * These paths are a contract with the frontend, kept in one place so it is
 * visible as one.
 */
export const FRONTEND_ROUTES = {
  /** → `POST /auth/verify-email { token }` */
  VERIFY_EMAIL: 'verify-email',
  /** → `POST /auth/confirm { token }` */
  CONFIRM_LOGIN: 'login/confirm',
  /** → `POST /users/:userId/email-change/confirm { token }` */
  CONFIRM_EMAIL_CHANGE: 'account/email/confirm',
  /** → `POST /users/:userId/deletion/confirm { token }` */
  CONFIRM_DELETION: 'account/delete/confirm',
} as const;

export type FrontendRoute =
  (typeof FRONTEND_ROUTES)[keyof typeof FRONTEND_ROUTES];

@Injectable()
export class LinkService {
  private readonly base: URL;

  constructor(config: ConfigService<NotificationConfig>) {
    // A trailing slash makes the routes resolve *under* the base path, so an
    // app served from `https://example.com/app` gets `/app/verify-email` rather
    // than `/verify-email`.
    const url = config.get('APP_PUBLIC_URL');
    this.base = new URL(url.endsWith('/') ? url : `${url}/`);
  }

  build(route: FrontendRoute, params: Record<string, string>): string {
    const url = new URL(route, this.base);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }
}
