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
  /** One user's finished conversions, filtered and paged — docs/TRANSFORMATION-HISTORY.md. */
  TRANSFORMATIONS: 'conversion.rpc.transformations',
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

/**
 * Per-conversion settings, opaque to everything but the converter that
 * reads them — `{ quality: 80 }` for a JPEG, nothing for CSV. Kept a flat bag
 * of primitives so a new module's options are a new key, not a new type here.
 * The converter validates them and refuses what it does not know.
 */
export type ConversionOptions = Record<string, string | number | boolean>;

/** Bounds on the bag, checked at both ends of the wire. */
export const CONVERSION_OPTIONS_LIMITS = {
  keys: 16,
  keyLength: 32,
  valueLength: 64,
} as const;

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
  options?: ConversionOptions;
  /**
   * Only this family's formats, in and out — what a family's own route
   * (`/api/images/convert`) sends. Absent: every registered format.
   */
  family?: string;
  correlationId: string;
}

export interface ConversionFormatsRequest {
  /** Only this family's directions. Absent: all of them. */
  family?: string;
  correlationId?: string;
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
  /** What the conversion was asked to do beyond the formats; `null` for nothing. */
  options: ConversionOptions | null;
  /** The user asked to keep the result. */
  saved: boolean;
  /** The result can still be downloaded from the history. */
  resultAvailable: boolean;
  error: { code: string; message: string } | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/**
 * What kind of transformation, as the history shows it. Every family that
 * is not images is `file`: the spec knows these two, and a new family is
 * one more line in `transformationType`, not a new value here.
 */
export const TRANSFORMATION_TYPES = ['file', 'image'] as const;
export type TransformationType = (typeof TRANSFORMATION_TYPES)[number];

/** Finished transformations only; one still running is not history yet. */
export const TRANSFORMATION_STATUSES = ['success', 'error'] as const;
export type TransformationStatus = (typeof TRANSFORMATION_STATUSES)[number];

/**
 * The right to read **another** user's transformation history. One's own
 * needs only a session. Created and granted to ADMIN by identity's migration
 * `20261012130000_transformations_permission`.
 */
export const TRANSFORMATIONS_READ_PERMISSION = {
  resource: 'transformations',
  action: 'read',
} as const;

export function transformationType(family: string): TransformationType {
  return family === 'image' ? 'image' : 'file';
}

export interface TransformationHistoryFilters {
  type?: TransformationType;
  sourceFormat?: string;
  targetFormat?: string;
  status?: TransformationStatus;
  /** ISO 8601, inclusive. */
  createdAtFrom?: string;
  /** ISO 8601, inclusive. */
  createdAtTo?: string;
}

export interface TransformationHistoryRequest extends TransformationHistoryFilters {
  /** Whose history: the caller's own, or — for an administrator — anyone's. */
  userId: string;
  cursor?: string;
  limit?: number;
  correlationId?: string;
}

/**
 * One finished transformation, as the spec fixes it. Nothing personal and
 * nothing about the content: no file name, no checksum, no storage key —
 * an administrator reading someone's history learns what was converted and
 * how it went, not what it was.
 */
export interface TransformationHistoryItem {
  id: string;
  type: TransformationType;
  /** `null` when the file was not recognised as any format. */
  sourceFormat: string | null;
  targetFormat: string;
  status: TransformationStatus;
  /** Bytes of the source. */
  fileSize: number;
  durationMs: number;
  errorCode?: string;
  /** A saved result can be downloaded: `GET /api/convert/history/:id/download`. */
  resultAvailable: boolean;
  createdAt: string;
}

export interface TransformationHistoryPage {
  items: TransformationHistoryItem[];
  nextCursor: string | null;
}

export interface ConversionOperationRequest {
  userId: string;
  operationId: string;
  correlationId?: string;
}

export const CONVERSION_HISTORY_LIMITS = { default: 20, max: 100 } as const;
