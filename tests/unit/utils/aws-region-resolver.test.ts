import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  resolveBucketRegion,
  resolveCrossAccountStateBucket,
  clearBucketRegionCache,
} from '../../../src/utils/aws-region-resolver.js';

// Replace the real S3Client with a controllable mock. Each test reaches
// into `mockSend` to dictate the GetBucketLocation result.
const mockSend = vi.fn();
const mockDestroy = vi.fn();
// Captures every cfg passed to `new S3Client(cfg)` so cross-account
// tests can verify that the assumed credentials are threaded through.
const s3ClientFactory = vi.fn();

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation((cfg: unknown) => {
      s3ClientFactory(cfg);
      return {
        send: mockSend,
        destroy: mockDestroy,
      };
    }),
  };
});

describe('resolveBucketRegion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBucketRegionCache();
  });

  it('returns the LocationConstraint for a non-us-east-1 bucket', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-west-2' });

    const region = await resolveBucketRegion('my-bucket');

    expect(region).toBe('us-west-2');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('returns us-east-1 when LocationConstraint is empty (S3 quirk)', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: '' });

    const region = await resolveBucketRegion('us-east-bucket');

    expect(region).toBe('us-east-1');
  });

  it('returns us-east-1 when LocationConstraint is null', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: null });

    const region = await resolveBucketRegion('us-east-bucket-null');

    expect(region).toBe('us-east-1');
  });

  it('caches the result for subsequent calls (no new API call)', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'eu-west-1' });

    const first = await resolveBucketRegion('cached-bucket');
    const second = await resolveBucketRegion('cached-bucket');
    const third = await resolveBucketRegion('cached-bucket');

    expect(first).toBe('eu-west-1');
    expect(second).toBe('eu-west-1');
    expect(third).toBe('eu-west-1');
    // Single API call shared by all three callers.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent calls for the same bucket into one API call', async () => {
    mockSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ LocationConstraint: 'ap-northeast-1' }), 10);
        })
    );

    const [a, b, c] = await Promise.all([
      resolveBucketRegion('concurrent-bucket'),
      resolveBucketRegion('concurrent-bucket'),
      resolveBucketRegion('concurrent-bucket'),
    ]);

    expect(a).toBe('ap-northeast-1');
    expect(b).toBe('ap-northeast-1');
    expect(c).toBe('ap-northeast-1');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns fallbackRegion when GetBucketLocation throws', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })
    );

    const region = await resolveBucketRegion('forbidden-bucket', {
      fallbackRegion: 'eu-central-1',
    });

    expect(region).toBe('eu-central-1');
    // Even on failure the client must be destroyed (no socket leak).
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('returns us-east-1 when no fallbackRegion is provided and the call fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('network error'));

    const region = await resolveBucketRegion('flaky-bucket');

    expect(region).toBe('us-east-1');
  });

  it('keeps separate cache entries per bucket name', async () => {
    mockSend
      .mockResolvedValueOnce({ LocationConstraint: 'us-west-2' })
      .mockResolvedValueOnce({ LocationConstraint: 'eu-west-1' });

    const a = await resolveBucketRegion('bucket-a');
    const b = await resolveBucketRegion('bucket-b');

    expect(a).toBe('us-west-2');
    expect(b).toBe('eu-west-1');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// MUST-FIX 5: direct tests for resolveCrossAccountStateBucket (the helper
// the cross-account `Fn::GetStackOutput` path calls between AssumeRole and
// the S3StateBackend construction).
// ---------------------------------------------------------------------------
describe('resolveCrossAccountStateBucket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3ClientFactory.mockReset();
    clearBucketRegionCache();
  });

  it('returns the canonical bucket name `cdkd-state-{accountId}`', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'eu-west-1' });

    const { bucket } = await resolveCrossAccountStateBucket('111122223333', {
      accessKeyId: 'ASIA-xacc',
      secretAccessKey: 'secret',
      sessionToken: 'session',
    });

    expect(bucket).toBe('cdkd-state-111122223333');
  });

  it('returns the GetBucketLocation-derived region (NOT the caller default)', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'ap-northeast-1' });

    const { region } = await resolveCrossAccountStateBucket('444455556666', {
      accessKeyId: 'ASIA-region',
      secretAccessKey: 's',
      sessionToken: 't',
    });

    expect(region).toBe('ap-northeast-1');
  });

  it('threads the assumed credentials into the S3 client used for GetBucketLocation', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-west-2' });

    await resolveCrossAccountStateBucket('777788889999', {
      accessKeyId: 'ASIA-assumed',
      secretAccessKey: 'assumed-secret',
      sessionToken: 'assumed-session',
    });

    // The S3Client used for the GetBucketLocation hop was constructed
    // with the assumed credentials — NOT the ambient ones — so the
    // producer's bucket policy can authorize against the assumed
    // principal.
    expect(s3ClientFactory).toHaveBeenCalled();
    const cfgs = s3ClientFactory.mock.calls.map((call) => call[0]) as Array<{
      credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    }>;
    const cfgWithCreds = cfgs.find((c) => c.credentials !== undefined);
    expect(cfgWithCreds).toBeDefined();
    expect(cfgWithCreds?.credentials?.accessKeyId).toBe('ASIA-assumed');
    expect(cfgWithCreds?.credentials?.secretAccessKey).toBe('assumed-secret');
    expect(cfgWithCreds?.credentials?.sessionToken).toBe('assumed-session');
  });

  it('issues GetBucketLocation against the canonical bucket name', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-east-2' });

    await resolveCrossAccountStateBucket('123456789012', {
      accessKeyId: 'a',
      secretAccessKey: 'b',
      sessionToken: 'c',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]?.[0];
    expect(cmd?.input?.Bucket).toBe('cdkd-state-123456789012');
  });

  // SHOULD-FIX 6: cross-account failure path on GetBucketLocation
  it('falls back to us-east-1 (silent) when GetBucketLocation rejects with AccessDenied', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    );

    const result = await resolveCrossAccountStateBucket('555566667777', {
      accessKeyId: 'a',
      secretAccessKey: 'b',
      sessionToken: 'c',
    });

    // Bucket name is still canonical; region falls back to us-east-1
    // (resolveBucketRegion's default when no fallbackRegion is set).
    // The silent fallback is by design: users may have s3:GetObject
    // but lack s3:GetBucketLocation, and we want the downstream
    // GetObject error to surface — not mask it behind a region
    // resolution failure.
    expect(result.bucket).toBe('cdkd-state-555566667777');
    expect(result.region).toBe('us-east-1');
  });

  it('caches the bucket-region lookup per bucket name (no duplicate GetBucketLocation)', async () => {
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'sa-east-1' });

    const creds = {
      accessKeyId: 'a',
      secretAccessKey: 'b',
      sessionToken: 'c',
    };
    const first = await resolveCrossAccountStateBucket('000000000000', creds);
    const second = await resolveCrossAccountStateBucket('000000000000', creds);

    expect(first.region).toBe('sa-east-1');
    expect(second.region).toBe('sa-east-1');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
