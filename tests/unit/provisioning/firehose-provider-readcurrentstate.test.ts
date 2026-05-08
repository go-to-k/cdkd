import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeDeliveryStreamCommand,
  ListTagsForDeliveryStreamCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-firehose';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-firehose', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-firehose')>(
    '@aws-sdk/client-firehose'
  );
  return {
    ...actual,
    FirehoseClient: vi.fn().mockImplementation(() => ({
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

import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';

describe('FirehoseProvider.readCurrentState', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  it('returns CFn-shaped properties from DescribeDeliveryStream (happy path)', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          DeliveryStreamType: 'KinesisStreamAsSource',
          Source: {
            KinesisStreamSourceDescription: {
              KinesisStreamARN: 'arn:aws:kinesis:us-east-1:1:stream/src',
              RoleARN: 'arn:aws:iam::1:role/r',
            },
          },
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeDeliveryStreamCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForDeliveryStreamCommand);
    expect(result).toEqual({
      DeliveryStreamName: 'mystream',
      DeliveryStreamType: 'KinesisStreamAsSource',
      KinesisStreamSourceConfiguration: {
        KinesisStreamARN: 'arn:aws:kinesis:us-east-1:1:stream/src',
        RoleARN: 'arn:aws:iam::1:role/r',
      },
      Tags: [],
    });
  });

  it('returns undefined when stream is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );
    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );
    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsForDeliveryStream with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({ DeliveryStreamDescription: { DeliveryStreamName: 'mystream' } })
      .mockResolvedValueOnce({
        Tags: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyStream/Resource' },
        ],
      });

    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForDeliveryStream returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({ DeliveryStreamDescription: { DeliveryStreamName: 'mystream' } })
      .mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyStream/Resource' }],
      });

    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );
    expect(result?.Tags).toEqual([]);
  });

  it('surfaces ExtendedS3DestinationConfiguration top-level fields when AWS reports an Extended S3 destination', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          DeliveryStreamType: 'DirectPut',
          Destinations: [
            {
              DestinationId: 'destinationId-000000000001',
              ExtendedS3DestinationDescription: {
                BucketARN: 'arn:aws:s3:::my-bucket',
                RoleARN: 'arn:aws:iam::1:role/firehose',
                Prefix: 'logs/',
                ErrorOutputPrefix: 'errors/',
                CompressionFormat: 'GZIP',
                BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
                S3BackupMode: 'Disabled',
                // Inner nested fields AWS auto-fills — comparator will
                // skip these via getDriftUnknownPaths, NOT surfaced here.
                EncryptionConfiguration: { NoEncryptionConfig: 'NoEncryption' },
                CloudWatchLoggingOptions: { Enabled: false },
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );

    expect(result?.['ExtendedS3DestinationConfiguration']).toEqual({
      BucketARN: 'arn:aws:s3:::my-bucket',
      RoleARN: 'arn:aws:iam::1:role/firehose',
      Prefix: 'logs/',
      ErrorOutputPrefix: 'errors/',
      CompressionFormat: 'GZIP',
      BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
      S3BackupMode: 'Disabled',
    });
    expect(result?.['S3DestinationConfiguration']).toBeUndefined();
  });

  it('surfaces S3DestinationConfiguration top-level fields when AWS reports a legacy S3 destination', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          DeliveryStreamType: 'DirectPut',
          Destinations: [
            {
              DestinationId: 'destinationId-000000000001',
              S3DestinationDescription: {
                BucketARN: 'arn:aws:s3:::my-bucket',
                RoleARN: 'arn:aws:iam::1:role/firehose',
                Prefix: 'logs/',
                CompressionFormat: 'UNCOMPRESSED',
                BufferingHints: { SizeInMBs: 1, IntervalInSeconds: 60 },
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );

    expect(result?.['S3DestinationConfiguration']).toEqual({
      BucketARN: 'arn:aws:s3:::my-bucket',
      RoleARN: 'arn:aws:iam::1:role/firehose',
      Prefix: 'logs/',
      CompressionFormat: 'UNCOMPRESSED',
      BufferingHints: { SizeInMBs: 1, IntervalInSeconds: 60 },
    });
    expect(result?.['ExtendedS3DestinationConfiguration']).toBeUndefined();
  });

  it('prefers ExtendedS3 over legacy S3 when both shapes are present (defensive)', async () => {
    // AWS docs say the two shapes are mutually exclusive, but defensively
    // guard against both being set: ExtendedS3 is the modern shape, take it.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              S3DestinationDescription: { BucketARN: 'arn:aws:s3:::legacy' },
              ExtendedS3DestinationDescription: { BucketARN: 'arn:aws:s3:::modern' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );

    expect(result?.['ExtendedS3DestinationConfiguration']).toEqual({
      BucketARN: 'arn:aws:s3:::modern',
    });
    expect(result?.['S3DestinationConfiguration']).toBeUndefined();
  });

  it('omits destination key entirely for non-S3 destination types (drift-unknown)', async () => {
    // Non-S3 destinations stay drift-unknown for v1 — the comparator
    // skips them via getDriftUnknownPaths so a templated
    // RedshiftDestinationConfiguration in state does not fire false drift.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              DestinationId: 'destinationId-000000000001',
              RedshiftDestinationDescription: {
                ClusterJDBCURL: 'jdbc:redshift://...',
                RoleARN: 'arn:aws:iam::1:role/redshift',
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );

    expect(result?.['ExtendedS3DestinationConfiguration']).toBeUndefined();
    expect(result?.['S3DestinationConfiguration']).toBeUndefined();
    expect(result?.['RedshiftDestinationConfiguration']).toBeUndefined();
  });
});

describe('FirehoseProvider.getDriftUnknownPaths', () => {
  it('declares non-S3 destinations and S3 nested complex fields as drift-unknown', () => {
    const provider = new FirehoseProvider();
    expect(provider.getDriftUnknownPaths()).toEqual([
      'S3DestinationConfiguration.EncryptionConfiguration',
      'S3DestinationConfiguration.CloudWatchLoggingOptions',
      'ExtendedS3DestinationConfiguration.EncryptionConfiguration',
      'ExtendedS3DestinationConfiguration.CloudWatchLoggingOptions',
      'ExtendedS3DestinationConfiguration.ProcessingConfiguration',
      'ExtendedS3DestinationConfiguration.DataFormatConversionConfiguration',
      'ExtendedS3DestinationConfiguration.DynamicPartitioningConfiguration',
      'ExtendedS3DestinationConfiguration.S3BackupConfiguration',
      'RedshiftDestinationConfiguration',
      'ElasticsearchDestinationConfiguration',
      'AmazonopensearchserviceDestinationConfiguration',
      'SplunkDestinationConfiguration',
      'HttpEndpointDestinationConfiguration',
      'AmazonOpenSearchServerlessDestinationConfiguration',
      'DeliveryStreamEncryptionConfigurationInput',
    ]);
  });
});
