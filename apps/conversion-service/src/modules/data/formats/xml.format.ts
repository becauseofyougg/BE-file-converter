import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

import { DataFormat, type DataValue } from '../data-format';
import {
  normalise,
  toXmlDocument,
  XML_ATTRIBUTE_PREFIX,
  XML_TEXT_KEY,
} from '../data-shapes';

const SHARED_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: XML_ATTRIBUTE_PREFIX,
  textNodeName: XML_TEXT_KEY,
};

/**
 * XML 1.0.
 *
 * Read into data as: an element is a key; its attributes are `@name` keys;
 * its text, when it also has children or attributes, is `#text`; an element
 * that repeats is a list. Everything is text — XML has no types, and guessing
 * them would turn `<zip>01234</zip>` into 1234.
 *
 * **No document type declarations.** `<!DOCTYPE` is refused outright rather
 * than parsed: it is the way in for external entities (XXE — reading
 * `/etc/passwd` or calling an internal URL) and for entity expansion bombs,
 * and a data file has no legitimate need for one.
 */
export class XmlFormat extends DataFormat {
  readonly id = 'xml';
  readonly extensions = ['.xml'];
  readonly mimeType = 'application/xml; charset=utf-8';

  private readonly parser = new XMLParser({
    ...SHARED_OPTIONS,
    parseTagValue: false,
    parseAttributeValue: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    trimValues: true,
  });

  private readonly builder = new XMLBuilder({
    ...SHARED_OPTIONS,
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
  });

  override sniff(text: string): boolean {
    return /^\s*</.test(text);
  }

  parse(text: string): DataValue {
    if (/<!DOCTYPE/i.test(text)) {
      throw this.syntaxError(
        'document type declarations (<!DOCTYPE>) are not accepted',
      );
    }

    const verdict = XMLValidator.validate(text);

    if (verdict !== true) {
      const { msg, line, col } = verdict.err;

      throw this.syntaxError(`${msg} (line ${line}, column ${col})`);
    }

    try {
      return normalise(this.parser.parse(text));
    } catch (error) {
      throw this.syntaxError((error as Error).message);
    }
  }

  serialize(value: DataValue): string {
    const body = this.builder.build(toXmlDocument(value));

    return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  }
}
