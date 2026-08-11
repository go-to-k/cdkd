import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketIntelligentTieringConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketReplicationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1595: the four per-item / per-rule STRING refusals that #1581 left
 * strict. Each refuses a malformed configuration ITEM through a
 * `readConfigString` carrying no `onUnusable`, so it hard-threw on the
 * state-replay paths too — the un-rollbackable refusal every CONTAINER guard
 * beside it exists to avoid.
 *
 * What makes this a per-site decision rather than a mechanical `onUnusable`
 * thread-through is the DOWNGRADE. `readConfigString`'s own downgrade is
 * warn-and-DEFAULT, and every default here ENABLES something on a LIVE
 * resource:
 *
 * - lifecycle `Status` -> `Enabled` starts an expiration rule DELETING objects;
 * - intelligent-tiering `Status` -> `Enabled` starts moving objects to archive
 *   tiers;
 * - replication `Status` -> `Enabled` starts copying objects OUT of the bucket;
 * - inventory `IncludedObjectVersions` -> `All` silently changes the report.
 *
 * So the downgrade is the SKIP the sibling container guards perform, with the
 * SAME per-applier unit: the whole Put where the Put replaces every rule
 * (lifecycle / replication), the single configuration item where the Put is
 * per-Id (intelligent tiering / inventory). Those two unit assertions are the
 * load-bearing ones here — a downgrade with the wrong unit is a different bug,
 * not a partial fix.
 *
 * The create-path rows are a REGRESSION FENCE, not proof of the new guard:
 * they pass on the unfixed tree too (the same read threw there, with a
 * byte-identical message). The genuinely new behavior is every replay / update
 * row.
 */

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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
const BUCKET = 'per-item-string-bucket';

const LIFECYCLE_STATUS_PATH = 'AWS::S3::Bucket LifecycleConfiguration.Rules[].Status';
const IT_STATUS_PATH = 'AWS::S3::Bucket IntelligentTieringConfigurations[].Status';
const INVENTORY_IOV_PATH = 'AWS::S3::Bucket InventoryConfigurations[].IncludedObjectVersions';
const REPLICATION_STATUS_PATH = 'AWS::S3::Bucket ReplicationConfiguration.Rules[].Status';

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  mockSend.mockResolvedValue({});
});

function sentCommands<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof commandType) as T[];
}

// The shapes a state record written by an older binary can legitimately carry
// for a field the template meant to be a string. The BLANK string and the
// explicit NULL are the rows a hand-written `typeof value !== 'string'` twin
// would disagree with `readConfigString` on — which is why the probe shares
// that helper's predicate instead of re-deriving one.
const malformedValues: Array<[string, unknown]> = [
  ['an array (an unresolved intrinsic collapsed to a list)', ['Enabled']],
  ['an object', { Fn__If: 'unresolved' }],
  ['a number', 1],
  ['a blank string', '   '],
  ['an explicit null', null],
];

const lifecycleProps = (rules: Array<Record<string, unknown>>) => ({
  BucketName: BUCKET,
  LifecycleConfiguration: { Rules: rules },
});
const itProps = (configs: Array<Record<string, unknown>>) => ({
  BucketName: BUCKET,
  IntelligentTieringConfigurations: configs,
});
const inventoryProps = (configs: Array<Record<string, unknown>>) => ({
  BucketName: BUCKET,
  InventoryConfigurations: configs,
});
const replicationProps = (rules: Array<Record<string, unknown>>) => ({
  BucketName: BUCKET,
  ReplicationConfiguration: { Role: 'arn:aws:iam::123456789012:role/repl', Rules: rules },
});

const validInventoryFields = {
  Destination: { BucketArn: 'arn:aws:s3:::inv-dest', Format: 'CSV' },
  ScheduleFrequency: 'Daily',
};
const validReplicationFields = {
  Destination: { Bucket: 'arn:aws:s3:::repl-dest' },
};

