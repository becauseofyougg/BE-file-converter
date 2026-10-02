import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import type { ConversionFormatEntry } from '@contracts/messages/conversion.messages';
import { FileConverter, type FormatDescriptor } from './file-converter';

/**
 * Every conversion module the application has, found rather than listed.
 *
 * On start-up it collects each provider that extends `FileConverter` — so a
 * module registers by existing and being imported, and there is no central
 * list to keep in step. Two modules claiming the same id is a mistake and
 * stops the service from starting.
 */
@Injectable()
export class ConverterRegistry implements OnModuleInit {
  private readonly logger = new Logger(ConverterRegistry.name);
  private converters: FileConverter[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const found = this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter(
        (instance): instance is FileConverter =>
          instance instanceof FileConverter,
      );

    this.register(found);
  }

  /** Exposed for tests; the application calls it once, from `onModuleInit`. */
  register(converters: readonly FileConverter[]): void {
    const ids = new Set<string>();

    for (const converter of converters) {
      if (ids.has(converter.id)) {
        throw new Error(
          `Two conversion modules are both called "${converter.id}"`,
        );
      }

      ids.add(converter.id);
    }

    this.converters = [...converters];

    this.logger.log({
      event: 'conversion.registry.loaded',
      converters: this.converters.map((converter) => converter.id),
    });
  }

  /** `GET /api/convert/formats`: every source, with every target it can reach. */
  formats(): ConversionFormatEntry[] {
    const targets = new Map<string, Set<string>>();

    for (const converter of this.converters) {
      for (const format of converter.sourceFormats()) {
        const reachable = targets.get(format.id) ?? new Set<string>();

        for (const target of converter.targetsFor(format.id)) {
          reachable.add(target);
        }

        targets.set(format.id, reachable);
      }
    }

    return [...targets.entries()]
      .map(([source, reachable]) => ({ source, target: [...reachable].sort() }))
      .sort((a, b) => a.source.localeCompare(b.source));
  }

  /** Every format some module can write. */
  knownTargets(): string[] {
    return [...new Set(this.formats().flatMap((entry) => entry.target))].sort();
  }

  /** Every format some module can read. */
  sourceFormats(): FormatDescriptor[] {
    return this.converters.flatMap((converter) => [
      ...converter.sourceFormats(),
    ]);
  }

  /** The first module that recognises the file decides what it is. */
  detect(fileName: string, head: Buffer): string | null {
    for (const converter of this.converters) {
      const format = converter.detect(fileName, head);

      if (format) {
        return format;
      }
    }

    return null;
  }

  /** A format some module can write: its type and extension. */
  describe(format: string): FormatDescriptor | undefined {
    for (const converter of this.converters) {
      const descriptor = converter.describe(format);

      if (descriptor) {
        return descriptor;
      }
    }

    return undefined;
  }

  converterFor(source: string, target: string): FileConverter | undefined {
    return this.converters.find((converter) =>
      converter.supports(source, target),
    );
  }
}
