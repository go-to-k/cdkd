import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';

// Regression tests for issues #1195 / #1202: the custom-resource response
// bucket is cdkd's STATE bucket, which can live in a different region from
// the deploy region (account-scoped region-free default bucket). The
// provider must region-correct its S3 client (placeholder PutObject +
// pre-signed ResponseURL) via the shared rebuildClientForBucketRegion
// helper — pre-#1195 it blindly trusted the deploy region, so S3 returned a
// 301 PermanentRedirect on every cross-region deploy carrying a custom
// resource. Since #1202 setResponseBucket takes no region argument at all:
// correction always starts from the shared AwsClients.s3 client.

const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
/**
 * Stand-in for the STS client `getAccountInfo()` resolves the deploy account
 * through (issue #1866). A FIXED, non-empty `Account` — an empty / absent one
 * is what `getAccountInfo` flags `fabricated`, which is a different case with
 * its own arm.
 */
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    // Issue #1866: the synthetic `StackId` is built from `getAccountInfo()`,
    // which resolves the account through THIS bag's STS client. Without a
    // stand-in it reaches for a real one, and — because `getAccountInfo`
    // swallows its own failure — the provider silently answers `fabricated`
    // and warns on every invocation. Answering here keeps the provider off
    // real AWS AND keeps the account a proven one, which is the state every
    // case in this file assumes.
    sts: { send: mockStsSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

const mockGetSignedUrl = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

const mockRebuildClientForBucketRegion = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: mockRebuildClientForBucketRegion,
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

describe('CustomResourceProvider response-bucket region correction (issue #1195)', () => {
  let provider: CustomResourceProvider;
  const correctedSend = vi.fn();
  // A stand-in for the region-corrected S3Client the shared helper returns.
  const correctedClient = { send: correctedSend };

  beforeEach(() => {
    // Issue #2447's replication probe is cached per BUCKET for the process
    // lifetime; cleared so every test's per-client call count is the same.
    clearReplicationProbeCache();
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    mockGetSignedUrl.mockReset();
    mockGetSignedUrl.mockResolvedValue('https://s3.example.com/presigned-url');
    mockRebuildClientForBucketRegion.mockReset();
    correctedSend.mockReset();
    provider = new CustomResourceProvider();
  });

  /** Queue the mocks one successful direct-payload Lambda create consumes. */
  const queueSuccessfulCreate = (s3Mock: ReturnType<typeof vi.fn>): void => {
    s3Mock.mockResolvedValueOnce({}); // placeholder PutObject
    mockLambdaSend
      .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
      .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
      .mockResolvedValueOnce({
        Payload: Buffer.from(
          JSON.stringify({ PhysicalResourceId: 'phys-1195', Data: {} })
        ),
      });
    s3Mock.mockResolvedValueOnce({}); // cleanup DeleteObject
    // ...and the noncurrent-version purge that follows it (issue #2340). It is
    // part of the cleanup, so it must go through the SAME region-corrected
    // client — which is what the per-client call counts below now prove.
    s3Mock.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [], IsTruncated: false });
  };

  /**
   * S3 calls one successful create makes against the response bucket:
   * placeholder PutObject, cleanup DeleteObject, ListObjectVersions purge.
   *
   * Issue #2447's `GetBucketReplication` probe is NOT among them, and its
   * absence is a real assertion rather than an omission: the probe runs only
   * when the purge actually removed a noncurrent version, and this fixture's
   * listing returns none. A probe appearing here would mean cdkd had started
   * announcing a replica survival for a body that never existed.
   */
  const S3_OPS_PER_CREATE = 3;

  const createOnce = () =>
    provider.create('MyCustom', 'Custom::MyResource', {
      ServiceToken: 'arn:aws:lambda:us-west-2:123456789012:function:my-handler',
    });

  it('region-corrects the response S3 client before the placeholder PutObject and presign', async () => {
    provider.setResponseBucket('cdkd-state-123456789012');
    mockRebuildClientForBucketRegion.mockResolvedValueOnce(correctedClient);
    queueSuccessfulCreate(correctedSend);

    const result = await createOnce();

    expect(result.physicalId).toBe('phys-1195');
    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(1);
    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledWith(
      expect.anything(),
      'cdkd-state-123456789012',
      expect.objectContaining({
        reuseClientCredentials: true,
        tolerateNonStandardClient: true,
      })
    );
    // Every response-bucket S3 op must go through the corrected client:
    // the placeholder PutObject, the cleanup DeleteObject and the
    // noncurrent-version purge that follows it...
    expect(correctedSend).toHaveBeenCalledTimes(S3_OPS_PER_CREATE);
    expect(mockS3Send).not.toHaveBeenCalled();
    // ...and the pre-signed ResponseURL must be signed with it too (the
    // URL's host is region-specific — this is where the 301 originated).
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      correctedClient,
      expect.anything(),
      expect.anything()
    );
  });

  it('keeps the original client when no rebuild is needed (helper returns null)', async () => {
    provider.setResponseBucket('cdkd-state-123456789012');
    mockRebuildClientForBucketRegion.mockResolvedValueOnce(null);
    queueSuccessfulCreate(mockS3Send);

    const result = await createOnce();

    expect(result.physicalId).toBe('phys-1195');
    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(1);
    expect(mockS3Send).toHaveBeenCalledTimes(S3_OPS_PER_CREATE); // all on the original client
    expect(correctedSend).not.toHaveBeenCalled();
  });

  it('memoizes the probe: a second operation does not re-resolve the bucket region', async () => {
    provider.setResponseBucket('cdkd-state-123456789012');
    mockRebuildClientForBucketRegion.mockResolvedValueOnce(correctedClient);

    queueSuccessfulCreate(correctedSend);
    await createOnce();
    queueSuccessfulCreate(correctedSend);
    await createOnce();

    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after setResponseBucket is called again', async () => {
    provider.setResponseBucket('cdkd-state-123456789012');
    mockRebuildClientForBucketRegion.mockResolvedValue(correctedClient);

    queueSuccessfulCreate(correctedSend);
    await createOnce();

    provider.setResponseBucket('cdkd-state-123456789012');
    queueSuccessfulCreate(correctedSend);
    await createOnce();

    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(2);
  });

  it('discards a stale in-flight probe superseded by a setResponseBucket re-arm', async () => {
    // No region hint anywhere, so this.s3Client stays the mocked shared
    // client and no real S3Client is ever constructed.
    provider.setResponseBucket('bucket-a');
    let releaseProbe: (value: unknown) => void = () => {};
    mockRebuildClientForBucketRegion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve;
        })
    );

    queueSuccessfulCreate(mockS3Send);
    const first = createOnce();
    await new Promise((resolve) => setImmediate(resolve)); // probe for bucket-a is in flight

    // Re-arm mid-probe: the stale probe's result must NOT be committed.
    provider.setResponseBucket('bucket-b');
    const staleClient = { send: vi.fn(), destroy: vi.fn() };
    releaseProbe(staleClient);
    await first;

    // The stale client was discarded (destroyed, never adopted): the first
    // create's S3 ops went through the original shared client.
    expect(staleClient.destroy).toHaveBeenCalledTimes(1);
    expect(staleClient.send).not.toHaveBeenCalled();
    expect(mockS3Send).toHaveBeenCalledTimes(S3_OPS_PER_CREATE);

    // The next operation re-probes against the NEW bucket and adopts its
    // replacement normally.
    mockRebuildClientForBucketRegion.mockResolvedValueOnce(correctedClient);
    queueSuccessfulCreate(correctedSend);
    await createOnce();
    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(2);
    expect(mockRebuildClientForBucketRegion).toHaveBeenLastCalledWith(
      expect.anything(),
      'bucket-b',
      expect.anything()
    );
    expect(correctedSend).toHaveBeenCalledTimes(S3_OPS_PER_CREATE);
  });

  it('a stale probe settling while a successor probe is in flight does not clobber the successor (issue #1202)', async () => {
    // Pins the finally-block generation guard in ensureResponseClient: when
    // stale probe A (superseded by a re-arm) settles AFTER successor probe B
    // has already started, A's finally must NOT null out B's single-flight
    // promise — otherwise a third operation would start a redundant probe C.
    // Implementation-based mocks throughout (queued mocks interleave
    // non-deterministically across concurrent creates).
    mockLambdaSend.mockImplementation((cmd: { input?: { Payload?: Uint8Array } }) =>
      cmd?.input?.Payload
        ? Promise.resolve({
            Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-1202', Data: {} })),
          })
        : Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } })
    );
    mockS3Send.mockResolvedValue({});
    correctedSend.mockResolvedValue({});

    provider.setResponseBucket('bucket-a');
    let releaseA: (value: unknown) => void = () => {};
    mockRebuildClientForBucketRegion.mockImplementationOnce(
      () => new Promise((resolve) => (releaseA = resolve))
    );
    const first = createOnce(); // starts probe A (bucket-a)
    await new Promise((resolve) => setImmediate(resolve));

    provider.setResponseBucket('bucket-b'); // re-arm; A is now stale
    let releaseB: (value: unknown) => void = () => {};
    mockRebuildClientForBucketRegion.mockImplementationOnce(
      () => new Promise((resolve) => (releaseB = resolve))
    );
    const second = createOnce(); // starts probe B (bucket-b)
    await new Promise((resolve) => setImmediate(resolve));

    const staleClient = { send: vi.fn(), destroy: vi.fn() };
    releaseA(staleClient); // stale A settles while B is still in flight
    await first; // first proceeds on the original shared client

    // B's single-flight promise must have survived A's finally: a third
    // operation joins B instead of starting probe C.
    const third = createOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(2); // A + B only

    releaseB(correctedClient);
    await Promise.all([second, third]);

    expect(staleClient.destroy).toHaveBeenCalledTimes(1);
    expect(staleClient.send).not.toHaveBeenCalled();
    expect(mockS3Send).toHaveBeenCalledTimes(S3_OPS_PER_CREATE); // first op only
    expect(correctedSend).toHaveBeenCalledTimes(2 * S3_OPS_PER_CREATE); // second + third ops on B's client
  });

  it('shares one in-flight probe across concurrent operations', async () => {
    provider.setResponseBucket('cdkd-state-123456789012');
    let releaseProbe: (value: typeof correctedClient) => void = () => {};
    mockRebuildClientForBucketRegion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve;
        })
    );

    // Implementation-based mocks: two concurrent creates would interleave a
    // shared mockResolvedValueOnce queue non-deterministically.
    mockLambdaSend.mockImplementation((cmd: { input?: { Payload?: Uint8Array } }) =>
      cmd?.input?.Payload
        ? Promise.resolve({
            Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-1195', Data: {} })),
          })
        : Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } })
    );
    correctedSend.mockResolvedValue({});
    const first = createOnce();
    const second = createOnce();
    // Let both creates reach the awaited probe before releasing it.
    await new Promise((resolve) => setImmediate(resolve));
    releaseProbe(correctedClient);

    await Promise.all([first, second]);

    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(1);
    expect(correctedSend).toHaveBeenCalledTimes(2 * S3_OPS_PER_CREATE);
  });
});
