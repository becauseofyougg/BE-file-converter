const getSignedUrl = jest.fn();
const uploadDone = jest.fn();
const Upload = jest.fn();

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrl(...args),
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: function (options: unknown) {
    Upload(options);
    return { done: () => uploadDone() as Promise<unknown> };
  },
}));

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

import { ConfigService } from '@core/config/config.service';

import { ObjectNotFoundError } from './file-storage';
import { S3FileStorage } from './s3-file-storage';

const CONFIG: Record<string, string> = {
  S3_BUCKET_UPLOADS: 'uploads-bucket',
  S3_BUCKET_RESULTS: 'results-bucket',
  S3_PRESIGN_TTL: '300',
};

describe('S3FileStorage', () => {
  let client: { send: jest.Mock };
  let service: S3FileStorage;

  /** The command instance the service handed to the client, by position. */
  const commandAt = (index: number) =>
    client.send.mock.calls[index][0] as
      | PutObjectCommand
      | GetObjectCommand
      | DeleteObjectCommand
      | HeadBucketCommand;

  beforeEach(() => {
    getSignedUrl.mockReset().mockResolvedValue('https://signed.example/object');
    client = { send: jest.fn().mockResolvedValue({}) };

    service = new S3FileStorage(
      client as unknown as S3Client,
      {
        get: (key: string) => CONFIG[key],
        getNumber: (key: string) => Number(CONFIG[key]),
      } as unknown as ConfigService<never>,
    );
  });

  describe('bucket routing', () => {
    /**
     * The two buckets are not interchangeable: inputs are attacker-supplied and
     * results are what the converter produced. Writing one into the other is
     * the kind of mistake a test is cheap insurance against.
     */
    it('sends uploads to the uploads bucket', async () => {
      await service.put({
        bucket: 'uploads',
        key: 'a/b',
        body: Buffer.from('x'),
      });

      expect(commandAt(0).input).toMatchObject({ Bucket: 'uploads-bucket' });
    });

    it('sends results to the results bucket', async () => {
      await service.getStream('results', 'a/b');

      expect(commandAt(0).input).toMatchObject({ Bucket: 'results-bucket' });
    });
  });

  describe('put', () => {
    it('passes the key, type and length through', async () => {
      await service.put({
        bucket: 'uploads',
        key: 'user-1/job-1.png',
        body: Buffer.from('x'),
        contentType: 'image/png',
        contentLength: 1,
      });

      expect(commandAt(0)).toBeInstanceOf(PutObjectCommand);
      expect(commandAt(0).input).toMatchObject({
        Key: 'user-1/job-1.png',
        ContentType: 'image/png',
        ContentLength: 1,
      });
    });
  });

  describe('getStream', () => {
    it('returns the body as a stream', async () => {
      const body = Readable.from(['chunk']);
      client.send.mockResolvedValue({ Body: body });

      await expect(service.getStream('results', 'a/b')).resolves.toBe(body);
    });

    /** A missing object is a 404 to the caller, not a storage outage. */
    it.each([
      ['NoSuchKey', { name: 'NoSuchKey' }],
      ['a bare 404', { name: 'Unknown', $metadata: { httpStatusCode: 404 } }],
    ])('turns %s into ObjectNotFoundError', async (_label, failure) => {
      client.send.mockRejectedValue(Object.assign(new Error('gone'), failure));

      await expect(service.getStream('results', 'a/b')).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
    });

    it('lets any other failure through as it is', async () => {
      client.send.mockRejectedValue(new Error('connection refused'));

      await expect(service.getStream('results', 'a/b')).rejects.toThrow(
        'connection refused',
      );
    });
  });

  /**
   * An upload still arriving has no known length, and PutObject needs one.
   * The multipart Upload helper takes the stream in parts instead.
   */
  describe('put with a stream of unknown length', () => {
    beforeEach(() => {
      Upload.mockReset();
      uploadDone.mockReset().mockResolvedValue({});
    });

    /**
     * S3 wants a length before a PutObject, and an upload still arriving has
     * none. The multipart Upload helper takes the stream in parts instead.
     */
    it('goes through the multipart Upload helper', async () => {
      const body = Readable.from([Buffer.from('a,b\n1,2\n')]);

      await service.put({
        bucket: 'uploads',
        key: 'user-1/op-1',
        body,
        contentType: 'text/csv',
      });

      expect(Upload).toHaveBeenCalledWith({
        client,
        params: {
          Bucket: 'uploads-bucket',
          Key: 'user-1/op-1',
          Body: body,
          ContentType: 'text/csv',
        },
      });
      expect(uploadDone).toHaveBeenCalled();
      expect(client.send).not.toHaveBeenCalled();
    });

    it('fails when the upload does', async () => {
      uploadDone.mockRejectedValue(new Error('part rejected'));

      await expect(
        service.put({
          bucket: 'uploads',
          key: 'user-1/op-1',
          body: Readable.from(['x']),
        }),
      ).rejects.toThrow('part rejected');
    });

    it('still uses a single PutObject when the length is known', async () => {
      await service.put({
        bucket: 'uploads',
        key: 'user-1/op-1',
        body: Readable.from(['x']),
        contentLength: 1,
      });

      expect(Upload).not.toHaveBeenCalled();
      expect(commandAt(0)).toBeInstanceOf(PutObjectCommand);
    });
  });

  it('calls itself s3, which is what the operation row records', () => {
    expect(service.driver).toBe('s3');
  });

  describe('presignGet', () => {
    it('signs a GET for the right bucket and key', async () => {
      await expect(service.presignGet('results', 'a/b')).resolves.toBe(
        'https://signed.example/object',
      );

      const [, command] = getSignedUrl.mock.calls[0] as [
        unknown,
        GetObjectCommand,
      ];

      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input).toMatchObject({
        Bucket: 'results-bucket',
        Key: 'a/b',
      });
    });

    it('uses the configured lifetime by default', async () => {
      await service.presignGet('results', 'a/b');

      expect(getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 300 });
    });

    it('lets a caller ask for a shorter one', async () => {
      await service.presignGet('results', 'a/b', 30);

      expect(getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 30 });
    });
  });

  describe('delete', () => {
    it('deletes by key', async () => {
      await service.delete('uploads', 'a/b');

      expect(commandAt(0)).toBeInstanceOf(DeleteObjectCommand);
      expect(commandAt(0).input).toMatchObject({ Key: 'a/b' });
    });
  });

  describe('ping', () => {
    it('heads a bucket, so a broken connection actually fails', async () => {
      await service.ping();

      expect(commandAt(0)).toBeInstanceOf(HeadBucketCommand);
    });

    it('propagates the failure, which is what makes it a probe', async () => {
      client.send.mockRejectedValue(new Error('connection refused'));

      await expect(service.ping()).rejects.toThrow('connection refused');
    });
  });

  describe('buildKey', () => {
    /**
     * The user id in the key is what makes accidental cross-user access
     * structurally impossible, and the client's filename never appears.
     */
    it('puts the user first, then the job', () => {
      expect(service.buildKey('user-1', 'job-1', 'png')).toBe(
        'user-1/job-1.png',
      );
    });

    it('omits the extension when there is none', () => {
      expect(service.buildKey('user-1', 'job-1')).toBe('user-1/job-1');
    });
  });
});
