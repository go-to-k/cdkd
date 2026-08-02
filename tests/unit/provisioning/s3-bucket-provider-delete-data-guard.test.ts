import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'my-data-bucket';

const AUTO_DELETE_TAG_PROPS = {
  Tags: [{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }],
};

function bucketNotEmptyError(): Error {
  const err = new Error('The bucket you tried to delete is not empty');
  err.name = 'BucketNotEmpty';
  return err;
}

/**
 * Dispatch: DeleteBucket rejects BucketNotEmpty until `emptied` flips;
 * ListObjectVersions returns one version; DeleteObjects flips `emptied`.
 */
function installNonEmptyBucketDispatch(): void {
  let emptied = false;
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'DeleteBucketCommand':
        return emptied ? Promise.resolve({}) : Promise.reject(bucketNotEmptyError());
      case 'ListObjectVersionsCommand':
        return Promise.resolve({
          Versions: [{ Key: 'doc.txt', VersionId: 'v1' }],
          DeleteMarkers: [],
          IsTruncated: false,
        });
      case 'DeleteObjectsCommand':
        emptied = true;
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  });
}

function sentCommandNames(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
}

describe('S3BucketProvider delete data guard (issue #1340)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
  });

  it('refuses to empty a non-empty bucket without an auto-delete opt-in (CFn parity)', async () => {
    installNonEmptyBucketDispatch();

    await expect(
      provider.delete('Bucket', BUCKET, RESOURCE_TYPE, { BucketName: BUCKET }, undefined)
    ).rejects.toThrow(ProvisioningError);

    // Retry once to assert on the message too (fresh dispatch state).
    installNonEmptyBucketDispatch();
    await expect(
      provider.delete('Bucket', BUCKET, RESOURCE_TYPE, { BucketName: BUCKET }, undefined)
    ).rejects.toThrow(/not empty.*autoDeleteObjects/s);

    // The guard must fire WITHOUT deleting any data.
    const names = sentCommandNames();
    expect(names).not.toContain('DeleteObjectsCommand');
    expect(names).not.toContain('ListObjectVersionsCommand');
  });

  it('empties and deletes when the CDK auto-delete-objects tag is present', async () => {
    installNonEmptyBucketDispatch();

    await provider.delete('Bucket', BUCKET, RESOURCE_TYPE, AUTO_DELETE_TAG_PROPS, undefined);

    const names = sentCommandNames();
    expect(names).toContain('ListObjectVersionsCommand');
    expect(names).toContain('DeleteObjectsCommand');
    expect(names.filter((n) => n === 'DeleteBucketCommand').length).toBeGreaterThanOrEqual(2);
  });

  it('empties and deletes when the caller passes forceDataDelete (replacement consent)', async () => {
    installNonEmptyBucketDispatch();

    await provider.delete(
      'Bucket',
      BUCKET,
      RESOURCE_TYPE,
      { BucketName: BUCKET },
      { forceDataDelete: true }
    );

    expect(sentCommandNames()).toContain('DeleteObjectsCommand');
  });

  it('ignores an auto-delete tag whose value is not truthy', async () => {
    installNonEmptyBucketDispatch();

    await expect(
      provider.delete(
        'Bucket',
        BUCKET,
        RESOURCE_TYPE,
        { Tags: [{ Key: 'aws-cdk:auto-delete-objects', Value: 'false' }] },
        undefined
      )
    ).rejects.toThrow(/not empty/);

    expect(sentCommandNames()).not.toContain('DeleteObjectsCommand');
  });

  it('deletes an already-empty bucket without any opt-in (unchanged fast path)', async () => {
    mockSend.mockResolvedValue({});

    await provider.delete('Bucket', BUCKET, RESOURCE_TYPE, { BucketName: BUCKET }, undefined);

    expect(sentCommandNames()).toEqual(['DeleteBucketCommand']);
  });
});
