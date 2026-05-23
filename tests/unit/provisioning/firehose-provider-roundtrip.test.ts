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
  DescribeDeliveryStreamCommand,
  TagDeliveryStreamCommand,
  UntagDeliveryStreamCommand,
  UpdateDestinationCommand,
} from '@aws-sdk/client-firehose';
import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const PHYSICAL_ID = 'my-stream';

describe('FirehoseProvider read-update round-trip', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  it('Class 1 — DirectPut readCurrentState does NOT emit KinesisStreamSourceConfiguration', async () => {
    // Mechanical guard for Class 1 placeholder regression on type-
    // discriminator-dependent fields. See docs/provider-development.md
    // § 3b "Read-update round-trip test".
    //
    // KinesisStreamSourceConfiguration is only valid when
    // DeliveryStreamType === 'KinesisStreamAsSource'. AWS only returns
    // Source.KinesisStreamSourceDescription on streams of that type, so
    // a DirectPut stream's snapshot must NOT contain the source key —
    // otherwise --revert (if Firehose ever supported update) or any
    // future re-creation pathway would push a Class 1 invalid value.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: PHYSICAL_ID,
          DeliveryStreamType: 'DirectPut',
          // Source intentionally absent — DirectPut has no source.
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const observed = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);
    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty('KinesisStreamSourceConfiguration');
    expect(observed?.DeliveryStreamType).toBe('DirectPut');
  });

  it('Class 1 — KinesisStreamAsSource emits KinesisStreamSourceConfiguration on the discriminator-true path', async () => {
    // Complement to the DirectPut test: the field MUST appear when the
    // discriminator is true, otherwise drift detection misses
    // console-side source-arn / role-arn changes.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: PHYSICAL_ID,
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

    const observed = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);
    expect(observed?.KinesisStreamSourceConfiguration).toEqual({
      KinesisStreamARN: 'arn:aws:kinesis:us-east-1:1:stream/src',
      RoleARN: 'arn:aws:iam::1:role/r',
    });
  });

  it('always emits Tags (even when ListTagsForDeliveryStream fails on a non-NotFound error)', async () => {
    // Per docs/provider-development.md § 3b: omitting `Tags` on the
    // failure path means the comparator's state-keys-only walk skips
    // Tags forever, hiding console-side tag adds from drift on the
    // unlucky run that hit the Tags API throttle.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: PHYSICAL_ID,
          DeliveryStreamType: 'DirectPut',
        },
      })
      .mockRejectedValueOnce(new Error('throttled'));

    const observed = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);
    expect(observed).toBeDefined();
    expect(observed?.Tags).toEqual([]);
  });

  it('round-trip: update() no-op when before/after are identical (no destination + no tag diff) — only DescribeDeliveryStream for attributes', async () => {
    // Per #477 the previous "always reject" guarantee no longer holds:
    // update() supports Tags diff + ExtendedS3 UpdateDestination. A
    // zero-diff call should not issue any mutating AWS calls and should
    // still return a valid ResourceUpdateResult.
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: `arn:aws:firehose:us-east-1:111:deliverystream/${PHYSICAL_ID}`,
            VersionId: '1',
            Destinations: [{ DestinationId: 'destinationId-000000000001' }],
          },
        });
      }
      return Promise.resolve({});
    });
    const observed = {
      DeliveryStreamName: PHYSICAL_ID,
      DeliveryStreamType: 'DirectPut',
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    const result = await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);
    expect(result.wasReplaced).toBe(false);
    expect(result.physicalId).toBe(PHYSICAL_ID);
    expect(result.attributes['Arn']).toBe(
      `arn:aws:firehose:us-east-1:111:deliverystream/${PHYSICAL_ID}`
    );

    // No mutating calls should fire — only DescribeDeliveryStream (for
    // the final attribute fetch).
    const mutatingCommands = mockSend.mock.calls.filter(
      (c) =>
        c[0] instanceof TagDeliveryStreamCommand ||
        c[0] instanceof UntagDeliveryStreamCommand ||
        c[0] instanceof UpdateDestinationCommand
    );
    expect(mutatingCommands).toHaveLength(0);
  });
});

