import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockS3Send, mockEcrSend, mockLoggerWarn } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockEcrSend: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => {
  const command = (type: string) => vi.fn().mockImplementation((input) => ({ ...input, _type: type }));
  return {
    S3Client: vi.fn().mockImplementation((cfg?: { region?: string }) => ({
      send: mockS3Send,
      destroy: vi.fn(),
      config: { region: async () => cfg?.region ?? 'us-east-1' },
    })),
    HeadBucketCommand: command('HeadBucket'),
    CreateBucketCommand: command('CreateBucket'),
    GetBucketLocationCommand: command('GetBucketLocation'),
    PutBucketEncryptionCommand: command('PutBucketEncryption'),
    PutPublicAccessBlockCommand: command('PutPublicAccessBlock'),
    PutBucketPolicyCommand: command('PutBucketPolicy'),
  };
});

vi.mock('@aws-sdk/client-ecr', () => {
  const command = (type: string) => vi.fn().mockImplementation((input) => ({ ...input, _type: type }));
  return {
    ECRClient: vi.fn().mockImplementation(() => ({ send: mockEcrSend, destroy: vi.fn() })),
    DescribeRepositoriesCommand: command('DescribeRepositories'),
    CreateRepositoryCommand: command('CreateRepository'),
    PutImageTagMutabilityCommand: command('PutImageTagMutability'),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() };
  return { getLogger: () => ({ ...l, child: () => l }) };
});

import { AssetModeResolver } from '../../../src/assets/asset-storage.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/assets` slice: `AssetModeResolver`'s auto-create catch NEVER hard-fails
 * the deploy -- a failed storage creation falls back to the CDK bootstrap
 * destinations with a warning. Its message was
 * `error instanceof Error ? error.message : String(error)`, and
 * `String(Object.create(null))` throws, so an SDK call rejecting with such a
 * value failed the deploy from inside the fallback.
 */

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AssetModeResolver auto-create failure (#3361)', () => {
  it('an unconvertible rejection still falls back to legacy mode, and warns', async () => {
    // `PutBucketEncryption` is sent raw (no `normalizeAwsError` wrap), so its
    // rejection reaches the auto-create catch exactly as the SDK produced it.
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') {
        return Promise.reject(
          Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
        );
      }
      if (cmd._type === 'PutBucketEncryption') return Promise.reject(Object.create(null));
      return Promise.resolve({});
    });
    const backend = {
      getRawObject: vi.fn(async () => null),
      putRawObject: vi.fn(async () => {}),
    } as unknown as S3StateBackend;
    const resolver = new AssetModeResolver(backend, ACCOUNT, {
      autoCreate: { confirm: vi.fn().mockResolvedValue(true) },
    });

    await expect(resolver.resolve(REGION)).resolves.toEqual({ mode: 'legacy' });

    const failed = mockLoggerWarn.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes('Failed to auto-create cdkd asset storage'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(PLACEHOLDER);
  });
});
