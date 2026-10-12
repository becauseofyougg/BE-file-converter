const postMessage = jest.fn();
let workerData: unknown;

jest.mock('node:worker_threads', () => ({
  parentPort: { postMessage: (...args: unknown[]) => postMessage(...args) },
  get workerData() {
    return workerData;
  },
}));

describe('data-transform.worker', () => {
  beforeEach(() => {
    jest.resetModules();
    postMessage.mockReset();
  });

  const start = (data: unknown) => {
    workerData = data;
    jest.isolateModules(() => {
      jest.requireActual('./data-transform.worker');
    });
  };

  it('posts the result, moving its bytes rather than copying them', () => {
    start({
      data: new TextEncoder().encode('[1]'),
      source: 'json',
      target: 'yaml',
      maxDepth: 8,
    });

    const [result, transfer] = postMessage.mock.calls[0] as [
      { ok: boolean; data: Uint8Array },
      ArrayBuffer[],
    ];

    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.data)).toBe('- 1\n');
    expect(transfer).toEqual([result.data.buffer]);
  });

  it('posts a refusal with nothing to transfer', () => {
    start({
      data: new TextEncoder().encode('{'),
      source: 'json',
      target: 'yaml',
      maxDepth: 8,
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
      [],
    );
  });
});
