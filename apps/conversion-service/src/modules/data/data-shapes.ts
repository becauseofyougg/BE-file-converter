import { DataSyntaxError, type DataValue } from './data-format';

type DataObject = { [key: string]: DataValue };

export function isObject(value: DataValue): value is DataObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerces whatever a parser produced into `DataValue`. JSON already is; YAML
 * can produce a few things JSON has no word for, and they are mapped to the
 * nearest thing JSON does have rather than lost or crashing the writer.
 */
export function normalise(value: unknown): DataValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    // JSON has no Infinity or NaN; YAML's `.inf` and `.nan` become null.
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }

  if (Array.isArray(value)) {
    return value.map(normalise);
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, item]) => [String(key), normalise(item)]),
    );
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalise(item)]),
    );
  }

  return String(value as string);
}

/**
 * Refuses data nested deeper than `maxDepth`. Walked with an explicit stack,
 * not recursion — the point is to stop a hostile file, and a recursive check
 * would itself be what blows the stack.
 */
export function assertDepth(value: DataValue, maxDepth: number): void {
  const stack: Array<[DataValue, number]> = [[value, 0]];

  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;

    if (depth > maxDepth) {
      throw new DataSyntaxError(
        'structure',
        `it is nested more than ${maxDepth} levels deep`,
      );
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push([item, depth + 1]);
      }
    } else if (isObject(current)) {
      for (const item of Object.values(current)) {
        stack.push([item, depth + 1]);
      }
    }
  }
}

/**
 * The rows a table-shaped format needs, from data of any shape.
 *
 * 1. A wrapper — an object with a single key — is looked through, repeatedly:
 *    `{ "users": [ … ] }` and XML's `<users><user/>…</users>` both reach
 *    the list inside.
 * 2. A list is the rows; each item that is not an object becomes a row with
 *    one `value` column.
 * 3. Any other object is a single row; a lone scalar, one `value` cell.
 *
 * Each row is then flattened: nested objects become dotted column names
 * (`address.city`), and lists inside a row become their JSON text in the cell
 * — a table cell cannot hold a list, and JSON is the one spelling of it that
 * reads back unambiguously.
 */
export function toRows(value: DataValue): Record<string, string>[] {
  let current = value;

  while (isObject(current) && Object.keys(current).length === 1) {
    current = Object.values(current)[0];
  }

  if (current === null) {
    return [];
  }

  const items = Array.isArray(current) ? current : [current];

  return items.map((item) =>
    isObject(item) ? flatten(item) : { value: cell(item) },
  );
}

/** Every column any row has, in the order they first appear. */
export function columnsOf(rows: readonly Record<string, string>[]): string[] {
  const columns = new Set<string>();

  for (const row of rows) {
    for (const column of Object.keys(row)) {
      columns.add(column);
    }
  }

  return [...columns];
}

function flatten(object: DataObject, prefix = ''): Record<string, string> {
  const row: Record<string, string> = {};

  for (const [key, item] of Object.entries(object)) {
    const column = prefix ? `${prefix}.${key}` : key;

    if (isObject(item) && Object.keys(item).length > 0) {
      Object.assign(row, flatten(item, column));
    } else {
      row[column] = cell(item);
    }
  }

  return row;
}

function cell(value: DataValue): string {
  if (value === null) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

const XML_NAME_START = /^[A-Za-z_]/;

/**
 * A key turned into a legal XML element name. Characters XML forbids become
 * `_`; a name that would start with a digit or with `xml` (reserved by the
 * spec) gets a leading `_`. `first name` → `first_name`, `1st` → `_1st`.
 */
export function xmlName(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_.-]/g, '_');

  if (
    cleaned === '' ||
    !XML_NAME_START.test(cleaned) ||
    /^xml/i.test(cleaned)
  ) {
    return `_${cleaned}`;
  }

  return cleaned;
}

export const XML_ATTRIBUTE_PREFIX = '@';
export const XML_TEXT_KEY = '#text';

/**
 * Data reshaped into something with exactly one root element.
 *
 * - An object with a single key, whose value is not a list, already has a
 *   root: that key. This is what XML read into data looks like, so XML → JSON
 *   → XML comes back with its original root.
 * - Anything else is wrapped in `<root>`; a list at the top becomes repeated
 *   `<item>` elements inside it.
 *
 * Keys are made legal element names throughout, except `@`-prefixed keys
 * (attributes) and `#text` (text content), which are how XML read in arrives
 * and so round-trip as attributes and text.
 */
export function toXmlDocument(value: DataValue): DataObject {
  if (isObject(value)) {
    const keys = Object.keys(value);

    if (
      keys.length === 1 &&
      !keys[0].startsWith(XML_ATTRIBUTE_PREFIX) &&
      keys[0] !== XML_TEXT_KEY &&
      !Array.isArray(value[keys[0]])
    ) {
      return { [xmlName(keys[0])]: xmlContent(value[keys[0]]) };
    }
  }

  return { root: xmlContent(Array.isArray(value) ? { item: value } : value) };
}

function xmlContent(value: DataValue): DataValue {
  if (Array.isArray(value)) {
    // A list directly inside a list has no element name of its own to repeat.
    return value.map((item) =>
      Array.isArray(item) ? { item: xmlContent(item) } : xmlContent(item),
    );
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.startsWith(XML_ATTRIBUTE_PREFIX) || key === XML_TEXT_KEY
          ? key
          : xmlName(key),
        xmlContent(item),
      ]),
    );
  }

  return value === null ? '' : value;
}
