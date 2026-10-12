import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  CONVERSION_HISTORY_LIMITS,
  TRANSFORMATION_STATUSES,
  TRANSFORMATION_TYPES,
  type TransformationHistoryFilters,
  type TransformationStatus,
  type TransformationType,
} from '@contracts/messages/conversion.messages';

const FORMAT = /^[a-z0-9]{1,16}$/;

const lowerCase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Shapes only. Whether a format exists is conversion-service's to say — it
 * knows the registered converters — and it answers an unknown one with a 400
 * naming the known ones.
 */
export class TransformationHistoryQueryDto implements TransformationHistoryFilters {
  @ApiPropertyOptional({
    description: '`nextCursor` from the previous page. Opaque.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: CONVERSION_HISTORY_LIMITS.max,
    default: CONVERSION_HISTORY_LIMITS.default,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONVERSION_HISTORY_LIMITS.max)
  limit?: number;

  @ApiPropertyOptional({ enum: TRANSFORMATION_TYPES })
  @IsOptional()
  @Transform(lowerCase)
  @IsIn([...TRANSFORMATION_TYPES])
  type?: TransformationType;

  @ApiPropertyOptional({
    example: 'csv',
    description:
      'csv, json, xml, yaml, png, jpeg, svg — any format `GET /api/convert/formats` names.',
  })
  @IsOptional()
  @Transform(lowerCase)
  @IsString()
  @Matches(FORMAT, {
    message: 'sourceFormat must be a format name, such as "csv"',
  })
  sourceFormat?: string;

  @ApiPropertyOptional({ example: 'json' })
  @IsOptional()
  @Transform(lowerCase)
  @IsString()
  @Matches(FORMAT, {
    message: 'targetFormat must be a format name, such as "json"',
  })
  targetFormat?: string;

  @ApiPropertyOptional({ enum: TRANSFORMATION_STATUSES })
  @IsOptional()
  @Transform(lowerCase)
  @IsIn([...TRANSFORMATION_STATUSES])
  status?: TransformationStatus;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-10-01T00:00:00Z',
    description: 'Inclusive.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  createdAtFrom?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-10-31T23:59:59Z',
    description: 'Inclusive.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  createdAtTo?: string;
}

export class TransformationUserParamsDto {
  @ApiProperty({ format: 'uuid', description: 'Whose history.' })
  @IsUUID()
  userId: string;
}

/** A malformed id is a 400, never a lookup. */
export class TransformationItemParamsDto {
  @ApiProperty({ format: 'uuid', description: 'The history entry.' })
  @IsUUID()
  itemId: string;
}

export class AdminTransformationItemParamsDto extends TransformationUserParamsDto {
  @ApiProperty({ format: 'uuid', description: 'The history entry.' })
  @IsUUID()
  itemId: string;
}

/* ---- response shapes, for the OpenAPI document ---- */

export class TransformationHistoryItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: TRANSFORMATION_TYPES })
  type: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'csv',
    description: 'Null when the file was not recognised as any format.',
  })
  sourceFormat: string | null;

  @ApiProperty({ example: 'json' })
  targetFormat: string;

  @ApiProperty({ enum: TRANSFORMATION_STATUSES })
  status: string;

  @ApiProperty({ example: 1024, description: 'Bytes of the source.' })
  fileSize: number;

  @ApiProperty({ example: 41 })
  durationMs: number;

  @ApiPropertyOptional({
    example: 'INVALID_SOURCE',
    description: 'Only when `status` is `error`.',
  })
  errorCode?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The saved file, while it can be downloaded — `GET …/history/{id}/download`. Null when the result was not saved, or its time has passed.',
  })
  fileId: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class TransformationHistoryPageDto {
  @ApiProperty({ type: [TransformationHistoryItemDto] })
  items: TransformationHistoryItemDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
