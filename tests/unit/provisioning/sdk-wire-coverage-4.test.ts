import { describe, expect, it, vi } from 'vite-plus/test';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { STSClient } from '@aws-sdk/client-sts';
import { S3Client } from '@aws-sdk/client-s3';
import { IAMClient } from '@aws-sdk/client-iam';
import { describeWireCases, record, setOutputOverrides } from './sdk-wire-harness.js';
import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';

// The client classes the fourth batch reaches (`sdk-wire-cases-4.ts`), wrapped
// as in `sdk-wire-coverage.test.ts`: every instance, shared or provider-built
// (the directory bucket's create, S3 Control and EC2 clients), is captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-cloudwatch-logs', (orig) => wrap(orig, 'CloudWatchLogsClient'));
vi.mock('@aws-sdk/client-sts', (orig) => wrap(orig, 'STSClient'));
vi.mock('@aws-sdk/client-iam', (orig) => wrap(orig, 'IAMClient'));
vi.mock('@aws-sdk/client-s3', (orig) => wrap(orig, 'S3Client'));
vi.mock('@aws-sdk/client-s3-control', (orig) => wrap(orig, 'S3ControlClient'));
vi.mock('@aws-sdk/client-ec2', (orig) => wrap(orig, 'EC2Client'));

const clients = {
  cloudWatchLogs: new CloudWatchLogsClient({}),
  sts: new STSClient({}),
  s3: new S3Client({}),
  iam: new IAMClient({}),
  credentialConfig: {},
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_4 } from './sdk-wire-cases-4.js';

describe('SDK wire coverage (batch 4)', () => {
  describeWireCases(CASES_4);
});

// The location type DERIVED from DataRedundancy is read here: no bag path
// names it, and the `create-vary` probe varies DataRedundancy to a value no
// zone type maps from. A Local Zone bucket must say `LocalZone`, a zonal one
// `AvailabilityZone` (go-to-k/cdkd#5317).
describe('AWS::S3Express::DirectoryBucket DataRedundancy and Location.Type on create', () => {
  it.each([
    ['SingleAvailabilityZone', 'use1-az4', 'AvailabilityZone'],
    ['SingleLocalZone', 'use1-mia2-az1', 'LocalZone'],
  ])('%s in %s sends Location.Type %s', async (dataRedundancy, zone, locationType) => {
    setOutputOverrides(undefined);
    const outcome = await record(() =>
      new S3DirectoryBucketProvider().create('L', 'AWS::S3Express::DirectoryBucket', {
        BucketName: `b--${zone}--x-s3`,
        LocationName: zone,
        DataRedundancy: dataRedundancy,
      })
    );
    expect(outcome).toMatchObject({ threw: false });
    const create = (outcome as { wire: string }).wire
      .split('\n')
      .find((line) => line.startsWith('["CreateBucketCommand"'));
    expect(create).toContain(`<Type>${locationType}</Type>`);
    expect(create).toContain(`<DataRedundancy>${dataRedundancy}</DataRedundancy>`);
  });
});
