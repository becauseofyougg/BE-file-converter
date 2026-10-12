import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import { FormatFamily } from '@contracts/enums/conversion.enums';
import {
  type ConversionOperationRecord,
  type ConversionOperationRequest,
  type ConversionResultFile,
  type ConvertFileRequest,
  type ConvertFileResponse,
} from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  FileStorage,
  ObjectNotFoundError,
  type StorageBucket,
} from '@storage/file-storage';
import { StorageResolver } from '@storage/storage-resolver';
import type { ConversionConfig } from '../../config/conversion.config';
import { PrismaService } from '../../database/prisma.service';
import { ConverterRegistry } from '../converters/converter-registry';
import { ConversionLimits } from './conversion-limits';
import {
  downloadName,
  isDownloadable,
  toOperationRecord,
} from './operation-record';

/** Enough of a file to recognise it by content when its name does not say. */
const HEAD_BYTES = 4096;

/** What is learned about the source along the way, kept for the record even on failure. */
interface SourceFacts {
  format: string | null;
  checksum: string | null;
  /** Whose kind of transformation it is — narrowed as more is known. */
  family: string;
}

/**
 * A conversion, done while the caller waits, and the history of them.
 *
 * The order of the checks is the order of the error codes a client can get,
 * and it is fixed: an unknown target (400), a source no module recognises
 * (415), a source over its format's limit (413), a pair that does not go
 * (400), options that do not apply (400), a file that does not parse or is
 * unsafe (400), a conversion that does not finish in time (422). Each stops
 * the run before anything more expensive happens.
 *
 * A request with a `family` (`/api/images/convert`) is held to that family's
 * formats throughout: an image route does not convert CSV.
 *
 * The upload is deleted whatever happens. The result is kept if the user
 * asked to save it; otherwise only long enough for the gateway to stream it,
 * and `ConversionCleanupJob` removes it after that.
 */
@Injectable()
export class ConversionOperationsService {
  private readonly logger = new Logger(ConversionOperationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConverterRegistry,
    private readonly limits: ConversionLimits,
    private readonly storage: FileStorage,
    private readonly resolver: StorageResolver,
    private readonly config: ConfigService<ConversionConfig>,
  ) {}

  async convert(request: ConvertFileRequest): Promise<ConvertFileResponse> {
    const startedAt = Date.now();
    const target = request.targetFormat.toLowerCase();
    const facts: SourceFacts = {
      format: null,
      checksum: null,
      // The best guess before the file is read: the route's family, else the
      // target's. Refined once the source is recognised.
      family:
        request.family ?? this.registry.familyOf(target) ?? FormatFamily.DATA,
    };

    await this.prisma.conversionOperation.create({
      data: {
        id: request.operationId,
        userId: request.userId,
        sourceName: request.source.name.slice(0, 255),
        sourceSize: BigInt(request.source.size),
        targetFormat: target.slice(0, 16),
        family: facts.family,
        storageDriver: this.storage.driver,
        saved: request.save,
        options: hasOptions(request.options) ? request.options : undefined,
        correlationId: request.correlationId,
      },
    });

    try {
      const response = await this.run(request, target, startedAt, facts);

      this.audit(request, target, facts, startedAt, 'success');

      return response;
    } catch (error) {
      await this.recordFailure(request, target, facts, startedAt, error);

      throw error;
    } finally {
      await this.discardUpload(request);
    }
  }

  async operation(
    request: ConversionOperationRequest,
  ): Promise<ConversionOperationRecord> {
    return toOperationRecord(await this.ownOperation(request));
  }

