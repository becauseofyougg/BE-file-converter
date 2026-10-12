import type { DiscoveryService } from '@nestjs/core';

import { FormatFamily } from '@contracts/enums/conversion.enums';
import { ConverterRegistry } from './converter-registry';
import {
  type ConversionOutput,
  type DetectedFormat,
  DETECTION,
  FileConverter,
  type FormatDescriptor,
} from './file-converter';

class FakeConverter extends FileConverter {
  constructor(
    readonly id: string,
    private readonly graph: Record<string, string[]>,
    /** What `detect` answers, whatever it is asked. */
    private readonly answer: DetectedFormat | null,
    readonly family: FormatFamily = FormatFamily.DATA,
  ) {
    super();
  }

  sourceFormats(): FormatDescriptor[] {
    return Object.keys(this.graph).map((id) => this.descriptorOf(id));
  }

  targetsFor(source: string): string[] {
    return this.graph[source] ?? [];
  }

  describe(format: string): FormatDescriptor | undefined {
    const known = new Set([
      ...Object.keys(this.graph),
      ...Object.values(this.graph).flat(),
    ]);

    return known.has(format) ? this.descriptorOf(format) : undefined;
  }

  detect(): DetectedFormat | null {
    return this.answer;
  }

  convert(): Promise<ConversionOutput> {
    return Promise.reject(new Error('not used'));
  }

  private descriptorOf(id: string): FormatDescriptor {
    return { id, extensions: [`.${id}`], mimeType: `x/${id}` };
  }
}

describe('ConverterRegistry', () => {
  const data = new FakeConverter(
    'data',
    { csv: ['json', 'xml'], json: ['csv'], xml: ['csv'] },
    { format: 'xml', confidence: DETECTION.CONTENT },
  );
  const image = new FakeConverter(
    'image',
    { png: ['jpeg'], svg: ['png'] },
    { format: 'svg', confidence: DETECTION.CONTENT_SPECIFIC },
    FormatFamily.IMAGE,
  );

  const registryWith = (...converters: FileConverter[]) => {
    const registry = new ConverterRegistry({} as DiscoveryService);

    jest.spyOn(registry['logger'], 'log').mockImplementation(() => undefined);
    registry.register(converters);

    return registry;
  };

  it('finds every FileConverter among the providers, and only those', () => {
    const discovery = {
      getProviders: () => [
        { instance: data },
        { instance: {} },
        { instance: null },
        { instance: image },
      ],
    } as unknown as DiscoveryService;
    const registry = new ConverterRegistry(discovery);

    jest.spyOn(registry['logger'], 'log').mockImplementation(() => undefined);
    registry.onModuleInit();

    expect(registry.sourceFormats().map((format) => format.id)).toEqual([
      'csv',
      'json',
      'xml',
      'png',
      'svg',
    ]);
  });

  it('refuses two modules with the same id', () => {
    expect(() =>
      registryWith(data, new FakeConverter('data', {}, null)),
    ).toThrow(/both called "data"/);
  });

  it('merges every module into one sorted list of directions', () => {
    expect(registryWith(image, data).formats()).toEqual([
      { source: 'csv', target: ['json', 'xml'] },
      { source: 'json', target: ['csv'] },
      { source: 'png', target: ['jpeg'] },
      { source: 'svg', target: ['png'] },
      { source: 'xml', target: ['csv'] },
    ]);
  });

  it("narrows the directions to one family's", () => {
    expect(registryWith(data, image).formats(FormatFamily.IMAGE)).toEqual([
      { source: 'png', target: ['jpeg'] },
      { source: 'svg', target: ['png'] },
    ]);
  });

  it('knows every format named anywhere, read or written', () => {
    const registry = registryWith(data, image);

    expect(registry.knownFormats()).toEqual([
      'csv',
      'jpeg',
      'json',
      'png',
      'svg',
      'xml',
    ]);
    expect(registry.knownFormats(FormatFamily.IMAGE)).toEqual([
      'jpeg',
      'png',
      'svg',
    ]);
  });

  /** An SVG starts with `<` too; the surer answer wins, whoever registered first. */
  it('takes the surest detection, not the first', () => {
    expect(registryWith(data, image).detect('x', Buffer.alloc(0))).toBe('svg');
    expect(registryWith(image, data).detect('x', Buffer.alloc(0))).toBe('svg');
  });

  it("asks only one family's modules when told to", () => {
    const registry = registryWith(data, image);

    expect(registry.detect('x', Buffer.alloc(0), FormatFamily.DATA)).toBe(
      'xml',
    );
  });

  it('gives a tie to the module registered first', () => {
    const other = new FakeConverter(
      'other',
      {},
      { format: 'other', confidence: DETECTION.CONTENT },
    );

    expect(registryWith(data, other).detect('x', Buffer.alloc(0))).toBe('xml');
  });

  it('recognises nothing when no module does', () => {
    const silent = new FakeConverter('silent', {}, null);

    expect(registryWith(silent).detect('x', Buffer.alloc(0))).toBeNull();
  });

  it('describes a format from whichever module knows it', () => {
    const registry = registryWith(data, image);

    expect(registry.describe('jpeg')?.mimeType).toBe('x/jpeg');
    expect(registry.describe('pdf')).toBeUndefined();
  });

  it('routes a pair to the module that supports it, within a family if given', () => {
    const registry = registryWith(data, image);

    expect(registry.converterFor('csv', 'json')).toBe(data);
    expect(registry.converterFor('svg', 'png')).toBe(image);
    expect(
      registry.converterFor('csv', 'json', FormatFamily.IMAGE),
    ).toBeUndefined();
    expect(registry.converterFor('png', 'svg')).toBeUndefined();
  });
});
