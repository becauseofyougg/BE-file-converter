import { AppError } from '@core/errors/app-error';
import type { ConversionOptions } from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { readImageOptions } from './image-options';

const LIMITS = { maxWidth: 4000, maxHeight: 3000 };

const read = (source: string, target: string, raw: ConversionOptions) =>
  readImageOptions(source, target, raw, LIMITS);

function errors(source: string, target: string, raw: ConversionOptions) {
  try {
    read(source, target, raw);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: ERROR_CODES.VALIDATION_FAILED,
      httpStatus: 400,
    });

    return (error as AppError & { details: { errors: string[] } }).details
      .errors;
  }

  throw new Error('expected a refusal');
}

describe('readImageOptions', () => {
  it('takes none at all', () => {
    expect(read('png', 'jpeg', {})).toEqual({});
  });

  it('reads quality for a JPEG result, from a number or a numeric string', () => {
    expect(read('png', 'jpeg', { quality: 70 })).toEqual({ quality: 70 });
    expect(read('svg', 'jpeg', { quality: ' 100 ' })).toEqual({
      quality: 100,
    });
  });

  it('reads the size for an SVG source, within the limits', () => {
    expect(read('svg', 'png', { width: '4000', height: 3000 })).toEqual({
      width: 4000,
      height: 3000,
    });
  });

  it('reads a background where transparency has to become a colour', () => {
    expect(read('svg', 'png', { background: '#abc' })).toEqual({
      background: '#abc',
    });
    expect(read('svg', 'jpeg', { background: '#AABBCC80' })).toEqual({
      background: '#AABBCC80',
    });
    expect(read('png', 'jpeg', { background: '#000000' })).toEqual({
      background: '#000000',
    });
    expect(read('svg', 'png', { background: 'Transparent' })).toEqual({
      background: 'transparent',
    });
  });

  it.each<[string, string, ConversionOptions, string]>([
    [
      'png',
      'jpeg',
      { quality: 0 },
      'quality must be a whole number from 1 to 100',
    ],
    [
      'png',
      'jpeg',
      { quality: 101 },
      'quality must be a whole number from 1 to 100',
    ],
    [
      'png',
      'jpeg',
      { quality: 80.5 },
      'quality must be a whole number from 1 to 100',
    ],
    [
      'png',
      'jpeg',
      { quality: 'high' },
      'quality must be a whole number from 1 to 100',
    ],
    [
      'png',
      'jpeg',
      { quality: true },
      'quality must be a whole number from 1 to 100',
    ],
    [
      'svg',
      'png',
      { width: 4001 },
      'width must be a whole number from 1 to 4000',
    ],
    [
      'svg',
      'png',
      { height: 3001 },
      'height must be a whole number from 1 to 3000',
    ],
    [
      'svg',
      'png',
      { width: '-5' },
      'width must be a whole number from 1 to 4000',
    ],
    [
      'svg',
      'png',
      { background: 'red' },
      'background must be a hex colour (#fff, #ffffff, #ffffff80) or transparent',
    ],
    [
      'svg',
      'png',
      { background: '#ggg' },
      'background must be a hex colour (#fff, #ffffff, #ffffff80) or transparent',
    ],
    [
      'svg',
      'png',
      { background: 1 },
      'background must be a hex colour (#fff, #ffffff, #ffffff80) or transparent',
    ],
    [
      'svg',
      'jpeg',
      { background: 'transparent' },
      'background cannot be transparent: JPEG has no transparency',
    ],
  ])('refuses %s → %s %j', (source, target, raw, message) => {
    expect(errors(source, target, raw)).toEqual([message]);
  });

  /** Refused, not ignored: a client sending these believes they did something. */
  it.each<[string, string, ConversionOptions, string]>([
    [
      'jpeg',
      'png',
      { quality: 80 },
      'quality applies only when the target is jpeg',
    ],
    [
      'svg',
      'png',
      { quality: 80 },
      'quality applies only when the target is jpeg',
    ],
    [
      'png',
      'jpeg',
      { width: 100 },
      'width applies only when the source is svg',
    ],
    [
      'jpeg',
      'png',
      { height: 100 },
      'height applies only when the source is svg',
    ],
    [
      'jpeg',
      'png',
      { background: '#fff' },
      'background applies only to an svg source, or to png → jpeg',
    ],
    ['png', 'jpeg', { dpi: 300 }, 'dpi is not an option for png → jpeg'],
  ])(
    'refuses an option that does not apply: %s → %s %j',
    (source, target, raw, message) => {
      expect(errors(source, target, raw)).toEqual([message]);
    },
  );

  it('reports every problem at once', () => {
    expect(
      errors('png', 'jpeg', { quality: 0, width: 1, dpi: 2 }),
    ).toHaveLength(3);
  });
});
