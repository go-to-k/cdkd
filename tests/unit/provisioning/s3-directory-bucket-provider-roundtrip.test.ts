import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockS3Send = vi.fn();
const mockStsSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockS3Send, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';

const PHYSICAL_ID = 'my-bucket--use1-az1--x-s3';
const RESOURCE_TYPE = 'AWS::S3Express::DirectoryBucket';

describe('S3DirectoryBucketProvider read-update round-trip', () => {
  let provider: S3DirectoryBucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3DirectoryBucketProvider();
  });

  it('Class 1 — round-trip on observed snapshot does not push DataRedundancy back through AWS', async () => {
    // Mechanical guard for Class 1 placeholder regression on type-
    // discriminator-dependent fields. See docs/provider-development.md
    // § 3b "Read-update round-trip test".
    //
    // S3 Express Directory Buckets are immutable after create — every
    // user-controllable property (BucketName, LocationName, DataRedundancy)
    // is fixed at creation time. update() is documented as a no-op for
    // exactly this reason. This round-trip test guards the no-op
    // contract: even when observedProperties (from readCurrentState)
    // is fed back through update() as the new desired state,
    // update() must NOT issue ANY AWS-mutating SDK call. AWS would
    // reject any attempt to "update" an immutable bucket
    // configuration.

    const observed = {
      BucketName: PHYSICAL_ID,
      DataRedundancy: 'SingleAvailabilityZone',
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    // Assert: zero AWS SDK calls fired during the round-trip update.
    // The provider is a pure no-op for update — no PutBucket*, no
    // CreateBucket, no DeleteBucket, nothing.
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('round-trip on no-drift snapshot is a logical no-op (zero AWS calls)', async () => {
    // Stronger assertion: state == AWS implies update() must make no
    // AWS-side mutations. For an immutable resource type this holds
    // unconditionally regardless of which fields are present.
    const observed = {
      BucketName: PHYSICAL_ID,
      DataRedundancy: 'SingleAvailabilityZone',
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('round-trip with drifted DataRedundancy (hypothetical) still issues zero AWS calls', async () => {
    // Defensive: even if a future DataRedundancy value were added by
    // AWS (today only `SingleAvailabilityZone` is valid) and observed
    // != state, update() must still no-op rather than attempt an AWS
    // call that would 400 — DataRedundancy is immutable. The deploy
    // engine routes immutable-property changes through replacement
    // (DELETE then CREATE), not update().
    const oldProps = {
      BucketName: PHYSICAL_ID,
      DataRedundancy: 'SingleAvailabilityZone',
    };
    const newProps = {
      BucketName: PHYSICAL_ID,
      DataRedundancy: 'MultiAvailabilityZone', // hypothetical future value
    };

    const result = await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(result).toEqual({
      physicalId: PHYSICAL_ID,
      wasReplaced: false,
    });
  });
});
