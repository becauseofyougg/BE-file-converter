import { Injectable } from '@nestjs/common';
import { Worker } from 'node:worker_threads';

export interface WorkerLimits {
  timeoutMs: number;
  /** Heap the worker may use before it is killed. */
  maxMemoryMb: number;
}

/** The work did not finish in time; the thread has been terminated. */
export class WorkerTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Gave up after ${timeoutMs} ms`);
    this.name = WorkerTimeoutError.name;
  }
}

/** The work wanted more memory than it was given; the thread is gone. */
export class WorkerMemoryError extends Error {
  constructor() {
    super('Ran out of the memory it was allowed');
    this.name = WorkerMemoryError.name;
  }
}

/**
 * Runs a piece of work on its own thread, one thread per run.
 *
 * Two reasons it is not done on the main thread. Parsing a file is CPU work,
 * and the main thread is also the one answering the broker and `/health`.
 * And a thread can be *stopped*: `terminate()` ends a parse that is taking too
 * long, and the heap limit ends one that is growing too large — neither of
 * which can be done to code running inline. The cost is a thread start per
 * conversion, a few tens of milliseconds.
 */
@Injectable()
export class WorkerRunner {
  run<T>(
    entry: string,
    data: unknown,
    limits: WorkerLimits,
    options: { eval?: boolean } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const worker = new Worker(entry, {
        eval: options.eval,
        workerData: data,
        resourceLimits: { maxOldGenerationSizeMb: limits.maxMemoryMb },
      });

      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        outcome();
        void worker.terminate();
      };

      const timer = setTimeout(
        () => settle(() => reject(new WorkerTimeoutError(limits.timeoutMs))),
        limits.timeoutMs,
      );

      worker.once('message', (message: T) => settle(() => resolve(message)));

      worker.once('error', (error: Error & { code?: string }) =>
        settle(() =>
          reject(
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? new WorkerMemoryError()
              : error,
          ),
        ),
      );

      worker.once('exit', (code) =>
        settle(() =>
          reject(
            new Error(`The worker exited with code ${code} before answering`),
          ),
        ),
      );
    });
  }
}
