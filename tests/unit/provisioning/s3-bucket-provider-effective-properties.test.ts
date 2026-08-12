import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketIntelligentTieringConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1612: the warn-and-skip replay paths #1579 / #1581 / #1595 / #1605
 * shipped announce the skip and let the deploy SUCCEED — so the engine records
 * the DESIRED bag, malformed value and all, for a Put that never reached AWS.
 * `readCurrentState` can then never match it, every later `cdkd drift`
 * re-reports the same difference, and `drift --revert` re-issues the same
 * skipped call: the permanent phantom drift `.claude/rules/providers.md`
 * records for the EC2 Route warn arm (#1591), reached through a SKIP rather
 * than a narrowing.
 *
 * The remedy is `effectiveProperties`, and what to record differs per path —
 * neither answer generalizes, which is why each is pinned separately here:
 *
 * - **UPDATE**: retain the PREVIOUS value. The Put never ran, so AWS still
 *   holds the previously-applied configuration. Dropping the key instead is
 *   wrong in the other direction — a later template that REMOVES the block
 *   would derive no removal and the live configuration would survive forever,
 *   which is what the `drops the key` mutation row below fences.
 * - **replay-CREATE**: DROP the key. The bucket is brand new and nothing was
 *   applied, so there is no previous value to keep.
 * - **per-item appliers**: the skip unit is one configuration ITEM, so the
 *   effective array substitutes the previous item of the same `Id` IN PLACE,
 *   or drops it when the skipped item was an ADD.
 *
 * Three rows exist because the obvious version of this test passes under a
 * wrong implementation:
 *
 * 1. **The DESIRED order is asserted with the skipped item FIRST.**
 *    `DiffCalculator` compares arrays positionally, so an implementation that
 *    appends the retained items instead of substituting them in place removes
 *    this phantom drift and manufactures a fresh one. With the skipped item
 *    last, `[kept, retained]` and `[retained, kept]` are the same array.
 * 2. **The no-skip row asserts `effectiveProperties` is ABSENT, not equal to
 *    the desired bag.** An implementation that always returns the bag is
 *    indistinguishable by value, and it would rewrite the record on every
 *    ordinary deploy — the engine gates on `??`, so absent is the contract.
 * 3. **The retained value is asserted to be the PREVIOUS one specifically**,
 *    not merely "different from desired". A skip that dropped the key also
 *    differs from desired.
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
const BUCKET = 'effective-properties-bucket';

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

/** The malformed shapes a state record written by an older binary can carry. */
const MALFORMED = ['   ', null, 1, ['Enabled'], { 'Fn::If': ['C', 'Enabled', 'Disabled'] }];

const TIERINGS = [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }];

const liveLifecycle = { Rules: [{ Id: 'r1', Status: 'Disabled', ExpirationInDays: 30 }] };
const malformedLifecycle = (value: unknown) => ({
  Rules: [{ Id: 'r1', Status: value, ExpirationInDays: 30 }],
});

