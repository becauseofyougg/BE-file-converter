import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ObjectNotFoundError } from './file-storage';
import { LocalFileStorage } from './local-file-storage';

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return Buffer.concat(chunks).toString('utf8');
}

describe('LocalFileStorage', () => {
  let root: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fc-storage-'));
    storage = new LocalFileStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('calls itself local, which is what the operation row records', () => {
    expect(storage.driver).toBe('local');
  });

  it('round-trips a buffer', async () => {
    await storage.put({
      bucket: 'results',
      key: 'user-1/op-1.json',
      body: Buffer.from('{"a":1}'),
    });

    await expect(
      readAll(await storage.getStream('results', 'user-1/op-1.json')),
    ).resolves.toBe('{"a":1}');
  });

  it('round-trips a stream, the way an upload arrives', async () => {
    await storage.put({
      bucket: 'uploads',
      key: 'user-1/op-1',
      body: Readable.from(['a,b\n', '1,2\n']),
    });

    await expect(
      readFile(join(root, 'uploads', 'user-1', 'op-1'), 'utf8'),
    ).resolves.toBe('a,b\n1,2\n');
  });

  it('keeps the two buckets apart on disk', async () => {
    await storage.put({
      bucket: 'uploads',
      key: 'u/x',
      body: Buffer.from('1'),
    });
    await storage.put({
      bucket: 'results',
      key: 'u/x',
      body: Buffer.from('2'),
    });

    expect(await readFile(join(root, 'uploads', 'u', 'x'), 'utf8')).toBe('1');
    expect(await readFile(join(root, 'results', 'u', 'x'), 'utf8')).toBe('2');
  });

  /** Written beside the target and renamed, so nothing half-written is left. */
  it('leaves nothing behind when the incoming stream fails', async () => {
    const failing = new Readable({
      read() {
        this.push('partial');
        this.destroy(new Error('client went away'));
      },
    });

    await expect(
      storage.put({ bucket: 'uploads', key: 'user-1/op-2', body: failing }),
    ).rejects.toThrow('client went away');

    expect(await readdir(join(root, 'uploads', 'user-1'))).toEqual([]);
  });

  it('reports a missing object as ObjectNotFoundError', async () => {
    await expect(
      storage.getStream('results', 'user-1/nothing'),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('deletes, and deleting again is not an error', async () => {
    await storage.put({
      bucket: 'results',
      key: 'u/y',
      body: Buffer.from('1'),
    });

    await storage.delete('results', 'u/y');
    await expect(storage.delete('results', 'u/y')).resolves.toBeUndefined();
    await expect(storage.getStream('results', 'u/y')).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  /** Keys come from ids, never from a client — anything else is an attack. */
  it.each([
    ['a parent reference', '../etc/passwd'],
    ['a parent reference mid-path', 'user-1/../../secret'],
    ['an absolute path', '/etc/passwd'],
    ['a hidden segment', 'user-1/.ssh'],
    ['a backslash', 'user-1\\..\\x'],
    ['an empty key', ''],
  ])('refuses %s', async (_label, key) => {
    await expect(
      storage.put({ bucket: 'uploads', key, body: Buffer.from('x') }),
    ).rejects.toThrow(/unsafe storage key/);
  });

  it('refuses a bucket it does not know', async () => {
    await expect(
      storage.getStream('elsewhere' as never, 'user-1/x'),
    ).rejects.toThrow(/unsafe storage key/);
  });

  it('pings by making sure both bucket directories exist and are writable', async () => {
    await storage.ping();

    expect((await readdir(root)).sort()).toEqual(['results', 'uploads']);
  });

  it('has no URL to offer — the caller streams instead', async () => {
    await expect(storage.presignGet()).resolves.toBeNull();
  });

  it('builds keys with the user first', () => {
    expect(storage.buildKey('user-1', 'op-1', 'json')).toBe('user-1/op-1.json');
    expect(storage.buildKey('user-1', 'op-1')).toBe('user-1/op-1');
  });
});
