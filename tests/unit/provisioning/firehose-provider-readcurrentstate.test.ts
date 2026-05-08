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

    // ExtendedS3 inner nested complex fields are now reverse-mapped (PR C).
    // EncryptionConfiguration is surfaced as the AWS-reported value (or
    // {} placeholder when AWS reports nothing); same for the others.
    // CloudWatchLoggingOptions in this fixture is `{Enabled: false}`,
    // so it surfaces verbatim.
    expect(result?.['ExtendedS3DestinationConfiguration']).toEqual({
      BucketARN: 'arn:aws:s3:::my-bucket',
      RoleARN: 'arn:aws:iam::1:role/firehose',
      Prefix: 'logs/',
      ErrorOutputPrefix: 'errors/',
      CompressionFormat: 'GZIP',
      BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
      S3BackupMode: 'Disabled',
      EncryptionConfiguration: { NoEncryptionConfig: 'NoEncryption' },
      CloudWatchLoggingOptions: { Enabled: false },
      ProcessingConfiguration: {},
      DataFormatConversionConfiguration: {},
      DynamicPartitioningConfiguration: {},
      S3BackupConfiguration: {},
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

    // EncryptionConfiguration / CloudWatchLoggingOptions placeholders
    // always emitted (even as {}) so the v3 baseline catches console-side
    // ADDs to a previously-default sub-shape.
    expect(result?.['S3DestinationConfiguration']).toEqual({
      BucketARN: 'arn:aws:s3:::my-bucket',
      RoleARN: 'arn:aws:iam::1:role/firehose',
      Prefix: 'logs/',
      CompressionFormat: 'UNCOMPRESSED',
      BufferingHints: { SizeInMBs: 1, IntervalInSeconds: 60 },
      EncryptionConfiguration: {},
      CloudWatchLoggingOptions: {},
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
      EncryptionConfiguration: {},
      CloudWatchLoggingOptions: {},
      ProcessingConfiguration: {},
      DataFormatConversionConfiguration: {},
      DynamicPartitioningConfiguration: {},
      S3BackupConfiguration: {},
    });
    expect(result?.['S3DestinationConfiguration']).toBeUndefined();
  });

  it('reverse-maps RedshiftDestinationDescription with nested S3Configuration via shared S3 mapper', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              DestinationId: 'destinationId-000000000001',
              RedshiftDestinationDescription: {
                ClusterJDBCURL: 'jdbc:redshift://cluster.example/db',
                RoleARN: 'arn:aws:iam::1:role/redshift',
                CopyCommand: { DataTableName: 'events' },
                Username: 'firehose-user',
                S3DestinationDescription: {
                  BucketARN: 'arn:aws:s3:::staging',
                  RoleARN: 'arn:aws:iam::1:role/redshift',
                  Prefix: 'redshift-staging/',
                },
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
    // Top-level RedshiftDestinationConfiguration with nested S3Configuration
    // shape (CFn input naming).
    expect(result?.['RedshiftDestinationConfiguration']).toEqual({
      ClusterJDBCURL: 'jdbc:redshift://cluster.example/db',
      RoleARN: 'arn:aws:iam::1:role/redshift',
      CopyCommand: { DataTableName: 'events' },
      Username: 'firehose-user',
      S3Configuration: {
        BucketARN: 'arn:aws:s3:::staging',
        RoleARN: 'arn:aws:iam::1:role/redshift',
        Prefix: 'redshift-staging/',
        EncryptionConfiguration: {},
        CloudWatchLoggingOptions: {},
      },
    });
  });
});

