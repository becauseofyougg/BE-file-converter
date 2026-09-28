import { ConfigService } from '@core/config/config.service';
import type { NotificationConfig } from '../../config/notification.config';
import { FRONTEND_ROUTES, LinkService } from './link.service';

const serviceFor = (APP_PUBLIC_URL: string) =>
  new LinkService(new ConfigService<NotificationConfig>({ APP_PUBLIC_URL }));

describe('LinkService', () => {
  it('builds a link to the frontend page, with the token in the query', () => {
    expect(
      serviceFor('https://app.example.com').build(
        FRONTEND_ROUTES.VERIFY_EMAIL,
        {
          token: 'abc',
        },
      ),
    ).toBe('https://app.example.com/verify-email?token=abc');
  });

  /** An app served from a sub-path must keep it. */
  it('resolves under a base path, with or without a trailing slash', () => {
    for (const base of [
      'https://example.com/app',
      'https://example.com/app/',
    ]) {
      expect(
        serviceFor(base).build(FRONTEND_ROUTES.CONFIRM_LOGIN, { token: 't' }),
      ).toBe('https://example.com/app/login/confirm?token=t');
    }
  });

  it('encodes what it is given rather than splicing it in', () => {
    const url = serviceFor('https://app.example.com').build(
      FRONTEND_ROUTES.CONFIRM_DELETION,
      { userId: 'a&b=c', token: 'x y' },
    );

    expect(url).toBe(
      'https://app.example.com/account/delete/confirm?userId=a%26b%3Dc&token=x+y',
    );
  });
});