describe('UPDATE: a skipped WHOLE-Put records the PREVIOUS value', () => {
  for (const value of MALFORMED) {
    it(`lifecycle: retains the previously applied configuration (${JSON.stringify(value)})`, async () => {
      const properties = { BucketName: BUCKET, LifecycleConfiguration: malformedLifecycle(value) };
      const previousProperties = { BucketName: BUCKET, LifecycleConfiguration: liveLifecycle };

      const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
        ...previousProperties,
      });

      // The Put really was skipped — otherwise there is nothing to record.
      expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
      // ...and the record describes what AWS still holds, not what it was
      // handed. Asserted against the PREVIOUS value specifically: a
      // key-dropping implementation is also "not the desired value".
      expect(result.effectiveProperties?.['LifecycleConfiguration']).toEqual(liveLifecycle);
      // Every other key rides through untouched — `effectiveProperties`
      // REPLACES the desired bag wholesale, so it has to be complete.
      expect(result.effectiveProperties?.['BucketName']).toBe(BUCKET);
    });
  }

  it('lifecycle: an ABSENT previous value removes the key rather than recording undefined', async () => {
    const properties = { BucketName: BUCKET, LifecycleConfiguration: malformedLifecycle(1) };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
    });

    expect(result.effectiveProperties).toBeDefined();
    // `in`, not a value compare: an explicit `undefined` survives a value
    // assertion but is dropped by `JSON.stringify` on one side of the next
    // diff and not the other.
    expect('LifecycleConfiguration' in result.effectiveProperties!).toBe(false);
  });

  it('versioning: a skipped PutBucketVersioning retains the previous block', async () => {
    const properties = { BucketName: BUCKET, VersioningConfiguration: { Status: ['Enabled'] } };
    const previousProperties = {
      BucketName: BUCKET,
      VersioningConfiguration: { Status: 'Enabled' },
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    expect(sentCommands(PutBucketVersioningCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
  });

  it('versioning: Object Lock blocking a suspend records the still-Enabled previous block', async () => {
    // A warn-and-skip arm reached by a structural AWS constraint rather than a
    // malformed value — same state consequence, so the same remedy.
    const previousProperties = {
      BucketName: BUCKET,
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Enabled' },
    };
    const properties = {
      BucketName: BUCKET,
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Suspended' },
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    expect(sentCommands(PutBucketVersioningCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
  });
});

describe('UPDATE: a skipped PER-ITEM Put substitutes that item IN PLACE', () => {
  it('intelligent tiering: keeps the previous item, in the DESIRED position', async () => {
    // The skipped item is FIRST and the previous array holds it LAST, so an
    // implementation that appends retained items instead of substituting them
    // produces `[good, previousBad]` and fails here. With the skipped item
    // last, both orders coincide and the mutation is invisible.
    const previousBad = { Id: 'bad', Status: 'Disabled', Tierings: TIERINGS };
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 'bad', Status: 1, Tierings: TIERINGS },
        { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
      ],
    };
    const previousProperties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 'good', Status: 'Disabled', Tierings: TIERINGS },
        previousBad,
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    // The valid sibling DID apply — the Put is per-Id, so only the malformed
    // item is skipped.
    const sent = sentCommands(PutBucketIntelligentTieringConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input['Id']).toBe('good');

    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([
      previousBad,
      { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
    ]);
  });

  it('intelligent tiering: a skipped ADD is DROPPED, since AWS holds nothing for that Id', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 'added', Status: 1, Tierings: TIERINGS },
        { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
      ],
    };
    const previousProperties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [{ Id: 'good', Status: 'Disabled', Tierings: TIERINGS }],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([
      { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
    ]);
  });

  it('intelligent tiering: every item skipped with NO previous array removes the key', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [{ Id: 'added', Status: 1, Tierings: TIERINGS }],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
    });

    expect(result.effectiveProperties).toBeDefined();
    expect('IntelligentTieringConfigurations' in result.effectiveProperties!).toBe(false);
  });
});

describe('replay-CREATE: a skip DROPS the key, because nothing was ever applied', () => {
  it('lifecycle: the skipped block is absent from the recorded bag', async () => {
    const properties = { BucketName: BUCKET, LifecycleConfiguration: malformedLifecycle(1) };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(result.effectiveProperties).toBeDefined();
    expect('LifecycleConfiguration' in result.effectiveProperties!).toBe(false);
    expect(result.effectiveProperties?.['BucketName']).toBe(BUCKET);
  });

  it('intelligent tiering: only the skipped ITEM is dropped, the applied ones stay', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 'bad', Status: 1, Tierings: TIERINGS },
        { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
      ],
    };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([
      { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
    ]);
  });

  it('versioning: the skipped block is absent, so state does not claim a versioned bucket', async () => {
    const properties = { BucketName: BUCKET, VersioningConfiguration: { Status: null } };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    expect(sentCommands(PutBucketVersioningCommand)).toHaveLength(0);
    expect('VersioningConfiguration' in result.effectiveProperties!).toBe(false);
  });
});

describe('nothing skipped: `effectiveProperties` stays ABSENT', () => {
  it('update: an ordinary configuration change records the desired bag unchanged', async () => {
    const properties = {
      BucketName: BUCKET,
      LifecycleConfiguration: { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 10 }] },
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      LifecycleConfiguration: liveLifecycle,
    });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    // Absent, NOT "equal to properties": the engine gates on `??`, so an
    // implementation that always answers is a rewrite of the record on every
    // deploy and a value compare cannot see it.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('template-path create: no downgrade is reachable, so nothing is recorded', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [{ Id: 'good', Status: 'Enabled', Tierings: TIERINGS }],
    };

    const result = await provider.create('B', RESOURCE_TYPE, properties);

    expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(1);
    expect(result.effectiveProperties).toBeUndefined();
  });
});

