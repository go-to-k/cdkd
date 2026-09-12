import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketAnalyticsConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketReplicationCommand,
  PutObjectLockConfigurationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1581: the malformed-CONTAINER class one level up from the #1579
 * `TagFilters` guard, on containers whose members are probed for PRESENCE
 * rather than read as a string — so neither `readConfigString` (which needs a
 * string read) nor `requireConfigArray` (which needs a list) ever fired.
 *
 * Two live hazards, both silent:
 *
 * 1. **Lifecycle `Filter`.** A non-object `Filter` indexed every probe in
 *    `lifecycleRuleScope` to `undefined`, so the rule kept NO scope and fell through
 *    to the empty-prefix V2 `Filter` — an expiration rule then applied to the
 *    WHOLE bucket (the #1388 hazard through the parent container).
 * 2. **Analytics `StorageClassAnalysis`.** A non-object container indexed the
 *    `DataExport` probe to `undefined`, so the data export vanished and the
 *    Put carried `StorageClassAnalysis: {}` — which S3 ACCEPTS as "no export",
 *    so nothing surfaced.
 *
 * Same #1556 split as its siblings: REFUSE on a template-path create, WARN and
 * skip on the state-replay paths. The skip UNIT differs by API — the lifecycle
 * Put replaces every rule, so the whole configuration is left alone, while the
 * analytics Put is per-Id and only the malformed item is skipped.
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

// eu-west-1, so that the several `expect(childLogger.warn).not.toHaveBeenCalled()`
// assertions below keep meaning "this well-formed container was not refused".
// In us-east-1 the provider pre-flights the bucket name before creating it
// (issue #2241) and warns when the name is already taken -- and this file's
// catch-all `mockSend.mockResolvedValue({})` answers that probe with a valid
// us-east-1 `GetBucketLocationOutput`, i.e. "already taken". That warning is
// about bucket identity, not container shape, so it would turn every no-warn
// assertion here into a fence on an unrelated code path.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('eu-west-1') } },
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
const BUCKET = 'container-shape-bucket';

const FILTER_PATH = 'AWS::S3::Bucket LifecycleConfiguration.Rules[].Filter';
const SCA_PATH = 'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis';
const DATA_EXPORT_PATH = `${SCA_PATH}.DataExport`;
const EVENT_HOLD_PATH =
  'AWS::S3::Bucket ObjectLockConfiguration.Rule.DefaultRetention.DefaultEventHold';

const VALID_DATA_EXPORT = {
  OutputSchemaVersion: 'V_1',
  Destination: { BucketArn: 'arn:aws:s3:::analytics-dest', Format: 'CSV' },
};

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  // `GetBucketLocation` is answered with THIS client's region rather than the
  // blanket `{}`: an absent `LocationConstraint` is S3's spelling of
  // us-east-1, so the blanket answer would tell the update-path identity guard
  // (issue #2245) that this bucket lives somewhere other than where the mocked
  // client is, and every update case here would die on that refusal instead of
  // exercising its container shape.
  mockSend.mockImplementation((cmd: unknown) =>
    Promise.resolve(
      (cmd as { constructor: { name: string } }).constructor.name === 'GetBucketLocationCommand'
        ? { LocationConstraint: 'eu-west-1' }
        : {}
    )
  );
});

function sentCommands<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof commandType) as T[];
}

const lifecycleProps = (rule: Record<string, unknown>) => ({
  BucketName: BUCKET,
  LifecycleConfiguration: { Rules: [{ Id: 'probe', Status: 'Enabled', ...rule }] },
});
const analyticsProps = (config: Record<string, unknown>) => ({
  BucketName: BUCKET,
  AnalyticsConfigurations: [{ Id: 'probe', ...config }],
});
const objectLockProps = (hold: unknown) => ({
  BucketName: BUCKET,
  ObjectLockEnabled: true,
  ObjectLockConfiguration: {
    ObjectLockEnabled: 'Enabled',
    Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30, DefaultEventHold: hold } },
  },
});

