import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

// eu-west-1, not us-east-1, and the reason is a wire fact rather than a
// preference. Every case in this file turns on whether `CreateBucket` created
// the bucket, and us-east-1 is the one region where a 200 does not answer that:
// it replies to a re-create of a bucket you already own with a legacy 200 OK
// instead of `BucketAlreadyOwnedByYou` (`@aws-sdk/client-s3`
// `dist-types/models/errors.d.ts`). Two consequences: the adopt case below
// cannot receive that 409 from a us-east-1 client at all, and the provider runs
// an extra pre-flight probe there (issue #2241). Both belong to that issue and
// are fenced in `s3-bucket-provider-us-east-1-preflight.test.ts`; this file
// stays on the region where the 200/409 pair alone decides, so it keeps testing
// issue #376's gate rather than #2241's probe.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('eu-west-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';

class BucketAlreadyOwnedByYou extends Error {
  override name = 'BucketAlreadyOwnedByYou';
}

describe('S3BucketProvider partial-create cleanup (Issue #376)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
  });

  it('issues DeleteBucketCommand when applyConfiguration fails after CreateBucket succeeded', async () => {
    // The implementation calls CreateBucket, then applyConfiguration walks
    // sub-config paths in order: VersioningConfiguration → Tags →
    // OwnershipControls → PublicAccessBlock → BucketEncryption. With
    // `VersioningConfiguration: { Status: 'Enabled' }` set, the first
    // post-CreateBucket call is `PutBucketVersioningCommand`; reject it
    // to trigger the inner catch + cleanup.
    mockSend.mockResolvedValueOnce({}); // CreateBucketCommand
    mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom')); // first sub-config call
    mockSend.mockResolvedValueOnce({}); // DeleteBucketCommand cleanup

    await expect(
      provider.create('MyBucket', RESOURCE_TYPE, {
        BucketName: 'my-test-bucket-xxx',
        VersioningConfiguration: { Status: 'Enabled' },
      })
    ).rejects.toThrow('Failed to create S3 bucket');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names[0]).toBe('CreateBucketCommand');
    expect(names).toContain('DeleteBucketCommand');
    const deleteCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'DeleteBucketCommand'
    );
    expect(deleteCall?.[0].input).toEqual({ Bucket: 'my-test-bucket-xxx' });
  });

  it('does NOT issue DeleteBucketCommand when CreateBucket hit BucketAlreadyOwnedByYou (pre-existing bucket)', async () => {
    // Pre-existing bucket: CreateBucket throws BucketAlreadyOwnedByYou
    // (handled inline as idempotent success); a later sub-config failure
    // must NOT delete the bucket, since deleting it would destroy a
    // user resource that lived before this deploy.
    //
    // The GetBucketLocation primer is the issue #2227 region readback that now
    // sits between the two: `BucketAlreadyOwnedByYou` is raised on OWNERSHIP,
    // which is account-global, so the provider confirms the existing bucket is
    // in this stack's region before adopting it. This error carries no
    // `x-amz-bucket-region` header, so the readback takes the
    // `GetBucketLocation` fallback, and it must report this file's mocked
    // client region for the adopt to proceed at all.
    //
    // Without the primer the sub-config rejection below is consumed by the
    // readback instead, the run dies there, and the `DeleteBucketCommand`
    // assertion passes because `applyConfiguration` was never reached at all —
    // a vacuous pass. The `PutBucketVersioningCommand` assertion at the end is
    // what makes that regression fail loudly instead of going quiet again.
    mockSend.mockRejectedValueOnce(new BucketAlreadyOwnedByYou('you already own it'));
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'eu-west-1' }); // GetBucketLocation readback
    mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

    await expect(
      provider.create('MyBucket', RESOURCE_TYPE, {
        BucketName: 'my-test-bucket-xxx',
        VersioningConfiguration: { Status: 'Enabled' },
      })
    ).rejects.toThrow('Failed to create S3 bucket');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).not.toContain('DeleteBucketCommand');
    // Proves the run actually REACHED configuration, so the assertion above is
    // about the cleanup gate rather than about an early exit.
    expect(names).toContain('PutBucketVersioningCommand');
  });

  it('does NOT issue DeleteBucketCommand when CreateBucket itself fails with a non-AlreadyOwned error', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateBucket boom'));

    await expect(
      provider.create('MyBucket', RESOURCE_TYPE, {
        BucketName: 'my-test-bucket-xxx',
        VersioningConfiguration: { Status: 'Enabled' },
      })
    ).rejects.toThrow('Failed to create S3 bucket');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateBucketCommand');
  });

  it('re-throws the original error even when DeleteBucketCommand cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateBucketCommand
    mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteBucket also failed'));

    await expect(
      provider.create('MyBucket', RESOURCE_TYPE, {
        BucketName: 'my-test-bucket-xxx',
        VersioningConfiguration: { Status: 'Enabled' },
      })
    ).rejects.toThrow('applyConfiguration boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws s3api delete-bucket --bucket');
    expect(warnMsg).toContain('my-test-bucket-xxx');
  });
});
