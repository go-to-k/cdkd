import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketInventoryConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
} from '@aws-sdk/client-s3';

/**
 * Two siblings of the #1612 / #1670 recording class, both reached through
 * `S3BucketProvider`'s UPDATE path, and both producing PERMANENT phantom drift
 * rather than a wrong AWS call.
 *
 * **Issue #1686 — a SHAPE mismatch.** The inventory applier accepts two
 * spellings of the schedule on the desired side: the CFn `ScheduleFrequency`
 * and the SDK `Schedule: { Frequency }` (the #1605 fall-through). But
 * `inventorySdkToCfn` only ever EMITS `ScheduleFrequency`, and the live CFn
 * registry schema declares `ScheduleFrequency` required with no `Schedule`
 * member at all — so a record carrying `Schedule` names a key the readback can
 * never produce. #1670 fixed the adjacent VALUE half (the fall-through records
 * what went on the wire); the KEY survived alongside it.
 *
 * **Issue #1671 — an empty-collection SKIP.** The lifecycle / CORS `onPut` arms
 * skip the Put for an empty rules array while the live configuration still
 * holds the previous rules, and the engine recorded `{Rules: []}` — a Put that
 * never ran, written as though it had.
 *
 * Rows are written so the obvious wrong implementations FAIL:
 *
 * 1. **The recorded shape is asserted against what the READBACK emits**, not
 *    against a literal — "recorded == what AWS will report" is the whole
 *    contract (the #1643 bar), so the convergence rows drive the record and a
 *    readback-shaped snapshot through the real drift comparator. A fix that
 *    adds `ScheduleFrequency` but leaves `Schedule` in place passes a
 *    value-only assertion and fails these.
 * 2. **The never-emitted key is asserted ABSENT**, per row. That is the half
 *    #1670 left behind, so a test that only checks the value cannot see it.
 * 3. **The empty-collection rows assert NO Put AND NO Delete.** The skip must
 *    not quietly become a removal: measured against live CloudFormation
 *    (us-east-1, 2026-08-12) an update to `Rules: []` / `CorsRules: []` drives
 *    the stack to UPDATE_ROLLBACK_COMPLETE and BOTH live configurations survive
 *    unchanged, so an empty collection is an INVALID template rather than a
 *    removal intent. A `length > 0` guard that falls through to the Delete arm
 *    would destroy a live configuration.
 * 4. **The well-formed polarity asserts `effectiveProperties` is ABSENT**, not
 *    equal to the desired bag — the engine gates on `??`, so absent is the
 *    contract and an implementation that always answers would rewrite the
 *    record on every deploy.
 * 5. **The DESIRED bag is asserted UNMUTATED**, since rewriting the caller's
 *    own property object is the `canonicalizeDesiredProperties` behavior this
 *    change deliberately does NOT have.
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
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'shape-and-empty-skip-bucket';
const DEST_ARN = 'arn:aws:s3:::inventory-dest';

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

/** Walk a nested path out of a recorded / sent bag without a cast at every hop. */
function at(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * `Enabled` is declared explicitly rather than left to the applier's
 * `?? true` default, and that is deliberate: the Put always sends
 * `IsEnabled` and `inventorySdkToCfn` always reads it back as `Enabled`, so an
 * item that OMITS it records one fewer key than the readback produces. That
 * gap is real but pre-existing and orthogonal to #1686 (it is the #1670
 * defaulted-but-sent class, one property over — filed separately); declaring
 * the value keeps the convergence row below measuring THIS fix rather than
 * that one.
 */
const inventoryItem = (extra: Record<string, unknown>) => ({
  Id: 'i1',
  Enabled: true,
  IncludedObjectVersions: 'All',
  Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
  ...extra,
});

/** A valid, previously-applied inventory item — the UPDATE path's previous side. */
const LIVE_INVENTORY = inventoryItem({ ScheduleFrequency: 'Weekly' });

/**
 * The shapes `configStringRefusal` refuses, which is what makes the applier
 * FALL THROUGH to `Schedule.Frequency` (issue #1605).
 */
const MALFORMED = ['   ', null, 1, ['Daily'], { 'Fn::If': ['C', 'Daily', 'Weekly'] }];

async function updateInventory(desired: Record<string, unknown>) {
  const properties = { BucketName: BUCKET, InventoryConfigurations: [desired] };
  const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
    BucketName: BUCKET,
    InventoryConfigurations: [LIVE_INVENTORY],
  });
  return { result, properties };
}

