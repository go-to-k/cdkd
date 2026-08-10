import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketLoggingCommand,
  PutBucketReplicationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1495: twenty nested CFn keys `s3-bucket-provider.ts` never wrote at
 * all. Each has a same-spelled member in `@aws-sdk/client-s3`, each is declared
 * by the CFn registry schema under a top-level property the provider lists in
 * `handledProperties`, and none was ever built — so a template that set one was
 * a WRITE-SIDE SILENT DROP. The serializer discarded nothing; the provider
 * simply never assembled the field, and the deploy reported success.
 *
 * These are the cases where "the deploy succeeded" was the most misleading:
 * cross-account replication with owner override, SSE-KMS replica encryption,
 * S3 Replication Time Control (a billed SLA), replica-modification /
 * SSE-KMS-object selection, the partitioned server-access-log key format, the
 * lifecycle small-object transition default, and the SSE-C block.
 *
 * The read-back assertions matter as much as the writes: a field the provider
 * now SENDS but does not READ surfaces as permanent phantom drift, which
 * `cdkd drift --revert` would then keep re-applying forever.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'my-replicated-bucket';

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  provider = new S3BucketProvider();
  mockSend.mockResolvedValue({});
});

/** Run an UPDATE with the given desired properties and return the Nth command. */
async function updateAndFind<T>(
  properties: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): Promise<T> {
  await provider.update('B', BUCKET, RESOURCE_TYPE, { BucketName: BUCKET, ...properties }, {
    BucketName: BUCKET,
  });
  const call = mockSend.mock.calls.map((c) => c[0]).find((c) => c instanceof commandType);
  expect(call, `${commandType.name} was never sent`).toBeDefined();
  return call as T;
}

describe('LoggingConfiguration.TargetObjectKeyFormat (issue #1495)', () => {
  it('sends the PARTITIONED key format instead of silently using the flat default', async () => {
    const cmd = await updateAndFind(
      {
        LoggingConfiguration: {
          DestinationBucketName: 'logs-bucket',
          LogFilePrefix: 'access/',
          TargetObjectKeyFormat: { PartitionedPrefix: { PartitionDateSource: 'EventTime' } },
        },
      },
      PutBucketLoggingCommand
    );

    expect(cmd.input.BucketLoggingStatus?.LoggingEnabled?.TargetObjectKeyFormat).toEqual({
      PartitionedPrefix: { PartitionDateSource: 'EventTime' },
    });
  });

  it('preserves an EMPTY SimplePrefix, whose PRESENCE is the whole signal', async () => {
    // `SimplePrefix: {}` carries no members — dropping it because it "looks
    // empty" is the same class of bug as never building the block at all.
    const cmd = await updateAndFind(
      {
        LoggingConfiguration: {
          DestinationBucketName: 'logs-bucket',
          TargetObjectKeyFormat: { SimplePrefix: {} },
        },
      },
      PutBucketLoggingCommand
    );

    expect(cmd.input.BucketLoggingStatus?.LoggingEnabled?.TargetObjectKeyFormat).toEqual({
      SimplePrefix: {},
    });
  });

  it('omits the block entirely when the template does not declare it', async () => {
    const cmd = await updateAndFind(
      { LoggingConfiguration: { DestinationBucketName: 'logs-bucket' } },
      PutBucketLoggingCommand
    );

    expect(
      cmd.input.BucketLoggingStatus?.LoggingEnabled?.TargetObjectKeyFormat
    ).toBeUndefined();
    // The pre-existing members must be untouched by the addition.
    expect(cmd.input.BucketLoggingStatus?.LoggingEnabled?.TargetBucket).toBe('logs-bucket');
  });

  it('reads the key format back, so a declaring bucket does not report phantom drift', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetBucketLoggingCommand') {
        return Promise.resolve({
          LoggingEnabled: {
            TargetBucket: 'logs-bucket',
            TargetPrefix: 'access/',
            TargetObjectKeyFormat: { PartitionedPrefix: { PartitionDateSource: 'DeliveryTime' } },
          },
        });
      }
      return Promise.resolve({});
    });

    const current = await provider.readCurrentState(BUCKET, 'B', RESOURCE_TYPE);

    expect(
      (current?.['LoggingConfiguration'] as Record<string, unknown>)['TargetObjectKeyFormat']
    ).toEqual({ PartitionedPrefix: { PartitionDateSource: 'DeliveryTime' } });
  });
});

