import { describe, it, expect, beforeEach, vi } from 'vitest';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StateBackendConfig } from '../../../src/types/config.js';
import { StateError } from '../../../src/utils/error-handler.js';

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('S3StateBackend.verifyBucketExists', () => {
  let s3Client: { send: ReturnType<typeof vi.fn> };
  let backend: S3StateBackend;
  const config: StateBackendConfig = {
    bucket: 'my-state-bucket',
    prefix: 'stacks',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    s3Client = { send: vi.fn() };
    backend = new S3StateBackend(s3Client as unknown as S3Client, config);
  });

  it('resolves when the bucket exists', async () => {
    s3Client.send.mockResolvedValueOnce({});

    await expect(backend.verifyBucketExists()).resolves.toBeUndefined();

    const call = s3Client.send.mock.calls[0][0];
    expect(call).toBeInstanceOf(HeadBucketCommand);
    expect(call.input).toEqual({ Bucket: 'my-state-bucket' });
  });

  it('throws a StateError with bootstrap hint when the bucket is missing (NotFound)', async () => {
    const err = Object.assign(new Error('Not Found'), { name: 'NotFound' });
    s3Client.send.mockRejectedValue(err);

    const caught = await backend.verifyBucketExists().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/does not exist/);
    expect((caught as Error).message).toMatch(/cdkd bootstrap/);
  });

  it('throws a StateError with bootstrap hint when the bucket is missing (NoSuchBucket)', async () => {
    const err = Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
    });
    s3Client.send.mockRejectedValue(err);

    const caught = await backend.verifyBucketExists().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/cdkd bootstrap/);
  });

  it('wraps other errors as StateError without the bootstrap hint', async () => {
    const err = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    s3Client.send.mockRejectedValue(err);

    const caught = await backend.verifyBucketExists().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/Failed to verify state bucket/);
    expect((caught as Error).message).not.toMatch(/cdkd bootstrap/);
  });
});