describe('#1686 UPDATE: inventory schedule is recorded in the CFn spelling', () => {
  it('records ScheduleFrequency and DROPS Schedule when only the SDK spelling is declared', async () => {
    // No refusal anywhere in sight: `ScheduleFrequency` is simply ABSENT, so
    // the applier reads the cadence out of `Schedule.Frequency` and sends the
    // right value. Pre-fix nothing was recorded at all, so state kept the
    // `Schedule` key the readback can never emit.
    const desired = inventoryItem({ Schedule: { Frequency: 'Daily' } });
    const { result } = await updateInventory(desired);

    // The Put REALLY went out carrying the declared cadence.
    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(at(sent[0]!.input, 'InventoryConfiguration', 'Schedule', 'Frequency')).toBe('Daily');

    const recorded = at(result.effectiveProperties?.['InventoryConfigurations'], 0) as Record<
      string,
      unknown
    >;
    expect(recorded['ScheduleFrequency']).toBe('Daily');
    expect('Schedule' in recorded).toBe(false);
  });

  for (const value of MALFORMED) {
    it(`drops Schedule alongside the fall-through value (ScheduleFrequency=${JSON.stringify(value)})`, async () => {
      // The #1605 fall-through: a malformed FIRST source lands on the second.
      // #1670 already recorded the VALUE; this pins that the SHAPE follows.
      const desired = inventoryItem({
        ScheduleFrequency: value,
        Schedule: { Frequency: 'Daily' },
      });
      const { result } = await updateInventory(desired);

      const sent = sentCommands(PutBucketInventoryConfigurationCommand);
      expect(sent).toHaveLength(1);
      const onTheWire = at(sent[0]!.input, 'InventoryConfiguration', 'Schedule', 'Frequency');
      expect(onTheWire).toBe('Daily');

      const recorded = at(result.effectiveProperties?.['InventoryConfigurations'], 0) as Record<
        string,
        unknown
      >;
      // Recorded == sent, in the spelling the readback produces.
      expect(recorded['ScheduleFrequency']).toBe(onTheWire);
      expect('Schedule' in recorded).toBe(false);
    });
  }

  it('drops a redundant Schedule even when ScheduleFrequency is well-formed and wins', async () => {
    // `useScheduleFrequency` is true here, so `Schedule` never reaches the wire
    // at all — but it would still sit in the record forever.
    const desired = inventoryItem({
      ScheduleFrequency: 'Daily',
      Schedule: { Frequency: 'Weekly' },
    });
    const { result } = await updateInventory(desired);

    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(at(sent[0]!.input, 'InventoryConfiguration', 'Schedule', 'Frequency')).toBe('Daily');

    const recorded = at(result.effectiveProperties?.['InventoryConfigurations'], 0) as Record<
      string,
      unknown
    >;
    expect(recorded['ScheduleFrequency']).toBe('Daily');
    expect('Schedule' in recorded).toBe(false);
  });

  it('answers NO effectiveProperties for an ordinary CFn-spelled item', async () => {
    const desired = inventoryItem({ ScheduleFrequency: 'Daily' });
    const { result } = await updateInventory(desired);

    expect(sentCommands(PutBucketInventoryConfigurationCommand)).toHaveLength(1);
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('does NOT mutate the caller-supplied desired bag', async () => {
    const desired = inventoryItem({ Schedule: { Frequency: 'Daily' } });
    const before = JSON.parse(JSON.stringify(desired));
    const { properties } = await updateInventory(desired);

    expect(properties['InventoryConfigurations']).toEqual([before]);
    expect(at(properties, 'InventoryConfigurations', 0, 'Schedule', 'Frequency')).toBe('Daily');
  });

  it('converges: the recorded item matches a readback-shaped snapshot', async () => {
    // The strongest row — the whole point of the fix is that a second `cdkd
    // drift` reports nothing. The AWS side is the shape `inventorySdkToCfn`
    // produces for the Put that just went out: `ScheduleFrequency`, no
    // `Schedule`.
    const desired = inventoryItem({ Schedule: { Frequency: 'Daily' } });
    const { result } = await updateInventory(desired);

    // `Enabled` is load-bearing in this fixture: the Put always sends
    // `IsEnabled: config['Enabled'] ?? true` and `inventorySdkToCfn` always
    // reads it back as `Enabled`, so a snapshot omitting it has a different KEY
    // COUNT and `deepEqual` reports drift — the row would then prove only
    // "record == hand-shaped object" rather than "the readback matches".
    const awsCurrent = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
          ScheduleFrequency: 'Daily',
        },
      ],
    };

    const drifts = calculateResourceDrift(
      result.effectiveProperties as Record<string, unknown>,
      awsCurrent
    );
    expect(drifts).toEqual([]);
  });
});

