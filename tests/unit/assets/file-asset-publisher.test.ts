import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Mock @aws-sdk/client-s3
const mockS3Send = vi.fn();
const mockS3Destroy = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockS3Send,
    destroy: mockS3Destroy,
  })),
  HeadObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'HeadObject' })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'PutObject' })),
}));

// Mock @aws-sdk/lib-storage: the multipart path above MULTIPART_UPLOAD_THRESHOLD.
// `file-asset-publisher-multipart-real.test.ts` runs the real package.
const mockUploadDone = vi.fn();
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn().mockImplementation(() => ({ done: mockUploadDone })),
}));

// Mock node:fs. The stream is one shared object so a test can assert both
// that it is the uploaded Body and that a failed upload releases it.
const mockStream = vi.hoisted(() => ({ destroy: vi.fn() }));
vi.mock('node:fs', () => ({
  createReadStream: vi.fn().mockReturnValue(mockStream),
  statSync: vi.fn().mockReturnValue({ size: 1024, isDirectory: () => false }),
}));

// Mock archiver - emits data/end events like a real archive stream.
// v8 dropped the factory export, so the shape mocked here is the `ZipArchive`
// CLASS the publisher now constructs. A mock cannot see the real package's
// export shape at all, which is why `file-asset-publisher-zip-real.test.ts`
// exercises the unmocked archiver alongside this file.
vi.mock('archiver', () => ({
  ZipArchive: vi.fn().mockImplementation(() => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const archive = {
      on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event]!.push(handler);
        return archive;
      }),
      directory: vi.fn(),
      file: vi.fn(),
      finalize: vi.fn().mockImplementation(() => {
        // Emit data then end
        const dataChunk = Buffer.from('mock-zip-data');
        for (const h of handlers['data'] ?? []) h(dataChunk);
        for (const h of handlers['end'] ?? []) h();
        // The real `finalize()` returns a PROMISE, and the publisher chains
        // `.catch(reject)` onto it. Returning undefined here made that chain
        // throw `Cannot read properties of undefined (reading 'catch')` on
        // every zip case — invisible only because the synchronous `'end'`
        // above had already resolved the executor's promise, so the line
        // under test was dead in this file.
        return Promise.resolve();
      }),
    };
    return archive;
  }),
}));

// Mock node:stream (no longer used by file-asset-publisher but kept for safety)
vi.mock('node:stream', () => ({
  PassThrough: vi.fn().mockImplementation(() => {
    const handlers: Record<string, Function[]> = {};
    return {
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
        // Auto-trigger 'end' event for zip tests
        if (event === 'end') {
          setTimeout(() => handler(), 0);
        }
        return { on: vi.fn() };
      }),
    };
  }),
}));

// Mock logger. `mockWarn` is SHARED across every `child()` — a fresh `vi.fn()`
// per call cannot be asserted on, since the object the code under test holds is
// not the one a test can reach.
const mockWarn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: vi.fn(),
    }),
  }),
}));

import { createReadStream, statSync } from 'node:fs';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ZipArchive } from 'archiver';
import {
  FileAssetPublisher,
  MULTIPART_UPLOAD_THRESHOLD,
} from '../../../src/assets/file-asset-publisher.js';
import type { FileAsset } from '../../../src/types/assets.js';