// Each is NOT a plain object, i.e. every probe of it indexes to `undefined`.
// The ARRAY is the one a bare `typeof === 'object'` check would have waved
// through. The last two are FALSY on purpose and are the highest-value rows
// here: every one of these guards sits behind a `!= null` gate, and issue
// #1493 shipped exactly this class of bug by putting the gate at truthiness
// instead — so a regression to `if (raw)` would keep every truthy row green
// while re-landing the bucket-wide expiration / silently-empty block. Without
// these rows the suite cannot tell the two gates apart.
const malformedContainers: Array<[string, unknown]> = [
  ['a string (an unresolved intrinsic collapsed to text)', 'logs/'],
  ['an array', [{ Prefix: 'logs/' }]],
  ['a number', 42],
  ['a blank string (FALSY — the #1493 truthiness-gate shape)', ''],
  ['zero (FALSY — the #1493 truthiness-gate shape)', 0],
  // Issue #3032, and the highest-value row here: an UNRESOLVED INTRINSIC is
  // the one malformed shape that is a plain OBJECT, so every row above is
  // blind to it — the guard used to accept it, the key probe indexed to
  // `undefined`, and the block read as EMPTY. Without this row the new
  // refusal is unfenced at every create-path site in this file (measured:
  // killing the throw arm reddened only helper-level and Glue cases, ZERO S3
  // ones). The file already records this arm shipping unfenced once, in
  // PR #3002, which is why it is a ROW rather than a single new case.
  ['an unresolved intrinsic (a plain OBJECT, so the other rows cannot see it)', { Ref: 'Scope' }],
];