/**
 * The per-APPLIER wiring fence (test review on PR #1660, HIGH).
 *
 * The rows above exercise three appliers. The other five are wired by
 * copy-paste — `retainPrevious('<Key>')` / `retainPreviousItems('<Key>',
 * skipped<X>Ids)` — and that is the highest-probability defect in the change:
 * a wrong key or a wrong skip-set pasted at any of the 22 wiring sites leaves
 * every assertion above GREEN, while silently recording a value AWS never
 * received (whole-Put case) or clobbering an unrelated property (wrong-key
 * case).
 *
 * Each row therefore asserts BOTH halves, which is what makes a mis-paste
 * visible: the target key must hold the PREVIOUS value, AND a sibling property
 * that was NOT skipped must survive untouched. Asserting only the first would
 * miss `retainPrevious` pointed at the wrong key; asserting only the second
 * would miss the skip going unrecorded.
 */
interface WiringSite {
  readonly name: string;
  readonly key: string;
  /** A valid, previously-applied value for `key`. */
  readonly previous: unknown;
  /** The same block with ONE field malformed, so the applier skips. */
  readonly desired: unknown;
  /** What the effective bag must carry — the previous value, or a rebuilt array. */
  readonly expected: unknown;
}

const S3_DEST = { BucketArn: 'arn:aws:s3:::dest', Format: 'CSV' };

