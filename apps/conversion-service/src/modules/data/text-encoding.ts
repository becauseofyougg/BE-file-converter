import { DataSyntaxError } from './data-format';

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * Bytes to text, accepting UTF-8 only — every format here is defined over
 * Unicode, and UTF-8 is what all four use in practice.
 *
 * A UTF-8 byte-order mark is dropped: Excel writes one at the start of every
 * CSV, and left in place it becomes part of the first column's name. A
 * UTF-16 mark is refused with a message that says what to do, and anything
 * that does not decode as UTF-8 is refused rather than turned into
 * replacement characters — silently corrupting a file is worse than saying no.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) {
    throw new DataSyntaxError(
      'encoding',
      'the file is UTF-16; only UTF-8 is accepted',
    );
  }

  const start = UTF8_BOM.every((byte, index) => bytes[index] === byte) ? 3 : 0;

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(start),
    );
  } catch {
    throw new DataSyntaxError('encoding', 'the file is not valid UTF-8');
  }
}

/** Results are UTF-8 without a byte-order mark. */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
