import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';

import { acceptCorrelationId, correlationIdFor } from './correlation-id';

describe('acceptCorrelationId', () => {
  it.each([
    ['a UUID', '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90'],
    ['a proxy-style id', 'req-1.edge:42_a'],
    ['64 characters exactly', 'a'.repeat(64)],
  ])('keeps %s', (_label, value) => {
    expect(acceptCorrelationId(value)).toBe(value);
  });

  /**
   * The first one is the attack: 65 characters failed identity's validation
   * before any handler ran, and the unacked message stopped identity
   * answering anyone.
   */
  it.each([
    ['one character too long', 'a'.repeat(65)],
    ['a line break (log and header injection)', 'abc\r\nx-admin: true'],
    ['spaces', 'not an id'],
    ['an empty string', ''],
    ['an array (a repeated header)', ['a', 'b']],
    ['nothing', undefined],
  ])('refuses %s', (_label, value) => {
    expect(acceptCorrelationId(value)).toBeUndefined();
  });
});

describe('correlationIdFor', () => {
  it("uses the caller's id when it is acceptable", () => {
    expect(
      correlationIdFor({
        headers: { [CORRELATION_ID_HEADER]: 'abc-123' },
        id: 'req-1',
      }),
    ).toBe('abc-123');
  });

  it('falls back to the request id rather than forwarding a bad one', () => {
    expect(
      correlationIdFor({
        headers: { [CORRELATION_ID_HEADER]: 'x'.repeat(100) },
        id: 'req-1',
      }),
    ).toBe('req-1');
  });

  it('makes one up when there is nothing else', () => {
    expect(correlationIdFor({ headers: {} })).toMatch(/^[0-9a-f-]{36}$/);
  });
});
