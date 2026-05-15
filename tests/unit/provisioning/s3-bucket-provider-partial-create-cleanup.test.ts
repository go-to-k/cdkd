import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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
    // sub-config paths (GetBucketTagging / PutBucketVersioning / etc).
    // The first post-CreateBucket call is a GetBucketTagging (read-side
    // probe inside applyConfiguration); reject it to trigger the inner
    // catch + cleanup.
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
    mockSend.mockRejectedValueOnce(new BucketAlreadyOwnedByYou('you already own it'));
    mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

    await expect(
      provider.create('MyBucket', RESOURCE_TYPE, {
        BucketName: 'my-test-bucket-xxx',
        VersioningConfiguration: { Status: 'Enabled' },
      })
    ).rejects.toThrow('Failed to create S3 bucket');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).not.toContain('DeleteBucketCommand');
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
