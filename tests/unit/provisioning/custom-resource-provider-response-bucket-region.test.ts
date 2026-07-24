import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Regression tests for issue #1195: the custom-resource response bucket is
// cdkd's STATE bucket, which can live in a different region from the deploy
// region (account-scoped region-free default bucket). The provider must
// region-correct its S3 client (placeholder PutObject + pre-signed
// ResponseURL) via the shared rebuildClientForBucketRegion helper instead of
// blindly trusting the deploy region passed by deploy.ts — otherwise S3
// returns a 301 PermanentRedirect on every cross-region deploy that carries
// a custom resource.

const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
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
  };

  const createOnce = () =>
    provider.create('MyCustom', 'Custom::MyResource', {
      ServiceToken: 'arn:aws:lambda:us-west-2:123456789012:function:my-handler',
    });

  it('region-corrects the response S3 client before the placeholder PutObject and presign', async () => {
    provider.setResponseBucket('cdkd-state-123456789012', 'us-west-2');
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
    // the placeholder PutObject + cleanup DeleteObject...
    expect(correctedSend).toHaveBeenCalledTimes(2);
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
    expect(mockS3Send).toHaveBeenCalledTimes(2); // placeholder + cleanup on the original client
    expect(correctedSend).not.toHaveBeenCalled();
  });

  it('memoizes the probe: a second operation does not re-resolve the bucket region', async () => {
    provider.setResponseBucket('cdkd-state-123456789012', 'us-west-2');
    mockRebuildClientForBucketRegion.mockResolvedValueOnce(correctedClient);

    queueSuccessfulCreate(correctedSend);
    await createOnce();
    queueSuccessfulCreate(correctedSend);
    await createOnce();

    expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after setResponseBucket is called again', async () => {
    provider.setResponseBucket('cdkd-state-123456789012', 'us-west-2');
    mockRebuildClientForBucketRegion.mockResolvedValue(correctedClient);

    queueSuccessfulCreate(correctedSend);
    await createOnce();

    provider.setResponseBucket('cdkd-state-123456789012', 'us-west-2');
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
    expect(mockS3Send).toHaveBeenCalledTimes(2); // placeholder + cleanup

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
    expect(correctedSend).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe across concurrent operations', async () => {
    provider.setResponseBucket('cdkd-state-123456789012', 'us-west-2');
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
    expect(correctedSend).toHaveBeenCalledTimes(4); // 2 ops x (placeholder + cleanup)
  });
});