describe('create path: the refusal still stands (regression fence, NOT the new behavior)', () => {
  for (const [label, value] of malformedValues) {
    it(`lifecycle: refuses a rule Status that is ${label}`, async () => {
      await expect(
        provider.create(
          'B',
          RESOURCE_TYPE,
          lifecycleProps([{ Id: 'probe', Status: value, ExpirationInDays: 30 }])
        )
      ).rejects.toThrow(`${LIFECYCLE_STATUS_PATH} must be a non-empty string`);
      expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    });

    it(`intelligent tiering: refuses a Status that is ${label}`, async () => {
      await expect(
        provider.create(
          'B',
          RESOURCE_TYPE,
          itProps([
            { Id: 'probe', Status: value, Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
          ])
        )
      ).rejects.toThrow(`${IT_STATUS_PATH} must be a non-empty string`);
      expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(0);
    });

    it(`inventory: refuses an IncludedObjectVersions that is ${label}`, async () => {
      await expect(
        provider.create(
          'B',
          RESOURCE_TYPE,
          inventoryProps([{ Id: 'probe', IncludedObjectVersions: value, ...validInventoryFields }])
        )
      ).rejects.toThrow(`${INVENTORY_IOV_PATH} must be a non-empty string`);
      expect(sentCommands(PutBucketInventoryConfigurationCommand)).toHaveLength(0);
    });

    it(`replication: refuses a rule Status that is ${label}`, async () => {
      await expect(
        provider.create(
          'B',
          RESOURCE_TYPE,
          replicationProps([{ Id: 'probe', Status: value, ...validReplicationFields }])
        )
      ).rejects.toThrow(`${REPLICATION_STATUS_PATH} must be a non-empty string`);
      expect(sentCommands(PutBucketReplicationCommand)).toHaveLength(0);
    });
  }
});

describe('replay path (create with replayingState): warn and SKIP, never default', () => {
  it('lifecycle: warns and sends NO Put — the default would ENABLE the rule', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps([{ Id: 'probe', Status: ['Disabled'], ExpirationInDays: 30 }]),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${LIFECYCLE_STATUS_PATH} must be a non-empty string`)
    );
    // The whole point: `readConfigString`'s own downgrade would have sent a
    // Put with `Status: 'Enabled'`, i.e. started deleting objects for a rule
    // the template had DISABLED.
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('intelligent tiering: warns and sends NO Put for the malformed item', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      itProps([
        { Id: 'probe', Status: 1, Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
      ]),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${IT_STATUS_PATH} must be a non-empty string`)
    );
    expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(0);
  });

  it('inventory: warns and sends NO Put for the malformed item', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      inventoryProps([{ Id: 'probe', IncludedObjectVersions: {}, ...validInventoryFields }]),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${INVENTORY_IOV_PATH} must be a non-empty string`)
    );
    expect(sentCommands(PutBucketInventoryConfigurationCommand)).toHaveLength(0);
  });

  it('replication: warns and sends NO Put — the default would START replicating', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      replicationProps([{ Id: 'probe', Status: '', ...validReplicationFields }]),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${REPLICATION_STATUS_PATH} must be a non-empty string`)
    );
    expect(sentCommands(PutBucketReplicationCommand)).toHaveLength(0);
  });

  it('the warning names the SKIP that actually happened, not a default it did not take', async () => {
    // A message inherited verbatim from `readConfigString`'s downgrade would
    // say "using the default (Enabled) here" — a claim this path never makes
    // good on. Getting that wrong turns a correct fix into a misleading log.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      replicationProps([{ Id: 'probe', Status: 1, ...validReplicationFields }]),
      { replayingState: true }
    );
    const message = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('Leaving the whole live replication configuration unchanged');
    expect(message).not.toContain('using the default');
  });
});

