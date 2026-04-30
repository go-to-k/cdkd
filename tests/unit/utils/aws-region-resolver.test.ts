import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveBucketRegion,
  clearBucketRegionCache,
} from '../../../src/utils/aws-region-resolver.js';

// Replace the real S3Client with a controllable mock. Each test reaches
// into `mockSend` to dictate the GetBucketLocation result.
const mockSend = vi.fn();
const mockDestroy = vi.fn();

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      destroy: mockDestroy,
    })),
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