describe('ReplicationConfiguration Destination blocks (issue #1495)', () => {
  const RULE_WITH_EVERY_BLOCK = {
    Id: 'full',
    Status: 'Enabled',
    Priority: 1,
    Filter: {},
    Destination: {
      Bucket: 'arn:aws:s3:::replica-bucket',
      Account: '222222222222',
      StorageClass: 'STANDARD',
      AccessControlTranslation: { Owner: 'Destination' },
      EncryptionConfiguration: { ReplicaKmsKeyID: 'arn:aws:kms:us-east-1:1:key/abc' },
      ReplicationTime: { Status: 'Enabled', Time: { Minutes: 15 } },
      Metrics: { Status: 'Enabled', EventThreshold: { Minutes: 15 } },
    },
    SourceSelectionCriteria: {
      ReplicaModifications: { Status: 'Enabled' },
      SseKmsEncryptedObjects: { Status: 'Enabled' },
    },
  };

  it('sends all four Destination blocks plus SourceSelectionCriteria', async () => {
    const cmd = await updateAndFind(
      {
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::111111111111:role/replication',
          Rules: [RULE_WITH_EVERY_BLOCK],
        },
      },
      PutBucketReplicationCommand
    );

    const rule = cmd.input.ReplicationConfiguration!.Rules![0]!;
    expect(rule.Destination).toEqual({
      Bucket: 'arn:aws:s3:::replica-bucket',
      Account: '222222222222',
      StorageClass: 'STANDARD',
      AccessControlTranslation: { Owner: 'Destination' },
      EncryptionConfiguration: { ReplicaKmsKeyID: 'arn:aws:kms:us-east-1:1:key/abc' },
      ReplicationTime: { Status: 'Enabled', Time: { Minutes: 15 } },
      Metrics: { Status: 'Enabled', EventThreshold: { Minutes: 15 } },
    });
    expect(rule.SourceSelectionCriteria).toEqual({
      ReplicaModifications: { Status: 'Enabled' },
      SseKmsEncryptedObjects: { Status: 'Enabled' },
    });
  });

  it('keeps a plain rule byte-identical — the addition is opt-in per block', async () => {
    const cmd = await updateAndFind(
      {
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::111111111111:role/replication',
          Rules: [
            {
              Id: 'plain',
              Status: 'Enabled',
              Destination: { Bucket: 'arn:aws:s3:::replica-bucket' },
            },
          ],
        },
      },
      PutBucketReplicationCommand
    );

    const rule = cmd.input.ReplicationConfiguration!.Rules![0]!;
    expect(rule.Destination).toEqual({
      Bucket: 'arn:aws:s3:::replica-bucket',
      Account: undefined,
      StorageClass: undefined,
    });
    expect(rule.SourceSelectionCriteria).toBeUndefined();
  });

  it('sends only the SUB-BLOCK the template declared (RTC without Metrics)', async () => {
    // Both blocks are required for real RTC, but the provider must not invent
    // the one the template omitted — AWS is the authority on that validation.
    const cmd = await updateAndFind(
      {
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::111111111111:role/replication',
          Rules: [
            {
              Id: 'rtc-only',
              Status: 'Enabled',
              Destination: {
                Bucket: 'arn:aws:s3:::replica-bucket',
                ReplicationTime: { Status: 'Enabled', Time: { Minutes: 15 } },
              },
            },
          ],
        },
      },
      PutBucketReplicationCommand
    );

    const dest = cmd.input.ReplicationConfiguration!.Rules![0]!.Destination!;
    expect(dest.ReplicationTime).toEqual({ Status: 'Enabled', Time: { Minutes: 15 } });
    expect(dest.Metrics).toBeUndefined();
  });

  it('reads every new block back so a replicating bucket reports no phantom drift', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetBucketReplicationCommand') {
        return Promise.resolve({
          ReplicationConfiguration: {
            Role: 'arn:aws:iam::111111111111:role/replication',
            Rules: [
              {
                ID: 'full',
                Status: 'Enabled',
                Priority: 1,
                Destination: {
                  Bucket: 'arn:aws:s3:::replica-bucket',
                  AccessControlTranslation: { Owner: 'Destination' },
                  EncryptionConfiguration: { ReplicaKmsKeyID: 'arn:aws:kms:us-east-1:1:key/abc' },
                  ReplicationTime: { Status: 'Enabled', Time: { Minutes: 15 } },
                  Metrics: { Status: 'Enabled', EventThreshold: { Minutes: 15 } },
                },
                SourceSelectionCriteria: {
                  ReplicaModifications: { Status: 'Enabled' },
                  SseKmsEncryptedObjects: { Status: 'Enabled' },
                },
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const current = await provider.readCurrentState(BUCKET, 'B', RESOURCE_TYPE);

    const rule = (
      (current?.['ReplicationConfiguration'] as Record<string, unknown>)['Rules'] as Array<
        Record<string, unknown>
      >
    )[0]!;
    expect(rule['Destination']).toEqual({
      Bucket: 'arn:aws:s3:::replica-bucket',
      AccessControlTranslation: { Owner: 'Destination' },
      EncryptionConfiguration: { ReplicaKmsKeyID: 'arn:aws:kms:us-east-1:1:key/abc' },
      ReplicationTime: { Status: 'Enabled', Time: { Minutes: 15 } },
      Metrics: { Status: 'Enabled', EventThreshold: { Minutes: 15 } },
    });
    expect(rule['SourceSelectionCriteria']).toEqual({
      ReplicaModifications: { Status: 'Enabled' },
      SseKmsEncryptedObjects: { Status: 'Enabled' },
    });
  });
});

describe('LifecycleConfiguration.TransitionDefaultMinimumObjectSize (issue #1495)', () => {
  it('sends it on the REQUEST, where the SDK puts it', async () => {
    // CFn nests this under `LifecycleConfiguration`; the SDK hoists it onto
    // `PutBucketLifecycleConfigurationRequest`. That mismatch is exactly why
    // the rules-only mapper never reached it.
    const cmd = await updateAndFind(
      {
        LifecycleConfiguration: {
          TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K',
          Rules: [{ Id: 'r', Status: 'Enabled', ExpirationInDays: 30 }],
        },
      },
      PutBucketLifecycleConfigurationCommand
    );

    expect(cmd.input.TransitionDefaultMinimumObjectSize).toBe('all_storage_classes_128K');
    expect(cmd.input.LifecycleConfiguration?.Rules).toHaveLength(1);
  });

  it('leaves it undefined when undeclared, so AWS keeps its own default', async () => {
    const cmd = await updateAndFind(
      { LifecycleConfiguration: { Rules: [{ Id: 'r', Status: 'Enabled', ExpirationInDays: 30 }] } },
      PutBucketLifecycleConfigurationCommand
    );

    expect(cmd.input.TransitionDefaultMinimumObjectSize).toBeUndefined();
  });

  it('reads back whatever AWS returns, BOTH values', async () => {
    // The first cut filtered out `varies_by_storage_class` as "the account
    // default". That polarity is wrong — AWS defaults buckets created after
    // September 2024 to `all_storage_classes_128K` — so the filter suppressed
    // the one value a template meaningfully declares and a bucket declaring it
    // reported permanent phantom drift. Emitting it unconditionally is not free
    // — `drift.ts` union-walks nested objects on the observed baseline, so the
    // sub-key IS compared — but the cost is one stale-baseline diff that clears
    // on the next deploy, against a forever-drift for the declaring template.
    for (const value of ['varies_by_storage_class', 'all_storage_classes_128K']) {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'GetBucketLifecycleConfigurationCommand') {
          return Promise.resolve({
            Rules: [{ ID: 'r', Status: 'Enabled' }],
            TransitionDefaultMinimumObjectSize: value,
          });
        }
        return Promise.resolve({});
      });

      const current = await provider.readCurrentState(BUCKET, 'B', RESOURCE_TYPE);
      expect(
        (current?.['LifecycleConfiguration'] as Record<string, unknown>)[
          'TransitionDefaultMinimumObjectSize'
        ]
      ).toBe(value);
    }
  });

  it('omits it when AWS returns nothing for it', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetBucketLifecycleConfigurationCommand') {
        return Promise.resolve({ Rules: [{ ID: 'r', Status: 'Enabled' }] });
      }
      return Promise.resolve({});
    });

    const current = await provider.readCurrentState(BUCKET, 'B', RESOURCE_TYPE);
    expect(
      (current?.['LifecycleConfiguration'] as Record<string, unknown>)[
        'TransitionDefaultMinimumObjectSize'
      ]
    ).toBeUndefined();
  });
});

