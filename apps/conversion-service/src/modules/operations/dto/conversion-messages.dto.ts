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
  ValidateNested,
} from 'class-validator';

import {
  CONVERSION_HISTORY_LIMITS,
  type ConversionHistoryRequest,
  type ConversionOperationRequest,
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

  @IsString()
  @MaxLength(128)
  correlationId: string;
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