// #477: in-place updates for Firehose delivery streams.
describe('FirehoseProvider.update — Tags diff (#477)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '1',
            Destinations: [{ DestinationId: 'destinationId-000000000001' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues TagDeliveryStream for added entries and UntagDeliveryStream for removed', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { Tags: [{ Key: 'env', Value: 'prod' }, { Key: 'tier', Value: 'web' }] },
      { Tags: [{ Key: 'env', Value: 'dev' }, { Key: 'owner', Value: 'team-a' }] }
    );

    const untags = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UntagDeliveryStreamCommand);
    expect(untags).toHaveLength(1);
    expect((untags[0] as unknown as { input: Record<string, unknown> }).input['TagKeys']).toEqual([
      'owner',
    ]);

    const tags = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof TagDeliveryStreamCommand);
    expect(tags).toHaveLength(1);
    expect((tags[0] as unknown as { input: Record<string, unknown> }).input['Tags']).toEqual([
      { Key: 'env', Value: 'prod' }, // changed
      { Key: 'tier', Value: 'web' }, // added
    ]);
  });

  it('no-ops when Tags before/after are identical', async () => {
    const tags = [{ Key: 'env', Value: 'prod' }];
    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, { Tags: tags }, { Tags: tags });

    const mutating = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagDeliveryStreamCommand || c[0] instanceof UntagDeliveryStreamCommand
    );
    expect(mutating).toHaveLength(0);
  });
});

