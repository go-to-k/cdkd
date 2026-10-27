import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import {
  CreateDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  UpdateDestinationCommand,
} from '@aws-sdk/client-firehose';
import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';

const RESOURCE_TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const PHYSICAL_ID = 'my-stream';
const ROLE = 'arn:aws:iam::111:role/firehose-role';
const BUCKET = 'arn:aws:s3:::dest-bucket';

function sentUpdates(): Record<string, unknown>[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c instanceof UpdateDestinationCommand)
    .map((c) => (c as unknown as { input: Record<string, unknown> }).input);
}

// A nested S3 configuration carrying every optional sub-field the reverse
// mapper forwards, and the bare form left after they are removed.
const S3_FULL = {
  BucketARN: BUCKET,
  RoleARN: ROLE,
  Prefix: 'backup/',
  ErrorOutputPrefix: 'backup-err/',
  CompressionFormat: 'GZIP',
  BufferingHints: { SizeInMBs: 10, IntervalInSeconds: 120 },
  CloudWatchLoggingOptions: { Enabled: true, LogGroupName: 'g', LogStreamName: 's' },
};
const S3_BARE = { BucketARN: BUCKET, RoleARN: ROLE };
const LOGGING = { Enabled: true, LogGroupName: 'g', LogStreamName: 's' };
const PROCESSING = {
  Enabled: true,
  Processors: [
    {
      Type: 'Lambda',
      Parameters: [{ ParameterName: 'LambdaArn', ParameterValue: 'arn:aws:lambda:fn' }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeDeliveryStreamCommand) {
      return Promise.resolve({
        DeliveryStreamDescription: {
          DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
          DeliveryStreamStatus: 'ACTIVE',
          VersionId: '3',
          Destinations: [{ DestinationId: 'destinationId-000000000001' }],
        },
      });
    }
    if (command instanceof CreateDeliveryStreamCommand) {
      return Promise.resolve({
        DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
      });
    }
    return Promise.resolve({});
  });
});

