import type { FormatDescriptor } from '../converters/file-converter';

/**
 * The shape every data format is read into and written from — the JSON data
 * model. Converting is `target.serialize(source.parse(text))`, so a format
 * only ever has to know this, never the other formats.
 */
export type DataValue =
  | null
  | boolean
  | number
  | string
  | DataValue[]
  | { [key: string]: DataValue };

/** The file is not valid in the format it claims to be. A 400, never a 500. */
export class DataSyntaxError extends Error {
  /** `subject` is what was wrong, as said to the user: `JSON`, `encoding`. */
  constructor(subject: string, detail: string) {
    super(`Invalid ${subject}: ${detail}`);
    this.name = DataSyntaxError.name;
  }
}

/**
 * One text data format.
 *
 * **The extension point of the data module.** A new format is a subclass
 * added to `DATA_FORMATS`; it then converts to and from every format already
 * there, because all of them meet in `DataValue`. Each format owns the rules
 * for turning arbitrary data into its own shape — CSV flattens it into rows,
 * XML gives it a single root — so no rule is ever written per pair.
 *
 * Implementations run inside a worker thread: no Nest, no I/O, no state.
 */
export abstract class DataFormat {
  abstract readonly id: string;
  abstract readonly extensions: readonly string[];
  abstract readonly mimeType: string;

  /**
   * Whether the opening text settles that a file is this format. Formats
   * that cannot tell from content — a line of CSV is also valid YAML — leave
   * this false and are recognised by extension only.
   */
  sniff(text: string): boolean {
    void text;

    return false;
  }

  /** Throws `DataSyntaxError` on input that is not valid. */
  abstract parse(text: string): DataValue;

  abstract serialize(value: DataValue): string;

  protected syntaxError(detail: string): DataSyntaxError {
    return new DataSyntaxError(this.id.toUpperCase(), detail);
  }

  descriptor(): FormatDescriptor {
    return {
      id: this.id,
      extensions: this.extensions,
      mimeType: this.mimeType,
    };
  }
}