describe('FirehoseProvider.update — ExtendedS3 destination (#477)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '7',
            Destinations: [{ DestinationId: 'destinationId-000000000042' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with the resolved VersionId + DestinationId and the new ExtendedS3 shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        ExtendedS3DestinationConfiguration: {
          BucketArn: 'arn:aws:s3:::dest-bucket',
          RoleArn: 'arn:aws:iam::111:role/firehose-role',
          Prefix: 'logs/v2/',
          BufferingHints: { SizeInMBs: 64, IntervalInSeconds: 60 },
        },
      },
      {
        ExtendedS3DestinationConfiguration: {
          BucketArn: 'arn:aws:s3:::dest-bucket',
          RoleArn: 'arn:aws:iam::111:role/firehose-role',
          Prefix: 'logs/v1/',
          BufferingHints: { SizeInMBs: 64, IntervalInSeconds: 60 },
        },
      }
    );

    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['DeliveryStreamName']).toBe(PHYSICAL_ID);
    expect(input['CurrentDeliveryStreamVersionId']).toBe('7');
    expect(input['DestinationId']).toBe('destinationId-000000000042');
    expect(input['ExtendedS3DestinationUpdate']).toEqual({
      BucketARN: 'arn:aws:s3:::dest-bucket',
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      Prefix: 'logs/v2/',
      BufferingHints: { SizeInMBs: 64, IntervalInSeconds: 60 },
    });
  });

  it('no-ops when ExtendedS3 destination before/after are identical', async () => {
    const dest = {
      BucketArn: 'arn:aws:s3:::dest-bucket',
      RoleArn: 'arn:aws:iam::111:role/firehose-role',
      Prefix: 'logs/',
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { ExtendedS3DestinationConfiguration: dest },
      { ExtendedS3DestinationConfiguration: dest }
    );

    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('rejects destination-type SWITCH (ExtendedS3 → Redshift) with a tightened error', async () => {
    await expect(
      provider.update(
        'L',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        {
          RedshiftDestinationConfiguration: { ClusterJDBCURL: 'jdbc:redshift://...' },
        },
        {
          ExtendedS3DestinationConfiguration: {
            BucketArn: 'arn:aws:s3:::dest-bucket',
            RoleArn: 'arn:aws:iam::111:role/firehose-role',
          },
        }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
  });

  it('rejects unsupported destination diffs (legacy S3DestinationConfiguration) with a tightened error that names the destination type', async () => {
    // After #549's bundle PR closes the 7 follow-ups, every modern
    // destination type has an in-place reverse-mapper. Only the legacy
    // `S3DestinationConfiguration` (deprecated by AWS in favor of
    // ExtendedS3) remains in `findDestinationKey` without a supported
    // reverse-mapper — CDK constructs always emit Extended, so this
    // rejection path only fires for hand-authored templates that still
    // pin the legacy shape.
    await expect(
      provider.update(
        'L',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        {
          S3DestinationConfiguration: {
            BucketARN: 'arn:aws:s3:::bucket-v2',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
          },
        },
        {
          S3DestinationConfiguration: {
            BucketARN: 'arn:aws:s3:::bucket-v1',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
          },
        }
      )
    ).rejects.toThrow(/S3DestinationConfiguration/);
  });
});

describe('FirehoseProvider.update — Redshift destination (#549)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '11',
            Destinations: [{ DestinationId: 'destinationId-redshift-99' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with RedshiftDestinationUpdate when the destination diff fires', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        RedshiftDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          ClusterJDBCURL: 'jdbc:redshift://cluster.example.com:5439/db',
          CopyCommand: {
            DataTableName: 'logs_v2',
            CopyOptions: "FORMAT AS JSON 'auto'",
          },
          Username: 'firehose',
          Password: 'redacted',
          RetryOptions: { DurationInSeconds: 7200 },
          S3Configuration: {
            BucketARN: 'arn:aws:s3:::backup-bucket',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
            Prefix: 'redshift-staging/v2/',
            BufferingHints: { SizeInMBs: 32, IntervalInSeconds: 120 },
          },
          S3BackupMode: 'Enabled',
          S3BackupConfiguration: {
            BucketARN: 'arn:aws:s3:::dr-bucket',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
            Prefix: 'dr/v2/',
          },
        },
      },
      {
        RedshiftDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          ClusterJDBCURL: 'jdbc:redshift://cluster.example.com:5439/db',
          CopyCommand: { DataTableName: 'logs_v1' },
          Username: 'firehose',
          Password: 'redacted',
        },
      }
    );

    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['DeliveryStreamName']).toBe(PHYSICAL_ID);
    expect(input['CurrentDeliveryStreamVersionId']).toBe('11');
    expect(input['DestinationId']).toBe('destinationId-redshift-99');
    // Verify the reverse-map produces the SDK Update shape: S3Configuration
    // → S3Update, S3BackupConfiguration → S3BackupUpdate, every field
    // gated on !== undefined.
    expect(input['RedshiftDestinationUpdate']).toEqual({
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      ClusterJDBCURL: 'jdbc:redshift://cluster.example.com:5439/db',
      CopyCommand: { DataTableName: 'logs_v2', CopyOptions: "FORMAT AS JSON 'auto'" },
      Username: 'firehose',
      Password: 'redacted',
      RetryOptions: { DurationInSeconds: 7200 },
      S3Update: {
        BucketARN: 'arn:aws:s3:::backup-bucket',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
        Prefix: 'redshift-staging/v2/',
        BufferingHints: { SizeInMBs: 32, IntervalInSeconds: 120 },
      },
      S3BackupMode: 'Enabled',
      S3BackupUpdate: {
        BucketARN: 'arn:aws:s3:::dr-bucket',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
        Prefix: 'dr/v2/',
      },
    });
  });

  it('no-ops when Redshift destination before/after are identical', async () => {
    const dest = {
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      ClusterJDBCURL: 'jdbc:redshift://cluster.example.com:5439/db',
      CopyCommand: { DataTableName: 'logs' },
      Username: 'firehose',
      Password: 'redacted',
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { RedshiftDestinationConfiguration: dest },
      { RedshiftDestinationConfiguration: dest }
    );

    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('round-trips SecretsManagerConfiguration through the Update shape (Redshift Secrets Manager auth)', async () => {
    // Redshift supports Secrets-Manager-based auth (no Username/Password
    // inline). The CDK construct surfaces this as
    // SecretsManagerConfiguration on the Redshift destination. Per the
    // round-trip rule (`feedback_update_optional_field_undefined_check`),
    // every field present on the CFn shape must reach AWS unmodified;
    // dropping SecretsManagerConfiguration would silently break drift-
    // revert / in-place update for users on Secrets Manager auth.
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        RedshiftDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          ClusterJDBCURL: 'jdbc:redshift://cluster.example.com:5439/db',
          CopyCommand: { DataTableName: 'logs' },
          SecretsManagerConfiguration: {
            Enabled: true,
            SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:rs-cred-Abc',
            RoleARN: 'arn:aws:iam::111:role/firehose-secrets-role',
          },
        },
      },
      {
        RedshiftDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          ClusterJDBCURL: 'jdbc:redshift://cluster.example.com:5439/db',
          CopyCommand: { DataTableName: 'logs' },
        },
      }
    );

    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    const updateShape = input['RedshiftDestinationUpdate'] as Record<string, unknown>;
    expect(updateShape['SecretsManagerConfiguration']).toEqual({
      Enabled: true,
      SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:rs-cred-Abc',
      RoleARN: 'arn:aws:iam::111:role/firehose-secrets-role',
    });
  });

  it('omits unset CFn keys from the Update shape so AWS-side state is not clobbered', async () => {
    // Only ClusterJDBCURL changes between before/after. The Update
    // payload should carry ONLY the keys present in the new config — no
    // RoleARN, no CopyCommand, no S3Update, etc. CFn keys present in
    // both before and after but unchanged still get forwarded (the
    // reverse-mapper does not diff; the call-site's stringify-equality
    // check is what short-circuits the no-op case above).
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        RedshiftDestinationConfiguration: {
          ClusterJDBCURL: 'jdbc:redshift://new.example.com:5439/db',
        },
      },
      {
        RedshiftDestinationConfiguration: {
          ClusterJDBCURL: 'jdbc:redshift://old.example.com:5439/db',
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['RedshiftDestinationUpdate']).toEqual({
      ClusterJDBCURL: 'jdbc:redshift://new.example.com:5439/db',
    });
  });
});

