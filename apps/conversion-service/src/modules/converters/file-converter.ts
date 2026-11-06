import type { FormatFamily } from '@contracts/enums/conversion.enums';
import type { ConversionOptions } from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

/** A format as the outside world sees it: what it is called and what it looks like. */
export interface FormatDescriptor {
  /** Lower case, what clients send: `csv`, `json`. */
  id: string;
  /** With the dot, lower case: `.yaml`, `.yml`. */
  extensions: readonly string[];
  /** What the result is served as. */
  mimeType: string;
}

/**
 * How sure a module is that a file is in one of its formats. The registry
 * asks every module and takes the surest answer, so the order modules are
 * registered in never decides what a file is.
 */
export const DETECTION = {
  /** Magic bytes that only one format starts with: PNG, JPEG. */
  SIGNATURE: 30,
  /** The file name says so — it is what the user meant. */
  EXTENSION: 20,
  /** Content that settles it within a broader kind: an `<svg>` root is XML too. */
  CONTENT_SPECIFIC: 15,
  /** Content that is merely consistent with the format: a leading `{` or `<`. */
  CONTENT: 10,
} as const;

export interface DetectedFormat {
  format: string;
  confidence: number;
}

export interface ConversionInput {
  data: Buffer;
  source: string;
  target: string;
  /** Already checked by `checkOptions`. */
  options: ConversionOptions;
  /** The whole conversion must finish inside this, or it is abandoned. */
  timeoutMs: number;
}

export interface ConversionOutput {
  data: Buffer;
  mimeType: string;
  extension: string;
}

/**
 * One conversion module — a family of formats and the engine between them.
 *
 * **This class is the extension point.** A new module is a new subclass,
 * provided by its own Nest module; `ConverterRegistry` finds every provider
 * that extends this and serves it. Nothing else changes: not the RPC
 * contract, not the gateway, not `GET /api/convert/formats`, which is built
 * from whatever the registered converters declare.
 *
 * Refusals that are the file's fault — it does not parse, it is too deep, it
 * took too long — are thrown as `AppError` with the matching code and status.
 */
export abstract class FileConverter {
  /** Unique across modules; appears in logs. */
  abstract readonly id: string;

  /** Which family the module belongs to — what a family's own route serves. */
  abstract readonly family: FormatFamily;

  /** Every format this module can read, and therefore detect. */
  abstract sourceFormats(): readonly FormatDescriptor[];

  /** What a file in `source` can be turned into. Empty when it cannot. */
  abstract targetsFor(source: string): readonly string[];

  /** A format this module reads or writes: its type and extension. */
  abstract describe(format: string): FormatDescriptor | undefined;

  /**
   * Which of this module's formats a file is, from its name and first bytes,
   * and how sure that is (`DETECTION`). `null` when it is none of them.
   */
  abstract detect(fileName: string, head: Buffer): DetectedFormat | null;

  abstract convert(input: ConversionInput): Promise<ConversionOutput>;

  /**
   * Refuses options this direction does not take, or values out of range,
   * with a `400 VALIDATION_FAILED` naming each. Called before the conversion
   * is attempted. By default a module takes no options at all.
   */
  checkOptions(
    source: string,
    target: string,
    options: ConversionOptions,
  ): void {
    const names = Object.keys(options);

    if (names.length > 0) {
      throw invalidOptions(
        names.map((name) => `${name} does not apply to ${source} → ${target}`),
      );
    }
  }

  supports(source: string, target: string): boolean {
    return this.targetsFor(source).includes(target);
  }
}

export function invalidOptions(errors: string[]): AppError {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, 'Invalid options', 400, {
    errors,
  });
}