describe('BucketEncryption BlockedEncryptionTypes (issue #1495)', () => {
  it('sends the blocked type instead of silently keeping it allowed', async () => {
    const cmd = await updateAndFind(
      {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
              BlockedEncryptionTypes: { EncryptionType: ['SSE-C'] },
            },
          ],
        },
      },
      PutBucketEncryptionCommand
    );

    const rule = cmd.input.ServerSideEncryptionConfiguration!.Rules![0]!;
    expect(rule.BlockedEncryptionTypes).toEqual({ EncryptionType: ['SSE-C'] });
    expect(rule.ApplyServerSideEncryptionByDefault).toEqual({
      SSEAlgorithm: 'AES256',
      KMSMasterKeyID: undefined,
    });
  });

  it('omits the block when undeclared', async () => {
    const cmd = await updateAndFind(
      {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
      },
      PutBucketEncryptionCommand
    );

    expect(cmd.input.ServerSideEncryptionConfiguration!.Rules![0]!.BlockedEncryptionTypes).toBe(
      undefined
    );
  });

  it('reads it back so a blocking bucket reports no phantom drift', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetBucketEncryptionCommand') {
        return Promise.resolve({
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
                BlockedEncryptionTypes: { EncryptionType: ['SSE-C'] },
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const current = await provider.readCurrentState(BUCKET, 'B', RESOURCE_TYPE);

    const rules = (current?.['BucketEncryption'] as Record<string, unknown>)[
      'ServerSideEncryptionConfiguration'
    ] as Array<Record<string, unknown>>;
    expect(rules[0]!['BlockedEncryptionTypes']).toEqual({ EncryptionType: ['SSE-C'] });
  });
});