describe('FirehoseProvider.update — Splunk destination (#549)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '7',
            Destinations: [{ DestinationId: 'destinationId-splunk-42' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with SplunkDestinationUpdate when the destination diff fires', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        SplunkDestinationConfiguration: {
          HECEndpoint: 'https://splunk-b.example.com:8088',
          HECEndpointType: 'Event',
          HECToken: 'token-v2',
          HECAcknowledgmentTimeoutInSeconds: 600,
          RetryOptions: { DurationInSeconds: 7200 },
          S3BackupMode: 'AllEvents',
          S3Configuration: {
            BucketARN: 'arn:aws:s3:::splunk-backup-bucket',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
            Prefix: 'splunk-staging/v2/',
            BufferingHints: { SizeInMBs: 32, IntervalInSeconds: 120 },
          },
          BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 60 },
        },
      },
      {
        SplunkDestinationConfiguration: {
          HECEndpoint: 'https://splunk-a.example.com:8088',
          HECEndpointType: 'Event',
          HECToken: 'token-v1',
        },
      }
    );

    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['DeliveryStreamName']).toBe(PHYSICAL_ID);
    expect(input['CurrentDeliveryStreamVersionId']).toBe('7');
    expect(input['DestinationId']).toBe('destinationId-splunk-42');
    // Verify the reverse-map produces the SDK Update shape:
    // S3Configuration → S3Update, every field gated on !== undefined.
    expect(input['SplunkDestinationUpdate']).toEqual({
      HECEndpoint: 'https://splunk-b.example.com:8088',
      HECEndpointType: 'Event',
      HECToken: 'token-v2',
      HECAcknowledgmentTimeoutInSeconds: 600,
      RetryOptions: { DurationInSeconds: 7200 },
      S3BackupMode: 'AllEvents',
      S3Update: {
        BucketARN: 'arn:aws:s3:::splunk-backup-bucket',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
        Prefix: 'splunk-staging/v2/',
        BufferingHints: { SizeInMBs: 32, IntervalInSeconds: 120 },
      },
      BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 60 },
    });
  });

  it('no-ops when Splunk destination before/after are identical', async () => {
    const dest = {
      HECEndpoint: 'https://splunk.example.com:8088',
      HECEndpointType: 'Raw',
      HECToken: 'token',
      RetryOptions: { DurationInSeconds: 3600 },
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { SplunkDestinationConfiguration: dest },
      { SplunkDestinationConfiguration: dest }
    );

    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('round-trips SecretsManagerConfiguration through the Update shape (Splunk Secrets Manager auth)', async () => {
    // Splunk supports Secrets-Manager-based auth (no inline HECToken).
    // Per the round-trip rule (`feedback_update_optional_field_undefined_check`),
    // every field present on the CFn shape must reach AWS unmodified;
    // dropping SecretsManagerConfiguration would silently break drift-
    // revert / in-place update for users on Secrets Manager auth.
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        SplunkDestinationConfiguration: {
          HECEndpoint: 'https://splunk.example.com:8088',
          HECEndpointType: 'Event',
          SecretsManagerConfiguration: {
            Enabled: true,
            SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:splunk-token-Abc',
            RoleARN: 'arn:aws:iam::111:role/firehose-secrets-role',
          },
        },
      },
      {
        SplunkDestinationConfiguration: {
          HECEndpoint: 'https://splunk.example.com:8088',
          HECEndpointType: 'Event',
        },
      }
    );

    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    const updateShape = input['SplunkDestinationUpdate'] as Record<string, unknown>;
    expect(updateShape['SecretsManagerConfiguration']).toEqual({
      Enabled: true,
      SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:splunk-token-Abc',
      RoleARN: 'arn:aws:iam::111:role/firehose-secrets-role',
    });
  });

  it('omits unset CFn keys from the Update shape so AWS-side state is not clobbered', async () => {
    // Only HECEndpoint changes between before/after. The Update payload
    // should carry ONLY the keys present in the new config — no
    // HECToken, no S3Update, no RetryOptions, etc.
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        SplunkDestinationConfiguration: {
          HECEndpoint: 'https://splunk-new.example.com:8088',
        },
      },
      {
        SplunkDestinationConfiguration: {
          HECEndpoint: 'https://splunk-old.example.com:8088',
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['SplunkDestinationUpdate']).toEqual({
      HECEndpoint: 'https://splunk-new.example.com:8088',
    });
  });
});

