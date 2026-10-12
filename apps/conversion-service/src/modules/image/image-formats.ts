import type { FormatDescriptor } from '../converters/file-converter';

export const IMAGE_FORMATS: Record<string, FormatDescriptor> = {
  png: { id: 'png', extensions: ['.png'], mimeType: 'image/png' },
  jpeg: { id: 'jpeg', extensions: ['.jpeg', '.jpg'], mimeType: 'image/jpeg' },
  svg: { id: 'svg', extensions: ['.svg'], mimeType: 'image/svg+xml' },
};

/**
 * What each format becomes. Nothing becomes SVG, and that is permanent:
 * tracing pixels into vectors is a different product, not a conversion.
 */
export const IMAGE_DIRECTIONS: Record<string, readonly string[]> = {
  png: ['jpeg'],
  jpeg: ['png'],
  svg: ['jpeg', 'png'],
};

const SIGNATURES: ReadonlyArray<[string, readonly number[]]> = [
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['jpeg', [0xff, 0xd8, 0xff]],
];

/** PNG or JPEG by their magic bytes, whatever the file is called. */
export function rasterSignature(head: Buffer): string | null {
  for (const [format, bytes] of SIGNATURES) {
    if (bytes.every((byte, index) => head[index] === byte)) {
      return format;
    }
  }

  return null;
}

/**
 * Whether the first element is `<svg>` — past a byte-order mark, an XML
 * declaration, comments and a doctype. Not proof of a valid SVG, which is
 * checked later; enough to tell an SVG from other XML.
 */
export function looksLikeSvg(head: Buffer): boolean {
  // `\s` covers U+FEFF, so a byte-order mark goes with the whitespace below.
  let text = head.toString('utf8');

  for (;;) {
    const before = text;

    text = text
      .replace(/^\s+/, '')
      .replace(/^<\?[\s\S]*?\?>/, '')
      .replace(/^<!--[\s\S]*?-->/, '')
      .replace(/^<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, '');

    if (text === before) {
      break;
    }
  }

  return /^<([A-Za-z_][\w.-]*:)?svg[\s/>]/.test(text);
}
