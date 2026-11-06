import { Injectable } from '@nestjs/common';
import { extname } from 'node:path';
import sharp, { type Sharp } from 'sharp';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import { FormatFamily } from '@contracts/enums/conversion.enums';
import type { ConversionOptions } from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { ConversionConfig } from '../../config/conversion.config';
import {
  type ConversionInput,
  type ConversionOutput,
  type DetectedFormat,
  DETECTION,
  FileConverter,
  type FormatDescriptor,
} from '../converters/file-converter';
import { decodeUtf8 } from '../data/text-encoding';
import {
  IMAGE_DIRECTIONS,
  IMAGE_FORMATS,
  looksLikeSvg,
  rasterSignature,
} from './image-formats';
import { type ImageOptions, readImageOptions } from './image-options';
import { assertSafeSvg } from './svg-safety';

/** What transparency becomes when nobody says — the spec's default. */
export const DEFAULT_BACKGROUND = '#ffffff';
export const DEFAULT_JPEG_QUALITY = 80;

/** The density an SVG's own size is measured at: one SVG unit, one pixel. */
const BASE_DENSITY = 72;

interface Limits {
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}

/**
 * PNG ⇄ JPEG, and SVG rasterised to either. Nothing is turned into SVG.
 *
 * The engine is sharp (libvips; librsvg for SVG). Its work runs on libuv's
 * thread pool, not on the main thread, and it can be stopped: `timeout()`
 * kills a pipeline past its time. That is why this module needs no worker
 * thread of its own, unlike the data formats, whose parsers are JavaScript.
 *
 * Defences, in the order they apply:
 * - an SVG is checked for references outside itself and active content
 *   before the renderer sees it (`assertSafeSvg`);
 * - every image's pixel count is read from its header and refused past
 *   `IMAGE_MAX_PIXELS` before anything is decoded — a 50 KB PNG can claim
 *   to be 100 000 × 100 000;
 * - an SVG's output size is computed and refused past `IMAGE_MAX_WIDTH` /
 *   `IMAGE_MAX_HEIGHT` before it is rendered.
 *
 * Metadata (EXIF, GPS, camera) is not copied into results; orientation is
 * applied to the pixels first, so a portrait photo stays portrait.
 */
@Injectable()
export class ImageConverter extends FileConverter {
  readonly id = 'image';
  readonly family = FormatFamily.IMAGE;

  constructor(private readonly config: ConfigService<ConversionConfig>) {
    super();
    // Results are never read twice; a cache would only hold memory.
    sharp.cache(false);
  }

  sourceFormats(): readonly FormatDescriptor[] {
    return Object.keys(IMAGE_DIRECTIONS).map((id) => IMAGE_FORMATS[id]);
  }

  targetsFor(source: string): readonly string[] {
    return IMAGE_DIRECTIONS[source] ?? [];
  }

  describe(format: string): FormatDescriptor | undefined {
    return IMAGE_FORMATS[format];
  }

  /**
   * PNG and JPEG by signature, which outranks any name: a JPEG called
   * `photo.png` is a JPEG. SVG by its extension, or by an `<svg>` root.
   */
  detect(fileName: string, head: Buffer): DetectedFormat | null {
    const signature = rasterSignature(head);

    if (signature) {
      return { format: signature, confidence: DETECTION.SIGNATURE };
    }

    const extension = extname(fileName).toLowerCase();
    const byName = Object.values(IMAGE_FORMATS).find((format) =>
      format.extensions.includes(extension),
    );

    if (byName) {
      return { format: byName.id, confidence: DETECTION.EXTENSION };
    }

    return looksLikeSvg(head)
      ? { format: 'svg', confidence: DETECTION.CONTENT_SPECIFIC }
      : null;
  }

  override checkOptions(
    source: string,
    target: string,
    options: ConversionOptions,
  ): void {
    readImageOptions(source, target, options, this.limits());
  }

