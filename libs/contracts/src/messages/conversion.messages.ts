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

/**
 * Request/response surface of conversion-service, on `conversion.rpc` — the
 * gateway asks, and waits for the answer. Distinct from the command queues
 * above, which take work and answer nothing.
 *
 * Nothing here names a format. Formats are strings, and which ones exist is
 * whatever the registered converters say at runtime: adding a format module
 * changes no type in this file.
 */
export const CONVERSION_RPC_PATTERNS = {
  /** Convert an uploaded file now and say where the result is. */
  CONVERT: 'conversion.rpc.convert',
  /** Every direction the registered converters can take. */
  FORMATS: 'conversion.rpc.formats',
  HISTORY_LIST: 'conversion.rpc.history.list',
  HISTORY_GET: 'conversion.rpc.history.get',
  /** Where a saved result is kept, for the gateway to stream it. */
  HISTORY_RESULT: 'conversion.rpc.history.result',
} as const;

export const CONVERSION_OPERATION_STATUSES = [
  'PROCESSING',
  'COMPLETED',
  'FAILED',
] as const;
export type ConversionOperationStatus =
  (typeof CONVERSION_OPERATION_STATUSES)[number];

/** A file in storage, and which storage: the driver is recorded, not assumed. */
export interface StoredFile {
  bucket: 'uploads' | 'results';
  key: string;
  driver: string;
}

export interface ConvertFileRequest {
  /** Chosen by the gateway, which already used it as the upload's key. */
  operationId: string;
  userId: string;
  source: StoredFile & {
    /** The client's filename — kept for the history, never used as a key. */
    name: string;
    size: number;
  };
  targetFormat: string;
  /** Keep the result in storage after this response. */
  save: boolean;
  correlationId: string;
}

/** What the gateway streams back to the client. */
export interface ConversionResultFile extends StoredFile {
  contentType: string;
  fileName: string;
  size: number;
}

export interface ConvertFileResponse {
  operation: ConversionOperationRecord;
  result: ConversionResultFile;
}

/** One entry of `GET /api/convert/formats`, in the shape the spec fixes. */
export interface ConversionFormatEntry {
  source: string;
  target: string[];
}

/**
 * One operation in a user's history: everything about the run except the
 * bytes and the storage keys.
 */
export interface ConversionOperationRecord {
  id: string;
  status: ConversionOperationStatus;
  source: {
    name: string;
    /** `null` when the format could not be recognised. */
    format: string | null;
    size: number;
    /** SHA-256 of what was uploaded. */
    checksum: string | null;
  };
  target: {
    format: string;
    size: number | null;
    checksum: string | null;
  };
  /** The user asked to keep the result. */
  saved: boolean;
  /** The result can still be downloaded from the history. */
  resultAvailable: boolean;
  error: { code: string; message: string } | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ConversionHistoryRequest {
  userId: string;
  cursor?: string;
  limit?: number;
  correlationId?: string;
}

export interface ConversionHistoryPage {
  items: ConversionOperationRecord[];
  nextCursor: string | null;
}

export interface ConversionOperationRequest {
  userId: string;
  operationId: string;
  correlationId?: string;
}

export const CONVERSION_HISTORY_LIMITS = { default: 20, max: 100 } as const;
