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

  it('rejects unsupported destination diffs (e.g. Splunk) with a tightened error that names the destination type', async () => {
    await expect(
      provider.update(
        'L',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        {
          SplunkDestinationConfiguration: {
            HECEndpoint: 'https://splunk-b.example.com',
          },
        },
        {
          SplunkDestinationConfiguration: {
            HECEndpoint: 'https://splunk-a.example.com',
          },
        }
      )
    ).rejects.toThrow(/SplunkDestinationConfiguration/);
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