  async convert(input: ConversionInput): Promise<ConversionOutput> {
    const target = IMAGE_FORMATS[input.target];

    if (!this.supports(input.source, input.target)) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_CONVERSION,
        `Cannot convert ${input.source} to ${input.target}`,
        400,
      );
    }

    const limits = this.limits();
    const options = readImageOptions(
      input.source,
      input.target,
      input.options,
      limits,
    );

    let timer: NodeJS.Timeout | undefined;

    try {
      const data = await Promise.race([
        this.render(input, options, limits),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout: the deadline passed')),
            input.timeoutMs,
          );
        }),
      ]);

      return {
        data,
        mimeType: target.mimeType,
        extension: target.extensions[0].slice(1),
      };
    } catch (error) {
      throw this.refusal(error, input.source);
    } finally {
      clearTimeout(timer);
    }
  }

  private async render(
    input: ConversionInput,
    options: ImageOptions,
    limits: Limits,
  ): Promise<Buffer> {
    const pipeline =
      input.source === 'svg'
        ? await this.rasterise(input.data, options, limits)
        : await this.decode(input.data, limits);

    const background = options.background ?? DEFAULT_BACKGROUND;
    const timed = pipeline.timeout({
      seconds: Math.max(1, Math.ceil(input.timeoutMs / 1000)),
    });

    if (input.target === 'jpeg') {
      // JPEG has no alpha: transparency is laid on the background colour.
      return timed
        .flatten({ background })
        .jpeg({ quality: options.quality ?? DEFAULT_JPEG_QUALITY })
        .toBuffer();
    }

    // PNG keeps its alpha channel — except an SVG's, which gets the spec's
    // white background unless `transparent` is asked for.
    return (
      input.source === 'svg' && background !== 'transparent'
        ? timed.flatten({ background })
        : timed
    )
      .png()
      .toBuffer();
  }

  /**
   * A PNG or JPEG, checked for size from its header, then turned upright.
   * The header is read without sharp's own limit, so the refusal can say
   * how big the image claims to be; the decode keeps the limit, in case the
   * header and the data disagree.
   */
  private async decode(data: Buffer, limits: Limits): Promise<Sharp> {
    const { width = 0, height = 0 } = await sharp(data, {
      limitInputPixels: false,
    }).metadata();

    this.assertPixels(width, height, limits);

    return sharp(data, {
      limitInputPixels: limits.maxPixels,
      failOn: 'error',
    }).rotate();
  }

  /**
   * An SVG, made safe and sized: its own size (as librsvg reads it — units,
   * `viewBox`, or the drawing's extent) unless `width`/`height` say
   * otherwise. One of the two scales the other; both fit the drawing inside
   * that box, centred on the background. It is rendered at the density
   * that gives that size directly, so vectors stay sharp rather than being
   * drawn small and stretched.
   */
  private async rasterise(
    data: Buffer,
    options: ImageOptions,
    limits: Limits,
  ): Promise<Sharp> {
    let text: string;

    try {
      text = decodeUtf8(data);
    } catch (error) {
      throw new AppError(
        ERROR_CODES.INVALID_SOURCE,
        (error as Error).message,
        400,
      );
    }

    assertSafeSvg(text);

    const { width: ownWidth = 0, height: ownHeight = 0 } = await sharp(data, {
      density: BASE_DENSITY,
    }).metadata();

    if (ownWidth < 1 || ownHeight < 1) {
      throw new AppError(
        ERROR_CODES.INVALID_SOURCE,
        'The SVG has no size to render at; give it width and height, or a viewBox',
        400,
      );
    }

    const width =
      options.width ??
      (options.height
        ? Math.round((options.height * ownWidth) / ownHeight)
        : ownWidth);
    const height =
      options.height ??
      (options.width
        ? Math.round((options.width * ownHeight) / ownWidth)
        : ownHeight);

    if (width > limits.maxWidth || height > limits.maxHeight) {
      throw new AppError(
        ERROR_CODES.IMAGE_TOO_LARGE,
        `The result would be ${width} × ${height}; the most allowed is ${limits.maxWidth} × ${limits.maxHeight}`,
        400,
        {
          width,
          height,
          maxWidth: limits.maxWidth,
          maxHeight: limits.maxHeight,
        },
      );
    }

    this.assertPixels(width, height, limits);

    const scale = Math.min(width / ownWidth, height / ownHeight);
    const background =
      options.background === 'transparent'
        ? { r: 0, g: 0, b: 0, alpha: 0 }
        : (options.background ?? DEFAULT_BACKGROUND);

    return sharp(data, {
      density: Math.min(Math.max(BASE_DENSITY * scale, 1), 100_000),
      limitInputPixels: limits.maxPixels,
      failOn: 'error',
    }).resize(Math.max(1, width), Math.max(1, height), {
      fit: 'contain',
      background,
    });
  }

  private assertPixels(width: number, height: number, limits: Limits): void {
    if (width * height > limits.maxPixels) {
      throw new AppError(
        ERROR_CODES.IMAGE_TOO_LARGE,
        `The image is ${width} × ${height}, more than ${limits.maxPixels} pixels`,
        400,
        { width, height, maxPixels: limits.maxPixels },
      );
    }
  }

  /** sharp's failures, as the refusals a client can act on. */
  private refusal(error: unknown, source: string): unknown {
    if (error instanceof AppError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (/^timeout/i.test(message)) {
      return new AppError(
        ERROR_CODES.CONVERSION_TIMEOUT,
        'The conversion did not finish in the time allowed',
        422,
      );
    }

    if (/pixel limit/i.test(message)) {
      return new AppError(
        ERROR_CODES.IMAGE_TOO_LARGE,
        'The image has more pixels than allowed',
        400,
      );
    }

    return new AppError(
      ERROR_CODES.INVALID_SOURCE,
      `The file is not a valid ${source.toUpperCase()}: ${message}`,
      400,
    );
  }

  private limits(): Limits {
    return {
      maxWidth: this.config.getNumber('IMAGE_MAX_WIDTH'),
      maxHeight: this.config.getNumber('IMAGE_MAX_HEIGHT'),
      maxPixels: this.config.getNumber('IMAGE_MAX_PIXELS'),
    };
  }
}