const WIRING_SITES: WiringSite[] = [
  {
    name: 'logging (whole Put)',
    key: 'LoggingConfiguration',
    previous: { DestinationBucketName: 'live-logs', LogFilePrefix: 'p/' },
    desired: { DestinationBucketName: 1 },
    expected: { DestinationBucketName: 'live-logs', LogFilePrefix: 'p/' },
  },
  {
    name: 'replication (whole Put)',
    key: 'ReplicationConfiguration',
    previous: {
      Role: 'arn:aws:iam::123456789012:role/repl',
      Rules: [{ Id: 'r', Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::dest' } }],
    },
    desired: {
      Role: 'arn:aws:iam::123456789012:role/repl',
      Rules: [{ Id: 'r', Status: 1, Destination: { Bucket: 'arn:aws:s3:::dest' } }],
    },
    expected: {
      Role: 'arn:aws:iam::123456789012:role/repl',
      Rules: [{ Id: 'r', Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::dest' } }],
    },
  },
  {
    name: 'metrics (per item, TagFilters container guard)',
    key: 'MetricsConfigurations',
    previous: [{ Id: 'm1', Prefix: 'live/' }],
    desired: [{ Id: 'm1', TagFilters: 'not-an-array' }],
    expected: [{ Id: 'm1', Prefix: 'live/' }],
  },
  {
    name: 'analytics (per item, StorageClassAnalysis container guard)',
    key: 'AnalyticsConfigurations',
    previous: [{ Id: 'a1', StorageClassAnalysis: {} }],
    desired: [{ Id: 'a1', StorageClassAnalysis: 'not-an-object' }],
    expected: [{ Id: 'a1', StorageClassAnalysis: {} }],
  },
  {
    name: 'analytics (per item, unusable DataExport destination)',
    key: 'AnalyticsConfigurations',
    previous: [{ Id: 'a1', StorageClassAnalysis: {} }],
    desired: [
      { Id: 'a1', StorageClassAnalysis: { DataExport: { Destination: 'not-an-object' } } },
    ],
    expected: [{ Id: 'a1', StorageClassAnalysis: {} }],
  },
  {
    name: 'inventory (per item, IncludedObjectVersions guard)',
    key: 'InventoryConfigurations',
    previous: [
      { Id: 'i1', IncludedObjectVersions: 'All', Destination: S3_DEST, ScheduleFrequency: 'Daily' },
    ],
    desired: [
      { Id: 'i1', IncludedObjectVersions: 1, Destination: S3_DEST, ScheduleFrequency: 'Daily' },
    ],
    expected: [
      { Id: 'i1', IncludedObjectVersions: 'All', Destination: S3_DEST, ScheduleFrequency: 'Daily' },
    ],
  },
  {
    name: 'inventory (per item, two-source ScheduleFrequency with no fallback)',
    key: 'InventoryConfigurations',
    previous: [
      { Id: 'i1', IncludedObjectVersions: 'All', Destination: S3_DEST, ScheduleFrequency: 'Daily' },
    ],
    desired: [
      { Id: 'i1', IncludedObjectVersions: 'All', Destination: S3_DEST, ScheduleFrequency: 1 },
    ],
    expected: [
      { Id: 'i1', IncludedObjectVersions: 'All', Destination: S3_DEST, ScheduleFrequency: 'Daily' },
    ],
  },
];

// A sibling the run never skips. Its survival is what catches a `retainPrevious`
// / `retainPreviousItems` call pointed at the WRONG key: a mis-paste overwrites
// this with the previous bag's value instead of the target property.
const UNSKIPPED_SIBLING = { Rules: [{ Id: 'keep', Status: 'Enabled', ExpirationInDays: 5 }] };

describe('UPDATE: every applier records under ITS OWN key (wiring fence)', () => {
  for (const site of WIRING_SITES) {
    it(`${site.name}: retains the previous value and leaves the unskipped sibling alone`, async () => {
      const properties = {
        BucketName: BUCKET,
        [site.key]: site.desired,
        LifecycleConfiguration: UNSKIPPED_SIBLING,
      };
      const previousProperties = {
        BucketName: BUCKET,
        [site.key]: site.previous,
        LifecycleConfiguration: UNSKIPPED_SIBLING,
      };

      const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
        ...previousProperties,
      });

      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties?.[site.key]).toEqual(site.expected);
      expect(result.effectiveProperties?.['LifecycleConfiguration']).toEqual(UNSKIPPED_SIBLING);
      expect(result.effectiveProperties?.['BucketName']).toBe(BUCKET);
    });
  }
});

describe('replay-CREATE: every applier drops ITS OWN key (wiring fence)', () => {
  for (const site of WIRING_SITES) {
    it(`${site.name}: the skipped block is absent and the sibling survives`, async () => {
      const properties = {
        BucketName: BUCKET,
        [site.key]: site.desired,
        LifecycleConfiguration: UNSKIPPED_SIBLING,
      };

      const result = await provider.create('B', RESOURCE_TYPE, properties, {
        replayingState: true,
      });

      expect(result.effectiveProperties).toBeDefined();
      // Nothing was applied on a fresh bucket, so the key is DROPPED — or, for a
      // per-item applier, reduced to the items that DID apply (none here).
      expect(result.effectiveProperties?.[site.key]).toBeUndefined();
      expect(result.effectiveProperties?.['LifecycleConfiguration']).toEqual(UNSKIPPED_SIBLING);
    });
  }
});

describe('the create-path logging GATE is its own arm', () => {
  it('drops LoggingConfiguration when the GATE refuses, before the applier runs', async () => {
    // Structurally distinct from every other create override: this one is set
    // from a refusal in `applyAllSubConfigsForCreate` that never calls
    // `applyLoggingConfiguration` at all. Deleting the `overrides.set` there
    // leaves the else-branch unreachable, so no other row can see it.
    const properties = {
      BucketName: BUCKET,
      LoggingConfiguration: { DestinationBucketName: 1 },
    };

    const result = await provider.create('B', RESOURCE_TYPE, properties, {
      replayingState: true,
    });

    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping the logging configuration')
    );
    expect(result.effectiveProperties).toBeDefined();
    expect('LoggingConfiguration' in result.effectiveProperties!).toBe(false);
  });
});

describe('a NUMERIC Id still records its skip (code review on PR #1660)', () => {
  it('substitutes the previous item when the Id is an unquoted-YAML number', async () => {
    // `diffArrayConfigById` accepts an `Id` under a TRUTHINESS test, so an
    // unquoted-YAML `Id: 1` is a NUMBER that reaches the Put and lands in the
    // skipped-id set as a number. A `typeof id === 'string'` predicate on the
    // other side read that item as NOT skipped and recorded the never-applied
    // desired value — the phantom drift this suite exists to fence, surviving
    // for exactly this shape.
    const previousItem = { Id: 1, Status: 'Disabled', Tierings: TIERINGS };
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [{ Id: 1, Status: 1, Tierings: TIERINGS }],
    };
    const previousProperties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [previousItem],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([previousItem]);
  });
});
