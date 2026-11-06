import {
  WorkerMemoryError,
  WorkerRunner,
  WorkerTimeoutError,
} from './worker-runner';

/**
 * Real threads, with the work given as source (`eval`) — what is under test
 * is the runner's handling of a thread, not any particular entry file.
 */
describe('WorkerRunner', () => {
  const runner = new WorkerRunner();
  const limits = { timeoutMs: 5_000, maxMemoryMb: 64 };
  const run = (source: string, data: unknown = null, overrides = {}) =>
    runner.run<unknown>(
      source,
      data,
      { ...limits, ...overrides },
      { eval: true },
    );

  it('resolves with what the worker posts, given its data', async () => {
    await expect(
      run(
        `const { parentPort, workerData } = require('node:worker_threads');
         parentPort.postMessage(workerData.n * 2);`,
        { n: 21 },
      ),
    ).resolves.toBe(42);
  });

  it('stops a worker that runs past the time limit', async () => {
    await expect(
      run('for (;;) {}', null, { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(WorkerTimeoutError);
  });

  it('stops a worker that grows past the memory limit', async () => {
    await expect(
      run(
        `const hoard = [];
         for (;;) hoard.push(new Array(100000).fill({ x: Math.random() }));`,
        null,
        { maxMemoryMb: 16, timeoutMs: 30_000 },
      ),
    ).rejects.toBeInstanceOf(WorkerMemoryError);
  }, 40_000);

  it('rejects with what the worker threw', async () => {
    await expect(run(`throw new Error('broken');`)).rejects.toThrow('broken');
  });

  it('rejects when the worker exits without answering', async () => {
    await expect(run('process.exit(3)')).rejects.toThrow(/exited with code 3/);
  });
});
