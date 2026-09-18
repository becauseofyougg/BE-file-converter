import { FormatFamily } from '../enums/conversion.enums';

/**
 * Commands consumed by conversion-service. Delivered to the work queue of the
 * source format's family; `jobId` doubles as the message id, which is what
 * makes a redelivered command harmless.
 */
export const CONVERSION_PATTERNS = {
  CONVERT: 'conversion.convert',
  CANCEL: 'conversion.cancel',
} as const;

export interface ConvertCommand {
  jobId: string;
  userId: string;
  family: FormatFamily;
  sourceFormat: string;
  targetFormat: string;
  sourceKey: string;
  sourceSize: number;
  options?: Record<string, unknown>;
  attempt: number;
  correlationId: string;
}

export interface CancelCommand {
  jobId: string;
  correlationId: string;
}
