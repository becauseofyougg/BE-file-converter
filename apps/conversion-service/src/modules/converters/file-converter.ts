import type { FormatFamily } from '@contracts/enums/conversion.enums';

/** A format as the outside world sees it: what it is called and what it looks like. */
export interface FormatDescriptor {
  /** Lower case, what clients send: `csv`, `json`. */
  id: string;
  /** With the dot, lower case: `.yaml`, `.yml`. */
  extensions: readonly string[];
  /** What the result is served as. */
  mimeType: string;
}

export interface ConversionInput {
  data: Buffer;
  source: string;
  target: string;
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

  /** Which work queue and deployment the module belongs to. */
  abstract readonly family: FormatFamily;

  /** Every format this module can read, and therefore detect. */
  abstract sourceFormats(): readonly FormatDescriptor[];

  /** What a file in `source` can be turned into. Empty when it cannot. */
  abstract targetsFor(source: string): readonly string[];

  /** A format this module can write, for the result's type and extension. */
  abstract describe(format: string): FormatDescriptor | undefined;

  /**
   * Which of this module's formats a file is, from its name and first bytes.
   * `null` when it is none of them — the registry then asks the next module.
   */
  abstract detect(fileName: string, head: Buffer): string | null;

  abstract convert(input: ConversionInput): Promise<ConversionOutput>;

  supports(source: string, target: string): boolean {
    return this.targetsFor(source).includes(target);
  }
}
