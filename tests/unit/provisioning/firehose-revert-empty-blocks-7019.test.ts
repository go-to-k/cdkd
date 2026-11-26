import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-firehose', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-firehose')>(
    '@aws-sdk/client-firehose'
  );
  return {
    ...actual,
    FirehoseClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
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

import {
  DescribeDeliveryStreamCommand,
  UpdateDestinationCommand,
  type ExtendedS3DestinationDescription,
} from '@aws-sdk/client-firehose';
import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';

const RESOURCE_TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const PHYSICAL_ID = 'my-stream';
const ROLE = 'arn:aws:iam::111:role/firehose-role';
const BUCKET = 'arn:aws:s3:::dest-bucket';
const PROCESSING = {
  Enabled: true,
  Processors: [
    {
      Type: 'Lambda',
      Parameters: [{ ParameterName: 'LambdaArn', ParameterValue: 'arn:aws:lambda:fn' }],
    },
  ],
};

// The template a CDK L2 `S3Bucket` destination synthesizes, as recorded.
const TEMPLATE = {
  BucketARN: BUCKET,
  RoleARN: ROLE,
  Prefix: 'fh/',
  BufferingHints: { IntervalInSeconds: 300, SizeInMBs: 5 },
};

// What `readCurrentState` emits for that stream after an out-of-band
// BufferingHints change, with the baseline's value overlaid: the shape
// `drift --revert` hands to `update()`. The four `{}` blocks are the
// readback's placeholders for blocks AWS reports none of.
const REVERT_DESIRED = {
  BucketARN: BUCKET,
  RoleARN: ROLE,
  Prefix: 'fh/',
  CompressionFormat: 'UNCOMPRESSED',
  BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
  EncryptionConfiguration: { NoEncryptionConfig: 'NoEncryption' },
  CloudWatchLoggingOptions: { Enabled: false },
  S3BackupMode: 'Disabled',
  ProcessingConfiguration: {},
  DataFormatConversionConfiguration: {},
  DynamicPartitioningConfiguration: {},
  S3BackupConfiguration: {},
};

let live: ExtendedS3DestinationDescription;

beforeEach(() => {
  live = {
    BucketARN: BUCKET,
    RoleARN: ROLE,
    BufferingHints: { SizeInMBs: 1, IntervalInSeconds: 60 },
    CompressionFormat: 'UNCOMPRESSED',
    EncryptionConfiguration: { NoEncryptionConfig: 'NoEncryption' },
  };
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeDeliveryStreamCommand) {
      return Promise.resolve({
        DeliveryStreamDescription: {
          DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
          DeliveryStreamStatus: 'ACTIVE',
          VersionId: '3',
          Destinations: [
            { DestinationId: 'destinationId-000000000001', ExtendedS3DestinationDescription: live },
          ],
        },
      });
    }
    return Promise.resolve({});
  });
});

async function revert(desired: Record<string, unknown>): Promise<Record<string, unknown>> {
  await new FirehoseProvider().update(
    'Fh',
    PHYSICAL_ID,
    RESOURCE_TYPE,
    { ExtendedS3DestinationConfiguration: desired },
    { ExtendedS3DestinationConfiguration: TEMPLATE },
    { desiredFromAwsReadback: true }
  );
  const updates = mockSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c instanceof UpdateDestinationCommand)
    .map((c) => (c as unknown as { input: Record<string, unknown> }).input);
  expect(updates).toHaveLength(1);
  return updates[0]!['ExtendedS3DestinationUpdate'] as Record<string, unknown>;
}

