import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateNested,
} from 'class-validator';

import { FormatFamily } from '@contracts/enums/conversion.enums';
import {
  CONVERSION_HISTORY_LIMITS,
  CONVERSION_OPTIONS_LIMITS,
  type ConversionFormatsRequest,
  type ConversionHistoryRequest,
  type ConversionOperationRequest,
  type ConversionOptions,
  type ConvertFileRequest,
} from '@contracts/messages/conversion.messages';
import { STORAGE_DRIVERS } from '@storage/file-storage';

/** Lower-case word, as the formats are named; length bounds the column. */
export const FORMAT_ID = /^[a-z0-9]{1,16}$/;

class UploadedSourceDto {
  @IsIn(['uploads'])
  bucket: 'uploads';

  @IsString()
  @MaxLength(512)
  key: string;

  @IsIn([...STORAGE_DRIVERS])
  driver: string;

  @IsString()
  @MaxLength(1024)
  name: string;

  @IsInt()
  @Min(0)
  size: number;
}

export class ConvertFileMessageDto implements ConvertFileRequest {
  @IsUUID()
  operationId: string;

  @IsUUID()
  userId: string;

  @ValidateNested()
  @Type(() => UploadedSourceDto)
  source: UploadedSourceDto;

  @IsString()
  @Matches(FORMAT_ID)
  targetFormat: string;

  @IsBoolean()
  save: boolean;

  @IsOptional()
  @IsConversionOptions()
  options?: ConversionOptions;

  @IsOptional()
  @IsIn(Object.values(FormatFamily))
  family?: string;

  @IsString()
  @MaxLength(128)
  correlationId: string;
}

export class ConversionFormatsMessageDto implements ConversionFormatsRequest {
  @IsOptional()
  @IsIn(Object.values(FormatFamily))
  family?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  correlationId?: string;
}

/**
 * A flat object of short primitives, within `CONVERSION_OPTIONS_LIMITS`.
 * What the options *mean* is the converter's to check; this only keeps the
 * shape small and storable.
 */
function IsConversionOptions(): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'isConversionOptions',
      target: target.constructor,
      propertyName: propertyName as string,
      validator: {
        validate: (value: unknown) => isConversionOptions(value),
        defaultMessage: () =>
          `options must be an object of at most ${CONVERSION_OPTIONS_LIMITS.keys} short strings, numbers or booleans`,
      },
    });
}

export function isConversionOptions(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const entries = Object.entries(value);

  return (
    entries.length <= CONVERSION_OPTIONS_LIMITS.keys &&
    entries.every(
      ([key, item]) =>
        key.length > 0 &&
        key.length <= CONVERSION_OPTIONS_LIMITS.keyLength &&
        (typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item)) ||
          (typeof item === 'string' &&
            item.length <= CONVERSION_OPTIONS_LIMITS.valueLength)),
    )
  );
}

export class ConversionHistoryMessageDto implements ConversionHistoryRequest {
  @IsUUID()
  userId: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CONVERSION_HISTORY_LIMITS.max)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  correlationId?: string;
}

export class ConversionOperationMessageDto implements ConversionOperationRequest {
  @IsUUID()
  userId: string;

  @IsUUID()
  operationId: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  correlationId?: string;
}