  /**
   * Where a saved result is, for the gateway to stream — docs/SAVED-RESULTS.md.
   *
   * Asked for by owner and id together, so another user's id is the same
   * 404 as no id. Then: a conversion with no result, or a result that was
   * not kept, is 404 `RESULT_NOT_SAVED`; one kept but past its time is 410
   * `RESULT_EXPIRED` — it existed, and is gone for good.
   */
  async savedResult(
    request: ConversionOperationRequest,
  ): Promise<ConversionResultFile> {
    const row = await this.ownOperation(request);

    if (row.status !== 'COMPLETED' || !row.saved) {
      throw new AppError(
        ERROR_CODES.RESULT_NOT_SAVED,
        row.status === 'COMPLETED'
          ? 'This result was not saved'
          : 'This conversion has no result',
        404,
      );
    }

    if (!isDownloadable(row)) {
      throw new AppError(
        ERROR_CODES.RESULT_EXPIRED,
        'This saved result has expired and been deleted',
        410,
      );
    }

    return this.resultFile(
      row.resultKey!,
      row.storageDriver,
      row.targetFormat,
      Number(row.resultSize),
      row.sourceName,
      row.fileId,
    );
  }

  private async run(
    request: ConvertFileRequest,
    target: string,
    startedAt: number,
    facts: SourceFacts,
  ): Promise<ConvertFileResponse> {
    const known = this.registry.knownFormats(request.family);

    if (!known.includes(target)) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_CONVERSION,
        `"${request.targetFormat}" is not a format this service converts to`,
        400,
        { supported: known },
      );
    }

    const source = await this.readSource(request, facts);

    facts.family = this.registry.familyOf(source.format) ?? facts.family;

    const converter = this.registry.converterFor(
      source.format,
      target,
      request.family,
    );

    if (!converter) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_CONVERSION,
        `Cannot convert ${source.format} to ${target}`,
        400,
        {
          supported: this.registry
            .formats(request.family)
            .find((entry) => entry.source === source.format)?.target,
        },
      );
    }

    facts.family = converter.family;

    const options = request.options ?? {};

    converter.checkOptions(source.format, target, options);

    const output = await converter.convert({
      data: source.data,
      source: source.format,
      target,
      options,
      // The limit is on the whole request, and reading the upload already
      // spent some of it.
      timeoutMs: Math.max(
        this.config.getNumber('CONVERSION_SYNC_TIMEOUT_MS') -
          (Date.now() - startedAt),
        1,
      ),
    });

    const key = this.storage.buildKey(
      request.userId,
      request.operationId,
      output.extension,
    );
    // Kept only if asked for, and only up to the size saved files may be. A
    // result over it is still returned — the conversion succeeded — just not
    // kept; the response says which (`X-Result-Saved`).
    const keep =
      request.save &&
      output.data.length <= this.config.getNumber('CONVERSION_MAX_SAVED_BYTES');
    const fileId = keep ? randomUUID() : null;
    const storing = Date.now();

    // Written to storage either way: it is where the gateway streams the
    // response from. Saving is the same write, kept longer — so it adds
    // nothing to the time the client waits.
    await this.storageCall(() =>
      this.storage.put({
        bucket: 'results',
        key,
        body: output.data,
        contentType: output.mimeType,
        contentLength: output.data.length,
      }),
    );

    const finishedAt = new Date();

    if (request.save) {
      this.auditSave(
        request,
        fileId,
        output.data.length,
        finishedAt.getTime() - storing,
      );
    }

    try {
      const row = await this.prisma.conversionOperation.update({
        where: { id: request.operationId },
        data: {
          status: 'COMPLETED',
          family: facts.family,
          sourceFormat: source.format,
          sourceChecksum: facts.checksum,
          resultSize: BigInt(output.data.length),
          resultChecksum: sha256(output.data),
          resultKey: key,
          saved: keep,
          fileId,
          resultExpiresAt: this.resultExpiry(keep, finishedAt),
          durationMs: finishedAt.getTime() - startedAt,
          finishedAt,
        },
      });

      return {
        operation: toOperationRecord(row),
        result: this.resultFile(
          key,
          this.storage.driver,
          target,
          output.data.length,
          'converted',
          fileId,
        ),
      };
    } catch (error) {
      // Nothing would ever point at it, so nothing would ever delete it.
      await this.deleteQuietly(this.storage, 'results', key);

      throw error;
    }
  }

  /**
   * The upload, read into memory — bounded by its format's limit, which is
   * known only once the first bytes have said what the format is.
   */
  private async readSource(
    request: ConvertFileRequest,
    facts: SourceFacts,
  ): Promise<{ format: string; data: Buffer }> {
    const storage = this.resolver.forDriver(request.source.driver);
    const stream = await this.storageCall(() =>
      storage.getStream('uploads', request.source.key),
    );

    const chunks: Buffer[] = [];
    let length = 0;
    let limit = Number.POSITIVE_INFINITY;
    let format: string | null = null;

    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        length += chunk.length;

        if (format === null && length >= HEAD_BYTES) {
          format = this.recognise(request, Buffer.concat(chunks), facts);
          limit = this.limits.maxBytesFor(format);
        }

        // The declared size was measured by the gateway; this is the check
        // that does not have to trust it.
        if (length > limit) {
          throw this.tooLarge(format!, limit);
        }
      }
    } finally {
      stream.destroy();
    }

    const data = Buffer.concat(chunks, length);

    if (format === null) {
      format = this.recognise(request, data, facts);
      limit = this.limits.maxBytesFor(format);

      if (length > limit) {
        throw this.tooLarge(format, limit);
      }
    }

    facts.checksum = sha256(data);

    return { format, data };
  }

  /**
   * 415 if no module knows the file; 413 if its format's limit is exceeded.
   * The format goes into `facts` as soon as it is known, so a file refused
   * for its size is still recorded as the format it was.
   */
  private recognise(
    request: ConvertFileRequest,
    head: Buffer,
    facts: SourceFacts,
  ): string {
    const format = this.registry.detect(
      request.source.name,
      head.subarray(0, HEAD_BYTES),
      request.family,
    );

    facts.format = format;

    if (!format) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_FORMAT,
        'The file is not in a format this service reads',
        415,
        {
          supported: this.registry
            .sourceFormats(request.family)
            .map((descriptor) => descriptor.id),
        },
      );
    }

    const limit = this.limits.maxBytesFor(format);

    if (request.source.size > limit) {
      throw this.tooLarge(format, limit);
    }

    return format;
  }

  private tooLarge(format: string, limit: number): AppError {
    return new AppError(
      ERROR_CODES.FILE_TOO_LARGE,
      `${format.toUpperCase()} files are accepted up to ${limit} bytes`,
      413,
      { format, maxBytes: limit },
    );
  }

  /**
   * `name` is what the file is called on the way out: the conversion's own
   * response is always `converted.<ext>`, as its spec fixes; a download from
   * the history is named after the upload (`people.csv` → `people.json`).
   */
  private resultFile(
    key: string,
    driver: string,
    format: string,
    size: number,
    name: string,
    fileId: string | null,
  ): ConversionResultFile {
    const descriptor = this.registry.describe(format);
    const extension = descriptor?.extensions[0]?.slice(1) ?? format;

    return {
      bucket: 'results',
      key,
      driver,
      contentType: descriptor?.mimeType ?? 'application/octet-stream',
      fileName:
        name === 'converted'
          ? `converted.${extension}`
          : downloadName(name, extension),
      size,
      ...(fileId ? { fileId } : {}),
    };
  }

  /**
   * An unsaved result lasts minutes — long enough to be streamed once. A
   * saved one lasts as long as the history it belongs to.
   */
  private resultExpiry(saved: boolean, from: Date): Date {
    return new Date(
      from.getTime() +
        (saved
          ? this.config.getNumber('HISTORY_RETENTION_DAYS') * 24 * 60 * 60_000
          : this.config.getNumber('CONVERSION_UNSAVED_RESULT_MINUTES') *
            60_000),
    );
  }

  /**
   * The save's own audit line: who, which transformation, which file, how
   * big, how long the write took — or why it was not kept. Never the bytes.
   */
  private auditSave(
    request: ConvertFileRequest,
    fileId: string | null,
    size: number,
    durationMs: number,
  ): void {
    const entry = {
      event: 'conversion.file.save',
      userId: request.userId,
      transformationId: request.operationId,
      fileId,
      fileSize: size,
      durationMs,
      result: fileId ? 'success' : 'failure',
      ...(fileId
        ? {}
        : {
            reason: `larger than the ${this.config.getNumber('CONVERSION_MAX_SAVED_BYTES')} bytes a saved file may be`,
          }),
    };

    if (fileId) {
      this.logger.log(entry);
    } else {
      this.logger.warn(entry);
    }
  }

  private async ownOperation(request: ConversionOperationRequest) {
    // By id *and* owner, so another user's id is indistinguishable from none.
    const row = await this.prisma.conversionOperation.findFirst({
      where: { id: request.operationId, userId: request.userId },
    });

    if (!row) {
      throw new AppError(ERROR_CODES.JOB_NOT_FOUND, 'No such conversion', 404);
    }

    return row;
  }

  private async recordFailure(
    request: ConvertFileRequest,
    target: string,
    facts: SourceFacts,
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    const known = error instanceof AppError;
    const code = known ? error.code : ERROR_CODES.INTERNAL_ERROR;
    const finishedAt = new Date();

    this.audit(request, target, facts, startedAt, 'failure', code);

    try {
      await this.prisma.conversionOperation.update({
        where: { id: request.operationId },
        data: {
          status: 'FAILED',
          family: facts.family,
          sourceFormat: facts.format,
          sourceChecksum: facts.checksum,
          errorCode: code,
          errorMessage: (known ? error.message : 'Internal error').slice(
            0,
            1024,
          ),
          durationMs: finishedAt.getTime() - startedAt,
          finishedAt,
        },
      });
    } catch (recordError) {
      // The caller still gets the original failure; this one is ours to see.
      this.logger.error({
        event: 'conversion.record_failed',
        operationId: request.operationId,
        error: (recordError as Error).message,
      });
    }
  }

  /**
   * The audit line: who converted what to what, how big, how it went, how
   * long it took. Never the content, and never the filename — it is the
   * user's, and can say more than they meant to share with a log pipeline.
   */
  private audit(
    request: ConvertFileRequest,
    target: string,
    facts: SourceFacts,
    startedAt: number,
    result: 'success' | 'failure',
    code?: string,
  ): void {
    const entry = {
      event: 'conversion.audit',
      operationId: request.operationId,
      correlationId: request.correlationId,
      userId: request.userId,
      sourceFormat: facts.format,
      targetFormat: target,
      fileSize: request.source.size,
      result,
      code: code ?? null,
      durationMs: Date.now() - startedAt,
    };

    if (result === 'success') {
      this.logger.log(entry);
    } else {
      this.logger.warn(entry);
    }
  }

  private async discardUpload(request: ConvertFileRequest): Promise<void> {
    try {
      await this.deleteQuietly(
        this.resolver.forDriver(request.source.driver),
        'uploads',
        request.source.key,
      );
    } catch {
      // The driver is not configured here; `readSource` already said so.
    }
  }

  private async deleteQuietly(
    storage: FileStorage,
    bucket: StorageBucket,
    key: string,
  ): Promise<void> {
    try {
      await storage.delete(bucket, key);
    } catch (error) {
      this.logger.warn({
        event: 'conversion.storage_delete_failed',
        bucket,
        key,
        error: (error as Error).message,
      });
    }
  }

  /** Storage being down is a 503 the client can retry, not a 500. */
  private async storageCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      if (error instanceof ObjectNotFoundError) {
        throw new AppError(
          ERROR_CODES.INVALID_SOURCE,
          'The uploaded file is gone',
          400,
        );
      }

      this.logger.error({
        event: 'conversion.storage_failed',
        error: (error as Error).message,
      });

      throw new AppError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        'Storage is unavailable',
        503,
      );
    }
  }
}

function hasOptions(
  options: ConvertFileRequest['options'],
): options is NonNullable<ConvertFileRequest['options']> {
  return options !== undefined && Object.keys(options).length > 0;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
