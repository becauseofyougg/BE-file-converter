/**
 * Job state machine — see ARCHITECTURE.md §5.1.
 */
export enum JobStatus {
  PENDING = 'PENDING',
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  RETRYING = 'RETRYING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
  JobStatus.EXPIRED,
];

/**
 * Routes a job to the queue — and therefore to the deployment — that owns the
 * binaries for it. A video conversion must not sit behind a thumbnail resize.
 */
export enum FormatFamily {
  IMAGE = 'image',
  DOCUMENT = 'document',
  AV = 'av',
  DATA = 'data',
}

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}
