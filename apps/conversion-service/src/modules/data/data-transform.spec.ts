import { DATA_FORMATS, dataFormat } from './data-formats';
import { transform, type TransformResult } from './data-transform';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (result: TransformResult) => {
  if (!result.ok) {
    throw new Error(`expected success, got: ${result.message}`);
  }

  return new TextDecoder().decode(result.data);
};

const run = (
  text: string | Uint8Array,
  source: string,
  target: string,
  maxDepth = 64,
) =>
  transform({
    data: typeof text === 'string' ? encode(text) : text,
    source,
    target,
    maxDepth,
  });

/** The same two records, written natively in each format. */
const SAMPLES: Record<string, string> = {
  csv: 'id,name\r\n1,Ann\r\n2,"Smith, J"\r\n',
  json: '[{"id":"1","name":"Ann"},{"id":"2","name":"Smith, J"}]',
  xml: '<people><person><id>1</id><name>Ann</name></person><person><id>2</id><name>Smith, J</name></person></people>',
  yaml: '- id: "1"\n  name: Ann\n- id: "2"\n  name: Smith, J\n',
};

/** What every one of them means, once read. */
const RECORDS = [
  { id: '1', name: 'Ann' },
  { id: '2', name: 'Smith, J' },
];

/** Looks through single-key wrappers, as CSV does, to the list inside. */
function rowsOf(value: unknown): unknown {
  let current = value;

  while (
    current !== null &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    Object.keys(current).length === 1
  ) {
    current = Object.values(current as Record<string, unknown>)[0];
  }

  return current;
}

describe('transform', () => {
  const ids = DATA_FORMATS.map((format) => format.id);
  const pairs = ids.flatMap((source) =>
    ids.filter((target) => target !== source).map((target) => [source, target]),
  );

  it('covers the twelve pairs of the four formats', () => {
    expect(pairs).toHaveLength(12);
  });

  /**
   * Every direction, on the same data: whatever the route, the two records
   * arrive intact — the guarantee the spec asks for, checked per pair rather
   * than trusted from the shared model.
   */
  it.each(pairs)('%s → %s keeps the records', (source, target) => {
    const output = decode(run(SAMPLES[source], source, target));

    expect(rowsOf(dataFormat(target)!.parse(output))).toEqual(RECORDS);
  });

  describe('refusals, as values rather than throws', () => {
    it('an empty file', () => {
      expect(run('  \n\t', 'json', 'csv')).toEqual({
        ok: false,
        message: 'The file is empty',
      });
    });

    it('a file that does not parse, saying which format', () => {
      const result = run('{"a":', 'json', 'csv');

      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toMatch(/^Invalid JSON: /);
    });

    it('UTF-16, with what to do about it', () => {
      const result = run(
        new Uint8Array([0xff, 0xfe, 0x5b, 0x00, 0x5d, 0x00]),
        'json',
        'csv',
      );

      expect(!result.ok && result.message).toMatch(/UTF-16; only UTF-8/);
    });

    it('bytes that are not UTF-8, rather than replacement characters', () => {
      const result = run(
        new Uint8Array([0x5b, 0xc3, 0x28, 0x5d]),
        'json',
        'csv',
      );

      expect(!result.ok && result.message).toMatch(/not valid UTF-8/);
    });

    it('nesting past the limit', () => {
      const result = run('[[[["deep"]]]]', 'json', 'yaml', 3);

      expect(!result.ok && result.message).toMatch(/more than 3 levels/);
    });

    /**
     * Far past it: the parser runs out of stack before the depth check gets
     * the value. Still a 400 with the same message, not a crashed worker.
     */
    it('nesting deep enough to overflow a recursive parser', () => {
      const deep = '['.repeat(200_000) + ']'.repeat(200_000);
      const result = run(deep, 'json', 'yaml');

      expect(!result.ok && result.message).toMatch(/more than 64 levels/);
    });
  });

  it('drops a UTF-8 byte-order mark, which Excel puts before every CSV', () => {
    const withBom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...encode('id\r\n1\r\n'),
    ]);

    expect(JSON.parse(decode(run(withBom, 'csv', 'json')))).toEqual([
      { id: '1' },
    ]);
  });

  it('writes results without a byte-order mark', () => {
    const result = run('[1]', 'json', 'yaml');

    expect(result.ok && result.data[0]).not.toBe(0xef);
  });

  it('keeps non-ASCII text intact in every direction', () => {
    const csv = 'город,emoji\r\nМинск,🙂\r\n';

    for (const target of ['json', 'xml', 'yaml']) {
      const output = decode(run(csv, 'csv', target));

      expect(output).toContain('Минск');
      expect(output).toContain('🙂');
    }
  });

  it('treats an unknown format as a bug, not as bad input', () => {
    expect(() => run('[]', 'json', 'toml')).toThrow(/No data format/);
  });

  it('lets an unexpected error through, to be reported as one', () => {
    const json = DATA_FORMATS.find((format) => format.id === 'json')!;
    const spy = jest.spyOn(json, 'serialize').mockImplementation(() => {
      throw new TypeError('boom');
    });

    expect(() => run('id\r\n1\r\n', 'csv', 'json')).toThrow('boom');

    spy.mockRestore();
  });
});