// Issue #1160: CloudFormation KEEPS a destination sub-field removed from the
// template (live A/B: ExtendedS3 and HttpEndpoint, with and without a sibling
// change forcing the update), because `UpdateDestination` merges and the
// CloudFormation handler sends no reset value. These cases pin that cdkd sends
// no reset value either: the payload is exactly the desired shape.
describe('FirehoseProvider.update — a removed destination sub-field is kept, as CloudFormation does (#1160)', () => {
  const cases: {
    destKey: string;
    updateKey: string;
    previous: Record<string, unknown>;
    desired: Record<string, unknown>;
    sent: Record<string, unknown>;
  }[] = [
    {
      destKey: 'ExtendedS3DestinationConfiguration',
      updateKey: 'ExtendedS3DestinationUpdate',
      previous: {
        BucketARN: BUCKET,
        RoleARN: ROLE,
        Prefix: 'data/',
        ErrorOutputPrefix: 'errors/',
        BufferingHints: { SizeInMBs: 10, IntervalInSeconds: 120 },
        CompressionFormat: 'GZIP',
        FileExtension: '.gz',
        CustomTimeZone: 'Asia/Tokyo',
        CloudWatchLoggingOptions: LOGGING,
        ProcessingConfiguration: PROCESSING,
      },
      desired: { BucketARN: BUCKET, RoleARN: ROLE, Prefix: 'data2/' },
      sent: { BucketARN: BUCKET, RoleARN: ROLE, Prefix: 'data2/' },
    },
    // go-to-k/cdkd#5439: a CloudFormation change set removing Prefix and
    // BufferingHints from a legacy S3DestinationConfiguration while adding
    // ErrorOutputPrefix kept both live values.
    {
      destKey: 'S3DestinationConfiguration',
      updateKey: 'S3DestinationUpdate',
      previous: S3_FULL,
      desired: { ...S3_BARE, CompressionFormat: 'UNCOMPRESSED' },
      sent: { ...S3_BARE, CompressionFormat: 'UNCOMPRESSED' },
    },
    {
      destKey: 'HttpEndpointDestinationConfiguration',
      updateKey: 'HttpEndpointDestinationUpdate',
      previous: {
        EndpointConfiguration: { Url: 'https://example.com/ingest', Name: 'ep-a' },
        RoleARN: ROLE,
        S3Configuration: S3_FULL,
        S3BackupMode: 'FailedDataOnly',
        BufferingHints: { SizeInMBs: 2, IntervalInSeconds: 120 },
        RetryOptions: { DurationInSeconds: 600 },
        RequestConfiguration: { ContentEncoding: 'GZIP' },
        CloudWatchLoggingOptions: LOGGING,
      },
      desired: {
        EndpointConfiguration: { Url: 'https://example.com/ingest', Name: 'ep-b' },
        RoleARN: ROLE,
        S3Configuration: S3_BARE,
      },
      sent: {
        EndpointConfiguration: { Url: 'https://example.com/ingest', Name: 'ep-b' },
        RoleARN: ROLE,
        S3Update: S3_BARE,
      },
    },
    {
      destKey: 'RedshiftDestinationConfiguration',
      updateKey: 'RedshiftDestinationUpdate',
      previous: {
        ClusterJDBCURL: 'jdbc:redshift://a.example.com:5439/db',
        RoleARN: ROLE,
        S3Configuration: S3_FULL,
        RetryOptions: { DurationInSeconds: 600 },
        CloudWatchLoggingOptions: LOGGING,
        ProcessingConfiguration: PROCESSING,
      },
      desired: {
        ClusterJDBCURL: 'jdbc:redshift://b.example.com:5439/db',
        RoleARN: ROLE,
        S3Configuration: S3_BARE,
      },
      sent: {
        ClusterJDBCURL: 'jdbc:redshift://b.example.com:5439/db',
        RoleARN: ROLE,
        S3Update: S3_BARE,
      },
    },
    {
      destKey: 'SplunkDestinationConfiguration',
      updateKey: 'SplunkDestinationUpdate',
      previous: {
        HECEndpoint: 'https://a.example.com',
        HECEndpointType: 'Raw',
        S3Configuration: S3_FULL,
        HECAcknowledgmentTimeoutInSeconds: 300,
        RetryOptions: { DurationInSeconds: 600 },
        BufferingHints: { SizeInMBs: 2, IntervalInSeconds: 120 },
        CloudWatchLoggingOptions: LOGGING,
      },
      desired: {
        HECEndpoint: 'https://b.example.com',
        HECEndpointType: 'Raw',
        S3Configuration: S3_BARE,
      },
      sent: { HECEndpoint: 'https://b.example.com', HECEndpointType: 'Raw', S3Update: S3_BARE },
    },
    {
      destKey: 'AmazonopensearchserviceDestinationConfiguration',
      updateKey: 'AmazonopensearchserviceDestinationUpdate',
      previous: {
        DomainARN: 'arn:aws:es:us-east-1:111:domain/d',
        IndexName: 'a',
        RoleARN: ROLE,
        S3Configuration: S3_FULL,
        IndexRotationPeriod: 'OneDay',
        TypeName: 't',
        BufferingHints: { SizeInMBs: 2, IntervalInSeconds: 120 },
        RetryOptions: { DurationInSeconds: 600 },
        CloudWatchLoggingOptions: LOGGING,
      },
      desired: {
        DomainARN: 'arn:aws:es:us-east-1:111:domain/d',
        IndexName: 'b',
        RoleARN: ROLE,
        S3Configuration: S3_BARE,
      },
      sent: {
        DomainARN: 'arn:aws:es:us-east-1:111:domain/d',
        IndexName: 'b',
        RoleARN: ROLE,
        S3Update: S3_BARE,
      },
    },
    {
      destKey: 'AmazonOpenSearchServerlessDestinationConfiguration',
      updateKey: 'AmazonOpenSearchServerlessDestinationUpdate',
      previous: {
        CollectionEndpoint: 'https://c.aoss.amazonaws.com',
        IndexName: 'a',
        RoleARN: ROLE,
        S3Configuration: S3_FULL,
        BufferingHints: { SizeInMBs: 2, IntervalInSeconds: 120 },
        RetryOptions: { DurationInSeconds: 600 },
        CloudWatchLoggingOptions: LOGGING,
      },
      desired: {
        CollectionEndpoint: 'https://c.aoss.amazonaws.com',
        IndexName: 'b',
        RoleARN: ROLE,
        S3Configuration: S3_BARE,
      },
      sent: {
        CollectionEndpoint: 'https://c.aoss.amazonaws.com',
        IndexName: 'b',
        RoleARN: ROLE,
        S3Update: S3_BARE,
      },
    },
    {
      destKey: 'ElasticsearchDestinationConfiguration',
      updateKey: 'ElasticsearchDestinationUpdate',
      previous: {
        DomainARN: 'arn:aws:es:us-east-1:111:domain/d',
        IndexName: 'a',
        RoleARN: ROLE,
        S3Configuration: S3_FULL,
        IndexRotationPeriod: 'OneDay',
        BufferingHints: { SizeInMBs: 2, IntervalInSeconds: 120 },
        CloudWatchLoggingOptions: LOGGING,
      },
      desired: {
        DomainARN: 'arn:aws:es:us-east-1:111:domain/d',
        IndexName: 'b',
        RoleARN: ROLE,
        S3Configuration: S3_BARE,
      },
      sent: {
        DomainARN: 'arn:aws:es:us-east-1:111:domain/d',
        IndexName: 'b',
        RoleARN: ROLE,
        S3Update: S3_BARE,
      },
    },
    {
      // The Iceberg Update shape keeps the name `S3Configuration` (#549).
      destKey: 'IcebergDestinationConfiguration',
      updateKey: 'IcebergDestinationUpdate',
      previous: {
        RoleARN: ROLE,
        CatalogConfiguration: { CatalogArn: 'arn:aws:glue:us-east-1:111:catalog' },
        S3Configuration: S3_FULL,
        AppendOnly: true,
        BufferingHints: { SizeInMBs: 2, IntervalInSeconds: 120 },
        RetryOptions: { DurationInSeconds: 600 },
        CloudWatchLoggingOptions: LOGGING,
      },
      desired: {
        RoleARN: 'arn:aws:iam::111:role/firehose-role-2',
        CatalogConfiguration: { CatalogArn: 'arn:aws:glue:us-east-1:111:catalog' },
        S3Configuration: S3_BARE,
      },
      sent: {
        RoleARN: 'arn:aws:iam::111:role/firehose-role-2',
        CatalogConfiguration: { CatalogArn: 'arn:aws:glue:us-east-1:111:catalog' },
        S3Configuration: S3_BARE,
      },
    },
    {
      destKey: 'SnowflakeDestinationConfiguration',
      updateKey: 'SnowflakeDestinationUpdate',
      previous: {
        AccountUrl: 'https://a.snowflakecomputing.com',
        Database: 'db',
        Schema: 'sc',
        Table: 'a',
        RoleARN: ROLE,
        S3Configuration: S3_FULL,
        MetaDataColumnName: 'meta',
        ContentColumnName: 'content',
        RetryOptions: { DurationInSeconds: 600 },
        BufferingHints: { SizeInMBs: 2, IntervalInSeconds: 120 },
        CloudWatchLoggingOptions: LOGGING,
      },
      desired: {
        AccountUrl: 'https://a.snowflakecomputing.com',
        Database: 'db',
        Schema: 'sc',
        Table: 'b',
        RoleARN: ROLE,
        S3Configuration: S3_BARE,
      },
      sent: {
        AccountUrl: 'https://a.snowflakecomputing.com',
        Database: 'db',
        Schema: 'sc',
        Table: 'b',
        RoleARN: ROLE,
        S3Update: S3_BARE,
      },
    },
  ];

  it.each(cases)(
    '$destKey: the payload carries only the desired fields',
    async ({ destKey, updateKey, previous, desired, sent }) => {
      await new FirehoseProvider().update(
        'L',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { [destKey]: desired },
        { [destKey]: previous }
      );
      const updates = sentUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0]![updateKey]).toEqual(sent);
    }
  );

  it('ExtendedS3: a removal with no other change still sends only the desired fields', async () => {
    // CloudFormation issues no UpdateDestination at all here (VersionId stayed
    // 1); cdkd's merge-only call leaves the same live result.
    await new FirehoseProvider().update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { ExtendedS3DestinationConfiguration: { BucketARN: BUCKET, RoleARN: ROLE } },
      {
        ExtendedS3DestinationConfiguration: {
          BucketARN: BUCKET,
          RoleARN: ROLE,
          Prefix: 'data/',
          CustomTimeZone: 'Asia/Tokyo',
          BufferingHints: { SizeInMBs: 10, IntervalInSeconds: 120 },
        },
      }
    );
    const updates = sentUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!['ExtendedS3DestinationUpdate']).toEqual({
      BucketARN: BUCKET,
      RoleARN: ROLE,
    });
  });
});

