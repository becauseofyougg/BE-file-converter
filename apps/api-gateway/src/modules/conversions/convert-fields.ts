import { AppError } from '@core/errors/app-error';
import {
  CONVERSION_OPTIONS_LIMITS,
  type ConversionOptions,
} from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';

/** Lower-case word, as the formats are named. */
const FORMAT_ID = /^[a-z0-9]{1,16}$/;

/**
 * What a convert route accepts beyond the file: which family it is held to,
 * and which options it also takes as separate form fields.
 */
export interface ConvertRoute {
  family?: string;
  /** `/api/images/convert` takes `quality=80` as well as `options={"quality":80}`. */
  flatOptions?: readonly string[];
}

export interface ConvertFields {
  targetFormat: string;
  save: boolean;
  options?: ConversionOptions;
}

/**
 * The form fields, checked by hand: they arrive as multipart text, past the
 * reach of the `ValidationPipe`. Unknown fields are refused, as they are on
 * every JSON route.
 *
 * Options come either as one `options` field holding a JSON object, or — on
 * a route that allows it — as separate fields. Not both: which one would
 * win is not something a client should have to guess. What the options mean
 * is conversion-service's to check; here only their shape is.
 */
export function parseFields(
  fields: Record<string, string>,
  route: ConvertRoute = {},
): ConvertFields {
  const flat = route.flatOptions ?? [];
  const known = ['targetFormat', 'save', 'options', ...flat];
  const unknown = Object.keys(fields).filter((name) => !known.includes(name));

  if (unknown.length > 0) {
    throw invalid(unknown.map((name) => `property ${name} should not exist`));
  }

  const targetFormat = (fields.targetFormat ?? '').trim().toLowerCase();

  if (!FORMAT_ID.test(targetFormat)) {
    throw invalid(['targetFormat must be a format name, such as "json"']);
  }

  const save = (fields.save ?? 'false').trim().toLowerCase();

  if (!['true', 'false', '1', '0'].includes(save)) {
    throw invalid(['save must be true or false']);
  }

  const separate = flat.filter((name) => fields[name] !== undefined);

  if (separate.length > 0 && fields.options !== undefined) {
    throw invalid([
      `send options either as the options field or as separate fields (${separate.join(', ')}), not both`,
    ]);
  }

  const options =
    fields.options !== undefined
      ? parseOptions(fields.options)
      : separate.length > 0
        ? Object.fromEntries(
            separate.map((name) => [name, formValue(fields[name])]),
          )
        : undefined;

  return {
    targetFormat,
    save: save === 'true' || save === '1',
    ...(options ? { options } : {}),
  };
}

/**
 * A form field is always text; one that is all digits is sent on as the
 * number it is, so `width=512` and `{"width":512}` arrive — and are kept in
 * the history — the same way.
 */
function formValue(raw: string): string | number {
  const value = raw.trim();

  return /^\d{1,9}$/.test(value) ? Number(value) : value;
}

function parseOptions(text: string): ConversionOptions {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw invalid(['options must be a JSON object, such as {"quality":80}']);
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(['options must be a JSON object, such as {"quality":80}']);
  }

  const entries = Object.entries(value);

  if (entries.length > CONVERSION_OPTIONS_LIMITS.keys) {
    throw invalid([
      `options may have at most ${CONVERSION_OPTIONS_LIMITS.keys} keys`,
    ]);
  }

  const errors = entries
    .filter(
      ([key, item]) =>
        key.length === 0 ||
        key.length > CONVERSION_OPTIONS_LIMITS.keyLength ||
        !(
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item)) ||
          (typeof item === 'string' &&
            item.length <= CONVERSION_OPTIONS_LIMITS.valueLength)
        ),
    )
    .map(
      ([key]) => `options.${key} must be a short string, a number or a boolean`,
    );

  if (errors.length > 0) {
    throw invalid(errors);
  }

  return value as ConversionOptions;
}

function invalid(details: string[]): AppError {
  return new AppError(
    ERROR_CODES.VALIDATION_FAILED,
    'Validation failed',
    400,
    details,
  );
}
