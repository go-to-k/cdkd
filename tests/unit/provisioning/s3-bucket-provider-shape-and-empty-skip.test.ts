import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketInventoryConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketCorsCommand,
  DeleteBucketLifecycleCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  PutBucketEncryptionCommand,
  DeleteBucketEncryptionCommand,
  PutBucketOwnershipControlsCommand,
  DeleteBucketOwnershipControlsCommand,
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
 * 5. **The DESIRED bag is asserted UNMUTATED.** Since issue #1717 the provider
 *    DOES canonicalize the desired side — but through a separate, pure
 *    `canonicalizeDesiredProperties` call the diff makes, never by mutating the
 *    bag `update()` / `create()` was handed.
 *
 * Two later siblings were appended at the bottom of this file rather than in a
 * new one, because they need the same drift-comparator harness: issue #1718's
 * CREATE-path empty-collection skip (the twin of #1671 above) and issue #1707's
 * destination-SHAPE fold (the twin of #1686 above).
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
 * item that OMITS it records one fewer key than the readback produces.
 *
 * That gap was real and orthogonal to #1686 (the #1670 defaulted-but-sent
 * class, one property over); it is FIXED by issue #1718, which records the
 * default. This fixture keeps declaring the value anyway, so the convergence
 * rows below keep measuring THIS fix rather than that one — the #1718 rows live
 * in `s3-bucket-provider-substituted-properties.test.ts`, on items that
 * deliberately omit it.
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
    // The remedy clause is half the point of announcing at all.
    expect(warned).toContain('remove the whole LifecycleConfiguration property');
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

  it('CORS: says nothing was applied before when ITS previous side declared none', async () => {
    // The CORS twin of the lifecycle row above. Without it, hardcoding the
    // lifecycle bag as the CORS call site's `previousProperties` argument — or
    // passing `properties` there — changes only the wording clause and no row
    // notices.
    const properties = { BucketName: BUCKET, CorsConfiguration: { CorsRules: [] } };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
    });

    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('CorsConfiguration.CorsRules');
    expect(warned).toContain('nothing was applied before');
    expect(result.effectiveProperties?.['CorsConfiguration']).toBeUndefined();
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
    // The wording is the point of this row — re-introducing "is an empty array"
    // would be a false claim about a value that was an unresolved intrinsic.
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/declares no rules/i);
    expect(warned).not.toMatch(/empty array/i);
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

