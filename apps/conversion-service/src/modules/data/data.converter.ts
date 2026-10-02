import { Injectable } from '@nestjs/common';
import { extname, join } from 'node:path';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import { FormatFamily } from '@contracts/enums/conversion.enums';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { ConversionConfig } from '../../config/conversion.config';
import {
  type ConversionInput,
  type ConversionOutput,
  FileConverter,
  type FormatDescriptor,
} from '../converters/file-converter';
import {
  WorkerMemoryError,
  WorkerRunner,
  WorkerTimeoutError,
} from '../converters/worker-runner';
import { DATA_FORMATS, dataFormat } from './data-formats';
import type { TransformRequest, TransformResult } from './data-transform';

/** How much of a file is looked at to recognise it when its name does not say. */
const SNIFF_CHARS = 1024;

/** A UTF-8 byte-order mark, spelled as an escape — the character is invisible. */
const LEADING_BOM = new RegExp('^\\u{FEFF}', 'u');

/**
 * CSV, JSON, XML and YAML, each to each of the others.
 *
 * Every conversion runs in its own worker thread (`data-transform.worker`),
 * with the time and memory limits from configuration. Which formats exist is
 * `DATA_FORMATS`; this class only connects them to the rest of the service.
 */
@Injectable()
export class DataConverter extends FileConverter {
  readonly id = 'data';
  readonly family = FormatFamily.DATA;

  /** Compiled alongside this file; a field so a test can point elsewhere. */
  protected workerEntry = join(__dirname, 'data-transform.worker.js');

  constructor(
    private readonly runner: WorkerRunner,
    private readonly config: ConfigService<ConversionConfig>,
  ) {
    super();
  }

  sourceFormats(): readonly FormatDescriptor[] {
    return DATA_FORMATS.map((format) => format.descriptor());
  }

  targetsFor(source: string): readonly string[] {
    if (!dataFormat(source)) {
      return [];
    }

    return DATA_FORMATS.map((format) => format.id).filter(
      (id) => id !== source,
    );
  }

  describe(format: string): FormatDescriptor | undefined {
    return dataFormat(format)?.descriptor();
  }

  /**
   * By extension first — it is what the user meant. Without a recognised
   * one, by content, for the formats whose content is unmistakable (JSON,
   * XML); CSV and YAML look like too many things to be guessed.
   */
  detect(fileName: string, head: Buffer): string | null {
    const extension = extname(fileName).toLowerCase();
    const byName = DATA_FORMATS.find((format) =>
      format.extensions.includes(extension),
    );

    if (byName) {
      return byName.id;
    }

    const text = head
      .subarray(0, SNIFF_CHARS * 4)
      .toString('utf8')
      .replace(LEADING_BOM, '')
      .slice(0, SNIFF_CHARS);

    return DATA_FORMATS.find((format) => format.sniff(text))?.id ?? null;
  }

  async convert(input: ConversionInput): Promise<ConversionOutput> {
    const target = dataFormat(input.target);

    if (!target || !this.supports(input.source, input.target)) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_CONVERSION,
        `Cannot convert ${input.source} to ${input.target}`,
        400,
      );
    }

    const request: TransformRequest = {
      data: input.data,
      source: input.source,
      target: input.target,
      maxDepth: this.config.getNumber('CONVERSION_MAX_DEPTH'),
    };

    let result: TransformResult;

    try {
      result = await this.runner.run<TransformResult>(
        this.workerEntry,
        request,
        {
          timeoutMs: input.timeoutMs,
          maxMemoryMb: this.config.getNumber('CONVERSION_WORKER_MEMORY_MB'),
        },
      );
    } catch (error) {
      if (error instanceof WorkerTimeoutError) {
        throw new AppError(
          ERROR_CODES.CONVERSION_TIMEOUT,
          // Not the number: `timeoutMs` is what was left of the request's
          // limit, and quoting it would contradict the documented one.
          'The conversion did not finish in the time allowed',
          422,
        );
      }

      if (error instanceof WorkerMemoryError) {
        throw new AppError(
          ERROR_CODES.FILE_TOO_LARGE,
          'The file needs more memory to convert than a conversion is allowed',
          413,
        );
      }

      throw error;
    }

    if (!result.ok) {
      throw new AppError(ERROR_CODES.INVALID_SOURCE, result.message, 400);
    }

    return {
      data: Buffer.from(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      ),
      mimeType: target.mimeType,
      extension: target.extensions[0].slice(1),
    };
  }
}
