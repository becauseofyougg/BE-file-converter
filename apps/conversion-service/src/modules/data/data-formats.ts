import type { DataFormat } from './data-format';
import { CsvFormat } from './formats/csv.format';
import { JsonFormat } from './formats/json.format';
import { XmlFormat } from './formats/xml.format';
import { YamlFormat } from './formats/yaml.format';

/**
 * The data formats, in one list read by both sides of the thread boundary:
 * `DataConverter` describes them on the main thread, the worker converts
 * with them. A format added here is announced and converted in every
 * direction with the others.
 *
 * Order matters only for sniffing a file with no recognised extension.
 */
export const DATA_FORMATS: readonly DataFormat[] = [
  new JsonFormat(),
  new XmlFormat(),
  new CsvFormat(),
  new YamlFormat(),
];

export function dataFormat(id: string): DataFormat | undefined {
  return DATA_FORMATS.find((format) => format.id === id);
}
