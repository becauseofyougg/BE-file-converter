import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  CONVERSION_RPC_PATTERNS,
  type ConversionFormatEntry,
  type ConversionHistoryPage,
  type ConversionHistoryRequest,
  type ConversionOperationRecord,
  type ConversionOperationRequest,
  type ConversionResultFile,
  type ConvertFileRequest,
  type ConvertFileResponse,
} from '@contracts/messages/conversion.messages';
import { FileStorage } from '@storage/file-storage';
import { StorageResolver } from '@storage/storage-resolver';
import type { GatewayConfig } from '../../config/gateway.config';
import { CONVERSION_CLIENT } from '../../messaging/messaging.module';
import { sendRpc } from '../../messaging/rpc';
import { readUpload } from './upload-reader';

/** Lower-case word, as the formats are named. */
const FORMAT_ID = /^[a-z0-9]{1,16}$/;

/** `GET /api/convert/formats` changes only with a deploy; asking once a minute is plenty. */
const FORMATS_TTL_MS = 60_000;

/** A converted file, ready to stream to the client. */
export interface DownloadableResult {
  file: ConversionResultFile;
  stream: Readable;
  operationId: string;
}

/**
 * The gateway's half of `/api/convert`: take the upload, ask
 * conversion-service, hand back the result.
 *
 * The upload goes straight from the request to storage, never through
 * memory, and conversion-service reads it from there — a file does not
 * travel through the broker. The result comes back the same way.
 */
@Injectable()
export class ConversionsService {
  private readonly logger = new Logger(ConversionsService.name);
  private formatsCache: {
    entries: ConversionFormatEntry[];
    at: number;
  } | null = null;

  constructor(
    @Inject(CONVERSION_CLIENT) private readonly conversion: ClientProxy,
    private readonly storage: FileStorage,
    private readonly resolver: StorageResolver,
    private readonly config: ConfigService<GatewayConfig>,
  ) {}

  async convert(
    request: FastifyRequest,
    userId: string,
    correlationId: string,
  ): Promise<DownloadableResult> {
    const operationId = randomUUID();
    const key = this.storage.buildKey(userId, operationId);
    const maxBytes = this.config.getNumber('CONVERSION_UPLOAD_MAX_BYTES');

    try {
      const upload = await readUpload(
        request,
        (body) => this.storage.put({ bucket: 'uploads', key, body }),
        maxBytes,
      );

      const { targetFormat, save } = parseFields(upload.fields);

      if (upload.size === 0) {
        throw new AppError(
          ERROR_CODES.INVALID_SOURCE,
          'The file is empty',
          400,
        );
      }

      const response = await sendRpc<ConvertFileResponse, ConvertFileRequest>(
        this.conversion,
        CONVERSION_RPC_PATTERNS.CONVERT,
        {
          operationId,
          userId,
          source: {
            bucket: 'uploads',
            key,
            driver: this.storage.driver,
            name: upload.fileName,
            size: upload.size,
          },
          targetFormat,
          save,
          correlationId,
        },
        this.config.getNumber('CONVERSION_RPC_TIMEOUT_MS'),
      );

      const stream = await this.open(response.result);

      if (!save) {
        // Nobody asked to keep it: gone once it has been sent, rather than
        // waiting out conversion-service's cleanup window.
        stream.once('close', () => void this.discard(response.result));
      }

      return { file: response.result, stream, operationId };
    } finally {
      // conversion-service deletes the upload when it is done with it; this
      // covers the cases where it never got it — a refused field, a timeout.
      await this.deleteQuietly(this.storage, 'uploads', key);
    }
  }

  async formats(correlationId: string): Promise<ConversionFormatEntry[]> {
    if (
      this.formatsCache &&
      Date.now() - this.formatsCache.at < FORMATS_TTL_MS
    ) {
      return this.formatsCache.entries;
    }

    const entries = await sendRpc<
      ConversionFormatEntry[],
      { correlationId: string }
    >(this.conversion, CONVERSION_RPC_PATTERNS.FORMATS, { correlationId });

    this.formatsCache = { entries, at: Date.now() };

    return entries;
  }

  history(request: ConversionHistoryRequest): Promise<ConversionHistoryPage> {
    return sendRpc(
      this.conversion,
      CONVERSION_RPC_PATTERNS.HISTORY_LIST,
      request,
    );
  }

  operation(
    request: ConversionOperationRequest,
  ): Promise<ConversionOperationRecord> {
    return sendRpc(
      this.conversion,
      CONVERSION_RPC_PATTERNS.HISTORY_GET,
      request,
    );
  }

  async download(
    request: ConversionOperationRequest,
  ): Promise<DownloadableResult> {
    const file = await sendRpc<
      ConversionResultFile,
      ConversionOperationRequest
    >(this.conversion, CONVERSION_RPC_PATTERNS.HISTORY_RESULT, request);

    return {
      file,
      stream: await this.open(file),
      operationId: request.operationId,
    };
  }

  /**
   * Opened before a single byte of the response is written, so a result
   * that cannot be read is an error response — never a 200 that stops
   * half-way.
   */
  private async open(file: ConversionResultFile): Promise<Readable> {
    try {
      return await this.resolver
        .forDriver(file.driver)
        .getStream(file.bucket, file.key);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      this.logger.error({
        event: 'conversion.result_unreadable',
        error: (error as Error).message,
      });

      throw new AppError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        'The result could not be read',
        503,
      );
    }
  }

  private async discard(file: ConversionResultFile): Promise<void> {
    try {
      await this.deleteQuietly(
        this.resolver.forDriver(file.driver),
        file.bucket,
        file.key,
      );
    } catch {
      // Not configured here; conversion-service's cleanup has it.
    }
  }

  private async deleteQuietly(
    storage: FileStorage,
    bucket: 'uploads' | 'results',
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
}

/**
 * The form fields, checked by hand: they arrive as multipart text, past the
 * reach of the `ValidationPipe`. Unknown fields are refused, as they are on
 * every JSON route.
 */
export function parseFields(fields: Record<string, string>): {
  targetFormat: string;
  save: boolean;
} {
  const unknown = Object.keys(fields).filter(
    (name) => !['targetFormat', 'save'].includes(name),
  );

  if (unknown.length > 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Validation failed',
      400,
      [...unknown.map((name) => `property ${name} should not exist`)],
    );
  }

  const targetFormat = (fields.targetFormat ?? '').trim().toLowerCase();

  if (!FORMAT_ID.test(targetFormat)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Validation failed',
      400,
      ['targetFormat must be a format name, such as "json"'],
    );
  }

  const save = (fields.save ?? 'false').trim().toLowerCase();

  if (!['true', 'false', '1', '0'].includes(save)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Validation failed',
      400,
      ['save must be true or false'],
    );
  }

  return { targetFormat, save: save === 'true' || save === '1' };
}