describe('FirehoseProvider.update — Amazonopensearchservice destination (#549)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '3',
            Destinations: [{ DestinationId: 'destinationId-aoss-12' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with AmazonopensearchserviceDestinationUpdate', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        AmazonopensearchserviceDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          DomainARN: 'arn:aws:es:us-east-1:111:domain/cluster',
          IndexName: 'logs-v2',
          TypeName: 'doc',
          IndexRotationPeriod: 'OneDay',
          BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
          RetryOptions: { DurationInSeconds: 300 },
          S3Configuration: {
            BucketARN: 'arn:aws:s3:::os-backup',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
            Prefix: 'os-staging/v2/',
          },
        },
      },
      {
        AmazonopensearchserviceDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          DomainARN: 'arn:aws:es:us-east-1:111:domain/cluster',
          IndexName: 'logs-v1',
        },
      }
    );

    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['CurrentDeliveryStreamVersionId']).toBe('3');
    expect(input['DestinationId']).toBe('destinationId-aoss-12');
    expect(input['AmazonopensearchserviceDestinationUpdate']).toEqual({
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      DomainARN: 'arn:aws:es:us-east-1:111:domain/cluster',
      IndexName: 'logs-v2',
      TypeName: 'doc',
      IndexRotationPeriod: 'OneDay',
      BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
      RetryOptions: { DurationInSeconds: 300 },
      S3Update: {
        BucketARN: 'arn:aws:s3:::os-backup',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
        Prefix: 'os-staging/v2/',
      },
    });
  });

  it('no-ops when Amazonopensearchservice destination before/after are identical', async () => {
    const dest = {
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      DomainARN: 'arn:aws:es:us-east-1:111:domain/cluster',
      IndexName: 'logs',
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { AmazonopensearchserviceDestinationConfiguration: dest },
      { AmazonopensearchserviceDestinationConfiguration: dest }
    );
    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('drops VpcConfiguration from the Update shape (read-only on AWS)', async () => {
    // AWS does not accept VpcConfiguration on Update. The reverse-
    // mapper silently omits it; users updating only Vpc will see the
    // diff surface on the next `cdkd drift` run.
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        AmazonopensearchserviceDestinationConfiguration: {
          IndexName: 'logs-v2',
          VpcConfiguration: { SubnetIds: ['s-2'], SecurityGroupIds: ['sg-2'], RoleARN: 'r' },
        },
      },
      {
        AmazonopensearchserviceDestinationConfiguration: {
          IndexName: 'logs-v1',
          VpcConfiguration: { SubnetIds: ['s-1'], SecurityGroupIds: ['sg-1'], RoleARN: 'r' },
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    const updateShape = input['AmazonopensearchserviceDestinationUpdate'] as Record<
      string,
      unknown
    >;
    expect(updateShape).not.toHaveProperty('VpcConfiguration');
    expect(updateShape['IndexName']).toBe('logs-v2');
  });

  it('omits unset CFn keys from the Update shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { AmazonopensearchserviceDestinationConfiguration: { IndexName: 'logs-v2' } },
      { AmazonopensearchserviceDestinationConfiguration: { IndexName: 'logs-v1' } }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['AmazonopensearchserviceDestinationUpdate']).toEqual({ IndexName: 'logs-v2' });
  });
});