describe('the SKIP UNIT matches the API, which is the per-site decision', () => {
  it('lifecycle: one malformed rule leaves the WHOLE live configuration alone', async () => {
    // `PutBucketLifecycleConfiguration` replaces every rule, so applying the
    // valid sibling alone would DELETE the malformed rule from AWS.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps([
        { Id: 'good', Status: 'Enabled', ExpirationInDays: 10, Filter: { Prefix: 'a/' } },
        { Id: 'bad', Status: ['Disabled'], ExpirationInDays: 30, Filter: { Prefix: 'b/' } },
      ]),
      { replayingState: true }
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('replication: one malformed rule leaves the WHOLE live configuration alone', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      replicationProps([
        { Id: 'good', Status: 'Enabled', ...validReplicationFields },
        { Id: 'bad', Status: 1, ...validReplicationFields },
      ]),
      { replayingState: true }
    );
    expect(sentCommands(PutBucketReplicationCommand)).toHaveLength(0);
  });

  it('intelligent tiering: the Put is per-Id, so the valid sibling STILL applies', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      itProps([
        {
          Id: 'good',
          Status: 'Enabled',
          Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }],
        },
        { Id: 'bad', Status: 1, Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
      ]),
      { replayingState: true }
    );
    const sent = sentCommands(PutBucketIntelligentTieringConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.Id).toBe('good');
  });

  it('inventory: the Put is per-Id, so the valid sibling STILL applies', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      inventoryProps([
        { Id: 'good', IncludedObjectVersions: 'Current', ...validInventoryFields },
        { Id: 'bad', IncludedObjectVersions: {}, ...validInventoryFields },
      ]),
      { replayingState: true }
    );
    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.Id).toBe('good');
  });
});

describe('update path: the wiring nothing else covers', () => {
  // `rollback-executor.ts`'s revert arm and `cdkd drift --revert` both call
  // `update(..., previousState.properties, ...)`, so the DESIRED bag on this
  // path is a state record too. Without these, dropping the third argument at
  // an update call site leaves the suite green while the malformed record
  // hard-throws on every rollback.
  it('lifecycle: warns and skips', async () => {
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      lifecycleProps([{ Id: 'probe', Status: ['Disabled'], ExpirationInDays: 30 }]),
      { BucketName: BUCKET }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${LIFECYCLE_STATUS_PATH} must be a non-empty string`)
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('intelligent tiering: warns and skips', async () => {
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      itProps([{ Id: 'probe', Status: 1, Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] }]),
      { BucketName: BUCKET }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${IT_STATUS_PATH} must be a non-empty string`)
    );
    expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(0);
  });

  it('inventory: warns and skips', async () => {
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      inventoryProps([{ Id: 'probe', IncludedObjectVersions: {}, ...validInventoryFields }]),
      { BucketName: BUCKET }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${INVENTORY_IOV_PATH} must be a non-empty string`)
    );
    expect(sentCommands(PutBucketInventoryConfigurationCommand)).toHaveLength(0);
  });

  it('replication: warns and skips', async () => {
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      replicationProps([{ Id: 'probe', Status: 1, ...validReplicationFields }]),
      { BucketName: BUCKET }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${REPLICATION_STATUS_PATH} must be a non-empty string`)
    );
    expect(sentCommands(PutBucketReplicationCommand)).toHaveLength(0);
  });
});

describe('no false refusal: valid and ABSENT values keep working', () => {
  it('lifecycle: an ABSENT Status still defaults to Enabled, with no warning', async () => {
    // The ABSENT case belongs to the caller, not the guard: an omitted field
    // legitimately means "defaulted", and refusing it would break every
    // template that relies on the default.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps([{ Id: 'probe', ExpirationInDays: 30 }])
    );
    const sent = sentCommands(PutBucketLifecycleConfigurationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.LifecycleConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Status']).toBe('Enabled');
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('lifecycle: a DISABLED rule is applied verbatim, on the replay path too', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps([{ Id: 'probe', Status: 'Disabled', ExpirationInDays: 30 }]),
      { replayingState: true }
    );
    const sent = sentCommands(PutBucketLifecycleConfigurationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.LifecycleConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Status']).toBe('Disabled');
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('replication: a DISABLED rule is applied verbatim, on the replay path too', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      replicationProps([{ Id: 'probe', Status: 'Disabled', ...validReplicationFields }]),
      { replayingState: true }
    );
    const sent = sentCommands(PutBucketReplicationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.ReplicationConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Status']).toBe('Disabled');
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('intelligent tiering: a valid item applies with no warning', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      itProps([
        { Id: 'probe', Status: 'Disabled', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
      ])
    );
    const sent = sentCommands(PutBucketIntelligentTieringConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.IntelligentTieringConfiguration?.Status).toBe('Disabled');
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('inventory: a valid item applies with no warning', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      inventoryProps([{ Id: 'probe', IncludedObjectVersions: 'Current', ...validInventoryFields }])
    );
    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.InventoryConfiguration?.IncludedObjectVersions).toBe('Current');
    expect(childLogger.warn).not.toHaveBeenCalled();
  });
});