describe('FirehoseProvider.readCurrentState (S3 nested fields)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  it('surfaces ExtendedS3 ProcessingConfiguration with Processors[] structure intact', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              ExtendedS3DestinationDescription: {
                BucketARN: 'arn:aws:s3:::my-bucket',
                RoleARN: 'arn:aws:iam::1:role/firehose',
                ProcessingConfiguration: {
                  Enabled: true,
                  Processors: [
                    {
                      Type: 'Lambda',
                      Parameters: [
                        {
                          ParameterName: 'LambdaArn',
                          ParameterValue: 'arn:aws:lambda:us-east-1:1:function:transform',
                        },
                      ],
                    },
                  ],
                },
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
    const ext = result?.['ExtendedS3DestinationConfiguration'] as Record<string, unknown>;
    expect(ext['ProcessingConfiguration']).toEqual({
      Enabled: true,
      Processors: [
        {
          Type: 'Lambda',
          Parameters: [
            {
              ParameterName: 'LambdaArn',
              ParameterValue: 'arn:aws:lambda:us-east-1:1:function:transform',
            },
          ],
        },
      ],
    });
  });

  it('surfaces S3BackupConfiguration reverse-mapped from S3BackupDescription (always emit placeholder)', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              ExtendedS3DestinationDescription: {
                BucketARN: 'arn:aws:s3:::main',
                RoleARN: 'arn:aws:iam::1:role/firehose',
                S3BackupMode: 'Enabled',
                S3BackupDescription: {
                  BucketARN: 'arn:aws:s3:::backup',
                  RoleARN: 'arn:aws:iam::1:role/firehose-backup',
                  Prefix: 'failed/',
                  CompressionFormat: 'GZIP',
                },
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
    const ext = result?.['ExtendedS3DestinationConfiguration'] as Record<string, unknown>;
    expect(ext['S3BackupConfiguration']).toEqual({
      BucketARN: 'arn:aws:s3:::backup',
      RoleARN: 'arn:aws:iam::1:role/firehose-backup',
      Prefix: 'failed/',
      CompressionFormat: 'GZIP',
      // Inner-of-inner placeholders also emitted recursively.
      EncryptionConfiguration: {},
      CloudWatchLoggingOptions: {},
    });
    expect(ext['S3BackupMode']).toBe('Enabled');
  });

  it('surfaces DataFormatConversionConfiguration deep pass-through', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              ExtendedS3DestinationDescription: {
                BucketARN: 'arn:aws:s3:::my-bucket',
                DataFormatConversionConfiguration: {
                  Enabled: true,
                  SchemaConfiguration: {
                    DatabaseName: 'analytics',
                    TableName: 'events',
                    RoleARN: 'arn:aws:iam::1:role/glue',
                  },
                  InputFormatConfiguration: {
                    Deserializer: { OpenXJsonSerDe: {} },
                  },
                  OutputFormatConfiguration: {
                    Serializer: { ParquetSerDe: { Compression: 'SNAPPY' } },
                  },
                },
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
    const ext = result?.['ExtendedS3DestinationConfiguration'] as Record<string, unknown>;
    expect(ext['DataFormatConversionConfiguration']).toEqual({
      Enabled: true,
      SchemaConfiguration: {
        DatabaseName: 'analytics',
        TableName: 'events',
        RoleARN: 'arn:aws:iam::1:role/glue',
      },
      // OpenXJsonSerDe: {} drops to undefined via pickDefinedDeep's
      // empty-object filter; Deserializer becomes empty too and is
      // dropped. This is acceptable behavior — state that templated
      // OpenXJsonSerDe with no fields would match the v2-fallback
      // baseline post-`cdkd state refresh-observed`.
      OutputFormatConfiguration: {
        Serializer: { ParquetSerDe: { Compression: 'SNAPPY' } },
      },
    });
  });

  it('surfaces DynamicPartitioningConfiguration with RetryOptions sub-shape', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              ExtendedS3DestinationDescription: {
                BucketARN: 'arn:aws:s3:::my-bucket',
                DynamicPartitioningConfiguration: {
                  Enabled: true,
                  RetryOptions: { DurationInSeconds: 300 },
                },
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
    const ext = result?.['ExtendedS3DestinationConfiguration'] as Record<string, unknown>;
    expect(ext['DynamicPartitioningConfiguration']).toEqual({
      Enabled: true,
      RetryOptions: { DurationInSeconds: 300 },
    });
  });

  it('surfaces EncryptionConfiguration KMSEncryptionConfig path', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              ExtendedS3DestinationDescription: {
                BucketARN: 'arn:aws:s3:::my-bucket',
                EncryptionConfiguration: {
                  KMSEncryptionConfig: {
                    AWSKMSKeyARN: 'arn:aws:kms:us-east-1:1:key/abc',
                  },
                },
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
    const ext = result?.['ExtendedS3DestinationConfiguration'] as Record<string, unknown>;
    expect(ext['EncryptionConfiguration']).toEqual({
      KMSEncryptionConfig: {
        AWSKMSKeyARN: 'arn:aws:kms:us-east-1:1:key/abc',
      },
    });
  });
});

