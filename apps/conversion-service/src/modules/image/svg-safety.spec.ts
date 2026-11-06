import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  assertSafeSvg,
  decodeReferences,
  SVG_MAX_ELEMENTS,
} from './svg-safety';

const svg = (body: string, attributes = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10" ${attributes}>${body}</svg>`;

function refusal(text: string): AppError {
  try {
    assertSafeSvg(text);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  throw new Error('expected a refusal');
}

describe('assertSafeSvg', () => {
  it('accepts a drawing that stays inside itself', () => {
    expect(() =>
      assertSafeSvg(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!-- a comment -->\n${svg(
          [
            '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>',
            '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs>',
            '<style>.a { fill: url(#g); }</style>',
            '<rect class="a" width="10" height="10" filter="url(#f)" style="stroke: url(&quot;#g&quot;)"/>',
            '<use href="#g"/><use xlink:href="#g"/>',
            '<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>',
            '<text>&lt;not markup&gt; &amp; fine</text>',
          ].join(''),
        )}`,
      ),
    ).not.toThrow();
  });

  describe('refuses active content', () => {
    it.each([
      ['<script>alert(1)</script>', '<script> is not accepted'],
      ['<svg:script xmlns:svg="http://www.w3.org/2000/svg"/>', '<svg:script>'],
      ['<foreignObject><div/></foreignObject>', '<foreignObject>'],
      ['<rect onclick="alert(1)"/>', 'event handlers (onclick)'],
      ['<rect ONLOAD="x"/>', 'event handlers (ONLOAD)'],
    ])('%s', (body, message) => {
      const error = refusal(svg(body));

      expect(error).toMatchObject({
        code: ERROR_CODES.UNSAFE_SOURCE,
        httpStatus: 400,
      });
      expect(error.message).toContain(message);
    });
  });

  describe('refuses anything that reaches outside the file', () => {
    it.each([
      '<image href="file:///etc/passwd"/>',
      '<image xlink:href="http://169.254.169.254/latest/meta-data"/>',
      '<image href="data:image/svg+xml;base64,PHN2Zz4="/>',
      '<use href="other.svg#x"/>',
      '<image href="&#x66;ile:///etc/passwd"/>',
      '<image href="&#102;ile:///etc/passwd"/>',
      '<rect fill="url(other.svg#g)"/>',
      '<rect fill="url( \'http://x/y.svg#g\' )"/>',
      '<rect style="fill: url(https://x)"/>',
      '<style>@import url(#ok);</style>',
      '<style>@IMPORT "https://x/y.css";</style>',
      '<style><![CDATA[ rect { fill: url(file:///x) } ]]></style>',
      '<style>&#64;import "x.css";</style>',
      '<style>@\\69mport "x.css";</style>',
      '<rect style="fill: u\\72l(file:///x)"/>',
      '<rect fill="url(#broken"/>',
      '<g xml:base="http://x/"><use href="#a"/></g>',
    ])('%s', (body) => {
      expect(refusal(svg(body)).code).toBe(ERROR_CODES.UNSAFE_SOURCE);
    });
  });

  it('refuses document type declarations and entities (XXE)', () => {
    const error = refusal(
      `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg('<text>&x;</text>')}`,
    );

    expect(error.code).toBe(ERROR_CODES.UNSAFE_SOURCE);
    expect(error.message).toMatch(/document type declarations/);
  });

  it('refuses an external stylesheet instruction', () => {
    expect(
      refusal(`<?xml-stylesheet href="https://x/y.css"?>${svg('')}`).code,
    ).toBe(ERROR_CODES.UNSAFE_SOURCE);
  });

  it('refuses malformed XML as an invalid source, saying where', () => {
    const error = refusal('<svg><g></svg>');

    expect(error.code).toBe(ERROR_CODES.INVALID_SOURCE);
    expect(error.message).toMatch(/^Invalid SVG: .*\(line 1, column \d+\)$/);
  });

  it.each(['<html/>', '<svg/><svg/>', 'just text'])(
    'refuses a document whose root is not one <svg>: %s',
    (text) => {
      expect(refusal(text).code).toBe(ERROR_CODES.INVALID_SOURCE);
    },
  );

  it('refuses more elements than any drawing needs', () => {
    const error = refusal(svg('<g/>'.repeat(SVG_MAX_ELEMENTS)));

    expect(error.code).toBe(ERROR_CODES.IMAGE_TOO_LARGE);
  });

  it('accepts the nesting a drawing has', () => {
    expect(() =>
      assertSafeSvg(svg('<g>'.repeat(90) + '</g>'.repeat(90))),
    ).not.toThrow();
  });

  it('refuses nesting no drawing has, as an invalid source', () => {
    const depth = 20_000;
    const error = refusal(svg('<g>'.repeat(depth) + '</g>'.repeat(depth)));

    expect(error.code).toBe(ERROR_CODES.INVALID_SOURCE);
    expect(error.message).toMatch(/nested/);
  });
});

describe('decodeReferences', () => {
  it('decodes the predefined entities and character references', () => {
    expect(decodeReferences('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#X43;')).toBe(
      `<>&"'ABC`,
    );
  });

  it('drops references to code points that do not exist', () => {
    expect(decodeReferences('a&#0;b&#x110000;c')).toBe('abc');
  });

  it('leaves anything else alone', () => {
    expect(decodeReferences('&nbsp; & plain')).toBe('&nbsp; & plain');
  });
});
