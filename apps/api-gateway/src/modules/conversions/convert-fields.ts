import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  validateSync,
  type ValidationArguments,
  type ValidationError,
} from 'class-validator';

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

/** A form value that is not a JSON object: kept, so the validator can say so. */
const NOT_JSON = Symbol('not JSON');

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The fields of `POST /api/convert`, checked by class-validator like every
 * other input — they only arrive differently, as multipart text, which is
 * why the transforms turn `"true"` and `"512"` into what they mean first.
 */
export class ConvertFieldsDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString({ message: 'targetFormat must be a format name, such as "json"' })
  @Matches(FORMAT_ID, {
    message: 'targetFormat must be a format name, such as "json"',
  })
  targetFormat: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';

    return text === 'true' || text === '1'
      ? true
      : text === 'false' || text === '0'
        ? false
        : value;
  })
  @IsBoolean({ message: 'save must be true or false' })
  save?: boolean;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return NOT_JSON;
    }

    try {
      // `null` too is "not an object" — and must not read as "absent", which
      // is what `@IsOptional` makes of it.
      return (JSON.parse(value) as unknown) ?? NOT_JSON;
    } catch {
      return NOT_JSON;
    }
  })
  @IsConversionOptions()
  options?: ConversionOptions;
}

/**
 * `/api/images/convert` also takes the options as separate fields. Their
 * shape is checked here; what is in range for which direction — `quality`
 * for a JPEG, `width` up to the configured maximum — is the converter's.
 */
export class ImageConvertFieldsDto extends ConvertFieldsDto {
  @IsOptional()
  @Transform(numeric)
  @IsInt({ message: 'quality must be a whole number' })
  @Min(1)
  @Max(100)
  quality?: number;

  @IsOptional()
  @Transform(numeric)
  @IsInt({ message: 'width must be a whole number' })
  @Min(1)
  width?: number;

  @IsOptional()
  @Transform(numeric)
  @IsInt({ message: 'height must be a whole number' })
  @Min(1)
  height?: number;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(CONVERSION_OPTIONS_LIMITS.valueLength)
  background?: string;
}

/**
 * Validates the form against the route's DTO. Unknown fields are refused,
 * as on every JSON route. Options come either as one `options` field
 * holding a JSON object, or — on a route that allows it — as separate
 * fields. Not both: which one would win is not something a client should
 * have to guess.
 */
export function parseFields(
  fields: Record<string, string>,
  route: ConvertRoute = {},
): ConvertFields {
  const flat = route.flatOptions ?? [];
  const dto = plainToInstance(
    flat.length > 0 ? ImageConvertFieldsDto : ConvertFieldsDto,
    fields,
  );
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  if (errors.length > 0) {
    throw invalid(messagesOf(errors));
  }

  const record = dto as unknown as Record<string, string | number | undefined>;
  const separate = flat.filter((name) => record[name] !== undefined);

  if (separate.length > 0 && dto.options !== undefined) {
    throw invalid([
      `send options either as the options field or as separate fields (${separate.join(', ')}), not both`,
    ]);
  }

  const options =
    dto.options ??
    (separate.length > 0
      ? (Object.fromEntries(
          separate.map((name) => [name, record[name]]),
        ) as ConversionOptions)
      : undefined);

  return {
    targetFormat: dto.targetFormat,
    save: dto.save ?? false,
    ...(options ? { options } : {}),
  };
}

/** A form field is always text; an all-digit one is the number it says. */
function numeric({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^\d{1,9}$/.test(value.trim())
    ? Number(value.trim())
    : value;
}

/**
 * A flat JSON object of short primitives, within `CONVERSION_OPTIONS_LIMITS`.
 * What the options *mean* is conversion-service's to check; here only their
 * shape, so what crosses the broker and lands in the history is bounded.
 */
function IsConversionOptions(): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'isConversionOptions',
      target: target.constructor,
      propertyName: propertyName as string,
      validator: {
        validate: (value: unknown) => optionsProblem(value) === null,
        defaultMessage: (args: ValidationArguments) =>
          optionsProblem(args.value) ?? '',
      },
    });
}

function optionsProblem(value: unknown): string | null {
  if (
    value === NOT_JSON ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return 'options must be a JSON object, such as {"quality":80}';
  }

  const entries = Object.entries(value);

  if (entries.length > CONVERSION_OPTIONS_LIMITS.keys) {
    return `options may have at most ${CONVERSION_OPTIONS_LIMITS.keys} keys`;
  }

  const bad = entries
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
    .map(([key]) => `options.${key}`);

  return bad.length > 0
    ? `${bad.join(', ')}: each option must be a short string, a number or a boolean, under a short name`
    : null;
}

function messagesOf(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

function invalid(details: string[]): AppError {
  return new AppError(
    ERROR_CODES.VALIDATION_FAILED,
    'Validation failed',
    400,
    details,
  );
}
