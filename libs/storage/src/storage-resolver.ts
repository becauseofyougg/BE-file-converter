import { Inject, Injectable } from '@nestjs/common';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';
import type { FileStorage, StorageDriverName } from './file-storage';
import { STORAGE_BACKENDS } from './storage.constants';

/**
 * Finds the storage a file was written to, by the driver name recorded with it.
 *
 * `FileStorage` is where *new* files go. A file written under the previous
 * driver is read back through this instead, so switching `STORAGE_DRIVER`
 * does not strand what is already stored — as long as the old driver is still
 * configured.
 */
@Injectable()
export class StorageResolver {
  constructor(
    @Inject(STORAGE_BACKENDS)
    private readonly backends: ReadonlyMap<StorageDriverName, FileStorage>,
  ) {}

  forDriver(driver: string): FileStorage {
    const storage = this.backends.get(driver as StorageDriverName);

    if (!storage) {
      throw new AppError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        `The file is kept in "${driver}" storage, which this deployment is not configured for`,
        503,
      );
    }

    return storage;
  }
}