// The ExtendedS3 mappers dropped `FileExtension`, `CustomTimeZone` and
// `DynamicPartitioningConfiguration`: a create never applied them (CloudFormation
// does), and an update never changed them.
describe('FirehoseProvider ExtendedS3 — FileExtension / CustomTimeZone / DynamicPartitioningConfiguration', () => {
  const DYNAMIC = { Enabled: true, RetryOptions: { DurationInSeconds: 300 } };

  it('create forwards all three', async () => {
    await new FirehoseProvider().create('L', RESOURCE_TYPE, {
      DeliveryStreamName: PHYSICAL_ID,
      ExtendedS3DestinationConfiguration: {
        BucketARN: BUCKET,
        RoleARN: ROLE,
        Prefix: 'data/!{partitionKeyFromQuery:team}/',
        FileExtension: '.json',
        CustomTimeZone: 'Asia/Tokyo',
        DynamicPartitioningConfiguration: DYNAMIC,
      },
    });
    const create = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof CreateDeliveryStreamCommand) as
      | { input: Record<string, Record<string, unknown>> }
      | undefined;
    expect(create).toBeDefined();
    const dest = create!.input['ExtendedS3DestinationConfiguration']!;
    expect(dest['FileExtension']).toBe('.json');
    expect(dest['CustomTimeZone']).toBe('Asia/Tokyo');
    expect(dest['DynamicPartitioningConfiguration']).toEqual(DYNAMIC);
  });

  it('update sends a changed FileExtension and CustomTimeZone', async () => {
    await new FirehoseProvider().update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        ExtendedS3DestinationConfiguration: {
          BucketARN: BUCKET,
          RoleARN: ROLE,
          FileExtension: '.ndjson',
          CustomTimeZone: 'UTC',
        },
      },
      {
        ExtendedS3DestinationConfiguration: {
          BucketARN: BUCKET,
          RoleARN: ROLE,
          FileExtension: '.json',
          CustomTimeZone: 'Asia/Tokyo',
        },
      }
    );
    const updates = sentUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!['ExtendedS3DestinationUpdate']).toEqual({
      BucketARN: BUCKET,
      RoleARN: ROLE,
      FileExtension: '.ndjson',
      CustomTimeZone: 'UTC',
    });
  });

  it('update re-sends an unchanged DynamicPartitioningConfiguration with an unrelated change', async () => {
    // Omitting it on a dynamic-partitioning stream reads as "disable" and
    // UpdateDestination refuses the whole call.
    const prefix = 'data/!{partitionKeyFromQuery:team}/';
    await new FirehoseProvider().update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        ExtendedS3DestinationConfiguration: {
          BucketARN: BUCKET,
          RoleARN: ROLE,
          Prefix: prefix,
          ErrorOutputPrefix: 'errors-v2/',
          DynamicPartitioningConfiguration: DYNAMIC,
        },
      },
      {
        ExtendedS3DestinationConfiguration: {
          BucketARN: BUCKET,
          RoleARN: ROLE,
          Prefix: prefix,
          ErrorOutputPrefix: 'errors/',
          DynamicPartitioningConfiguration: DYNAMIC,
        },
      }
    );
    const updates = sentUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!['ExtendedS3DestinationUpdate']).toEqual({
      BucketARN: BUCKET,
      RoleARN: ROLE,
      Prefix: prefix,
      ErrorOutputPrefix: 'errors-v2/',
      DynamicPartitioningConfiguration: DYNAMIC,
    });
  });
});

