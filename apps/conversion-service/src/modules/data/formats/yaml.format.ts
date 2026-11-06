import { type Document, parseAllDocuments, stringify } from 'yaml';

import { DataFormat, type DataValue } from '../data-format';
import { normalise } from '../data-shapes';

/**
 * Aliases a document may expand. YAML lets one anchor be referenced from
 * many places, and nesting that is how a few hundred bytes become gigabytes
 * ("billion laughs"); the parser refuses past this.
 */
const MAX_ALIAS_COUNT = 100;

/**
 * YAML 1.2 (core schema — `yes` and `on` are strings, not booleans, as 1.2
 * says). A file with several documents (`---`) is read as a list of them.
 */
export class YamlFormat extends DataFormat {
  readonly id = 'yaml';
  readonly extensions = ['.yaml', '.yml'];
  readonly mimeType = 'application/yaml; charset=utf-8';

  parse(text: string): DataValue {
    // An empty stream parses to an empty list of documents.
    const documents: readonly Document.Parsed[] = parseAllDocuments(text, {
      version: '1.2',
      uniqueKeys: true,
      prettyErrors: false,
    });

    const values = documents.map((document) => {
      const [error] = document.errors;

      if (error) {
        throw this.syntaxError(firstLine(error.message));
      }

      try {
        return normalise(document.toJS({ maxAliasCount: MAX_ALIAS_COUNT }));
      } catch (cause) {
        throw this.syntaxError(firstLine((cause as Error).message));
      }
    });

    if (values.length === 0) {
      return null;
    }

    return values.length === 1 ? values[0] : values;
  }

  serialize(value: DataValue): string {
    return stringify(value, { version: '1.2', lineWidth: 0 });
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0].trim();
}
