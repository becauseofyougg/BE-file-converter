import sharp from 'sharp';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import type { ConversionOptions } from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { ConversionConfig } from '../../config/conversion.config';
import { DETECTION } from '../converters/file-converter';
import { ImageConverter } from './image.converter';

/**
 * Real sharp, real images — made here, so the suite carries no fixtures and
 * every input is exactly what the test says it is.
 */
describe('ImageConverter', () => {
  let env: Record<string, number>;
  let converter: ImageConverter;

  beforeEach(() => {
    env = {
      IMAGE_MAX_WIDTH: 2000,
      IMAGE_MAX_HEIGHT: 2000,
      IMAGE_MAX_PIXELS: 2_000_000,
    };
    converter = new ImageConverter({
      getNumber: (key: string) => env[key],
    } as unknown as ConfigService<ConversionConfig>);
  });

  /** A PNG with a half-transparent blue fill. */
  const png = (width = 8, height = 4) =>
    sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();

  const jpeg = (orientation?: number) => {
    const image = sharp({
      create: { width: 8, height: 4, channels: 3, background: '#00ff00' },
    }).jpeg();

    return (
      orientation ? image.withMetadata({ orientation }) : image
    ).toBuffer();
  };

  const svg = (
    attributes = 'width="100" height="50"',
    body = '<rect x="10" y="10" width="20" height="20" fill="red"/>',
  ) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`,
    );

  const convert = (
    data: Buffer,
    source: string,
    target: string,
    options: ConversionOptions = {},
    timeoutMs = 10_000,
  ) => converter.convert({ data, source, target, options, timeoutMs });

  async function refusal(promise: Promise<unknown>): Promise<AppError> {
    const error = await promise.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  describe('what it serves', () => {
    it('PNG → JPEG, JPEG → PNG, SVG → either, and nothing to SVG', () => {
      expect(converter.family).toBe('image');
      expect(converter.sourceFormats().map((format) => format.id)).toEqual([
        'png',
        'jpeg',
        'svg',
      ]);
      expect(converter.targetsFor('png')).toEqual(['jpeg']);
      expect(converter.targetsFor('jpeg')).toEqual(['png']);
      expect(converter.targetsFor('svg')).toEqual(['jpeg', 'png']);
      expect(converter.supports('png', 'svg')).toBe(false);
      expect(converter.targetsFor('gif')).toEqual([]);
      expect(converter.describe('jpeg')).toEqual({
        id: 'jpeg',
        extensions: ['.jpeg', '.jpg'],
        mimeType: 'image/jpeg',
      });
    });
  });

  describe('detect', () => {
    it('knows PNG and JPEG by signature, whatever the name says', async () => {
      expect(converter.detect('photo.csv', await png())).toEqual({
        format: 'png',
        confidence: DETECTION.SIGNATURE,
      });
      expect(converter.detect('photo.png', await jpeg())).toEqual({
        format: 'jpeg',
        confidence: DETECTION.SIGNATURE,
      });
    });

    it.each([
      ['drawing.SVG', 'svg'],
      ['photo.jpg', 'jpeg'],
      ['photo.JPEG', 'jpeg'],
      ['image.png', 'png'],
    ])('by extension when the bytes do not say: %s', (name, format) => {
      expect(converter.detect(name, Buffer.from('?'))).toEqual({
        format,
        confidence: DETECTION.EXTENSION,
      });
    });

    it('an SVG by its root, past a BOM, a declaration, comments and a doctype', () => {
      const head = Buffer.from(
        '﻿<?xml version="1.0"?>\n<!-- drawn by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>',
      );

      expect(converter.detect('upload', head)).toEqual({
        format: 'svg',
        confidence: DETECTION.CONTENT_SPECIFIC,
      });
    });

    it('nothing else', () => {
      expect(converter.detect('notes.xml', Buffer.from('<notes/>'))).toBeNull();
      expect(converter.detect('upload', Buffer.from('{}'))).toBeNull();
    });
  });

  describe('PNG → JPEG', () => {
    it('lays transparency on white by default, at quality 80', async () => {
      const output = await convert(await png(), 'png', 'jpeg');

      expect(output).toMatchObject({
        mimeType: 'image/jpeg',
        extension: 'jpeg',
      });

      const meta = await sharp(output.data).metadata();
      const [r, g, b] = await sharp(output.data).raw().toBuffer();

      expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual([
        'jpeg',
        8,
        4,
        false,
      ]);
      // Half-transparent blue over white.
      expect(r).toBeGreaterThan(110);
      expect(b).toBeGreaterThan(240);
      expect(g).toBeGreaterThan(110);
    });

    it('on the background asked for, at the quality asked for', async () => {
      const source = await png(64, 64);
      const low = await convert(source, 'png', 'jpeg', {
        quality: 5,
        background: '#000000',
      });
      const high = await convert(source, 'png', 'jpeg', { quality: 100 });
      const [r, , b] = await sharp(low.data).raw().toBuffer();

      expect(r).toBeLessThan(20);
      expect(b).toBeGreaterThan(100);
      expect(b).toBeLessThan(150);
      expect(low.data.length).toBeLessThan(high.data.length);
    });
  });

  describe('JPEG → PNG', () => {
    it('converts, upright, without the camera metadata', async () => {
      const output = await convert(await jpeg(6), 'jpeg', 'png');
      const meta = await sharp(output.data).metadata();

      expect(output).toMatchObject({ mimeType: 'image/png', extension: 'png' });
      // Orientation 6 is a quarter turn: 8 × 4 stored, 4 × 8 seen.
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 4, 8]);
      expect(meta.orientation).toBeUndefined();
      expect(meta.exif).toBeUndefined();
    });
  });

  describe('SVG → raster', () => {
    it('at its own size, on white, by default', async () => {
      const output = await convert(svg(), 'svg', 'png');
      const meta = await sharp(output.data).metadata();
      const [r, g, b, a] = await sharp(output.data)
        .ensureAlpha()
        .raw()
        .toBuffer();

      expect([meta.width, meta.height]).toEqual([100, 50]);
      expect([r, g, b, a]).toEqual([255, 255, 255, 255]);
    });

    it('transparent when asked, for PNG', async () => {
      const output = await convert(svg(), 'svg', 'png', {
        background: 'transparent',
      });
      const [, , , a] = await sharp(output.data).ensureAlpha().raw().toBuffer();

      expect(a).toBe(0);
    });

    it('scales the other side when one is given', async () => {
      const wide = await convert(svg(), 'svg', 'png', { width: 400 });
      const tall = await convert(svg(), 'svg', 'jpeg', { height: 25 });

      expect(await size(wide.data)).toEqual([400, 200]);
      expect(await size(tall.data)).toEqual([50, 25]);
    });

    it('fits the drawing inside both when both are given', async () => {
      const output = await convert(svg(), 'svg', 'png', {
        width: 300,
        height: 300,
        background: '#00ff00',
      });

      expect(await size(output.data)).toEqual([300, 300]);
      // The top edge is letterbox: the drawing (2:1) is centred vertically.
      const [r, g, b] = await sharp(output.data).raw().toBuffer();

      expect([r, g, b]).toEqual([0, 255, 0]);
    });

    it('renders vectors at the size asked, not small and stretched', async () => {
      const output = await convert(
        svg(
          'viewBox="0 0 10 10"',
          '<circle cx="5" cy="5" r="5" fill="black"/>',
        ),
        'svg',
        'png',
        { width: 1000 },
      );
      const { data, info } = await sharp(output.data)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const row = data.subarray(500 * info.width, 501 * info.width);
      const edges = [...row].filter((value) => value > 10 && value < 245);

      // A sharp edge is a pixel or two of anti-aliasing on each side; a 10px
      // render blown up 100× would smear it over a hundred.
      expect(edges.length).toBeLessThan(10);
    });

    it('refuses a result over the size limits, before rendering it', async () => {
      const error = await refusal(
        convert(svg('width="5000" height="10"'), 'svg', 'png'),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.IMAGE_TOO_LARGE,
        httpStatus: 400,
        details: { width: 5000, height: 10, maxWidth: 2000, maxHeight: 2000 },
      });
    });

    it('refuses a result over the pixel limit', async () => {
      const error = await refusal(
        convert(svg(), 'svg', 'png', { width: 2000, height: 2000 }),
      );

      expect(error.code).toBe(ERROR_CODES.IMAGE_TOO_LARGE);
      expect(error.message).toMatch(/2000 × 2000, more than 2000000 pixels/);
    });

    it('refuses an unsafe SVG before the renderer sees it', async () => {
      const error = await refusal(
        convert(
          svg(undefined, '<image href="file:///etc/passwd"/>'),
          'svg',
          'png',
        ),
      );

      expect(error.code).toBe(ERROR_CODES.UNSAFE_SOURCE);
    });

    it('refuses an SVG that is not UTF-8', async () => {
      const error = await refusal(
        convert(Buffer.from([0xff, 0xfe, 0x3c, 0x00]), 'svg', 'png'),
      );

      expect(error).toMatchObject({ code: ERROR_CODES.INVALID_SOURCE });
      expect(error.message).toMatch(/UTF-16/);
    });

    it('refuses an SVG with nothing to measure', async () => {
      const error = await refusal(
        convert(svg('width="0" height="0"', ''), 'svg', 'png'),
      );

      expect(error.code).toBe(ERROR_CODES.INVALID_SOURCE);
    });
  });

  describe('refusals', () => {
    it('a decompression bomb, from its header, before decoding', async () => {
      // 1500 × 1500 is 2.25 MP against a 2 MP limit: refused on the header.
      const error = await refusal(
        convert(await png(1500, 1500), 'png', 'jpeg'),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.IMAGE_TOO_LARGE,
        httpStatus: 400,
        details: { width: 1500, height: 1500, maxPixels: 2_000_000 },
      });
    });

    it('a file that is not the image it claims to be', async () => {
      const error = await refusal(
        convert(Buffer.from('not a png at all'), 'png', 'jpeg'),
      );

      expect(error.code).toBe(ERROR_CODES.INVALID_SOURCE);
      expect(error.message).toMatch(/^The file is not a valid PNG: /);
    });

    it('a truncated image', async () => {
      const whole = await png(64, 64);
      const error = await refusal(
        convert(whole.subarray(0, whole.length / 2), 'png', 'jpeg'),
      );

      expect(error.code).toBe(ERROR_CODES.INVALID_SOURCE);
    });

    it('a direction it does not do', async () => {
      const error = await refusal(convert(await png(), 'png', 'svg'));

      expect(error).toMatchObject({
        code: ERROR_CODES.UNSUPPORTED_CONVERSION,
        httpStatus: 400,
      });
    });

    it('options that do not apply, through checkOptions and convert alike', async () => {
      expect(() =>
        converter.checkOptions('jpeg', 'png', { quality: 80 }),
      ).toThrow(AppError);
      expect(() =>
        converter.checkOptions('svg', 'png', { width: 10 }),
      ).not.toThrow();

      const error = await refusal(
        convert(await jpeg(), 'jpeg', 'png', { quality: 80 }),
      );

      expect(error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    /** The deadline is the converter's own, whatever sharp is doing. */
    it('a conversion past its deadline, as a 422', async () => {
      jest
        .spyOn(
          converter as unknown as { render: () => Promise<Buffer> },
          'render',
        )
        .mockReturnValue(new Promise<Buffer>(() => undefined));

      const error = await refusal(convert(svg(), 'svg', 'png', {}, 20));

      expect(error).toMatchObject({
        code: ERROR_CODES.CONVERSION_TIMEOUT,
        httpStatus: 422,
      });
    });

    it.each([
      ['timeout: 12% complete', ERROR_CODES.CONVERSION_TIMEOUT, 422],
      ['Input image exceeds pixel limit', ERROR_CODES.IMAGE_TOO_LARGE, 400],
      [
        'VipsJpeg: Premature end of input file',
        ERROR_CODES.INVALID_SOURCE,
        400,
      ],
    ])("sharp's %j as %s", async (message, code, status) => {
      jest
        .spyOn(
          converter as unknown as { render: () => Promise<Buffer> },
          'render',
        )
        .mockRejectedValue(new Error(message));

      const error = await refusal(convert(await png(), 'png', 'jpeg'));

      expect(error).toMatchObject({ code, httpStatus: status });
    });

    it('something thrown that is not an Error', async () => {
      jest
        .spyOn(
          converter as unknown as { render: () => Promise<Buffer> },
          'render',
        )
        .mockRejectedValue('odd');

      const error = await refusal(convert(await png(), 'png', 'jpeg'));

      expect(error.message).toBe('The file is not a valid PNG: odd');
    });
  });

  async function size(data: Buffer): Promise<[number?, number?]> {
    const meta = await sharp(data).metadata();

    return [meta.width, meta.height];
  }
});
