import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';

const { mockStsSend, mockStsDestroy } = vi.hoisted(() => ({
  mockStsSend: vi.fn(),
  mockStsDestroy: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend, destroy: mockStsDestroy })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import {
  resolveExpectedBucketOwner,
  expectedOwnerParam,
} from '../../../src/utils/expected-bucket-owner.js';

/** A structurally-standard S3 client double (config.region/credentials fns). */
function standardClient(
  creds: Record<string, unknown> = { accessKeyId: 'AKIA', secretAccessKey: 'secret' }
): S3Client {
  return {
    config: {
      region: async () => 'us-east-1',
      credentials: async () => creds,
    },
  } as unknown as S3Client;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
});

describe('resolveExpectedBucketOwner', () => {
  it('resolves the caller account via STS using the client credentials', async () => {
    await expect(resolveExpectedBucketOwner(standardClient())).resolves.toBe('123456789012');
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    expect(mockStsDestroy).toHaveBeenCalledTimes(1);
  });

  it('caches per client instance (one STS call for repeated resolutions)', async () => {
    const client = standardClient();
    await resolveExpectedBucketOwner(client);
    await resolveExpectedBucketOwner(client);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for a non-standard client (test double) without calling STS', async () => {
    const bare = { send: vi.fn() } as unknown as S3Client;
    await expect(resolveExpectedBucketOwner(bare)).resolves.toBeUndefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('returns undefined when the resolved credentials lack an access key', async () => {
    await expect(resolveExpectedBucketOwner(standardClient({}))).resolves.toBeUndefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('degrades to undefined (header omitted) when STS fails', async () => {
    mockStsSend.mockRejectedValue(new Error('sts down'));
    await expect(resolveExpectedBucketOwner(standardClient())).resolves.toBeUndefined();
  });

  it('does NOT cache a transient STS failure — the next resolution retries and succeeds', async () => {
    const client = standardClient();
    mockStsSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(resolveExpectedBucketOwner(client)).resolves.toBeUndefined();
    await expect(resolveExpectedBucketOwner(client)).resolves.toBe('123456789012');
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });
});

describe('expectedOwnerParam', () => {
  it('spreads to ExpectedBucketOwner when resolved', async () => {
    await expect(expectedOwnerParam(standardClient())).resolves.toEqual({
      ExpectedBucketOwner: '123456789012',
    });
  });

  it('spreads to an empty object when unresolved', async () => {
    const bare = {} as unknown as S3Client;
    await expect(expectedOwnerParam(bare)).resolves.toEqual({});
  });
});