describe('FirehoseProvider.update — AmazonOpenSearchServerless destination (#549)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '4',
            Destinations: [{ DestinationId: 'destinationId-aos-svl-22' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with AmazonOpenSearchServerlessDestinationUpdate', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        AmazonOpenSearchServerlessDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          CollectionEndpoint: 'https://abc.us-east-1.aoss.amazonaws.com',
          IndexName: 'logs-v2',
          BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
          RetryOptions: { DurationInSeconds: 300 },
          S3Configuration: {
            BucketARN: 'arn:aws:s3:::aoss-backup',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
          },
        },
      },
      {
        AmazonOpenSearchServerlessDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          CollectionEndpoint: 'https://abc.us-east-1.aoss.amazonaws.com',
          IndexName: 'logs-v1',
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['AmazonOpenSearchServerlessDestinationUpdate']).toEqual({
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      CollectionEndpoint: 'https://abc.us-east-1.aoss.amazonaws.com',
      IndexName: 'logs-v2',
      BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 300 },
      RetryOptions: { DurationInSeconds: 300 },
      S3Update: {
        BucketARN: 'arn:aws:s3:::aoss-backup',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
      },
    });
  });

  it('no-ops when AmazonOpenSearchServerless destination before/after are identical', async () => {
    const dest = {
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      CollectionEndpoint: 'https://abc.us-east-1.aoss.amazonaws.com',
      IndexName: 'logs',
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { AmazonOpenSearchServerlessDestinationConfiguration: dest },
      { AmazonOpenSearchServerlessDestinationConfiguration: dest }
    );
    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('omits unset CFn keys from the Update shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { AmazonOpenSearchServerlessDestinationConfiguration: { IndexName: 'logs-v2' } },
      { AmazonOpenSearchServerlessDestinationConfiguration: { IndexName: 'logs-v1' } }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['AmazonOpenSearchServerlessDestinationUpdate']).toEqual({
      IndexName: 'logs-v2',
    });
  });
});

describe('FirehoseProvider.update — HttpEndpoint destination (#549)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '5',
            Destinations: [{ DestinationId: 'destinationId-http-31' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with HttpEndpointDestinationUpdate', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        HttpEndpointDestinationConfiguration: {
          EndpointConfiguration: {
            Url: 'https://api.example.com/v2',
            Name: 'my-endpoint-v2',
            AccessKey: 'key-v2',
          },
          BufferingHints: { SizeInMBs: 1, IntervalInSeconds: 60 },
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          RetryOptions: { DurationInSeconds: 300 },
          S3BackupMode: 'AllData',
          S3Configuration: {
            BucketARN: 'arn:aws:s3:::http-backup',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
          },
          RequestConfiguration: { ContentEncoding: 'GZIP' },
        },
      },
      {
        HttpEndpointDestinationConfiguration: {
          EndpointConfiguration: {
            Url: 'https://api.example.com/v1',
            Name: 'my-endpoint-v1',
            AccessKey: 'key-v1',
          },
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['HttpEndpointDestinationUpdate']).toEqual({
      EndpointConfiguration: {
        Url: 'https://api.example.com/v2',
        Name: 'my-endpoint-v2',
        AccessKey: 'key-v2',
      },
      BufferingHints: { SizeInMBs: 1, IntervalInSeconds: 60 },
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      RetryOptions: { DurationInSeconds: 300 },
      S3BackupMode: 'AllData',
      S3Update: {
        BucketARN: 'arn:aws:s3:::http-backup',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
      },
      RequestConfiguration: { ContentEncoding: 'GZIP' },
    });
  });

  it('no-ops when HttpEndpoint destination before/after are identical', async () => {
    const dest = {
      EndpointConfiguration: { Url: 'https://api.example.com/v1', Name: 'e', AccessKey: 'k' },
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { HttpEndpointDestinationConfiguration: dest },
      { HttpEndpointDestinationConfiguration: dest }
    );
    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('round-trips SecretsManagerConfiguration through the Update shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        HttpEndpointDestinationConfiguration: {
          EndpointConfiguration: { Url: 'https://api.example.com/v2', Name: 'e' },
          SecretsManagerConfiguration: {
            Enabled: true,
            SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:http-key-Xyz',
            RoleARN: 'arn:aws:iam::111:role/firehose-secrets-role',
          },
        },
      },
      {
        HttpEndpointDestinationConfiguration: {
          EndpointConfiguration: { Url: 'https://api.example.com/v1', Name: 'e' },
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    const updateShape = input['HttpEndpointDestinationUpdate'] as Record<string, unknown>;
    expect(updateShape['SecretsManagerConfiguration']).toEqual({
      Enabled: true,
      SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:http-key-Xyz',
      RoleARN: 'arn:aws:iam::111:role/firehose-secrets-role',
    });
  });

  it('omits unset CFn keys from the Update shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        HttpEndpointDestinationConfiguration: {
          EndpointConfiguration: { Url: 'https://api.example.com/v2', Name: 'e' },
        },
      },
      {
        HttpEndpointDestinationConfiguration: {
          EndpointConfiguration: { Url: 'https://api.example.com/v1', Name: 'e' },
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['HttpEndpointDestinationUpdate']).toEqual({
      EndpointConfiguration: { Url: 'https://api.example.com/v2', Name: 'e' },
    });
  });
});

