import type { ConversionOperation } from '@prisma-clients/conversion';

import { downloadName, hasExpired, isDownloadable } from './operation-record';

describe('downloadName', () => {
  it.each([
    ['people.csv', 'json', 'people.json'],
    ['report.final.xml', 'yaml', 'report.final.yaml'],
    ['no-extension', 'png', 'no-extension.png'],
    ['отчёт.csv', 'json', 'отчёт.json'],
    ['C:\\Users\\me\\data.csv', 'json', 'data.json'],
    ['../../etc/passwd.csv', 'json', 'passwd.json'],
    ['a"b*c:d<e>f?g|h.svg', 'png', 'a_b_c_d_e_f_g_h.png'],
    ['line\r\nbreak.csv', 'json', 'line__break.json'],
    ['  .hidden.csv', 'json', 'hidden.json'],
    ['.csv', 'json', 'converted.json'],
    ['', 'json', 'converted.json'],
  ])('%j as %s → %j', (source, extension, name) => {
    expect(downloadName(source, extension)).toBe(name);
  });

  it('keeps a long name to a hundred characters before the extension', () => {
    expect(downloadName(`${'a'.repeat(300)}.csv`, 'json')).toBe(
      `${'a'.repeat(100)}.json`,
    );
  });
});

describe('isDownloadable and hasExpired', () => {
  const NOW = new Date('2026-10-12T12:00:00Z');
  const row = (overrides: Partial<ConversionOperation>) =>
    ({
      status: 'COMPLETED',
      saved: true,
      resultKey: 'u/a.json',
      resultExpiresAt: new Date('2026-10-13T00:00:00Z'),
      ...overrides,
    }) as ConversionOperation;

  it('offers a saved, kept, unexpired result', () => {
    expect(isDownloadable(row({}), NOW)).toBe(true);
    expect(isDownloadable(row({ resultExpiresAt: null }), NOW)).toBe(true);
  });

  it.each([
    ['not saved', { saved: false }],
    ['failed', { status: 'FAILED' as const }],
    ['deleted', { resultKey: null }],
    ['expired', { resultExpiresAt: new Date('2026-10-12T11:59:59Z') }],
  ])('not one that is %s', (_case, overrides) => {
    expect(isDownloadable(row(overrides), NOW)).toBe(false);
  });

  it('counts the expiry moment itself as expired', () => {
    expect(hasExpired(row({ resultExpiresAt: NOW }), NOW)).toBe(true);
  });
});
