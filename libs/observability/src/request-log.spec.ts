import type { IncomingMessage } from 'node:http';

import { attachUserToRequestLog, requestLogUserId } from './request-log';

describe('request log attribution', () => {
  it('reads back the user attached to a request', () => {
    const req = {} as IncomingMessage;

    attachUserToRequestLog(req, 'user-1');

    expect(requestLogUserId(req)).toBe('user-1');
  });

  /** An anonymous request logs no userId rather than a misleading one. */
  it('has nothing to say about a request nobody authenticated', () => {
    expect(requestLogUserId({} as IncomingMessage)).toBeUndefined();
  });

  it('is invisible to anything enumerating the request', () => {
    const req = {} as IncomingMessage;

    attachUserToRequestLog(req, 'user-1');

    expect(Object.keys(req)).toEqual([]);
  });
});
