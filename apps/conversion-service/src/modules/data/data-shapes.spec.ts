import { DataSyntaxError } from './data-format';
import {
  assertDepth,
  columnsOf,
  normalise,
  toRows,
  toXmlDocument,
  xmlName,
} from './data-shapes';

describe('normalise', () => {
  it('maps the values YAML can produce to their JSON equivalents', () => {
    expect(
      normalise({
        when: new Date('2026-10-02T00:00:00.000Z'),
        big: BigInt(12),
        bytes: new Uint8Array([104, 105]),
        map: new Map<unknown, unknown>([[1, 'one']]),
        missing: undefined,
        list: [Infinity, 1],
      }),
    ).toEqual({
      when: '2026-10-02T00:00:00.000Z',
      big: '12',
      bytes: 'aGk=',
      map: { '1': 'one' },
      missing: null,
      list: [null, 1],
    });
  });

  it('turns anything else into its text', () => {
    expect(normalise(Symbol.for('x'))).toBe('Symbol(x)');
  });
});

describe('assertDepth', () => {
  it('accepts data at the limit', () => {
    expect(() => assertDepth({ a: [{ b: 1 }] }, 3)).not.toThrow();
  });

  it('refuses data past it', () => {
    expect(() => assertDepth({ a: [{ b: [1] }] }, 3)).toThrow(DataSyntaxError);
  });
});

describe('toRows', () => {
  it('looks through wrappers to the list inside', () => {
    expect(toRows({ users: { user: [{ id: 1 }, { id: 2 }] } })).toEqual([
      { id: '1' },
      { id: '2' },
    ]);
  });

  it('makes a lone object one row, and a scalar one cell', () => {
    expect(toRows({ a: 1, b: 2 })).toEqual([{ a: '1', b: '2' }]);
    expect(toRows('x')).toEqual([{ value: 'x' }]);
  });

  it('flattens nested objects to dotted columns', () => {
    expect(
      toRows([{ name: 'A', address: { city: 'Minsk', geo: { lat: 1 } } }]),
    ).toEqual([{ name: 'A', 'address.city': 'Minsk', 'address.geo.lat': '1' }]);
  });

  it('writes lists inside a row as their JSON, and null as empty', () => {
    expect(toRows([{ tags: ['a', 'b'], none: null, empty: {} }])).toEqual([
      { tags: '["a","b"]', none: '', empty: '{}' },
    ]);
  });

  it('gives a list of scalars a value column', () => {
    expect(toRows([1, true])).toEqual([{ value: '1' }, { value: 'true' }]);
  });

  it('has no rows for null', () => {
    expect(toRows(null)).toEqual([]);
    expect(toRows({ wrapper: null })).toEqual([]);
  });
});

describe('columnsOf', () => {
  it('lists every column in the order first seen', () => {
    expect(
      columnsOf([
        { b: '', a: '' },
        { c: '', a: '' },
      ]),
    ).toEqual(['b', 'a', 'c']);
  });
});

describe('xmlName', () => {
  it.each([
    ['name', 'name'],
    ['first name', 'first_name'],
    ['1st', '_1st'],
    ['', '_'],
    ['XmlThing', '_XmlThing'],
    ['a:b', 'a_b'],
    ['ok-name.v2', 'ok-name.v2'],
  ])('%j → %j', (key, name) => {
    expect(xmlName(key)).toBe(name);
  });
});

describe('toXmlDocument', () => {
  it('keeps a single key as the root', () => {
    expect(toXmlDocument({ users: { user: 'x' } })).toEqual({
      users: { user: 'x' },
    });
  });

  it('wraps several keys, a list or a scalar in <root>', () => {
    expect(toXmlDocument({ a: 1, b: 2 })).toEqual({ root: { a: 1, b: 2 } });
    expect(toXmlDocument([1])).toEqual({ root: { item: [1] } });
    expect(toXmlDocument('x')).toEqual({ root: 'x' });
  });

  it('does not make a root of a key whose value is a list', () => {
    expect(toXmlDocument({ items: [1, 2] })).toEqual({
      root: { items: [1, 2] },
    });
  });

  it('does not make a root of an attribute or text key', () => {
    expect(toXmlDocument({ '@id': '1' })).toEqual({ root: { '@id': '1' } });
  });

  it('nests a list inside a list under <item>, and writes null as empty', () => {
    expect(toXmlDocument({ root: { k: [[1, 2], null] } })).toEqual({
      root: { k: [{ item: [1, 2] }, ''] },
    });
  });
});
