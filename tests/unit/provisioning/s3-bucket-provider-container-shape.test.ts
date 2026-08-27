import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketAnalyticsConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketReplicationCommand,
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
  // these assertions would ALSO pass on the unfixed tree: before this change a
  // non-object `DataExport` reached `readConfigString(dataExport,
  // 'OutputSchemaVersion', …)`, whose refusal message is byte-identical and
  // which also fired before any Put — so no matcher can tell the two apart on
  // the create path. Claiming them as proof of the new guard would be a test
  // that pins the author's intent rather than the behavior. They are kept as a
  // REGRESSION fence (the explicit guard must not have relaxed the create-path
  // refusal); the genuinely NEW DataExport behavior is the replay/update
  // downgrade, pinned separately below.
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