describe('#1713 UPDATE: an empty BucketEncryption / OwnershipControls collection skips instead of DELETING', () => {
  const LIVE_ENCRYPTION = {
    ServerSideEncryptionConfiguration: [
      {
        ServerSideEncryptionByDefault: {
          SSEAlgorithm: 'aws:kms',
          KMSMasterKeyID: 'arn:aws:kms:us-east-1:123456789012:key/abc',
        },
      },
    ],
  };
  const LIVE_OWNERSHIP = { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] };

  it('encryption: no Put, NO DeleteBucketEncryption, and the PREVIOUS configuration is recorded', async () => {
    // The arm with teeth. Before the fix `emptyListConfigToUndefined` folded
    // the declared-but-empty desired side to `undefined`, `diffSubConfig` took
    // its onDelete arm, and the declared `aws:kms` default was silently
    // dropped to SSE-S3 / AES256 on a template whose only fault is a collapsed
    // array. Measured live (us-east-1, 2026-08-12): CFn REJECTS this template
    // (UPDATE_ROLLBACK_COMPLETE) and leaves the live configuration intact.
    const properties = {
      BucketName: BUCKET,
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
    };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      BucketEncryption: LIVE_ENCRYPTION,
    });

    expect(sentCommands(DeleteBucketEncryptionCommand)).toHaveLength(0);
    expect(sentCommands(PutBucketEncryptionCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['BucketEncryption']).toEqual(LIVE_ENCRYPTION);
  });

  it('ownership: no Put, NO DeleteBucketOwnershipControls, and the PREVIOUS configuration is recorded', async () => {
    const properties = { BucketName: BUCKET, OwnershipControls: { Rules: [] } };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      OwnershipControls: LIVE_OWNERSHIP,
    });

    expect(sentCommands(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);
    expect(sentCommands(PutBucketOwnershipControlsCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['OwnershipControls']).toEqual(LIVE_OWNERSHIP);
  });

  it('drift --revert: the SAME empty bag DELETES, because it is an AWS readback', async () => {
    // The blocker a reviewer found (issue #1732), and the reason `update()`
    // gained a context at all. `readCurrentState` spells "this feature is not
    // set" as `{Rules: []}` / `{ServerSideEncryptionConfiguration: []}`, and
    // `cdkd drift --revert` builds its desired bag from that readback — so the
    // bytes are IDENTICAL to a template's condition-collapsed array while
    // meaning the opposite. Without the flag this row and the two skip rows
    // above cannot both pass.
    mockSend.mockResolvedValue({});
    const properties = {
      BucketName: BUCKET,
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      OwnershipControls: { Rules: [] },
    };
    const result = await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      properties,
      {
        BucketName: BUCKET,
        BucketEncryption: LIVE_ENCRYPTION,
        OwnershipControls: LIVE_OWNERSHIP,
      },
      { desiredFromAwsReadback: true }
    );

    expect(sentCommands(DeleteBucketEncryptionCommand)).toHaveLength(1);
    expect(sentCommands(DeleteBucketOwnershipControlsCommand)).toHaveLength(1);
    // ...and nothing is retained into the baseline, so the out-of-band value
    // cannot be laundered clean by the revert that was supposed to remove it.
    expect(result.effectiveProperties?.['BucketEncryption']).toBeUndefined();
    expect(result.effectiveProperties?.['OwnershipControls']).toBeUndefined();
  });

  it('drift --revert also removes an out-of-band LIFECYCLE / CORS rule', async () => {
    // The same laundering two arms below, found by the same review: `readLifecycle`
    // returns `{Rules: []}` on NoSuchLifecycleConfiguration and `readCors` returns
    // `{CorsRules: []}` on NoSuchCORSConfiguration, so those empty arrays are the
    // unset-spelling too. They are NOT folded, so a revert bag reaches the onPut
    // arm and hit the empty guard — skipping, and recording the AWS-current rules
    // as the new baseline. Pre-existing (#1671) rather than a regression here, but
    // the enumerate-every-caller rule this change wrote does not get to skip its
    // own siblings.
    mockSend.mockResolvedValue({});
    const properties = {
      BucketName: BUCKET,
      LifecycleConfiguration: { Rules: [] },
      CorsConfiguration: { CorsRules: [] },
    };
    const result = await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      properties,
      {
        BucketName: BUCKET,
        LifecycleConfiguration: {
          Rules: [{ Id: 'expire-30', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 30 }],
        },
        CorsConfiguration: {
          CorsRules: [{ Id: 'cors-a', AllowedMethods: ['GET'], AllowedOrigins: ['https://x.test'] }],
        },
      },
      { desiredFromAwsReadback: true }
    );

    expect(sentCommands(DeleteBucketLifecycleCommand)).toHaveLength(1);
    expect(sentCommands(DeleteBucketCorsCommand)).toHaveLength(1);
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(sentCommands(PutBucketCorsCommand)).toHaveLength(0);
    // Nothing retained, so the out-of-band rules cannot be laundered clean.
    expect(result.effectiveProperties?.['LifecycleConfiguration']).toBeUndefined();
    expect(result.effectiveProperties?.['CorsConfiguration']).toBeUndefined();
  });

  it('control: REMOVING the property entirely still Deletes both configurations', async () => {
    // The discrimination the whole fix rests on. `emptyListConfigToUndefined`
    // collapsed declared-but-empty and ABSENT into one `undefined`, so this
    // row and the two above were indistinguishable; a fix that simply stops
    // folding would break THIS one, which is the template-side remedy the
    // skip's warning tells the user to reach for.
    const properties = { BucketName: BUCKET };
    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      BucketEncryption: LIVE_ENCRYPTION,
      OwnershipControls: LIVE_OWNERSHIP,
    });

    expect(sentCommands(DeleteBucketEncryptionCommand)).toHaveLength(1);
    expect(sentCommands(DeleteBucketOwnershipControlsCommand)).toHaveLength(1);
  });

  it('control: the readCurrentState placeholder round-trip still issues NO call', async () => {
    // `readCurrentState` ALWAYS emits the empty placeholder for a bucket with
    // no explicit setting, and `cdkd drift --revert` feeds it straight back
    // through `update()`. Both sides fold to `undefined`, compare EQUAL, and
    // reach neither arm — which is why the fold stays and only the Delete arm
    // is split. A fix that stopped normalizing the desired side would send a
    // Put with an empty configuration here.
    const placeholder = {
      BucketName: BUCKET,
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      OwnershipControls: { Rules: [] },
    };
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, placeholder, placeholder);

    expect(sentCommands(DeleteBucketEncryptionCommand)).toHaveLength(0);
    expect(sentCommands(PutBucketEncryptionCommand)).toHaveLength(0);
    expect(sentCommands(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);
    expect(sentCommands(PutBucketOwnershipControlsCommand)).toHaveLength(0);
    // Nothing was skipped over a live value, so nothing is retained either.
    expect(result.effectiveProperties?.['BucketEncryption']).toBeUndefined();
  });

  it('control: a MALFORMED block is not read as empty and still reaches the applier', async () => {
    // `emptyListConfigToUndefined` passes a malformed block through unchanged,
    // so it never reaches the Delete arm and the predicate must not claim it.
    // The applier refuses it by name; what this row fences is that the guard
    // did not swallow it into the skip.
    const properties = {
      BucketName: BUCKET,
      BucketEncryption: { ServerSideEncryptionConfiguration: 'not-an-array' },
    };
    await expect(
      provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
        BucketName: BUCKET,
        BucketEncryption: LIVE_ENCRYPTION,
      })
    ).rejects.toThrow();

    expect(sentCommands(DeleteBucketEncryptionCommand)).toHaveLength(0);
  });
});

