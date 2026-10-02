import type { DiscoveryService } from '@nestjs/core';

import { FormatFamily } from '@contracts/enums/conversion.enums';
import { ConverterRegistry } from './converter-registry';
import {
  type ConversionOutput,
  FileConverter,
  type FormatDescriptor,
} from './file-converter';

class FakeConverter extends FileConverter {
  readonly family = FormatFamily.DATA;

  constructor(
    readonly id: string,
    private readonly graph: Record<string, string[]>,
    private readonly extension: string,
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

  detect(fileName: string): string | null {
    return fileName.endsWith(this.extension)
      ? Object.keys(this.graph)[0]
      : null;
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
    { csv: ['json', 'yaml'], json: ['csv'] },
    '.csv',
  );
  const sheets = new FakeConverter(
    'sheets',
    { csv: ['xlsx'], xlsx: ['csv'] },
    '.xlsx',
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
        { instance: sheets },
      ],
    } as unknown as DiscoveryService;
    const registry = new ConverterRegistry(discovery);

    jest.spyOn(registry['logger'], 'log').mockImplementation(() => undefined);
    registry.onModuleInit();

    expect(registry.sourceFormats().map((format) => format.id)).toEqual([
      'csv',
      'json',
      'csv',
      'xlsx',
    ]);
  });

  it('refuses two modules with the same id', () => {
    expect(() =>
      registryWith(data, new FakeConverter('data', {}, '.x')),
    ).toThrow(/both called "data"/);
  });

  it('merges every module into one sorted list of directions', () => {
    expect(registryWith(sheets, data).formats()).toEqual([
      { source: 'csv', target: ['json', 'xlsx', 'yaml'] },
      { source: 'json', target: ['csv'] },
      { source: 'xlsx', target: ['csv'] },
    ]);
  });

  it('knows every target any module writes', () => {
    expect(registryWith(data, sheets).knownTargets()).toEqual([
      'csv',
      'json',
      'xlsx',
      'yaml',
    ]);
  });

  it('lets the first module that recognises a file decide', () => {
    const registry = registryWith(data, sheets);

    expect(registry.detect('a.xlsx', Buffer.alloc(0))).toBe('csv');
    expect(registry.detect('a.csv', Buffer.alloc(0))).toBe('csv');
    expect(registry.detect('a.bin', Buffer.alloc(0))).toBeNull();
  });

  it('describes a format from whichever module knows it', () => {
    const registry = registryWith(data, sheets);

    expect(registry.describe('xlsx')?.mimeType).toBe('x/xlsx');
    expect(registry.describe('pdf')).toBeUndefined();
  });

  it('routes a pair to the module that supports it', () => {
    const registry = registryWith(data, sheets);

    expect(registry.converterFor('csv', 'yaml')).toBe(data);
    expect(registry.converterFor('csv', 'xlsx')).toBe(sheets);
    expect(registry.converterFor('yaml', 'csv')).toBeUndefined();
  });
});
