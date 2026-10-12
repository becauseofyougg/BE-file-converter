import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import type { ConversionFormatEntry } from '@contracts/messages/conversion.messages';
import {
  type DetectedFormat,
  FileConverter,
  type FormatDescriptor,
} from './file-converter';

/**
 * Every conversion module the application has, found rather than listed.
 *
 * On start-up it collects each provider that extends `FileConverter` — so a
 * module registers by existing and being imported, and there is no central
 * list to keep in step. Two modules claiming the same id is a mistake and
 * stops the service from starting.
 *
 * Most questions take an optional `family`, which narrows the answer to that
 * family's modules: what `/api/images/convert` asks, where `/api/convert`
 * asks about everything.
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

  /** `GET …/formats`: every source, with every target it can reach. */
  formats(family?: string): ConversionFormatEntry[] {
    const targets = new Map<string, Set<string>>();

    for (const converter of this.modules(family)) {
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

  /**
   * Every format named anywhere — read or written. A target outside this is
   * not a format at all; one inside it may still be unreachable from a given
   * source (`png` → `svg`), which is a different refusal.
   */
  knownFormats(family?: string): string[] {
    const entries = this.formats(family);

    return [
      ...new Set([
        ...entries.map((entry) => entry.source),
        ...entries.flatMap((entry) => entry.target),
      ]),
    ].sort();
  }

  /** Every format some module can read. */
  sourceFormats(family?: string): FormatDescriptor[] {
    return this.modules(family).flatMap((converter) => [
      ...converter.sourceFormats(),
    ]);
  }

  /**
   * What the file is, by the surest answer any module gives (`DETECTION`):
   * a PNG signature beats a `.csv` name, and a `.svg` name beats XML's
   * guess from a leading `<`. Ties go to the module registered first.
   * With a family, only its modules are asked.
   */
  detect(fileName: string, head: Buffer, family?: string): string | null {
    let best: DetectedFormat | null = null;

    for (const converter of this.modules(family)) {
      const found = converter.detect(fileName, head);

      if (found && (!best || found.confidence > best.confidence)) {
        best = found;
      }
    }

    return best?.format ?? null;
  }

  /** A format some module reads or writes: its type and extension. */
  describe(format: string): FormatDescriptor | undefined {
    for (const converter of this.converters) {
      const descriptor = converter.describe(format);

      if (descriptor) {
        return descriptor;
      }
    }

    return undefined;
  }

  converterFor(
    source: string,
    target: string,
    family?: string,
  ): FileConverter | undefined {
    return this.modules(family).find((converter) =>
      converter.supports(source, target),
    );
  }

  private modules(family?: string): FileConverter[] {
    return family
      ? // `family` arrives as text from the wire, already checked against
        // `FormatFamily` by the RPC's validation.
        this.converters.filter(
          (converter) => (converter.family as string) === family,
        )
      : this.converters;
  }
}
