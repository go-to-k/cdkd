/**
 * The REAL `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`, with only the HTTP
 * layer replaced (go-to-k/cdkd#6162).
 *
 * `file-asset-publisher.test.ts` mocks `Upload`, so it pins WHICH path the
 * publisher picks and nothing about the requests that path puts on the wire.
 * The defect was on the wire: AWS Emulator refuses a request body of 16 MiB or
 * more (`413`, then a closed connection the SDK reports as `write EPIPE`), so
 * the property that matters is that NO request carries a body larger than one
 * part. This file records every HTTP request a real `S3Client` sends for a real
 * file and asserts the operation sequence and each body's size.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/** The slice of smithy's `HttpRequest` the handler reads. */
interface HttpRequest {
  method: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

interface Recorded {
  method: string;
  query: Record<string, unknown>;
  bodyBytes: number;
}
const recorded: Recorded[] = [];
/** When set, this UploadPart number answers 500 InternalError. */
let failPartNumber: string | undefined;

async function bodyLength(body: unknown): Promise<number> {
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  let n = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    n += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
  }
  return n;
}

function xml(body: string): Readable {
  return Readable.from([Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${body}`)]);
}

/** Answers like S3 does, enough for HeadObject / PutObject / the multipart trio. */
const recordingHandler = {
  metadata: { handlerProtocol: 'http/1.1' },
  async handle(request: HttpRequest) {
    const query = request.query ?? {};
    recorded.push({
      method: request.method,
      query,
      bodyBytes: await bodyLength(request.body),
    });
    const ok = (headers: Record<string, string> = {}, body: Readable = Readable.from([])) => ({
      response: { statusCode: 200, headers, body },
    });
    if (request.method === 'HEAD') {
      return { response: { statusCode: 404, headers: {}, body: Readable.from([]) } };
    }
    if (request.method === 'POST' && 'uploads' in query) {
      return ok(
        {},
        xml(
          '<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key>' +
            '<UploadId>upload-1</UploadId></InitiateMultipartUploadResult>'
        )
      );
    }
    if (request.method === 'POST' && 'uploadId' in query) {
      return ok(
        {},
        xml(
          '<CompleteMultipartUploadResult><Bucket>b</Bucket><Key>k</Key>' +
            '<ETag>"done"</ETag></CompleteMultipartUploadResult>'
        )
      );
    }
    if (request.method === 'DELETE' && 'uploadId' in query) {
      return { response: { statusCode: 204, headers: {}, body: Readable.from([]) } };
    }
    if (failPartNumber !== undefined && query['partNumber'] === failPartNumber) {
      return {
        response: {
          statusCode: 500,
          headers: {},
          body: xml('<Error><Code>InternalError</Code><Message>part refused</Message></Error>'),
        },
      };
    }
    return ok({ etag: `"part-${recorded.length}"` });
  },
  updateHttpClientConfig() {},
  httpHandlerConfigs() {
    return {};
  },
  destroy() {},
};

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  class RecordingS3Client extends actual.S3Client {
    constructor(config: ConstructorParameters<typeof actual.S3Client>[0]) {
      super({
        ...config,
        region: 'us-east-1',
        credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
        requestHandler: recordingHandler,
        // A refused part fails at once instead of after the SDK's backoff.
        maxAttempts: 1,
      });
    }
  }
  return { ...actual, S3Client: RecordingS3Client };
});

const { FileAssetPublisher, MULTIPART_UPLOAD_THRESHOLD } =
  await import('../../../src/assets/file-asset-publisher.js');

/** S3's own name for each recorded request. */
function operation(r: Recorded): string {
  if (r.method === 'HEAD') return 'HeadObject';
  if (r.method === 'POST' && 'uploads' in r.query) return 'CreateMultipartUpload';
  if (r.method === 'POST' && 'uploadId' in r.query) return 'CompleteMultipartUpload';
  if (r.method === 'PUT' && 'partNumber' in r.query) return 'UploadPart';
  if (r.method === 'PUT') return 'PutObject';
  if (r.method === 'DELETE' && 'uploadId' in r.query) return 'AbortMultipartUpload';
  return `${r.method}?${Object.keys(r.query).join('&')}`;
}

describe('FileAssetPublisher uploads through the real S3 client and lib-storage', () => {
  let dir: string;

  beforeEach(() => {
    recorded.length = 0;
    failPartNumber = undefined;
    dir = mkdtempSync(join(tmpdir(), 'cdkd-multipart-real-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function publishFileOfSize(size: number): Promise<void> {
    writeFileSync(join(dir, 'asset.bin'), Buffer.alloc(size, 7));
    await new FileAssetPublisher().publish(
      'hash',
      {
        displayName: 'Big',
        source: { path: 'asset.bin', packaging: 'file' },
        destinations: { d: { bucketName: 'cdkd-assets', objectKey: 'hash.zip' } },
      },
      dir,
      '123456789012',
      'us-east-1',
      dir
    );
  }

  it('sends a small file as one PutObject carrying the whole body', async () => {
    await publishFileOfSize(1024);

    expect(recorded.map(operation)).toEqual(['HeadObject', 'PutObject']);
    // The streamed PutObject may be aws-chunked (framing bytes on top), so the
    // body is at least the file, and far below one part.
    expect(recorded[1]!.bodyBytes).toBeGreaterThanOrEqual(1024);
  });

  it('splits a 22 MB file (the AwsCliLayer asset) into parts no larger than the threshold', async () => {
    const size = 22_004_168;
    await publishFileOfSize(size);

    const ops = recorded.map(operation);
    const parts = recorded.filter((r) => operation(r) === 'UploadPart');
    expect(ops).toEqual([
      'HeadObject',
      'CreateMultipartUpload',
      ...parts.map(() => 'UploadPart'),
      'CompleteMultipartUpload',
    ]);
    expect(parts).toHaveLength(Math.ceil(size / MULTIPART_UPLOAD_THRESHOLD));
    for (const p of parts) expect(p.bodyBytes).toBeLessThanOrEqual(MULTIPART_UPLOAD_THRESHOLD);
    expect(parts.reduce((n, p) => n + p.bodyBytes, 0)).toBe(size);
    // The defect: no single request may carry the whole object.
    expect(Math.max(...recorded.map((r) => r.bodyBytes))).toBeLessThan(16 * 1024 * 1024);
  });

  it('aborts the multipart upload when a part fails, and completes nothing', async () => {
    failPartNumber = '2';

    await expect(publishFileOfSize(22_004_168)).rejects.toThrow();

    const ops = recorded.map(operation);
    // `leavePartsOnError` stays false: no billed parts are left in the bucket.
    expect(ops).toContain('AbortMultipartUpload');
    expect(ops).not.toContain('CompleteMultipartUpload');
  });
});