/**
 * Issue #1718 item 1 — the CREATE-path sibling of the #1671 skip above.
 *
 * `applyAllSubConfigsForCreate` carries the same `length > 0` guard the update
 * path does and skipped in SILENCE, so a fresh bucket came up with a declared
 * lifecycle / CORS configuration that was never applied and nothing said so.
 *
 * Rows are written so the obvious wrong implementations FAIL:
 *
 * 1. **No Put AND no Delete**, same as the #1671 rows: the live A/B recorded on
 *    `emptyCollectionSkip` measured CloudFormation REFUSING the empty
 *    collection rather than treating it as a removal, so a guard that falls
 *    through to a Delete arm would diverge from CFn — and on a create there is
 *    nothing to delete, so the wrong implementation is a stray API call.
 * 2. **The warning is asserted by CONTENT, not by count.** A skip nobody can
 *    read is the defect being fixed, so the message has to name the property.
 * 3. **`effectiveProperties` is asserted ABSENT.** The rule's replay-CREATE line
 *    ("DROP the key") is the tempting import and is wrong here: `readLifecycle`
 *    / `readCors` ALWAYS emit the empty placeholder for an unconfigured bucket,
 *    so the declared empty collection already IS what `readCurrentState`
 *    returns. The convergence row proves that rather than asserting it.
 * 4. **The non-empty polarity asserts the warning does NOT fire**, or the rows
 *    above would pass against an implementation that warns unconditionally.
 */