describe('FirehoseProvider.readCurrentState (non-S3 destinations)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  it('reverse-maps ElasticsearchDestinationDescription via pickDefinedDeep pass-through', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              ElasticsearchDestinationDescription: {
                RoleARN: 'arn:aws:iam::1:role/firehose',
                DomainARN: 'arn:aws:es:us-east-1:1:domain/mydomain',
                IndexName: 'logs',
                IndexRotationPeriod: 'OneDay',
                BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
                RetryOptions: { DurationInSeconds: 300 },
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
    expect(result?.['ElasticsearchDestinationConfiguration']).toEqual({
      RoleARN: 'arn:aws:iam::1:role/firehose',
      DomainARN: 'arn:aws:es:us-east-1:1:domain/mydomain',
      IndexName: 'logs',
      IndexRotationPeriod: 'OneDay',
      BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
      RetryOptions: { DurationInSeconds: 300 },
    });
  });

  it('strips AWS-managed VpcId from VpcConfigurationDescription and renames to VpcConfiguration', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              AmazonopensearchserviceDestinationDescription: {
                RoleARN: 'arn:aws:iam::1:role/firehose',
                DomainARN: 'arn:aws:es:us-east-1:1:domain/mydomain',
                IndexName: 'logs',
                VpcConfigurationDescription: {
                  RoleARN: 'arn:aws:iam::1:role/vpc-firehose',
                  SubnetIds: ['subnet-1', 'subnet-2'],
                  SecurityGroupIds: ['sg-1'],
                  // AWS-managed read-only — must be stripped.
                  VpcId: 'vpc-abc123',
                },
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
    const aoss = result?.['AmazonopensearchserviceDestinationConfiguration'] as Record<
      string,
      unknown
    >;
    expect(aoss['VpcConfiguration']).toEqual({
      RoleARN: 'arn:aws:iam::1:role/vpc-firehose',
      SubnetIds: ['subnet-1', 'subnet-2'],
      SecurityGroupIds: ['sg-1'],
      // VpcId stripped.
    });
    expect(aoss['VpcConfigurationDescription']).toBeUndefined();
  });

  it('reverse-maps SplunkDestinationDescription', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              SplunkDestinationDescription: {
                HECEndpoint: 'https://splunk.example.com:8088',
                HECEndpointType: 'Raw',
                HECToken: 'token-redacted',
                HECAcknowledgmentTimeoutInSeconds: 180,
                BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
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
    expect(result?.['SplunkDestinationConfiguration']).toEqual({
      HECEndpoint: 'https://splunk.example.com:8088',
      HECEndpointType: 'Raw',
      HECToken: 'token-redacted',
      HECAcknowledgmentTimeoutInSeconds: 180,
      BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
    });
  });

  it('reverse-maps HttpEndpointDestinationDescription with EndpointConfiguration (AccessKey absent — write-only)', async () => {
    // AWS strips AccessKey from HttpEndpointDescription. State that
    // carries AccessKey falls back to v2 baseline; declared in
    // getDriftUnknownPaths.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              HttpEndpointDestinationDescription: {
                RoleARN: 'arn:aws:iam::1:role/firehose',
                EndpointConfiguration: {
                  Url: 'https://endpoint.example.com/',
                  Name: 'partner-endpoint',
                  // AccessKey absent — AWS strips it.
                },
                BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 1 },
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
    expect(result?.['HttpEndpointDestinationConfiguration']).toEqual({
      RoleARN: 'arn:aws:iam::1:role/firehose',
      EndpointConfiguration: {
        Url: 'https://endpoint.example.com/',
        Name: 'partner-endpoint',
      },
      BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 1 },
    });
  });

  it('reverse-maps AmazonOpenSearchServerlessDestinationDescription', async () => {
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: 'mystream',
          Destinations: [
            {
              AmazonOpenSearchServerlessDestinationDescription: {
                RoleARN: 'arn:aws:iam::1:role/firehose',
                CollectionEndpoint: 'https://collection.endpoint',
                IndexName: 'logs',
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
    expect(result?.['AmazonOpenSearchServerlessDestinationConfiguration']).toEqual({
      RoleARN: 'arn:aws:iam::1:role/firehose',
      CollectionEndpoint: 'https://collection.endpoint',
      IndexName: 'logs',
    });
  });
});

describe('FirehoseProvider.getDriftUnknownPaths', () => {
  it('declares only write-only fields and DeliveryStreamEncryptionConfigurationInput as drift-unknown (non-S3 destinations now reverse-mapped)', () => {
    const provider = new FirehoseProvider();
    expect(provider.getDriftUnknownPaths()).toEqual([
      'RedshiftDestinationConfiguration.Password',
      'HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey',
      'DeliveryStreamEncryptionConfigurationInput',
    ]);
  });
});