describe('FirehoseProvider.update — the readback placeholders a drift revert sends back (#7019)', () => {
  it('sends nothing for an empty block the live stream has none of', async () => {
    const sent = await revert(REVERT_DESIRED);
    // Measured: AWS refuses `S3BackupUpdate: {}` ("Bucket ARN is required"),
    // reads `DataFormatConversionConfiguration: {}` as enabled, and writes
    // explicit disabled defaults for the other two.
    expect(sent).not.toHaveProperty('S3BackupUpdate');
    expect(sent).not.toHaveProperty('DataFormatConversionConfiguration');
    expect(sent).not.toHaveProperty('ProcessingConfiguration');
    expect(sent).not.toHaveProperty('DynamicPartitioningConfiguration');
    // The drifted member still reaches AWS.
    expect(sent['BufferingHints']).toEqual({ SizeInMBs: 5, IntervalInSeconds: 300 });
    expect(sent['BucketARN']).toBe(BUCKET);
  });

  it('disables processing and data format conversion the live stream has enabled', async () => {
    live.ProcessingConfiguration = PROCESSING as ExtendedS3DestinationDescription['ProcessingConfiguration'];
    live.DataFormatConversionConfiguration = { Enabled: true };
    live.DynamicPartitioningConfiguration = { Enabled: true };
    const sent = await revert(REVERT_DESIRED);
    expect(sent['ProcessingConfiguration']).toEqual({ Enabled: false });
    expect(sent['DataFormatConversionConfiguration']).toEqual({ Enabled: false });
    // Dynamic partitioning cannot be switched on a live stream either way.
    expect(sent).not.toHaveProperty('DynamicPartitioningConfiguration');
  });

  it('leaves an already-disabled block alone', async () => {
    live.ProcessingConfiguration = { Enabled: false, Processors: [] };
    live.DataFormatConversionConfiguration = { Enabled: false };
    const sent = await revert(REVERT_DESIRED);
    expect(sent).not.toHaveProperty('ProcessingConfiguration');
    expect(sent).not.toHaveProperty('DataFormatConversionConfiguration');
  });

  it('still forwards declared, non-empty blocks', async () => {
    const backup = { BucketARN: BUCKET, RoleARN: ROLE, Prefix: 'backup/' };
    const sent = await revert({
      ...REVERT_DESIRED,
      S3BackupMode: 'Enabled',
      S3BackupConfiguration: backup,
      ProcessingConfiguration: PROCESSING,
      DynamicPartitioningConfiguration: { Enabled: false },
    });
    expect(sent['S3BackupUpdate']).toEqual(backup);
    expect(sent['ProcessingConfiguration']).toEqual(PROCESSING);
    expect(sent['DynamicPartitioningConfiguration']).toEqual({ Enabled: false });
  });
});

describe('FirehoseProvider.canonicalizeDriftProperties — a disabled ExtendedS3 block is the empty placeholder (#7019)', () => {
  const provider = new FirehoseProvider();
  const canonical = (dest: Record<string, unknown>): Record<string, unknown> =>
    provider.canonicalizeDriftProperties(RESOURCE_TYPE, {
      ExtendedS3DestinationConfiguration: dest,
    })['ExtendedS3DestinationConfiguration'] as Record<string, unknown>;

  it('reads a block holding Enabled: false and only AWS fills as {}', () => {
    // Measured read-back after `UpdateDestination` disabled each block.
    expect(
      canonical({
        BucketARN: BUCKET,
        ProcessingConfiguration: { Enabled: false, Processors: [] },
        DataFormatConversionConfiguration: { Enabled: false },
        DynamicPartitioningConfiguration: {
          Enabled: false,
          RetryOptions: { DurationInSeconds: 300 },
        },
      })
    ).toEqual({
      BucketARN: BUCKET,
      ProcessingConfiguration: {},
      DataFormatConversionConfiguration: {},
      DynamicPartitioningConfiguration: {},
    });
  });

  it('keeps an enabled block, a disabled block with real members, and a changed fill', () => {
    const dest = {
      ProcessingConfiguration: PROCESSING,
      DataFormatConversionConfiguration: {
        Enabled: false,
        SchemaConfiguration: { DatabaseName: 'db', TableName: 't' },
      },
      DynamicPartitioningConfiguration: { Enabled: false, RetryOptions: { DurationInSeconds: 60 } },
    };
    expect(canonical(dest)).toEqual(dest);
    expect(
      canonical({ ProcessingConfiguration: { Enabled: false, Processors: PROCESSING.Processors } })
    ).toEqual({ ProcessingConfiguration: { Enabled: false, Processors: PROCESSING.Processors } });
  });

  it('returns the bag by identity when nothing applies', () => {
    const bag = { ExtendedS3DestinationConfiguration: { BucketARN: BUCKET } };
    expect(provider.canonicalizeDriftProperties(RESOURCE_TYPE, bag)).toBe(bag);
    const other = { HttpEndpointDestinationConfiguration: { RoleARN: ROLE } };
    expect(provider.canonicalizeDriftProperties(RESOURCE_TYPE, other)).toBe(other);
  });
});
