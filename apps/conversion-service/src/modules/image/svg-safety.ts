import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';

/**
 * Elements past this are refused: rendering cost grows with them, and no
 * drawing a person uploads to be converted comes near it.
 */
export const SVG_MAX_ELEMENTS = 50_000;

/** Elements that run code or pull in another document. */
const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'handler',
  'listener',
]);

/** The one kind of `href` that does not leave the file: an embedded raster. */
const EMBEDDED_RASTER = /^data:image\/(png|jpe?g|gif|webp);base64,/i;

type Node = Record<string, unknown> & { ':@'?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Entities are decoded here, by `decodeReferences`, so what is checked is
  // exactly what the renderer will see.
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
});

/**
 * Refuses an SVG that could do anything but draw itself.
 *
 * The renderer (librsvg, through sharp) executes no scripts, but it does
 * **load what a file points at** — an `<image href="file:///…">`, a
 * `url(other.svg#x)`, a CSS `@import`. That is the threat here: a request
 * that makes the server read its own files or call an internal address. So
 * every reference must stay inside the file (`#id`) or be an embedded raster
 * (`data:image/png;base64,…`); anything else is refused, with what it was.
 *
 * Scripts and event handlers are refused too, though they would never run:
 * the spec says active content is not accepted, and a file that carries it
 * is not one to trust in other ways.
 *
 * Refuse, never strip: a cleaned file is a different drawing from the one
 * the user sent, and they would not be told.
 */
export function assertSafeSvg(text: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw unsafe('document type declarations and entities are not accepted');
  }

  if (/<\?xml-stylesheet/i.test(text)) {
    throw unsafe('external stylesheets are not accepted');
  }

  const verdict = XMLValidator.validate(text);

  if (verdict !== true) {
    const { msg, line, col } = verdict.err;

    throw new AppError(
      ERROR_CODES.INVALID_SOURCE,
      `Invalid SVG: ${msg} (line ${line}, column ${col})`,
      400,
    );
  }

  let parsed: Node[];

  try {
    parsed = parser.parse(text) as Node[];
  } catch (error) {
    // Well-formed but past what the parser takes — nesting deeper than its
    // 100 levels, which no drawing needs and a hostile file would.
    throw new AppError(
      ERROR_CODES.INVALID_SOURCE,
      `Invalid SVG: ${(error as Error).message}`,
      400,
    );
  }

  const roots = parsed.filter((node) => elementName(node) !== null);
  const rootName = roots.length === 1 ? elementName(roots[0]) : null;

  if (rootName === null || localName(rootName) !== 'svg') {
    throw new AppError(
      ERROR_CODES.INVALID_SOURCE,
      'Invalid SVG: the document element must be <svg>',
      400,
    );
  }

  inspect(roots[0]);
}

/** Walked with a stack, not recursion: depth is the attacker's to choose. */
function inspect(root: Node): void {
  const stack: Array<{ node: Node; inStyle: boolean }> = [
    { node: root, inStyle: false },
  ];
  let elements = 0;

  while (stack.length > 0) {
    const { node, inStyle } = stack.pop()!;
    const name = elementName(node);

    if (name === null) {
      if (inStyle && typeof node['#text'] === 'string') {
        checkCss(decodeReferences(node['#text']));
      }

      continue;
    }

    elements += 1;

    if (elements > SVG_MAX_ELEMENTS) {
      throw new AppError(
        ERROR_CODES.IMAGE_TOO_LARGE,
        `The SVG has more than ${SVG_MAX_ELEMENTS} elements`,
        400,
      );
    }

    const local = localName(name);

    if (FORBIDDEN_ELEMENTS.has(local)) {
      throw unsafe(`<${name}> is not accepted`);
    }

    for (const [attribute, raw] of Object.entries(node[':@'] ?? {})) {
      checkAttribute(attribute, decodeReferences(String(raw)));
    }

    for (const child of (node[name] as Node[]) ?? []) {
      stack.push({ node: child, inStyle: local === 'style' });
    }
  }
}

function checkAttribute(attribute: string, value: string): void {
  const name = attribute.toLowerCase();

  if (name.startsWith('on')) {
    throw unsafe(`event handlers (${attribute}) are not accepted`);
  }

  if (name === 'xml:base') {
    throw unsafe('xml:base is not accepted');
  }

  if (localName(name) === 'href') {
    const target = value.trim();

    if (!target.startsWith('#') && !EMBEDDED_RASTER.test(target)) {
      throw unsafe(
        `${attribute} points outside the file; only #fragments and embedded PNG/JPEG/GIF/WebP data are accepted`,
      );
    }
  }

  if (name === 'style') {
    checkCss(value);
  } else {
    checkUrls(value, attribute);
  }
}

function checkCss(css: string): void {
  // CSS has its own escapes (`@\69mport`, `u\72l(`) that a pattern over the
  // text would not see through, and a drawing has no need of them.
  if (css.includes('\\')) {
    throw unsafe('escapes in CSS are not accepted');
  }

  if (/@import/i.test(css)) {
    throw unsafe('@import is not accepted');
  }

  checkUrls(css, 'style');
}

function checkUrls(value: string, where: string): void {
  for (const match of value.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!match[2].trim().startsWith('#')) {
      throw unsafe(`url(${match[2]}) in ${where} points outside the file`);
    }
  }

  // An unterminated or oddly quoted url( the pattern above could not read is
  // refused rather than guessed at.
  const opened = (value.match(/url\s*\(/gi) ?? []).length;
  const read = [...value.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)]
    .length;

  if (opened !== read) {
    throw unsafe(`a url() in ${where} could not be read`);
  }
}

/** The five predefined entities and numeric character references. */
export function decodeReferences(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi,
    (_match, reference: string) => {
      const lower = reference.toLowerCase();

      if (lower.startsWith('#x')) {
        return codePoint(parseInt(lower.slice(2), 16));
      }

      if (lower.startsWith('#')) {
        return codePoint(parseInt(lower.slice(1), 10));
      }

      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[
        lower as 'lt' | 'gt' | 'amp' | 'quot' | 'apos'
      ];
    },
  );
}

function codePoint(value: number): string {
  return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
}

function elementName(node: Node): string | null {
  return (
    Object.keys(node).find((key) => key !== ':@' && key !== '#text') ?? null
  );
}

function localName(name: string): string {
  return name.split(':').pop()!.toLowerCase();
}

function unsafe(detail: string): AppError {
  return new AppError(
    ERROR_CODES.UNSAFE_SOURCE,
    `The SVG is not accepted: ${detail}`,
    400,
  );
}
