import { parentPort, workerData } from 'node:worker_threads';

import { transform, type TransformRequest } from './data-transform';

/**
 * Worker-thread entry: one conversion, one answer, exit. Started by
 * `WorkerRunner` from the compiled `.js` beside this file.
 */
const result = transform(workerData as TransformRequest);

// The result's bytes are moved to the main thread, not copied.
parentPort!.postMessage(
  result,
  result.ok ? [result.data.buffer as ArrayBuffer] : [],
);
