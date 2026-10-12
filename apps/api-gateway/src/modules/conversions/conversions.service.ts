import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  CONVERSION_RPC_PATTERNS,
  type ConversionFormatEntry,
  type ConversionFormatsRequest,
  type ConversionResultFile,
  type ConvertFileRequest,
  type ConvertFileResponse,
} from '@contracts/messages/conversion.messages';
import { FileStorage } from '@storage/file-storage';
import { StorageResolver } from '@storage/storage-resolver';
import type { GatewayConfig } from '../../config/gateway.config';
import { CONVERSION_CLIENT } from '../../messaging/messaging.module';
import { sendRpc } from '../../messaging/rpc';
import { type ConvertRoute, parseFields } from './convert-fields';
import { type DownloadableResult, openResult } from './result-stream';
import { readUpload } from './upload-reader';

/** `GET …/formats` changes only with a deploy; asking once a minute is plenty. */
const FORMATS_TTL_MS = 60_000;

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
  /** Per family; `''` is every family. */
  private readonly formatsCache = new Map<
    string,
    { entries: ConversionFormatEntry[]; at: number }
  >();

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
    route: ConvertRoute = {},
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

      const { targetFormat, save, options } = parseFields(upload.fields, route);

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
          ...(options ? { options } : {}),
          ...(route.family ? { family: route.family } : {}),
          correlationId,
        },
        this.config.getNumber('CONVERSION_RPC_TIMEOUT_MS'),
      );

      const stream = await openResult(
        this.resolver,
        response.result,
        this.logger,
      );

      if (!save) {
        // Nobody asked to keep it: gone once it has been sent, rather than
        // waiting out conversion-service's cleanup window.
        stream.once('close', () => void this.discard(response.result));
      }

      return {
        file: response.result,
        stream,
        operationId,
        saved: response.operation.saved,
      };
    } finally {
      // conversion-service deletes the upload when it is done with it; this
      // covers the cases where it never got it — a refused field, a timeout.
      await this.deleteQuietly(this.storage, 'uploads', key);
    }
  }

  async formats(
    correlationId: string,
    family?: string,
  ): Promise<ConversionFormatEntry[]> {
    const cached = this.formatsCache.get(family ?? '');

    if (cached && Date.now() - cached.at < FORMATS_TTL_MS) {
      return cached.entries;
    }

    const entries = await sendRpc<
      ConversionFormatEntry[],
      ConversionFormatsRequest
    >(this.conversion, CONVERSION_RPC_PATTERNS.FORMATS, {
      ...(family ? { family } : {}),
      correlationId,
    });

    this.formatsCache.set(family ?? '', { entries, at: Date.now() });

    return entries;
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
