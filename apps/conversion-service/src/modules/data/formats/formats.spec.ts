import { DataSyntaxError } from '../data-format';
import { CsvFormat } from './csv.format';
import { JsonFormat } from './json.format';
import { XmlFormat } from './xml.format';
import { YamlFormat } from './yaml.format';

describe('CsvFormat', () => {
  const csv = new CsvFormat();

  it('reads the header as keys and every cell as text', () => {
    expect(csv.parse('zip,count\n01234,7\n')).toEqual([
      { zip: '01234', count: '7' },
    ]);
  });

  it('reads quoted cells with commas, quotes and line breaks', () => {
    expect(csv.parse('a,b\r\n"x, ""y""","line\nbreak"\r\n')).toEqual([
      { a: 'x, "y"', b: 'line\nbreak' },
    ]);
  });

  it('names blank header cells and keeps repeated ones apart', () => {
    expect(csv.parse('a,,a\n1,2,3\n')).toEqual([
      { a: '1', column_2: '2', a_2: '3' },
    ]);
  });

  it('reads an empty file as no rows', () => {
    expect(csv.parse('')).toEqual([]);
  });

  it('refuses a row with the wrong number of cells', () => {
    expect(() => csv.parse('a,b\n1\n')).toThrow(DataSyntaxError);
    expect(() => csv.parse('a,b\n1\n')).toThrow(/^Invalid CSV: /);
  });

  it('refuses an unclosed quote', () => {
    expect(() => csv.parse('a\n"open\n')).toThrow(/^Invalid CSV: /);
  });

  it('writes RFC 4180: header row, CRLF, quoting only where needed', () => {
    expect(
      csv.serialize([
        { a: 'x,y', b: 'say "hi"' },
        { a: 'plain', b: '' },
      ]),
    ).toBe('a,b\r\n"x,y","say ""hi"""\r\nplain,\r\n');
  });

  it('writes the union of the columns, blank where a row has none', () => {
    expect(csv.serialize([{ a: 1 }, { b: 2 }])).toBe('a,b\r\n1,\r\n,2\r\n');
  });

  it('writes nothing for nothing', () => {
    expect(csv.serialize([])).toBe('');
    expect(csv.serialize(null)).toBe('');
  });
});

describe('JsonFormat', () => {
  const json = new JsonFormat();

  it('recognises an object or a list by its first character', () => {
    expect(json.sniff('  \n{"a":1}')).toBe(true);
    expect(json.sniff('[1]')).toBe(true);
    expect(json.sniff('a: 1')).toBe(false);
  });

  it('reads any JSON value', () => {
    expect(json.parse('{"a":[1,true,null,"x"]}')).toEqual({
      a: [1, true, null, 'x'],
    });
  });

  it('refuses what is not JSON', () => {
    expect(() => json.parse("{'a':1}")).toThrow(/^Invalid JSON: /);
  });

  it('writes indented, with a final newline', () => {
    expect(json.serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe('XmlFormat', () => {
  const xml = new XmlFormat();

  it('recognises markup by its first character', () => {
    expect(xml.sniff('\n<?xml version="1.0"?><a/>')).toBe(true);
    expect(xml.sniff('{"a":1}')).toBe(false);
  });

  it('reads attributes as @-keys and repeated elements as a list, all as text', () => {
    expect(
      xml.parse(
        '<?xml version="1.0"?><users><user id="1"><zip>01234</zip></user><user id="2"/></users>',
      ),
    ).toEqual({
      users: { user: [{ '@id': '1', zip: '01234' }, { '@id': '2' }] },
    });
  });

  it('keeps text beside attributes as #text', () => {
    expect(xml.parse('<price currency="EUR">10</price>')).toEqual({
      price: { '@currency': 'EUR', '#text': '10' },
    });
  });

  it('decodes the predefined entities', () => {
    expect(xml.parse('<a>&lt;b&gt; &amp; &quot;c&quot;</a>')).toEqual({
      a: '<b> & "c"',
    });
  });

  /** XXE and entity-expansion bombs both need a DTD; none is accepted. */
  it.each([
    '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>',
    '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><a>&lol2;</a>',
    '<?xml version="1.0"?>\n<!doctype a SYSTEM "http://internal/a.dtd"><a/>',
  ])('refuses a document type declaration: %s', (input) => {
    expect(() => xml.parse(input)).toThrow(/<!DOCTYPE>\) are not accepted/);
  });

  it('refuses malformed XML, saying where', () => {
    expect(() => xml.parse('<a><b></a>')).toThrow(
      /^Invalid XML: .*\(line 1, column \d+\)/,
    );
  });

  it('writes a declaration and keeps a single-key root as the root', () => {
    expect(xml.serialize({ users: { user: [{ name: 'A' }] } })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<users>\n  <user>\n    <name>A</name>\n  </user>\n</users>\n',
    );
  });

  it('wraps a list in <root> with one <item> each', () => {
    expect(xml.serialize([1, 2])).toContain(
      '<root>\n  <item>1</item>\n  <item>2</item>\n</root>',
    );
  });

  it('escapes text and attributes', () => {
    const output = xml.serialize({ a: { '@title': 'x"y', '#text': '<&>' } });

    expect(output).toContain('title="x&quot;y"');
    expect(output).toContain('&lt;&amp;&gt;');
  });

  it('turns keys that are not element names into ones that are', () => {
    const output = xml.serialize({ 'first name': 'A', '1st': 2, xmlns: 3 });

    expect(output).toContain('<first_name>A</first_name>');
    expect(output).toContain('<_1st>2</_1st>');
    expect(output).toContain('<_xmlns>3</_xmlns>');
  });
});

describe('YamlFormat', () => {
  const yaml = new YamlFormat();

  it('recognises nothing by content — too much text is valid YAML', () => {
    expect(yaml.sniff('a: 1')).toBe(false);
  });

  it('reads YAML 1.2: yes and on are strings', () => {
    expect(yaml.parse('a: yes\nb: on\nc: true\nd: 0o17\n')).toEqual({
      a: 'yes',
      b: 'on',
      c: true,
      d: 15,
    });
  });

  it('reads several documents as a list of them', () => {
    expect(yaml.parse('a: 1\n---\nb: 2\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reads an empty stream as null', () => {
    expect(yaml.parse('# only a comment\n')).toBeNull();
  });

  it('maps what JSON cannot hold to what it can', () => {
    expect(yaml.parse('inf: .inf\nnan: .nan\n')).toEqual({
      inf: null,
      nan: null,
    });
  });

  it('refuses duplicate keys rather than keep one silently', () => {
    expect(() => yaml.parse('a: 1\na: 2\n')).toThrow(
      /^Invalid YAML: Map keys must be unique/,
    );
  });

  it('refuses malformed YAML', () => {
    expect(() => yaml.parse('a: [1, 2\n')).toThrow(/^Invalid YAML: /);
  });

  it('refuses an alias bomb', () => {
    const bomb = [
      'a: &a [x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c]',
    ].join('\n');

    expect(() => yaml.parse(bomb)).toThrow(
      /^Invalid YAML: Excessive alias count/,
    );
  });

  it('writes long strings on one line', () => {
    const long = 'word '.repeat(40).trim();

    expect(yaml.serialize({ long })).toBe(`long: ${long}\n`);
  });
});
