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

// What the AWS SDK's own region chain (env / shared config profile) resolves
// for a client constructed WITHOUT an explicit region. `us-east-1` is the
// default so the pre-#1763 tests below keep probing the endpoint they always
// probed; the #1763 block drives it explicitly.
let ambientRegion: string | undefined;

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation((cfg: unknown) => {
      s3ClientFactory(cfg);
      const explicit = (cfg as { region?: string } | undefined)?.region;
      return {
        send: mockSend,
        destroy: mockDestroy,
        // Mirrors the real client: `config.region()` reports the explicitly
        // configured region, or whatever the SDK's own chain resolved.
        config: { region: async (): Promise<string | undefined> => explicit ?? ambientRegion },
      };
    }),
  };
});

/** Every cfg handed to `new S3Client(...)` during the current test. */
function clientConfigs(): Array<{ region?: string; profile?: string; credentials?: unknown }> {
  return s3ClientFactory.mock.calls.map((call) => call[0] ?? {}) as Array<{
    region?: string;
    profile?: string;
    credentials?: unknown;
  }>;
}

describe('resolveBucketRegion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    ambientRegion = 'us-east-1';
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

  // -------------------------------------------------------------------------
  // Issue #1763: the GetBucketLocation probe was pinned to a hardcoded
  // us-east-1 endpoint, which is unreachable outside the commercial partition
  // — so in `aws-cn` / `us-iso*` the probe could not run at all, every call
  // fell through to the commercial default, and every state-bucket consumer
  // proceeded against the wrong region.
  //
  // Each non-commercial assertion is PAIRED with a commercial counter-case
  // asserting the pre-#1763 behavior is unchanged.
  // -------------------------------------------------------------------------
  describe('probe endpoint partition (issue #1763)', () => {
    it('aims the probe at the caller-supplied region (aws-cn)', async () => {
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'cn-northwest-1' });

      const region = await resolveBucketRegion('cn-bucket', { region: 'cn-north-1' });

      expect(region).toBe('cn-northwest-1');
      // One client only — no re-pin to us-east-1.
      expect(clientConfigs()).toEqual([{ region: 'cn-north-1' }]);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it('commercial counter-case: an explicit region is honored identically', async () => {
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'eu-west-1' });

      const region = await resolveBucketRegion('commercial-bucket', { region: 'us-west-2' });

      expect(region).toBe('eu-west-1');
      expect(clientConfigs()).toEqual([{ region: 'us-west-2' }]);
    });

    it('falls through to fallbackRegion for the probe endpoint (aws-us-gov)', async () => {
      // Every `rebuildClientForBucketRegion` consumer already passes
      // fallbackRegion, sourced from the client's own `config.region()`, so
      // the whole state-bucket family is fixed with no call-site change.
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-gov-east-1' });

      const region = await resolveBucketRegion('gov-bucket', { fallbackRegion: 'us-gov-west-1' });

      expect(region).toBe('us-gov-east-1');
      expect(clientConfigs()).toEqual([{ region: 'us-gov-west-1' }]);
    });

    it('prefers region over fallbackRegion when both are supplied', async () => {
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-isob-east-1' });

      const region = await resolveBucketRegion('iso-bucket', {
        region: 'us-iso-east-1',
        fallbackRegion: 'us-east-1',
      });

      expect(region).toBe('us-isob-east-1');
      expect(clientConfigs()).toEqual([{ region: 'us-iso-east-1' }]);
    });

    it('leaves the region to the SDK chain when the caller supplies none', async () => {
      // The chain reads AWS_REGION / the shared config profile — which every
      // cdkd command has already aligned with `--region` before this point.
      ambientRegion = 'cn-north-1';
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'cn-north-1' });

      const region = await resolveBucketRegion('ambient-bucket');

      expect(region).toBe('cn-north-1');
      // No `region` key at all — the SDK resolves its own.
      expect(clientConfigs()).toEqual([{}]);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it('pins us-east-1 when no region is configured anywhere (pre-#1763 behavior)', async () => {
      // A client whose chain yields nothing cannot send at all, so the historic
      // endpoint is restored rather than turning a working probe into a guess.
      ambientRegion = undefined;
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'ap-northeast-1' });

      const region = await resolveBucketRegion('no-region-bucket', {
        profile: 'my-profile',
      });

      expect(region).toBe('ap-northeast-1');
      expect(clientConfigs()).toEqual([
        { profile: 'my-profile' },
        // Auth must survive the re-pin, or the probe 403s instead of resolving.
        { region: 'us-east-1', profile: 'my-profile' },
      ]);
      expect(mockDestroy).toHaveBeenCalledTimes(2);
    });

    it('returns the probed region — not us-east-1 — when a non-commercial probe fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('network error'));

      const region = await resolveBucketRegion('unreachable-cn-bucket', {
        region: 'cn-north-1',
      });

      expect(region).toBe('cn-north-1');
    });

    it('commercial counter-case: a failed probe with no region opts still returns us-east-1', async () => {
      mockSend.mockRejectedValueOnce(new Error('network error'));

      const region = await resolveBucketRegion('unreachable-commercial-bucket');

      expect(region).toBe('us-east-1');
    });

    it('still prefers an explicit fallbackRegion over the probe region on failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('network error'));

      const region = await resolveBucketRegion('fallback-wins-bucket', {
        region: 'cn-north-1',
        fallbackRegion: 'cn-northwest-1',
      });

      expect(region).toBe('cn-northwest-1');
    });

    it('does NOT cache a failed probe — a later call re-probes and heals', async () => {
      mockSend
        .mockRejectedValueOnce(new Error('transient throttle'))
        .mockResolvedValueOnce({ LocationConstraint: 'eu-central-1' });

      const first = await resolveBucketRegion('healing-bucket', { region: 'eu-west-1' });
      const second = await resolveBucketRegion('healing-bucket', { region: 'eu-west-1' });

      // The guess is not pinned for the process lifetime.
      expect(first).toBe('eu-west-1');
      expect(second).toBe('eu-central-1');
      expect(mockSend).toHaveBeenCalledTimes(2);

      // ... and the healed answer IS cached.
      const third = await resolveBucketRegion('healing-bucket', { region: 'eu-west-1' });
      expect(third).toBe('eu-central-1');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('still collapses concurrent callers onto ONE failing probe', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));

      const [a, b, c] = await Promise.all([
        resolveBucketRegion('concurrent-failure', { region: 'us-west-2' }),
        resolveBucketRegion('concurrent-failure', { region: 'us-west-2' }),
        resolveBucketRegion('concurrent-failure', { region: 'us-west-2' }),
      ]);

      expect([a, b, c]).toEqual(['us-west-2', 'us-west-2', 'us-west-2']);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
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
    ambientRegion = 'us-east-1';
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