describe('FirehoseProvider.update — Elasticsearch destination (#549)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '6',
            Destinations: [{ DestinationId: 'destinationId-es-42' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with ElasticsearchDestinationUpdate', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        ElasticsearchDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          DomainARN: 'arn:aws:es:us-east-1:111:domain/cluster',
          IndexName: 'logs-v2',
          TypeName: 'doc',
          IndexRotationPeriod: 'OneHour',
          S3Configuration: {
            BucketARN: 'arn:aws:s3:::es-backup',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
          },
        },
      },
      {
        ElasticsearchDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          DomainARN: 'arn:aws:es:us-east-1:111:domain/cluster',
          IndexName: 'logs-v1',
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['ElasticsearchDestinationUpdate']).toEqual({
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      DomainARN: 'arn:aws:es:us-east-1:111:domain/cluster',
      IndexName: 'logs-v2',
      TypeName: 'doc',
      IndexRotationPeriod: 'OneHour',
      S3Update: {
        BucketARN: 'arn:aws:s3:::es-backup',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
      },
    });
  });

  it('no-ops when Elasticsearch destination before/after are identical', async () => {
    const dest = {
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      DomainARN: 'arn:aws:es:us-east-1:111:domain/cluster',
      IndexName: 'logs',
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { ElasticsearchDestinationConfiguration: dest },
      { ElasticsearchDestinationConfiguration: dest }
    );
    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('omits unset CFn keys from the Update shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { ElasticsearchDestinationConfiguration: { IndexName: 'logs-v2' } },
      { ElasticsearchDestinationConfiguration: { IndexName: 'logs-v1' } }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['ElasticsearchDestinationUpdate']).toEqual({ IndexName: 'logs-v2' });
  });
});

describe('FirehoseProvider.update — Iceberg destination (#549)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '8',
            Destinations: [{ DestinationId: 'destinationId-iceberg-66' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with IcebergDestinationUpdate (S3Configuration NOT renamed)', async () => {
    // Iceberg quirk: the SDK Update shape's S3 field is named
    // `S3Configuration` (full S3DestinationConfiguration shape) — NOT
    // `S3Update` like every other destination. The reverse-mapper must
    // forward it verbatim without renaming.
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        IcebergDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          CatalogConfiguration: {
            CatalogArn: 'arn:aws:glue:us-east-1:111:catalog',
          },
          DestinationTableConfigurationList: [
            { DestinationTableName: 't-v2', DestinationDatabaseName: 'db' },
          ],
          S3BackupMode: 'FailedDataOnly',
          AppendOnly: true,
          S3Configuration: {
            BucketARN: 'arn:aws:s3:::iceberg-backup',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
            Prefix: 'iceberg-staging/v2/',
          },
        },
      },
      {
        IcebergDestinationConfiguration: {
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          CatalogConfiguration: { CatalogArn: 'arn:aws:glue:us-east-1:111:catalog' },
          DestinationTableConfigurationList: [
            { DestinationTableName: 't-v1', DestinationDatabaseName: 'db' },
          ],
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    const updateShape = input['IcebergDestinationUpdate'] as Record<string, unknown>;
    // Critical assertion: S3Configuration stays as S3Configuration, not S3Update.
    expect(updateShape).toHaveProperty('S3Configuration');
    expect(updateShape).not.toHaveProperty('S3Update');
    expect(updateShape['S3Configuration']).toEqual({
      BucketARN: 'arn:aws:s3:::iceberg-backup',
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      Prefix: 'iceberg-staging/v2/',
    });
    expect(updateShape['RoleARN']).toBe('arn:aws:iam::111:role/firehose-role');
    expect(updateShape['CatalogConfiguration']).toEqual({
      CatalogArn: 'arn:aws:glue:us-east-1:111:catalog',
    });
    expect(updateShape['S3BackupMode']).toBe('FailedDataOnly');
    expect(updateShape['AppendOnly']).toBe(true);
  });

  it('no-ops when Iceberg destination before/after are identical', async () => {
    const dest = {
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      CatalogConfiguration: { CatalogArn: 'arn:aws:glue:us-east-1:111:catalog' },
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { IcebergDestinationConfiguration: dest },
      { IcebergDestinationConfiguration: dest }
    );
    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('omits unset CFn keys from the Update shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { IcebergDestinationConfiguration: { AppendOnly: true } },
      { IcebergDestinationConfiguration: { AppendOnly: false } }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['IcebergDestinationUpdate']).toEqual({ AppendOnly: true });
  });
});

