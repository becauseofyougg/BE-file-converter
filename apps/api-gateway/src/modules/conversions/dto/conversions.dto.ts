import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { CONVERSION_OPERATION_STATUSES } from '@contracts/messages/conversion.messages';

/** A malformed id is a 400, never a lookup. */
export class ConversionParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  operationId: string;
}

/* ---- response shapes, for the OpenAPI document ---- */

export class ConversionFormatEntryDto {
  @ApiProperty({ example: 'csv' })
  source: string;

  @ApiProperty({ type: [String], example: ['json', 'xml', 'yaml'] })
  target: string[];
}

class OperationSourceDto {
  @ApiProperty({ example: 'users.csv' })
  name: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'csv',
    description: 'Null when the format was not recognised.',
  })
  format: string | null;

  @ApiProperty({ example: 1024 })
  size: number;

  @ApiProperty({ nullable: true, type: String, description: 'SHA-256, hex.' })
  checksum: string | null;
}

class OperationTargetDto {
  @ApiProperty({ example: 'json' })
  format: string;

  @ApiProperty({ nullable: true, type: Number })
  size: number | null;

  @ApiProperty({ nullable: true, type: String, description: 'SHA-256, hex.' })
  checksum: string | null;
}

class OperationErrorDto {
  @ApiProperty({ example: 'INVALID_SOURCE' })
  code: string;

  @ApiProperty()
  message: string;
}

export class ConversionOperationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: CONVERSION_OPERATION_STATUSES })
  status: string;

  @ApiProperty({ type: OperationSourceDto })
  source: OperationSourceDto;

  @ApiProperty({ type: OperationTargetDto })
  target: OperationTargetDto;

  @ApiProperty({
    type: Object,
    nullable: true,
    example: { quality: 80 },
    description: 'The options the conversion was asked for; null for none.',
  })
  options: Record<string, string | number | boolean> | null;

  @ApiProperty({ description: 'The user asked to keep the result.' })
  saved: boolean;

  @ApiProperty({
    description: 'The result can be downloaded from the history.',
  })
  resultAvailable: boolean;

  @ApiProperty({ type: OperationErrorDto, nullable: true })
  error: OperationErrorDto | null;

  @ApiProperty({ nullable: true, type: Number })
  durationMs: number | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  finishedAt: string | null;
}
