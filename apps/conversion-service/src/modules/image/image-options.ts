import type { ConversionOptions } from '@contracts/messages/conversion.messages';
import { invalidOptions } from '../converters/file-converter';

export interface ImageOptions {
  /** JPEG only, 1–100. */
  quality?: number;
  /** SVG sources only: the size to rasterise to. */
  width?: number;
  height?: number;
  /** Whatever transparency becomes — `#rgb[a]`, `#rrggbb[aa]`, or `transparent` for PNG. */
  background?: string;
}

export interface ImageSizeLimits {
  maxWidth: number;
  maxHeight: number;
}

const HEX_COLOUR = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The options, checked against the direction they are for. An option that
 * does not apply is refused, not ignored: a client sending `quality` for a
 * PNG believes it changed something, and should be told it did not.
 *
 * - `quality` — only when the result is a JPEG;
 * - `width`, `height` — only when the source is an SVG (raster images are
 *   converted, not resized);
 * - `background` — wherever transparency has to become a colour: SVG
 *   rasterised to either format, or a PNG with alpha written as JPEG.
 *
 * Values arrive as numbers from the JSON `options` field and as strings from
 * the flat form fields; both are accepted.
 */
export function readImageOptions(
  source: string,
  target: string,
  raw: ConversionOptions,
  limits: ImageSizeLimits,
): ImageOptions {
  const errors: string[] = [];
  const options: ImageOptions = {};

  for (const [name, value] of Object.entries(raw)) {
    switch (name) {
      case 'quality':
        if (target !== 'jpeg') {
          errors.push('quality applies only when the target is jpeg');
        } else {
          options.quality = integer(name, value, 1, 100, errors);
        }
        break;

      case 'width':
      case 'height':
        if (source !== 'svg') {
          errors.push(`${name} applies only when the source is svg`);
        } else {
          options[name] = integer(
            name,
            value,
            1,
            name === 'width' ? limits.maxWidth : limits.maxHeight,
            errors,
          );
        }
        break;

      case 'background':
        if (source !== 'svg' && !(source === 'png' && target === 'jpeg')) {
          errors.push(
            'background applies only to an svg source, or to png → jpeg',
          );
        } else {
          options.background = colour(value, target, errors);
        }
        break;

      default:
        errors.push(`${name} is not an option for ${source} → ${target}`);
    }
  }

  if (errors.length > 0) {
    throw invalidOptions(errors);
  }

  return options;
}

function integer(
  name: string,
  value: string | number | boolean,
  min: number,
  max: number,
  errors: string[],
): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;

  if (!Number.isInteger(number) || number < min || number > max) {
    errors.push(`${name} must be a whole number from ${min} to ${max}`);

    return undefined;
  }

  return number;
}

function colour(
  value: string | number | boolean,
  target: string,
  errors: string[],
): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';

  if (text.toLowerCase() === 'transparent') {
    if (target === 'jpeg') {
      errors.push('background cannot be transparent: JPEG has no transparency');

      return undefined;
    }

    return 'transparent';
  }

  if (!HEX_COLOUR.test(text)) {
    errors.push(
      'background must be a hex colour (#fff, #ffffff, #ffffff80) or transparent',
    );

    return undefined;
  }

  return text;
}
