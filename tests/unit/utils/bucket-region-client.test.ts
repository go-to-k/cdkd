import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { S3Client } from '@aws-sdk/client-s3';
import { rebuildClientForBucketRegion } from '../../../src/utils/bucket-region-client.js';

// Mock the S3Client constructor so we can assert a replacement was built and
// inspect the config it was built with — without issuing any real API call.
vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
      destroy: vi.fn(),
    })),
  };
});

// Mock the region resolver so the helper never issues a real GetBucketLocation.
vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return {
    ...actual,
    resolveBucketRegion: vi.fn(),
  };
});

/**
 * Build a fake S3Client whose `.config.region()` / `.config.credentials()`
 * resolve canned values — the shape the helper reads.
 */
function makeFakeClient(
  region: string,
  credentials?: { accessKeyId: string; secretAccessKey: string }
): {
  send: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  config: {
    region: () => Promise<string>;
    credentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string }>;
  };
} {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve(region),
      ...(credentials && { credentials: () => Promise.resolve(credentials) }),
    },
  };
}

describe('rebuildClientForBucketRegion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a rebuilt client pointed at the bucket region when it differs (301/region-mismatch)', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const client = makeFakeClient('us-east-1');

    const rebuilt = await rebuildClientForBucketRegion(client as unknown as S3Client, 'my-bucket', {
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
    });

    expect(rebuilt).not.toBeNull();
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2' })
    );
  });

  it('returns null (no rebuild) when the resolved region matches the client region', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');

    const client = makeFakeClient('us-east-1');

    const rebuilt = await rebuildClientForBucketRegion(client as unknown as S3Client, 'my-bucket');

    expect(rebuilt).toBeNull();
    expect(vi.mocked(S3Client)).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('threads static credentials into BOTH the probe and the rebuilt client (S3StateBackend mode)', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const staticCreds = { accessKeyId: 'AKIASTATIC', secretAccessKey: 'static-secret' };
    const client = makeFakeClient('us-east-1');

    await rebuildClientForBucketRegion(client as unknown as S3Client, 'my-bucket', {
      profile: 'my-profile',
      credentials: staticCreds,
    });

    // The probe got the static credentials + profile + fallbackRegion.
    expect(vi.mocked(resolveBucketRegion)).toHaveBeenCalledWith(
      'my-bucket',
      expect.objectContaining({
        profile: 'my-profile',
        credentials: staticCreds,
        fallbackRegion: 'us-east-1',
      })
    );
    // The rebuilt client also got the static credentials + profile.
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-west-2',
        profile: 'my-profile',
        credentials: staticCreds,
      })
    );
  });

  it('destroys the old client only when destroyOldClient is set', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const owned = makeFakeClient('us-east-1');
    await rebuildClientForBucketRegion(owned as unknown as S3Client, 'b', {
      destroyOldClient: true,
    });
    expect(owned.destroy).toHaveBeenCalledTimes(1);

    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');
    const shared = makeFakeClient('us-east-1');
    await rebuildClientForBucketRegion(shared as unknown as S3Client, 'b');
    expect(shared.destroy).not.toHaveBeenCalled();
  });

  it('reuses the client credentials provider for probe + rebuild (LockManager / ExportIndexStore mode)', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const resolvedCreds = { accessKeyId: 'AKIARESOLVED', secretAccessKey: 'resolved-secret' };
    const client = makeFakeClient('us-east-1', resolvedCreds);
    // Capture the provider reference the rebuilt client should reuse verbatim.
    const credentialsProvider = client.config.credentials;

    const rebuilt = await rebuildClientForBucketRegion(client as unknown as S3Client, 'b', {
      reuseClientCredentials: true,
    });

    expect(rebuilt).not.toBeNull();
    // Probe authenticated with the resolved credentials.
    expect(vi.mocked(resolveBucketRegion)).toHaveBeenCalledWith(
      'b',
      expect.objectContaining({ credentials: resolvedCreds, fallbackRegion: 'us-east-1' })
    );
    // Rebuilt client carries the ORIGINAL provider reference (not a resolved snapshot).
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2', credentials: credentialsProvider })
    );
  });

  it('tolerates a non-standard test-double client by returning null (ExportIndexStore graceful degradation)', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    // No `config` at all — a hand-rolled test double.
    const nonStandard = { send: vi.fn() };

    const rebuilt = await rebuildClientForBucketRegion(nonStandard as unknown as S3Client, 'b', {
      tolerateNonStandardClient: true,
    });

    expect(rebuilt).toBeNull();
    // Never probed nor rebuilt.
    expect(vi.mocked(resolveBucketRegion)).not.toHaveBeenCalled();
    expect(vi.mocked(S3Client)).not.toHaveBeenCalled();
  });

  it('does NOT pass credentials to the rebuilt client when none are supplied or reused', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const client = makeFakeClient('us-east-1');
    await rebuildClientForBucketRegion(client as unknown as S3Client, 'b');

    const builtWith = vi.mocked(S3Client).mock.calls[0][0] as { credentials?: unknown };
    expect(builtWith).not.toHaveProperty('credentials');
  });
});
