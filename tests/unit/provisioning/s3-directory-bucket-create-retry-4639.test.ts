import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: S3 Express `CreateBucket` calls carry no idempotency token, so the AWS SDK's own
// retry of a 5xx whose request had succeeded replayed them inside ONE `send`
// and collided with what the first send made. That "already exists" surfaced
// from the engine's first attempt and read as a name somebody else holds.

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    S3Client: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
  };
});
vi.mock('@aws-sdk/client-s3-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3-control')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    S3ControlClient: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
  };
});
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    STSClient: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
  };
});
vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    EC2Client: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
  };
});

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

import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { BucketAlreadyOwnedByYou, S3Client } from '@aws-sdk/client-s3';
import { AwsClients, getAwsClients, setAwsClients } from '../../../src/utils/aws-clients.js';
import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';
import { configsOf, topLevel, useService, type NamedCreate } from './data-create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './data-create-retry-4639-suite.js';

const CREATES: Record<string, NamedCreate> = {
  CreateBucketCommand: {
    nameOf: topLevel('Bucket'),
    // S3's wording never says "already exists".
    collision: () =>
      new BucketAlreadyOwnedByYou({
        message:
          'Your previous request to create the named bucket succeeded and you already own it.',
        $metadata: { httpStatusCode: 409 },
      }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::S3Express::DirectoryBucket',
    command: 'CreateBucketCommand',
    name: 'orders--euw3-az1--x-s3',
    props: {
      BucketName: 'orders--euw3-az1--x-s3',
      DataRedundancy: 'SingleAvailabilityZone',
      LocationName: 'euw3-az1',
    },
    provider: () => new S3DirectoryBucketProvider(),
    prose: false,
    successResponses: {},
    // EC2 resolves the zone id only inside create, after the switch.
    otherLazyClients: ['DescribeAvailabilityZonesCommand'],
  },
];

describeCreateRetrySafety(SITES, CREATES);

describe('S3 Express create client region read (issue #4639)', () => {
  let previous: AwsClients;
  beforeEach(() => {
    previous = getAwsClients();
    setAwsClients(new AwsClients({ region: 'eu-west-3' }));
    useService(async () => ({}));
  });
  afterEach(() => setAwsClients(previous));

  it('retries a rejected region read on the next create, then builds ONE client for every later create', async () => {
    const shared = getAwsClients().s3 as unknown as { config: { region: () => Promise<string> } };
    // The create client's region read is the LAST region read of a cold
    // provider's first create (the ARN build reads it first): count them on a
    // dry run, then fail exactly that one.
    let reads = 0;
    let failAt = 0;
    shared.config.region = () => {
      reads++;
      return reads === failAt
        ? Promise.reject(new Error('region unresolved'))
        : Promise.resolve('eu-west-3');
    };
    await new S3DirectoryBucketProvider().create('Res', SITES[0]!.type, SITES[0]!.props);
    failAt = reads + reads;
    const provider = new S3DirectoryBucketProvider();
    const built = () => vi.mocked(S3Client).mock.calls.length;
    const before = built();

    await expect(provider.create('Res', SITES[0]!.type, SITES[0]!.props)).rejects.toThrow(
      /region unresolved/
    );
    await provider.create('Res', SITES[0]!.type, SITES[0]!.props);
    await provider.create('Res', SITES[0]!.type, SITES[0]!.props);

    expect(built() - before).toBe(1);
    // The dry run's create, then the two that succeeded.
    expect(configsOf('CreateBucketCommand')).toHaveLength(3);
  });
});

describe('S3 Express create client region source (issue #4639)', () => {
  let previous: AwsClients;
  beforeEach(() => {
    previous = getAwsClients();
    // The ambient region differs from the shared client's: the create must
    // follow the shared client, where the provider's other bucket calls go.
    vi.stubEnv('AWS_REGION', 'ap-south-1');
    setAwsClients(new AwsClients({ region: 'eu-west-3' }));
    useService(async () => ({}));
  });
  afterEach(() => {
    setAwsClients(previous);
    vi.unstubAllEnvs();
  });

  it("lands CreateBucket in the shared S3 client's region, not the ambient one", async () => {
    await new S3DirectoryBucketProvider().create('Res', SITES[0]!.type, SITES[0]!.props);

    for (const config of configsOf('CreateBucketCommand')) {
      expect(await config.region()).toBe('eu-west-3');
    }
  });
});