describe('create path: a non-object container is REFUSED, not silently emptied', () => {
  for (const [label, value] of malformedContainers) {
    it(`lifecycle: refuses a Filter that is ${label}, and sends NO lifecycle Put`, async () => {
      await expect(
        provider.create(
          'B',
          RESOURCE_TYPE,
          lifecycleProps({ ExpirationInDays: 30, Filter: value })
        )
      ).rejects.toThrow(`${FILTER_PATH} must be an object`);
      expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    });

    it(`analytics: refuses a StorageClassAnalysis that is ${label}`, async () => {
      await expect(
        provider.create('B', RESOURCE_TYPE, analyticsProps({ StorageClassAnalysis: value }))
      ).rejects.toThrow(`${SCA_PATH} must be an object`);
      expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
    });

    it(`object lock: refuses a DefaultEventHold that is ${label}`, async () => {
      // PR #3002. This is the THROWING arm of the guard, and it is the arm a
      // plain `cdkd deploy` takes: `replayWarn(...).onUnusable` is `undefined`
      // on a template-path create. Measured before this case existed --
      // downgrading the arm to a no-op callback left the ENTIRE unit suite
      // green (992/992 files) while a declared WORM rule was silently skipped
      // and the deploy reported success. Every other case for this member
      // drives the warn arm, so nothing else can see it.
      await expect(
        provider.create('B', RESOURCE_TYPE, objectLockProps(value))
      ).rejects.toThrow(`${EVENT_HOLD_PATH} must be an object`);
      expect(sentCommands(PutObjectLockConfigurationCommand)).toHaveLength(0);
    });
  }

  it('the refusal fires BEFORE the widened-scope rule can reach S3', async () => {
    // The regression this exists for: with the malformed Filter dropped
    // silently, the rule below reached S3 as a bucket-wide 30-day expiration.
    // Asserting only "it throws" would also pass if the Put had already gone
    // out, so pin the absence of the request itself.
    await expect(
      provider.create(
        'B',
        RESOURCE_TYPE,
        lifecycleProps({ ExpirationInDays: 30, Filter: 'archive/' })
      )
    ).rejects.toThrow(/must be an object/);
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('one malformed rule refuses the WHOLE configuration, not just that rule', async () => {
    // The Put replaces every rule, so applying the valid sibling alone would
    // DELETE the malformed rule from AWS — a destructive "partial success".
    await expect(
      provider.create('B', RESOURCE_TYPE, {
        BucketName: BUCKET,
        LifecycleConfiguration: {
          Rules: [
            { Id: 'good', Status: 'Enabled', ExpirationInDays: 10, Filter: { Prefix: 'a/' } },
            { Id: 'bad', Status: 'Enabled', ExpirationInDays: 30, Filter: 'b/' },
          ],
        },
      })
    ).rejects.toThrow(`${FILTER_PATH} must be an object`);
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });
});

describe('create path: the PRE-EXISTING DataExport refusal is preserved, not new', () => {
  // Deliberately its own block rather than a row in the table above, because
  // EVERY NON-OBJECT ROW here would ALSO pass on the unfixed tree: before that
  // change a non-object `DataExport` reached `readConfigString(dataExport,
  // 'OutputSchemaVersion', …)`, whose refusal message is byte-identical and
  // which also fired before any Put — so no matcher can tell the two apart on
  // the create path. Claiming those as proof of the guard would pin the
  // author's intent rather than the behavior; they are kept as a REGRESSION
  // fence (the explicit guard must not have relaxed the create-path refusal).
  //
  // The scope of that caveat NARROWED with issue #3032 and the wording is
  // corrected here rather than left to read as covering the whole table: the
  // INTRINSIC row is a plain object, so pre-#3032 it passed the container
  // guard, the `OutputSchemaVersion` read took its fallback, and nothing threw
  // at all. That row IS a genuine new-guard fence. The other genuinely new
  // DataExport behavior is the replay/update downgrade, pinned separately
  // below.
  for (const [label, value] of malformedContainers) {
    it(`analytics: still refuses a DataExport that is ${label}`, async () => {
      await expect(
        provider.create(
          'B',
          RESOURCE_TYPE,
          analyticsProps({ StorageClassAnalysis: { DataExport: value } })
        )
      ).rejects.toThrow(`${DATA_EXPORT_PATH} must be an object`);
      expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
    });
  }
});

describe('replication: the same container class, one applier over', () => {
  const REPLICATION_PATH = 'AWS::S3::Bucket ReplicationConfiguration.Rules[].Filter';
  const replicationProps = (rule: Record<string, unknown>) => ({
    BucketName: BUCKET,
    ReplicationConfiguration: {
      Role: 'arn:aws:iam::123456789012:role/repl',
      Rules: [
        {
          Id: 'probe',
          Status: 'Enabled',
          Destination: { Bucket: 'arn:aws:s3:::repl-dest' },
          ...rule,
        },
      ],
    },
  });

  for (const [label, value] of malformedContainers) {
    it(`refuses a Filter that is ${label}`, async () => {
      // The widest blast radius of the three: the malformed container used to
      // fall through to the "empty / unrecognized filter object" arm, which
      // emits `Filter: {}` — the valid CFn form meaning "replicate EVERY
      // object". So the bucket replicated wholesale instead of the declared
      // subset, at cross-region cost and outside the intended data scope.
      await expect(
        provider.create('B', RESOURCE_TYPE, replicationProps({ Filter: value }))
      ).rejects.toThrow(`${REPLICATION_PATH} must be an object`);
      expect(sentCommands(PutBucketReplicationCommand)).toHaveLength(0);
    });
  }

  it('warns and leaves the WHOLE live configuration alone on a replay', async () => {
    await provider.create('B', RESOURCE_TYPE, replicationProps({ Filter: 'logs/' }), {
      replayingState: true,
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${REPLICATION_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketReplicationCommand)).toHaveLength(0);
  });

  it('a valid Filter still replicates the declared subset', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      replicationProps({ Filter: { Prefix: 'logs/' } })
    );
    const sent = sentCommands(PutBucketReplicationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.ReplicationConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Filter']).toEqual({ Prefix: 'logs/' });
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('warns and skips on the UPDATE path (the only wiring nothing else covers)', async () => {
    // Without this, deleting the third argument at the update call site leaves
    // the whole suite green while a malformed replication `Filter` HARD-THROWS
    // on update / rollback replay — exactly the un-rollbackable failure the
    // create/replay split exists to prevent. Lifecycle and analytics both have
    // this test; replication did not until the PR review asked for it.
    await provider.update('B', BUCKET, RESOURCE_TYPE, replicationProps({ Filter: 'logs/' }), {
      BucketName: BUCKET,
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${REPLICATION_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketReplicationCommand)).toHaveLength(0);
  });

  it('an EMPTY Filter object still means "replicate every object" (issue #936)', async () => {
    // The guard must not disturb the one shape that legitimately produces the
    // wide scope — otherwise the fix would break a valid template.
    await provider.create('B', RESOURCE_TYPE, replicationProps({ Filter: {} }));
    const sent = sentCommands(PutBucketReplicationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.ReplicationConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Filter']).toEqual({});
  });
});

describe('no false refusal: well-formed and absent containers still apply', () => {
  it('lifecycle: a valid Filter keeps its scope', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Filter: { Prefix: 'logs/' } })
    );
    const sent = sentCommands(PutBucketLifecycleConfigurationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.LifecycleConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Filter']).toEqual({ Prefix: 'logs/' });
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('lifecycle: an EMPTY Filter object is legitimate (a whole-bucket rule the template asked for)', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Filter: {} })
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
  });

  it('lifecycle: an explicit NULL Filter means "block omitted" and keeps the V1 Prefix form', async () => {
    // The `!= null` alignment: the strict `!== undefined` compare used to read
    // `null` as PRESENT and force every rule into V2 Filter form, disagreeing
    // with the container guard one line up which treats it as absent.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Prefix: 'logs/', Filter: null })
    );
    const sent = sentCommands(PutBucketLifecycleConfigurationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.LifecycleConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Prefix']).toBe('logs/');
    expect(rule['Filter']).toBeUndefined();
  });

  it('analytics: a valid StorageClassAnalysis.DataExport still reaches S3', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      analyticsProps({ StorageClassAnalysis: { DataExport: VALID_DATA_EXPORT } })
    );
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent).toHaveLength(1);
    const dataExport = sent[0]!.input.AnalyticsConfiguration?.StorageClassAnalysis?.DataExport;
    expect(dataExport?.OutputSchemaVersion).toBe('V_1');
    expect(dataExport?.Destination?.S3BucketDestination?.Bucket).toBe(
      'arn:aws:s3:::analytics-dest'
    );
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('analytics: an ABSENT StorageClassAnalysis still applies with the empty block', async () => {
    await provider.create('B', RESOURCE_TYPE, analyticsProps({ Prefix: 'logs/' }));
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.AnalyticsConfiguration?.StorageClassAnalysis).toEqual({});
  });

  it('analytics: an EXPLICIT empty StorageClassAnalysis is legitimate, not a refusal', async () => {
    await provider.create('B', RESOURCE_TYPE, analyticsProps({ StorageClassAnalysis: {} }));
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.AnalyticsConfiguration?.StorageClassAnalysis).toEqual({});
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('lifecycle: a VALID Filter is not refused on the REPLAY path either', async () => {
    // The downgrade must only change what happens to a MALFORMED value; a
    // replay carrying a well-formed container has to apply exactly as a
    // template-path create does.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Filter: { Prefix: 'logs/' } }),
      { replayingState: true }
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });
});

describe('replay create (`replayingState`): warn and skip instead of stranding the rollback', () => {
  it('lifecycle: warns and leaves the WHOLE live configuration alone', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Filter: 'logs/' }),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${FILTER_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('lifecycle: an UNRESOLVED INTRINSIC Filter takes the same whole-Put skip', async () => {
    // Issue #3032's warn arm, and the one that matters most: pre-guard, an
    // intrinsic `Filter` indexed every scope probe to `undefined`, so the rule
    // kept NO scope and the 30-day expiration applied to the WHOLE bucket --
    // destructive, on a replay the user cannot edit from the template. The
    // string fixture above cannot reach this: it fails the shape test, while
    // an intrinsic PASSES it.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Filter: { Ref: 'ScopeParam' } }),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('got an unresolved Ref intrinsic')
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('analytics: an UNRESOLVED INTRINSIC item is skipped, the valid sibling still applies', async () => {
    // The per-ITEM skip unit for the same shape -- a different arm from the
    // whole-Put one above, so it needs its own row.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      {
        BucketName: BUCKET,
        AnalyticsConfigurations: [
          { Id: 'bad', StorageClassAnalysis: { 'Fn::If': ['C', {}, {}] } },
          { Id: 'good', StorageClassAnalysis: { DataExport: VALID_DATA_EXPORT } },
        ],
      },
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('got an unresolved Fn::If intrinsic')
    );
    const puts = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(puts).toHaveLength(1);
    expect((puts[0] as { input: { Id: string } }).input.Id).toBe('good');
  });

  it('analytics: warns, skips the malformed item, still applies the valid sibling', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      {
        BucketName: BUCKET,
        AnalyticsConfigurations: [
          { Id: 'bad', StorageClassAnalysis: 'nope' },
          { Id: 'good', StorageClassAnalysis: { DataExport: VALID_DATA_EXPORT } },
        ],
      },
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${SCA_PATH} must be an object`)
    );
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent.map((c) => c.input.Id)).toEqual(['good']);
  });

  it('analytics: a malformed DataExport no longer HARD-THROWS on a replay', async () => {
    // Before this change the block was refused only indirectly, by the
    // `readConfigString(dataExport, 'OutputSchemaVersion', …)` below it — which
    // carries no downgrade, so a historical state record with a malformed
    // DataExport made the resource un-rollbackable.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      analyticsProps({ StorageClassAnalysis: { DataExport: 'nope' } }),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${DATA_EXPORT_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });
});

describe('update path: warn and skip (the desired bag can be a historical state record)', () => {
  async function update(properties: Record<string, unknown>): Promise<void> {
    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, { BucketName: BUCKET });
  }

  it('lifecycle: warns and does NOT send the Put', async () => {
    await update(lifecycleProps({ ExpirationInDays: 30, Filter: 'logs/' }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${FILTER_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('analytics: warns on a malformed StorageClassAnalysis and does NOT send the Put', async () => {
    await update(analyticsProps({ StorageClassAnalysis: 'nope' }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${SCA_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });

  it('analytics: warns on a malformed DataExport and does NOT send the Put', async () => {
    await update(analyticsProps({ StorageClassAnalysis: { DataExport: 42 } }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${DATA_EXPORT_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });

  it('versioning: an UNRESOLVED INTRINSIC VersioningConfiguration does NOT suspend a live bucket', async () => {
    // The module header's OWN headline case, and it had no provider-level
    // witness until issue #3032 — `configStringRefusal` was fenced only at
    // helper level. Pre-guard the refusal was `undefined`, `readConfigString`
    // returned the `'Suspended'` fallback, and `applyVersioning` suspended
    // versioning on a LIVE bucket from a template that asked for nothing of
    // the sort.
    await update({
      BucketName: BUCKET,
      VersioningConfiguration: { 'Fn::If': ['C', { Status: 'Enabled' }, { Status: 'Suspended' }] },
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('got an unresolved Fn::If intrinsic')
    );
    expect(sentCommands(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it('notification: an UNRESOLVED INTRINSIC EventBridgeConfiguration is not folded to false', async () => {
    // `configBooleanRefusal`'s provider-level witness. Pre-guard the intrinsic
    // container indexed `EventBridgeEnabled` to `undefined`, the refusal was
    // `undefined`, and `foldEventBridgeConfiguration` rewrote the block to
    // `{ EventBridgeEnabled: false }` — silently DISABLING a delivery the
    // template never disabled.
    await update({
      BucketName: BUCKET,
      NotificationConfiguration: { EventBridgeConfiguration: { Ref: 'EbToggle' } },
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('got an unresolved Ref intrinsic')
    );
    expect(sentCommands(PutBucketNotificationConfigurationCommand)).toHaveLength(0);
  });

  it('analytics: an UNRESOLVED INTRINSIC DataExport is skipped, not sent half-built', async () => {
    // The 5th `requireConfigObject` site, and the rows above cannot reach it:
    // `'nope'` / `42` fail the SHAPE test while an intrinsic passes it. Without
    // the guard the item is SENT with `OutputSchemaVersion: 'V_1'` and no
    // `Destination` -- a half-built export the template never asked for.
    await update(analyticsProps({ StorageClassAnalysis: { DataExport: { Ref: 'Export' } } }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('got an unresolved Ref intrinsic')
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });

  it('replication: an UNRESOLVED INTRINSIC Filter skips the whole Put on the update path', async () => {
    // The destructive one. This applier's fall-through emits `Filter: {}` --
    // valid CFn for "replicate EVERY object" -- so an accepted intrinsic here
    // widened replication from the declared subset to the WHOLE bucket. The
    // create path is covered by `malformedContainers`; this is the replay /
    // update arm, which is the one a user cannot fix from the template.
    // `replicationProps` is local to the replication describe above, so the
    // shape is inlined rather than widened into shared scope.
    await update({
      BucketName: BUCKET,
      ReplicationConfiguration: {
        Role: 'arn:aws:iam::123456789012:role/repl',
        Rules: [
          {
            Id: 'probe',
            Status: 'Enabled',
            Destination: { Bucket: 'arn:aws:s3:::repl-dest' },
            Filter: { 'Fn::If': ['C', {}, {}] },
          },
        ],
      },
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('got an unresolved Fn::If intrinsic')
    );
    expect(sentCommands(PutBucketReplicationCommand)).toHaveLength(0);
  });

  it('analytics: the update-path skip unit is the ITEM, not the whole sync', async () => {
    // The per-Id Put means a malformed sibling must not take the valid ones
    // down with it — the opposite of the lifecycle contract, and the reason
    // the two guards use different exits.
    await update({
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        { Id: 'bad', StorageClassAnalysis: 'nope' },
        { Id: 'good', StorageClassAnalysis: { DataExport: VALID_DATA_EXPORT } },
      ],
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${SCA_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand).map((c) => c.input.Id)).toEqual([
      'good',
    ]);
  });

  it('analytics: a malformed OutputSchemaVersion warns and proceeds with V_1', async () => {
    // The only user-visible BEHAVIOR change in the review delta: this field
    // used to hard-throw on a replay, and now sends a Put it previously
    // refused. The fallback is uniquely safe here because the SDK's
    // `StorageClassAnalysisSchemaVersion` has exactly one member — but that
    // makes it MORE important to pin, since nothing else would notice if the
    // downgrade were dropped or if it started defaulting a real enum.
    await update(
      analyticsProps({
        StorageClassAnalysis: {
          DataExport: { ...VALID_DATA_EXPORT, OutputSchemaVersion: 42 },
        },
      })
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${DATA_EXPORT_PATH}.OutputSchemaVersion`)
    );
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.AnalyticsConfiguration?.StorageClassAnalysis?.DataExport).toMatchObject({
      OutputSchemaVersion: 'V_1',
    });
  });

  it('a VALID container still applies on the update path (the guard is shape-only)', async () => {
    await update(lifecycleProps({ ExpirationInDays: 30, Filter: { Prefix: 'logs/' } }));
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });
});