describe('FileAssetPublisher', () => {
  let publisher: FileAssetPublisher;

  const makeFileAsset = (overrides: Partial<FileAsset> = {}): FileAsset => ({
    displayName: 'TestAsset',
    source: {
      path: 'asset.abc123/index.js',
      packaging: 'file' as const,
    },
    destinations: {
      'current-account': {
        bucketName: 'cdk-assets-${AWS::AccountId}-${AWS::Region}',
        objectKey: 'assets/abc123.js',
      },
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new FileAssetPublisher();
  });

  it('should upload file to S3', async () => {
    // HeadObject throws NotFound -> file does not exist yet
    mockS3Send.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'HeadObject') {
        const err = new Error('Not Found') as Error & { name: string; $metadata: { httpStatusCode: number } };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    });

    await publisher.publish(
      'abc123',
      makeFileAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1',
      '/tmp/cdk.out'
    );

    expect(HeadObjectCommand).toHaveBeenCalledWith({
      Bucket: 'cdk-assets-123456789012-us-east-1',
      Key: 'assets/abc123.js',
    });
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'cdk-assets-123456789012-us-east-1',
        Key: 'assets/abc123.js',
        Body: mockStream,
        ContentLength: 1024,
      })
    );
    expect(createReadStream).toHaveBeenCalledWith('/tmp/cdk.out/asset.abc123/index.js');
    expect(mockS3Destroy).toHaveBeenCalled();
  });

  describe('multipart above MULTIPART_UPLOAD_THRESHOLD (go-to-k/cdkd#6162)', () => {
    const headNotFound = (cmd: { _type?: string }): object => {
      if (cmd._type === 'HeadObject') {
        const err = new Error('Not Found') as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    };
    // `clearAllMocks` keeps a `mockReturnValue`: put the file-level default back
    // so a large size does not leak into the cases below this block.
    afterEach(() => {
      vi.mocked(statSync).mockReturnValue({
        size: 1024,
        isDirectory: () => false,
      } as ReturnType<typeof statSync>);
    });
    const publishFile = (asset = makeFileAsset()): Promise<void> =>
      publisher.publish('abc123', asset, '/tmp/cdk.out', '123456789012', 'us-east-1', '/tmp/cdk.out');

    it('is the 5 MiB part size cdk-assets uses (lib-storage default, S3 minimum)', () => {
      expect(MULTIPART_UPLOAD_THRESHOLD).toBe(5 * 1024 * 1024);
    });

    it('sends a file of exactly the threshold as one streamed PutObject', async () => {
      mockS3Send.mockImplementation(headNotFound);
      vi.mocked(statSync).mockReturnValue({
        size: MULTIPART_UPLOAD_THRESHOLD,
        isDirectory: () => false,
      } as ReturnType<typeof statSync>);

      await publishFile();

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Body: mockStream, ContentLength: MULTIPART_UPLOAD_THRESHOLD })
      );
      expect(Upload).not.toHaveBeenCalled();
    });

    it('uploads a file one byte over the threshold as a multipart upload', async () => {
      mockS3Send.mockImplementation(headNotFound);
      const size = MULTIPART_UPLOAD_THRESHOLD + 1;
      vi.mocked(statSync).mockReturnValue({
        size,
        isDirectory: () => false,
      } as ReturnType<typeof statSync>);

      await publishFile();

      expect(PutObjectCommand).not.toHaveBeenCalled();
      expect(Upload).toHaveBeenCalledTimes(1);
      const opts = vi.mocked(Upload).mock.calls[0]![0];
      // The publisher's own client, so the multipart requests carry its
      // credentials, region and path-style addressing.
      expect(opts.client).toBe(vi.mocked(S3Client).mock.results[0]!.value);
      expect(opts.params).toEqual({
        Bucket: 'cdk-assets-123456789012-us-east-1',
        Key: 'assets/abc123.js',
        Body: mockStream,
        ContentLength: size,
      });
      expect(opts.partSize).toBe(MULTIPART_UPLOAD_THRESHOLD);
      expect(opts.leavePartsOnError).toBeUndefined();
      expect(mockUploadDone).toHaveBeenCalledTimes(1);
      expect(mockS3Destroy).toHaveBeenCalled();
    });

    it('propagates a multipart failure and still destroys the client', async () => {
      mockS3Send.mockImplementation(headNotFound);
      vi.mocked(statSync).mockReturnValue({
        size: MULTIPART_UPLOAD_THRESHOLD * 4,
        isDirectory: () => false,
      } as ReturnType<typeof statSync>);
      mockUploadDone.mockRejectedValueOnce(new Error('part 3 failed'));

      await expect(publishFile()).rejects.toThrow('part 3 failed');
      expect(mockS3Destroy).toHaveBeenCalled();
      // The file descriptor is released, not left to the GC.
      expect(mockStream.destroy).toHaveBeenCalledTimes(1);
    });

    it('uploads a zip archive over the threshold as a multipart upload', async () => {
      mockS3Send.mockImplementation(headNotFound);
      vi.mocked(statSync).mockReturnValue({
        size: 0,
        isDirectory: () => true,
      } as ReturnType<typeof statSync>);
      const big = Buffer.alloc(MULTIPART_UPLOAD_THRESHOLD + 1);
      vi.mocked(ZipArchive).mockImplementationOnce(() => {
        const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
        const archive = {
          on: vi.fn().mockImplementation((event: string, h: (...args: unknown[]) => void) => {
            (handlers[event] ??= []).push(h);
            return archive;
          }),
          directory: vi.fn(),
          file: vi.fn(),
          finalize: vi.fn().mockImplementation(() => {
            for (const h of handlers['data'] ?? []) h(big);
            for (const h of handlers['end'] ?? []) h();
            return Promise.resolve();
          }),
        };
        return archive as unknown as InstanceType<typeof ZipArchive>;
      });

      await publishFile(makeFileAsset({ source: { path: 'asset.zip123', packaging: 'zip' } }));

      expect(PutObjectCommand).not.toHaveBeenCalled();
      const opts = vi.mocked(Upload).mock.calls[0]![0];
      expect(Buffer.isBuffer(opts.params.Body)).toBe(true);
      expect(opts.params.ContentLength).toBe(MULTIPART_UPLOAD_THRESHOLD + 1);
    });
  });

  it('should skip upload if object already exists', async () => {
    // HeadObject succeeds -> file exists
    mockS3Send.mockResolvedValue({});

    await publisher.publish(
      'abc123',
      makeFileAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1',
      '/tmp/cdk.out'
    );

    expect(HeadObjectCommand).toHaveBeenCalled();
    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it('should handle ZIP packaging', async () => {
    mockS3Send.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'HeadObject') {
        const err = new Error('Not Found') as Error & { name: string; $metadata: { httpStatusCode: number } };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    });

    vi.mocked(statSync).mockReturnValue({
      size: 2048,
      isDirectory: () => true,
    } as ReturnType<typeof statSync>);

    const zipAsset = makeFileAsset({
      source: { path: 'asset.zip123', packaging: 'zip' },
    });

    await publisher.publish(
      'zip123',
      zipAsset,
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1',
      '/tmp/cdk.out'
    );

    // Should use archiver for zip packaging
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'cdk-assets-123456789012-us-east-1',
        Key: 'assets/abc123.js',
        Body: expect.any(Buffer),
      })
    );

    // Pin the constructor argument. `ZipArchive` takes the options the v7
    // factory took as its SECOND argument, so dropping them is the quiet
    // failure mode of this migration: uploads inflate ~2.2x under an
    // already-minted content hash (measured 2504 B vs 1143 B on the real
    // archiver) and every other assertion still passes.
    expect(ZipArchive).toHaveBeenCalledWith({ zlib: { level: 9 } });
  });

  it('rejects when finalize() rejects without the archive emitting an error', async () => {
    // The case that discriminates `archive.finalize().catch(reject)` from the
    // `void archive.finalize()` it replaced.
    //
    // In the real archiver the two coincide: `finalize()`'s promise rejects
    // from `self._module.on('error')`, and `_modulePipe` registers
    // `_onModuleError` on that SAME emitter, which re-emits to
    // `archive.on('error', reject)`. So the outer promise is already settling
    // and the discarded rejection was an UNHANDLED one — fatal on current
    // Node — rather than a lost failure.
    //
    // A mock can separate them, which is the only way to get a case that
    // fails without the fix instead of merely not-crashing with it: finalize
    // rejects, nothing emits `'error'`, so without the `.catch` the publish
    // promise never settles and the test times out.
    vi.mocked(ZipArchive).mockImplementationOnce(
      () =>
        ({
          on: vi.fn().mockReturnThis(),
          directory: vi.fn(),
          file: vi.fn(),
          finalize: vi.fn().mockRejectedValue(new Error('zip module failed')),
        }) as unknown as InstanceType<typeof ZipArchive>
    );

    mockS3Send.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'HeadObject') {
        const err = new Error('Not Found') as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    });

    vi.mocked(statSync).mockReturnValue({
      size: 2048,
      isDirectory: () => true,
    } as ReturnType<typeof statSync>);

    await expect(
      publisher.publish(
        'zip123',
        makeFileAsset({ source: { path: 'asset.zip123', packaging: 'zip' } }),
        '/tmp/cdk.out',
        '123456789012',
        'us-east-1',
        '/tmp/cdk.out'
      )
    ).rejects.toThrow('zip module failed');

    expect(PutObjectCommand).not.toHaveBeenCalled();
  });

  it('should resolve placeholders', async () => {
    mockS3Send.mockResolvedValue({}); // HeadObject succeeds (skip upload)

    const asset = makeFileAsset({
      destinations: {
        dest1: {
          bucketName: 'bucket-${AWS::AccountId}-${AWS::Region}',
          objectKey: '${AWS::Partition}/assets/key.js',
          region: '${AWS::Region}',
        },
      },
    });

    await publisher.publish(
      'hash1',
      asset,
      '/tmp/cdk.out',
      '111122223333',
      'ap-northeast-1',
      '/tmp/cdk.out'
    );

    expect(HeadObjectCommand).toHaveBeenCalledWith({
      Bucket: 'bucket-111122223333-ap-northeast-1',
      Key: 'aws/assets/key.js',
    });
  });

  it('should handle S3 upload errors', async () => {
    mockS3Send.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'HeadObject') {
        const err = new Error('Not Found') as Error & { name: string; $metadata: { httpStatusCode: number } };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      if (cmd._type === 'PutObject') {
        throw new Error('Access Denied');
      }
      return {};
    });

    await expect(
      publisher.publish(
      'abc123',
      makeFileAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1',
      '/tmp/cdk.out'
    )
    ).rejects.toThrow('Access Denied');

    expect(mockS3Destroy).toHaveBeenCalled();
  });

  describe('an ABSOLUTE source.path (issue go-to-k/cdkd#3532)', () => {
    // The WIRING half of the absolute arm. `asset-path-containment.test.ts`
    // fences the resolver; what only `publish()` can show is that the warning
    // names the DESTINATION — which the manifest chose, and which is the one
    // detail a user can act on. "cdkd will upload it" tells them nothing;
    // `s3://attacker-named-bucket/...` is a bucket they can see is not theirs.
    it('WARNS naming the manifest-chosen destination, and still publishes', async () => {
      mockWarn.mockClear();
      mockS3Send.mockImplementation((command: { _type?: string }) => {
        if (command._type === 'HeadObject') {
          return Promise.reject(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
        }
        return Promise.resolve({});
      });

      await publisher.publish(
        'abs1',
        makeFileAsset({
          source: { path: '/srv/victim-dir', packaging: 'zip' },
          destinations: {
            'acct-region': { bucketName: 'attacker-named-bucket', objectKey: 'x.zip' },
          },
        }),
        '/tmp/cdk.out',
        '123456789012',
        'us-east-1',
        '/tmp/cdk.out'
      );

      const warned = mockWarn.mock.calls.map((c) => String(c[0]));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('/srv/victim-dir');
      expect(warned[0]).toContain('s3://attacker-named-bucket/x.zip');
      expect(warned[0]).toContain('--no-staging');
      // ...and the publish went through, which is the behaviour change.
      expect(PutObjectCommand).toHaveBeenCalled();
    });

    it('stays SILENT for an absolute source.path inside the outdir', async () => {
      mockWarn.mockClear();
      mockS3Send.mockImplementation((command: { _type?: string }) => {
        if (command._type === 'HeadObject') {
          return Promise.reject(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
        }
        return Promise.resolve({});
      });

      await publisher.publish(
        'abs2',
        makeFileAsset({ source: { path: '/tmp/cdk.out/asset.abc', packaging: 'zip' } }),
        '/tmp/cdk.out',
        '123456789012',
        'us-east-1',
        '/tmp/cdk.out'
      );

      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('assembly-path containment (issue go-to-k/cdkd#3489)', () => {
    // The manifest names the DESTINATION bucket as well as the source, so an
    // escaping `source.path` zipped a directory from outside `cdk.out` and
    // PutObject'd it to a bucket the attacker chose, with the caller's own
    // credentials. Asserted BEHAVIOURALLY, through `publish()`, because the
    // property that matters is "no S3 command was sent", which a source-text
    // check on the join spelling cannot express.
    //
    // `node:fs` is mocked in this file, so `realpathSync` is absent and the
    // helper's symlink arm is skipped — the lexical arm is pure path maths and
    // is what these cases exercise. The symlink arm has its own real-filesystem
    // cases in `asset-path-containment.test.ts`.
    it('refuses an escaping source.path and sends NOTHING to S3', async () => {
      await expect(
        publisher.publish(
          'abc123',
          makeFileAsset({ source: { path: '../../../etc', packaging: 'zip' } }),
          '/tmp/cdk.out',
          '123456789012',
          'us-east-1',
          '/tmp/cdk.out'
        )
      ).rejects.toThrow(/source\.path=\.\.\/\.\.\/\.\.\/etc which resolves to .*, outside/);

      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('refuses BEFORE the already-exists HeadObject, so remote state cannot skip the check', async () => {
      // The check used to sit below `objectExists`, which `continue`s on a
      // hit — so an object that already existed skipped containment entirely,
      // and the HeadObject itself was a signed request to the attacker's
      // bucket. Priming HeadObject to SUCCEED is what discriminates.
      mockS3Send.mockResolvedValue({});

      await expect(
        publisher.publish(
          'abc123',
          makeFileAsset({ source: { path: '../../../etc', packaging: 'zip' } }),
          '/tmp/cdk.out',
          '123456789012',
          'us-east-1',
          '/tmp/cdk.out'
        )
      ).rejects.toThrow(/outside/);

      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('still publishes an ordinary asset path unchanged', async () => {
      mockS3Send.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === 'HeadObject') {
          const err = new Error('Not Found') as Error & {
            name: string;
            $metadata: { httpStatusCode: number };
          };
          err.name = 'NotFound';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return {};
      });

      await publisher.publish(
      'abc123',
      makeFileAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1',
      '/tmp/cdk.out'
    );

      expect(mockS3Send).toHaveBeenCalled();
    });
  });
});
