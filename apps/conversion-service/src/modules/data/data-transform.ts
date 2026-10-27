import { DataSyntaxError } from './data-format';
import { dataFormat } from './data-formats';
import { assertDepth } from './data-shapes';
import { decodeUtf8, encodeUtf8 } from './text-encoding';

export interface TransformRequest {
  data: Uint8Array;
  source: string;
  target: string;
  maxDepth: number;
}

/**
 * The outcome as a value, never a throw — it crosses a thread boundary, and
 * an Error does not survive that with its type, so "the file is bad" would
 * arrive looking exactly like "the code is broken".
 */
export type TransformResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; message: string };

/**
 * One conversion, start to finish: bytes in one format to bytes in another.
 * Pure and synchronous — run in a worker thread by `DataConverter`, called
 * directly by the tests.
 */
export function transform(request: TransformRequest): TransformResult {
  const source = dataFormat(request.source);
  const target = dataFormat(request.target);

  if (!source || !target) {
    // The converter checks the pair before it starts a thread; reaching this
    // is a bug, and is reported as one.
    throw new Error(`No data format for ${request.source} → ${request.target}`);
  }

  try {
    const text = decodeUtf8(request.data);

    if (text.trim() === '') {
      return { ok: false, message: 'The file is empty' };
    }

    const value = source.parse(text);

    assertDepth(value, request.maxDepth);

    return { ok: true, data: encodeUtf8(target.serialize(value)) };
  } catch (error) {
    if (error instanceof DataSyntaxError) {
      return { ok: false, message: error.message };
    }

    // A parser or writer that recurses ran out of stack on a file nested far
    // past the limit, before the depth check could see it.
    if (error instanceof RangeError) {
      return {
        ok: false,
        message: `Invalid structure: it is nested more than ${request.maxDepth} levels deep`,
      };
    }

    throw error;
  }
}