describe('#1718 CREATE: an empty rules collection skips the Put and SAYS SO', () => {
  const emptyLifecycleWarnings = () =>
    childLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('LifecycleConfiguration.Rules declares no rules'));
  const emptyCorsWarnings = () =>
    childLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('CorsConfiguration.CorsRules declares no rules'));

  it('lifecycle: no Put, no Delete, and a warning naming the property', async () => {
    const properties = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };

    const result = await provider.create('B', RESOURCE_TYPE, properties);

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(sentCommands(DeleteBucketLifecycleCommand)).toHaveLength(0);
    expect(emptyLifecycleWarnings()).toHaveLength(1);
    expect(emptyLifecycleWarnings()[0]).toMatch(/Creating the bucket WITHOUT the declared/);
    // The declared empty collection IS the readback shape, so nothing is
    // overridden — see the convergence row below.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('CORS: no Put, no Delete, and a warning naming the property', async () => {
    const properties = { BucketName: BUCKET, CorsConfiguration: { CorsRules: [] } };

    const result = await provider.create('B', RESOURCE_TYPE, properties);

    expect(sentCommands(PutBucketCorsCommand)).toHaveLength(0);
    expect(sentCommands(DeleteBucketCorsCommand)).toHaveLength(0);
    expect(emptyCorsWarnings()).toHaveLength(1);
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('converges: the record matches what the REAL readCurrentState emits', async () => {
    // This row drives the actual `readCurrentState` rather than comparing the
    // record against a hand-written literal. The earlier cut did the latter and
    // was TAUTOLOGICAL (review of #1718): with `effectiveProperties` absent the
    // recorded bag IS `properties`, and the "AWS side" was a byte-identical
    // copy, so `calculateResourceDrift(x, copy-of-x)` returned `[]` under any
    // implementation — including one that DROPPED the key. It therefore proved
    // nothing about the claim it exists for, which is that `readLifecycle` /
    // `readCors` emit the empty placeholder for an UNCONFIGURED bucket and so
    // "record nothing" beats "drop the key".
    const properties = {
      BucketName: BUCKET,
      LifecycleConfiguration: { Rules: [] },
      CorsConfiguration: { CorsRules: [] },
    };
    const result = await provider.create('B', RESOURCE_TYPE, properties);
    const recorded = result.effectiveProperties ?? properties;

    // Now read the bucket back the way `cdkd drift` does, with S3 answering the
    // two GETs exactly as it does for a bucket that has neither configuration.
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetBucketLifecycleConfigurationCommand) {
        return Promise.reject(Object.assign(new Error('no lifecycle'), {
          name: 'NoSuchLifecycleConfiguration',
        }));
      }
      if (cmd instanceof GetBucketCorsCommand) {
        return Promise.reject(Object.assign(new Error('no cors'), {
          name: 'NoSuchCORSConfiguration',
        }));
      }
      return Promise.resolve({});
    });
    const awsCurrent = await provider.readCurrentState(BUCKET, 'B', RESOURCE_TYPE);

    // The claim, asserted against the mapper's real output rather than restated.
    expect(awsCurrent?.['LifecycleConfiguration']).toEqual({ Rules: [] });
    expect(awsCurrent?.['CorsConfiguration']).toEqual({ CorsRules: [] });
    // ...so the record converges, and would NOT have if the key were dropped.
    expect(
      calculateResourceDrift(recorded, awsCurrent as Record<string, unknown>)
    ).toEqual([]);
    // The negative twin, and it deliberately does NOT go through
    // `calculateResourceDrift` (review of #1718): that comparator walks STATE
    // keys only, so a record missing the key yields `[]` too and the headline
    // assertion above cannot tell "converges" from "not compared at all". The
    // cost of dropping shows up on the DIFF instead — the template keeps
    // declaring a key the record does not — so assert the record KEEPS both
    // keys, per collection, which a partial drop also fails.
    expect(recorded).toHaveProperty('LifecycleConfiguration');
    expect(recorded).toHaveProperty('CorsConfiguration');
    expect((recorded as Record<string, unknown>)['LifecycleConfiguration']).toEqual({ Rules: [] });
    expect((recorded as Record<string, unknown>)['CorsConfiguration']).toEqual({ CorsRules: [] });
    // And state it explicitly: the recorded value is byte-equal to what the
    // readback just produced, which is the claim "record nothing" rests on.
    expect((recorded as Record<string, unknown>)['LifecycleConfiguration']).toEqual(
      awsCurrent?.['LifecycleConfiguration']
    );
    expect((recorded as Record<string, unknown>)['CorsConfiguration']).toEqual(
      awsCurrent?.['CorsConfiguration']
    );
  });

  it('control: a NON-empty collection applies and warns nothing', async () => {
    const properties = {
      BucketName: BUCKET,
      LifecycleConfiguration: { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30 }] },
      CorsConfiguration: {
        CorsRules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }],
      },
    };

    await provider.create('B', RESOURCE_TYPE, properties);

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(sentCommands(PutBucketCorsCommand)).toHaveLength(1);
    expect(emptyLifecycleWarnings()).toHaveLength(0);
    expect(emptyCorsWarnings()).toHaveLength(0);
  });

  it('control: an ABSENT collection is the ordinary no-configuration path, not a skip', async () => {
    // The guard fires on a DECLARED-but-empty block only. An omitted property
    // must stay silent, or every bucket in the tree gains two warnings.
    await provider.create('B', RESOURCE_TYPE, { BucketName: BUCKET });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(emptyLifecycleWarnings()).toHaveLength(0);
    expect(emptyCorsWarnings()).toHaveLength(0);
  });
});