describe('FirehoseProvider.update — Snowflake destination (#549)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '9',
            Destinations: [{ DestinationId: 'destinationId-snowflake-77' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it('issues UpdateDestinationCommand with SnowflakeDestinationUpdate', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        SnowflakeDestinationConfiguration: {
          AccountUrl: 'https://acct-v2.snowflakecomputing.com',
          PrivateKey: 'PK-v2',
          User: 'firehose-v2',
          Database: 'analytics',
          Schema: 'logs',
          Table: 'events_v2',
          DataLoadingOption: 'JSON_MAPPING',
          RoleARN: 'arn:aws:iam::111:role/firehose-role',
          S3BackupMode: 'AllData',
          S3Configuration: {
            BucketARN: 'arn:aws:s3:::snowflake-backup',
            RoleARN: 'arn:aws:iam::111:role/firehose-role',
          },
        },
      },
      {
        SnowflakeDestinationConfiguration: {
          AccountUrl: 'https://acct-v1.snowflakecomputing.com',
          PrivateKey: 'PK-v1',
          User: 'firehose-v1',
          Database: 'analytics',
          Schema: 'logs',
          Table: 'events_v1',
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['SnowflakeDestinationUpdate']).toEqual({
      AccountUrl: 'https://acct-v2.snowflakecomputing.com',
      PrivateKey: 'PK-v2',
      User: 'firehose-v2',
      Database: 'analytics',
      Schema: 'logs',
      Table: 'events_v2',
      DataLoadingOption: 'JSON_MAPPING',
      RoleARN: 'arn:aws:iam::111:role/firehose-role',
      S3BackupMode: 'AllData',
      S3Update: {
        BucketARN: 'arn:aws:s3:::snowflake-backup',
        RoleARN: 'arn:aws:iam::111:role/firehose-role',
      },
    });
  });

  it('no-ops when Snowflake destination before/after are identical', async () => {
    const dest = {
      AccountUrl: 'https://acct.snowflakecomputing.com',
      Database: 'd',
      Schema: 's',
      Table: 't',
    };
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { SnowflakeDestinationConfiguration: dest },
      { SnowflakeDestinationConfiguration: dest }
    );
    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(0);
  });

  it('round-trips SecretsManagerConfiguration through the Update shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      {
        SnowflakeDestinationConfiguration: {
          AccountUrl: 'https://acct.snowflakecomputing.com',
          SecretsManagerConfiguration: {
            Enabled: true,
            SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:snowflake-Abc',
            RoleARN: 'arn:aws:iam::111:role/firehose-secrets-role',
          },
        },
      },
      {
        SnowflakeDestinationConfiguration: {
          AccountUrl: 'https://acct.snowflakecomputing.com',
        },
      }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    const updateShape = input['SnowflakeDestinationUpdate'] as Record<string, unknown>;
    expect(updateShape['SecretsManagerConfiguration']).toEqual({
      Enabled: true,
      SecretARN: 'arn:aws:secretsmanager:us-east-1:111:secret:snowflake-Abc',
      RoleARN: 'arn:aws:iam::111:role/firehose-secrets-role',
    });
  });

  it('omits unset CFn keys from the Update shape', async () => {
    await provider.update(
      'L',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { SnowflakeDestinationConfiguration: { Table: 'events_v2' } },
      { SnowflakeDestinationConfiguration: { Table: 'events_v1' } }
    );
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateDestinationCommand);
    expect(updates).toHaveLength(1);
    const input = (updates[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['SnowflakeDestinationUpdate']).toEqual({ Table: 'events_v2' });
  });
});
