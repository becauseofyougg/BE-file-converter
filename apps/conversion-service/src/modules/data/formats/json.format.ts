import { DataFormat, type DataValue } from '../data-format';

/** RFC 8259. Read as is; written indented by two spaces. */
export class JsonFormat extends DataFormat {
  readonly id = 'json';
  readonly extensions = ['.json'];
  readonly mimeType = 'application/json; charset=utf-8';

  override sniff(text: string): boolean {
    return /^\s*[[{]/.test(text);
  }

  parse(text: string): DataValue {
    try {
      return JSON.parse(text) as DataValue;
    } catch (error) {
      throw this.syntaxError((error as Error).message);
    }
  }

  serialize(value: DataValue): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }
}