/**
 * Issue #1707 — the destination-SHAPE sibling of #1686's key fold, pinned end to
 * end through the real drift comparator.
 *
 * The desired side accepts the nested SDK `S3BucketDestination` wrapper and a
 * `Bucket` / `BucketArn` alias inside it; `inventorySdkToCfn` emits only the
 * flattened CFn block with `BucketArn`. So a record written in either tolerated
 * spelling could never match the readback — permanent phantom drift with NO
 * warning anywhere, because nothing is malformed and nothing is substituted.
 */
describe('#1707 UPDATE: a tolerated destination spelling converges after normalization', () => {
  it('the nested wrapper + Bucket alias record as the flattened CFn block', async () => {
    const desired = {
      Id: 'i1',
      Enabled: true,
      IncludedObjectVersions: 'All',
      ScheduleFrequency: 'Weekly',
      Destination: {
        S3BucketDestination: { Bucket: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
      },
    };
    const { result } = await updateInventory(desired);

    // The wire is unchanged — the SDK really does take the nested shape with a
    // `Bucket` member, so this is a RECORDING fold, not a re-shaped request.
    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(
      at(sent[0]!.input, 'InventoryConfiguration', 'Destination', 'S3BucketDestination', 'Bucket')
    ).toBe(DEST_ARN);

    // ...and the record is the shape `inventorySdkToCfn` will produce.
    const awsCurrent = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          ScheduleFrequency: 'Weekly',
          Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
        },
      ],
    };
    expect(
      calculateResourceDrift(result.effectiveProperties as Record<string, unknown>, awsCurrent)
    ).toEqual([]);
  });

  it('the DECLARED spelling does NOT converge — the row above has teeth', async () => {
    // Without the fold the record keeps the nested wrapper, which the readback
    // can never emit. Driving the un-folded desired bag through the same
    // comparator must report drift, or the row above would pass on any
    // implementation.
    const desired = {
      Id: 'i1',
      Enabled: true,
      IncludedObjectVersions: 'All',
      ScheduleFrequency: 'Weekly',
      Destination: {
        S3BucketDestination: { Bucket: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
      },
    };
    const awsCurrent = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          ScheduleFrequency: 'Weekly',
          Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
        },
      ],
    };

    const drifts = calculateResourceDrift(
      { BucketName: BUCKET, InventoryConfigurations: [desired] },
      awsCurrent
    );
    expect(drifts).not.toEqual([]);
  });
});
