import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import {
  CONVERSION_HISTORY_LIMITS,
  type ConversionHistoryPage,
  type ConversionHistoryRequest,
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
  decodeCursor,
  encodeCursor,
  isDownloadable,
  toOperationRecord,
} from './operation-record';

/** Enough of a file to recognise it by content when its name does not say. */
const HEAD_BYTES = 4096;

/** What is learned about the source along the way, kept for the record even on failure. */
interface SourceFacts {
  format: string | null;
  checksum: string | null;
}

/**
 * A conversion, done while the caller waits, and the history of them.
 *
 * The order of the checks is the order of the error codes a client can get,
 * and it is fixed: an unknown target (400), a source no module recognises
 * (415), a source over its format's limit (413), a pair that does not go
 * (400), a file that does not parse (400), a conversion that does not finish
 * in time (422). Each stops the run before anything more expensive happens.
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
    const facts: SourceFacts = { format: null, checksum: null };

    await this.prisma.conversionOperation.create({
      data: {
        id: request.operationId,
        userId: request.userId,
        sourceName: request.source.name.slice(0, 255),
        sourceSize: BigInt(request.source.size),
        targetFormat: target.slice(0, 16),
        storageDriver: this.storage.driver,
        saved: request.save,
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

  async history(
    request: ConversionHistoryRequest,
  ): Promise<ConversionHistoryPage> {
    const limit = Math.min(
      Math.max(request.limit ?? CONVERSION_HISTORY_LIMITS.default, 1),
      CONVERSION_HISTORY_LIMITS.max,
    );
    const cursor = request.cursor ? decodeCursor(request.cursor) : null;

    if (request.cursor && !cursor) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'The cursor is not valid',
        400,
      );
    }

    const rows = await this.prisma.conversionOperation.findMany({
      where: {
        userId: request.userId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);

    return {
      items: page.map(toOperationRecord),
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  async operation(
    request: ConversionOperationRequest,
  ): Promise<ConversionOperationRecord> {
    return toOperationRecord(await this.ownOperation(request));
  }

  /** Where a saved result is, for the gateway to stream. */
  async savedResult(
    request: ConversionOperationRequest,
  ): Promise<ConversionResultFile> {
    const row = await this.ownOperation(request);

    if (!isDownloadable(row)) {
      throw new AppError(
        ERROR_CODES.RESULT_NOT_SAVED,
        row.status === 'COMPLETED'
          ? 'This result was not saved'
          : 'This conversion has no result',
        404,
      );
    }

    return this.resultFile(
      row.resultKey!,
      row.storageDriver,
      row.targetFormat,
      Number(row.resultSize),
    );
  }

  private async run(
    request: ConvertFileRequest,
    target: string,
    startedAt: number,
    facts: SourceFacts,
  ): Promise<ConvertFileResponse> {
    if (!this.registry.knownTargets().includes(target)) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_CONVERSION,
        `"${request.targetFormat}" is not a format this service converts to`,
        400,
        { supported: this.registry.knownTargets() },
      );
    }

    const source = await this.readSource(request, facts);
    const converter = this.registry.converterFor(source.format, target);

    if (!converter) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_CONVERSION,
        `Cannot convert ${source.format} to ${target}`,
        400,
      );
    }

    const output = await converter.convert({
      data: source.data,
      source: source.format,
      target,
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

    try {
      const row = await this.prisma.conversionOperation.update({
        where: { id: request.operationId },
        data: {
          status: 'COMPLETED',
          sourceFormat: source.format,
          sourceChecksum: facts.checksum,
          resultSize: BigInt(output.data.length),
          resultChecksum: sha256(output.data),
          resultKey: key,
          resultExpiresAt: request.save
            ? null
            : new Date(
                finishedAt.getTime() +
                  this.config.getNumber('CONVERSION_UNSAVED_RESULT_MINUTES') *
                    60_000,
              ),
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
    );

    facts.format = format;

    if (!format) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_FORMAT,
        'The file is not in a format this service reads',
        415,
        {
          supported: this.registry
            .sourceFormats()
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

  private resultFile(
    key: string,
    driver: string,
    format: string,
    size: number,
  ): ConversionResultFile {
    const descriptor = this.registry.describe(format);
    const extension = descriptor?.extensions[0]?.slice(1) ?? format;

    return {
      bucket: 'results',
      key,
      driver,
      contentType: descriptor?.mimeType ?? 'application/octet-stream',
      fileName: `converted.${extension}`,
      size,
    };
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

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