// The same create-path gap on the other destinations: each field below was
// dropped from CreateDeliveryStream although the template declared it.
describe('FirehoseProvider create — every declared destination sub-field reaches CreateDeliveryStream', () => {
  const SECRETS = {
    Enabled: true,
    SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:s-Abc',
    RoleARN: ROLE,
  };
  const VPC = { RoleARN: ROLE, SubnetIds: ['subnet-1'], SecurityGroupIds: ['sg-1'] };
  const DOC_ID = { DefaultDocumentIdFormat: 'NO_DOCUMENT_ID' };

  const cases: {
    destKey: string;
    base: Record<string, unknown>;
    added: Record<string, unknown>;
    sent: Record<string, unknown>;
  }[] = [
    {
      destKey: 'HttpEndpointDestinationConfiguration',
      base: { EndpointConfiguration: { Url: 'https://e.example.com' }, S3Configuration: S3_BARE },
      added: { SecretsManagerConfiguration: SECRETS },
      sent: { SecretsManagerConfiguration: SECRETS },
    },
    {
      destKey: 'RedshiftDestinationConfiguration',
      base: {
        ClusterJDBCURL: 'jdbc:redshift://a.example.com:5439/db',
        RoleARN: ROLE,
        CopyCommand: { DataTableName: 't' },
        S3Configuration: S3_BARE,
      },
      added: {
        RetryOptions: { DurationInSeconds: 600 },
        S3BackupMode: 'Enabled',
        S3BackupConfiguration: { BucketArn: BUCKET, RoleArn: ROLE, Prefix: 'bk/' },
        SecretsManagerConfiguration: SECRETS,
      },
      sent: {
        RetryOptions: { DurationInSeconds: 600 },
        S3BackupMode: 'Enabled',
        S3BackupConfiguration: { BucketARN: BUCKET, RoleARN: ROLE, Prefix: 'bk/' },
        SecretsManagerConfiguration: SECRETS,
      },
    },
    {
      destKey: 'ElasticsearchDestinationConfiguration',
      base: { DomainARN: 'arn:aws:es:us-east-1:111:domain/d', IndexName: 'i', RoleARN: ROLE },
      added: { VpcConfiguration: VPC, DocumentIdOptions: DOC_ID },
      sent: { VpcConfiguration: VPC, DocumentIdOptions: DOC_ID },
    },
    {
      destKey: 'AmazonopensearchserviceDestinationConfiguration',
      base: { DomainARN: 'arn:aws:es:us-east-1:111:domain/d', IndexName: 'i', RoleARN: ROLE },
      added: { VpcConfiguration: VPC, DocumentIdOptions: DOC_ID },
      sent: { VpcConfiguration: VPC, DocumentIdOptions: DOC_ID },
    },
    {
      destKey: 'SplunkDestinationConfiguration',
      base: {
        HECEndpoint: 'https://s.example.com',
        HECEndpointType: 'Raw',
        S3Configuration: S3_BARE,
      },
      added: {
        BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
        SecretsManagerConfiguration: SECRETS,
      },
      sent: {
        BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
        SecretsManagerConfiguration: SECRETS,
      },
    },
    {
      destKey: 'AmazonOpenSearchServerlessDestinationConfiguration',
      base: {
        CollectionEndpoint: 'https://c.aoss.amazonaws.com',
        IndexName: 'i',
        RoleARN: ROLE,
        S3Configuration: S3_BARE,
      },
      added: { VpcConfiguration: VPC },
      sent: { VpcConfiguration: VPC },
    },
  ];

  it.each(cases)('$destKey', async ({ destKey, base, added, sent }) => {
    await new FirehoseProvider().create('L', RESOURCE_TYPE, {
      DeliveryStreamName: PHYSICAL_ID,
      [destKey]: { ...base, ...added },
    });
    const create = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof CreateDeliveryStreamCommand) as
      | { input: Record<string, Record<string, unknown>> }
      | undefined;
    expect(create).toBeDefined();
    expect(create!.input[destKey]).toMatchObject(sent);
  });
});
