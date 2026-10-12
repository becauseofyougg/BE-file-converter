import { CsvError, parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

import { DataFormat, type DataValue } from '../data-format';
import { columnsOf, toRows } from '../data-shapes';

/**
 * RFC 4180: comma-separated, `"` quoted, the first row the header. Read
 * leniently on line endings (LF or CRLF), strictly on shape — a row with the
 * wrong number of cells is an error, not something to guess about.
 *
 * Every cell is text. CSV does not say `007` is a number, and reading it as
 * one would lose the leading zeros of every postcode and phone number; a
 * consumer that wants numbers converts the columns it knows about.
 */
export class CsvFormat extends DataFormat {
  readonly id = 'csv';
  readonly extensions = ['.csv'];
  readonly mimeType = 'text/csv; charset=utf-8';

  parse(text: string): DataValue {
    let records: string[][];

    try {
      records = parse(text, {
        skip_empty_lines: true,
        relax_column_count: false,
      });
    } catch (error) {
      throw this.syntaxError(
        error instanceof CsvError ? error.message : String(error),
      );
    }

    if (records.length === 0) {
      return [];
    }

    const [header, ...rows] = records;
    const columns = uniqueColumns(header);

    return rows.map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, row[index]])),
    );
  }

  /** Written with CRLF line endings, as RFC 4180 specifies. */
  serialize(value: DataValue): string {
    const rows = toRows(value);
    const columns = columnsOf(rows);

    if (columns.length === 0) {
      return '';
    }

    return stringify(
      [
        columns,
        ...rows.map((row) => columns.map((column) => row[column] ?? '')),
      ],
      { record_delimiter: 'windows' },
    );
  }
}

/**
 * Column names that can be object keys. A blank header cell becomes
 * `column_<n>`; a repeated one gets `_2`, `_3` — dropping either would lose
 * the cells under it.
 */
function uniqueColumns(header: readonly string[]): string[] {
  const seen = new Map<string, number>();

  return header.map((raw, index) => {
    const base = raw.trim() === '' ? `column_${index + 1}` : raw;
    const count = (seen.get(base) ?? 0) + 1;

    seen.set(base, count);

    return count === 1 ? base : `${base}_${count}`;
  });
}