describe('#1671 UPDATE: an empty rules collection skips the Put and records the previous value', () => {
  const LIVE_LIFECYCLE = {
    Rules: [{ Id: 'expire-30', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 30 }],
  };
  const LIVE_CORS = {
    CorsRules: [{ Id: 'cors-a', AllowedMethods: ['GET'], AllowedOrigins: ['https://example.com'] }],
  };

  it('lifecycle: no Put, no Delete, and the PREVIOUS configuration is recorded', async () => {
    const properties = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      LifecycleConfiguration: LIVE_LIFECYCLE,
    });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    // The empty collection is NOT a removal intent — CFn rejects the template
    // outright and leaves the configuration alive.
    expect(sentCommands(DeleteBucketLifecycleCommand)).toHaveLength(0);

    expect(result.effectiveProperties?.['LifecycleConfiguration']).toEqual(LIVE_LIFECYCLE);
    // ...and the empty declaration is gone from the record entirely.
    expect(at(result.effectiveProperties, 'LifecycleConfiguration', 'Rules')).toHaveLength(1);
  });

  it('CORS: no Put, no Delete, and the PREVIOUS configuration is recorded', async () => {
    const properties = { BucketName: BUCKET, CorsConfiguration: { CorsRules: [] } };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      CorsConfiguration: LIVE_CORS,
    });

    expect(sentCommands(PutBucketCorsCommand)).toHaveLength(0);
    expect(sentCommands(DeleteBucketCorsCommand)).toHaveLength(0);

    expect(result.effectiveProperties?.['CorsConfiguration']).toEqual(LIVE_CORS);
  });

  it('announces the skip, naming the property and the remedy', async () => {
    const properties = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };
    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      LifecycleConfiguration: LIVE_LIFECYCLE,
    });

    // A silent skip is the defect one layer up: CFn's own answer to this
    // template is a loud failure, so the user must not have to diff state.
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('LifecycleConfiguration.Rules');
    expect(warned).toMatch(/declares no rules/i);
    expect(warned).toContain('recording the previously-applied value');
  });

  it('announces the CORS skip with its OWN joined path literal', async () => {
    // Asserted separately from the lifecycle arm because the two pass DIFFERENT
    // path literals, and the joined spelling is load-bearing: a bare
    // `'CorsRules'` literal in this file retires the reviewed
    // `AWS::S3::Bucket#CorsConfiguration.CorsRules` nested-key allow-list entry
    // (measured). Without this row, swapping the CORS arm's path — or dropping
    // its `emptyCollectionSkip` call for a bare `retainPrevious` — passes.
    const properties = { BucketName: BUCKET, CorsConfiguration: { CorsRules: [] } };
    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      CorsConfiguration: LIVE_CORS,
    });

    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('CorsConfiguration.CorsRules');
    expect(warned).not.toContain('LifecycleConfiguration');
  });

  it('says nothing was applied before when the previous side declared none', async () => {
    const properties = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };
    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, { BucketName: BUCKET });

    // "recording the previously-applied value" would be a lie here — there is
    // no previous value and the key is REMOVED from the record.
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('nothing was applied before');
    expect(warned).not.toContain('recording the previously-applied value');
  });

  it('also fires for an ABSENT / non-array collection, without claiming "empty array"', async () => {
    // The guard is `!cfg.Rules || !Array.isArray(cfg.Rules) || length === 0`,
    // so an unresolved intrinsic reaches it too. The wording must not assert a
    // shape the value did not have.
    const properties = {
      BucketName: BUCKET,
      LifecycleConfiguration: { Rules: { 'Fn::If': ['C', [], []] } } as unknown as {
        Rules: Array<Record<string, unknown>>;
      },
    };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      LifecycleConfiguration: LIVE_LIFECYCLE,
    });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(sentCommands(DeleteBucketLifecycleCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['LifecycleConfiguration']).toEqual(LIVE_LIFECYCLE);
  });

  it('records the key as REMOVED when the previous side declared none', async () => {
    // Nothing was ever applied, so there is no previous value to keep — and
    // dropping the key is what lets a later genuine removal derive one.
    const properties = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
    });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(sentCommands(DeleteBucketLifecycleCommand)).toHaveLength(0);
    expect(result.effectiveProperties).toBeDefined();
    expect(result.effectiveProperties?.['LifecycleConfiguration']).toBeUndefined();
  });

  it('control: a NON-empty rules array is still applied, with no override recorded', async () => {
    // The guard must not over-fire — this is the row that fails if the
    // emptiness predicate is inverted or widened.
    const properties = {
      BucketName: BUCKET,
      LifecycleConfiguration: {
        Rules: [{ Id: 'expire-1', Status: 'Enabled', Prefix: 'tmp/', ExpirationInDays: 1 }],
      },
    };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      LifecycleConfiguration: LIVE_LIFECYCLE,
    });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(result.effectiveProperties?.['LifecycleConfiguration']).toBeUndefined();
  });

  it('control: REMOVING the property entirely still Deletes the configuration', async () => {
    // The removal path is what the empty-collection skip must not be confused
    // with, and it is the reason the skip records the PREVIOUS value rather
    // than dropping the key: a dropped key would make this derive no removal.
    const properties = { BucketName: BUCKET };
    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      LifecycleConfiguration: LIVE_LIFECYCLE,
    });

    expect(sentCommands(DeleteBucketLifecycleCommand)).toHaveLength(1);
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });
});
