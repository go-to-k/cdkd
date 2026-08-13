import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ListBucketAnalyticsConfigurationsCommand,
  PutBucketAnalyticsConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
  PutBucketIntelligentTieringConfigurationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1670: the warn-and-SUBSTITUTE sibling of #1612's warn-and-SKIP arms.
 *
 * Three reads in `S3BucketProvider` warn and then SEND a substituted default
 * instead of the declared value — the analytics
 * `StorageClassAnalysis.DataExport.OutputSchemaVersion`, and the analytics /
 * inventory destination `Format`. The Put SUCCEEDS, so the engine recorded the
 * DESIRED bag, malformed value and all, for a configuration AWS holds with the
 * default. `analyticsSdkToCfn` / `inventorySdkToCfn` read both fields back, so
 * the difference is visible to the comparator and never converges: the
 * permanent phantom drift `.claude/rules/providers.md` records for the #1633
 * warn-and-default arm, reached here through a per-item Put.
 *
 * The remedy is the SAME `effectiveProperties` machinery #1612 added, with the
 * third arm the skip path did not need: a substituted item is APPLIED, so it
 * keeps its position and its declared shape and only the substituted field
 * differs. That distinction is what most of these rows exist to pin — an
 * implementation that routes a substitution through the SKIP arm drops the
 * item on create and retains a stale previous item on update, which is a fresh
 * phantom drift in place of the one being removed.
 *
 * Rows are written so the obvious wrong implementations FAIL:
 *
 * 1. **The exact substituted STRING is asserted**, not "something changed" —
 *    and against the value that actually went ON THE WIRE, read back out of
 *    the sent command. "Recorded == sent" is the whole contract, so a test
 *    that only compares the record to a literal cannot see the two drifting.
 * 2. **Both destination BRANCHES are covered.** The CFn `Destination` block is
 *    accepted flattened (`{BucketArn, Format}`) and nested
 *    (`{S3BucketDestination: {...}}`). Issue #1707 changed the ANSWER here and
 *    the rows moved with it: #1670 wrote the substituted value back at the
 *    branch the template DECLARED, to avoid leaving the malformed value alive
 *    at the other key; the record is now NORMALIZED to the flattened CFn
 *    spelling instead, which dissolves that concern (there is no other key
 *    left) and is the only spelling `analyticsSdkToCfn` / `inventorySdkToCfn`
 *    can emit. So each nested row now asserts the wrapper is GONE.
 * 3. **The well-formed polarity asserts `effectiveProperties` is ABSENT**, not
 *    equal to the desired bag. An implementation that always answers is
 *    indistinguishable by value and would rewrite the record on every deploy —
 *    the engine gates on `??`, so absent is the contract. "Well-formed" now
 *    means FULLY DECLARED: since #1718 an item that omits a defaulted-but-SENT
 *    member (`Enabled`, `IncludedObjectVersions`, `OutputSchemaVersion`,
 *    `Format`) records it, because the readback always emits it.
 * 4. **The DESIRED bag is asserted UNMUTATED.** Rewriting the caller's own
 *    property object would silently narrow the template side of the next
 *    comparison. Since #1717 the provider DOES canonicalize the desired side —
 *    but through a separate, pure `canonicalizeDesiredProperties` call the diff
 *    makes, never by mutating the bag `update()` was handed (see the last
 *    describe block).
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
import type { ResourceProvider } from '../../../src/types/resource.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'substituted-properties-bucket';

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

/**
 * The shapes `configStringRefusal` refuses and `readConfigString` then
 * substitutes the default for — what a hand-written L1 template, an unresolved
 * intrinsic, or a state record written by an older binary can carry.
 */
const MALFORMED = ['   ', null, 1, ['CSV'], { 'Fn::If': ['C', 'CSV', 'ORC'] }];

const DEST_ARN = 'arn:aws:s3:::analytics-dest';

/** Walk a nested path out of a recorded / sent bag without a cast at every hop. */
function at(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

const analyticsItem = (dataExport: Record<string, unknown>) => ({
  Id: 'a1',
  StorageClassAnalysis: { DataExport: dataExport },
});

/** A valid, previously-applied analytics item — the UPDATE path's previous side. */
const LIVE_ANALYTICS = analyticsItem({
  OutputSchemaVersion: 'V_1',
  Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
});

const inventoryItem = (destination: Record<string, unknown>) => ({
  Id: 'i1',
  IncludedObjectVersions: 'All',
  ScheduleFrequency: 'Daily',
  Destination: destination,
});

/**
 * The same item as {@link inventoryItem} would be RECORDED (issue #1718).
 *
 * `Enabled` is always sent (`IsEnabled: … ?? true`) and always read back
 * (`inventorySdkToCfn` emits it whenever `IsEnabled` is present), so an item
 * omitting it recorded one key FEWER than the readback produces and the whole
 * array compared unequal. The fixture deliberately keeps declaring items
 * WITHOUT it, so every row below re-pins that the default is recorded rather
 * than asserting it away.
 */
const recordedInventoryItem = (destination: Record<string, unknown>) => ({
  ...inventoryItem(destination),
  Enabled: true,
});

/** A valid, previously-applied inventory item — the UPDATE path's previous side. */
const LIVE_INVENTORY = inventoryItem({ BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' });

describe('UPDATE: analytics OutputSchemaVersion records the SUBSTITUTED value', () => {
  for (const value of MALFORMED) {
    it(`records V_1, the value actually sent (${JSON.stringify(value)})`, async () => {
      const desired = analyticsItem({
        OutputSchemaVersion: value,
        Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
      });
      const properties = { BucketName: BUCKET, AnalyticsConfigurations: [desired] };

      const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
        BucketName: BUCKET,
        AnalyticsConfigurations: [LIVE_ANALYTICS],
      });

      // The Put REALLY went out — this is a substitution, not a skip, and the
      // whole defect only exists because the deploy succeeds.
      const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
      expect(sent).toHaveLength(1);
      const onTheWire = at(
        sent[0]!.input,
        'AnalyticsConfiguration',
        'StorageClassAnalysis',
        'DataExport',
        'OutputSchemaVersion'
      );
      expect(onTheWire).toBe('V_1');

      const recorded = at(
        result.effectiveProperties?.['AnalyticsConfigurations'],
        0,
        'StorageClassAnalysis',
        'DataExport',
        'OutputSchemaVersion'
      );
      // Asserted against the WIRE value, then against the exact literal: the
      // contract is "record what was sent", and a test that only pins the
      // literal cannot see the two drift apart.
      expect(recorded).toBe(onTheWire);
      expect(recorded).toBe('V_1');
      expect(recorded).not.toEqual(value);
    });
  }

  it('keeps the rest of the item, its position, and the sibling properties', async () => {
    const desired = analyticsItem({
      OutputSchemaVersion: 1,
      Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
    });
    const clean = {
      Id: 'a2',
      StorageClassAnalysis: {
        DataExport: {
          OutputSchemaVersion: 'V_1',
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        },
      },
    };
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [desired, clean],
      InventoryConfigurations: [LIVE_INVENTORY],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      AnalyticsConfigurations: [LIVE_ANALYTICS],
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    // Position preserved (DiffCalculator compares arrays positionally, so a
    // reordered effective array manufactures a fresh phantom drift), the
    // untouched item byte-identical, and every other member of the substituted
    // item carried through.
    expect(result.effectiveProperties?.['AnalyticsConfigurations']).toEqual([
      analyticsItem({
        OutputSchemaVersion: 'V_1',
        Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
      }),
      clean,
    ]);
    // A substitution on one applier must not rewrite a sibling key — the
    // wiring fence #1660 added for the skip arms, applied to this one.
    expect(result.effectiveProperties?.['InventoryConfigurations']).toEqual([LIVE_INVENTORY]);
    expect(result.effectiveProperties?.['BucketName']).toBe(BUCKET);
  });

  it('does NOT mutate the desired bag it was handed', async () => {
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        analyticsItem({
          OutputSchemaVersion: 1,
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        }),
      ],
    };
    const snapshot = JSON.stringify(properties);

    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      AnalyticsConfigurations: [LIVE_ANALYTICS],
    });

    // The engine and `DiffCalculator` still read this object. Narrowing it in
    // place would silently rewrite the TEMPLATE side of the next comparison —
    // the `canonicalizeDesiredProperties` behavior this change refuses.
    expect(JSON.stringify(properties)).toBe(snapshot);
  });
});

describe('UPDATE: the destination records in the FLATTENED CFn spelling (#1707)', () => {
  it('analytics, FLATTENED destination', async () => {
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        analyticsItem({
          OutputSchemaVersion: 'V_1',
          Destination: { BucketArn: DEST_ARN, Format: 1, Prefix: 'live/' },
        }),
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      AnalyticsConfigurations: [LIVE_ANALYTICS],
    });

    const recordedDest = at(
      result.effectiveProperties?.['AnalyticsConfigurations'],
      0,
      'StorageClassAnalysis',
      'DataExport',
      'Destination'
    );
    expect(recordedDest).toEqual({ BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' });
    expect(
      at(
        sentCommands(PutBucketAnalyticsConfigurationCommand)[0]!.input,
        'AnalyticsConfiguration',
        'StorageClassAnalysis',
        'DataExport',
        'Destination',
        'S3BucketDestination',
        'Format'
      )
    ).toBe('CSV');
  });

  it('analytics, NESTED destination — the SDK wrapper is normalized away', async () => {
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        analyticsItem({
          OutputSchemaVersion: 'V_1',
          Destination: { S3BucketDestination: { BucketArn: DEST_ARN, Format: null } },
        }),
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      AnalyticsConfigurations: [LIVE_ANALYTICS],
    });

    const recordedDest = at(
      result.effectiveProperties?.['AnalyticsConfigurations'],
      0,
      'StorageClassAnalysis',
      'DataExport',
      'Destination'
    ) as Record<string, unknown>;
    // Recorded in the ONLY spelling `analyticsSdkToCfn` can emit...
    expect(recordedDest).toEqual({ BucketArn: DEST_ARN, Format: 'CSV' });
    // ...with the SDK-only wrapper gone, so nothing is left carrying the
    // malformed value at a key the readback never produces.
    expect('S3BucketDestination' in recordedDest).toBe(false);
  });

  it('inventory, FLATTENED destination', async () => {
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        inventoryItem({ BucketArn: DEST_ARN, Format: ['CSV'], Prefix: 'live/' }),
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(
      at(sent[0]!.input, 'InventoryConfiguration', 'Destination', 'S3BucketDestination', 'Format')
    ).toBe('CSV');
    expect(result.effectiveProperties?.['InventoryConfigurations']).toEqual([
      recordedInventoryItem({ BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' }),
    ]);
  });

  it('inventory, NESTED destination — the SDK wrapper is normalized away', async () => {
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        inventoryItem({ S3BucketDestination: { BucketArn: DEST_ARN, Format: '   ' } }),
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    const recordedDest = at(
      result.effectiveProperties?.['InventoryConfigurations'],
      0,
      'Destination'
    ) as Record<string, unknown>;
    expect(recordedDest).toEqual({ BucketArn: DEST_ARN, Format: 'CSV' });
    expect('S3BucketDestination' in recordedDest).toBe(false);
  });

  it('inventory, the `Bucket` ALIAS is normalized to BucketArn', async () => {
    // The other cdkd-only tolerance in the same block: the readers accept
    // `BucketArn ?? Bucket`, while `inventorySdkToCfn` only ever emits
    // `BucketArn`. No refusal fires here — the item is entirely well-formed by
    // cdkd's own rules — so an implementation keying the normalization off the
    // substitution arm (the obvious one) misses this row's whole population.
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [inventoryItem({ Bucket: DEST_ARN, Format: 'ORC' })],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    expect(at(result.effectiveProperties?.['InventoryConfigurations'], 0, 'Destination')).toEqual({
      BucketArn: DEST_ARN,
      Format: 'ORC',
    });
    // ...and the wire is unchanged by the normalization: the SDK member is
    // still `Bucket`, so this is a RECORDING fold, not a re-shaped request.
    expect(
      at(
        sentCommands(PutBucketInventoryConfigurationCommand)[0]!.input,
        'InventoryConfiguration',
        'Destination',
        'S3BucketDestination',
        'Bucket'
      )
    ).toBe(DEST_ARN);
  });
});

describe('UPDATE: two substitutions in ONE item are both recorded', () => {
  it('OutputSchemaVersion and Format together', async () => {
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        analyticsItem({
          OutputSchemaVersion: 1,
          Destination: { BucketArn: DEST_ARN, Format: 2 },
        }),
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      AnalyticsConfigurations: [LIVE_ANALYTICS],
    });

    // The second substitution must build on the first, not replace it: an
    // implementation that rebuilds from the DECLARED item each time records
    // only the last one and leaves the other malformed value in state.
    expect(result.effectiveProperties?.['AnalyticsConfigurations']).toEqual([
      analyticsItem({
        OutputSchemaVersion: 'V_1',
        Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
      }),
    ]);
  });
});

describe('UPDATE: a SUBSTITUTED item and a SKIPPED item coexist', () => {
  it('substitutes one in place and retains the previous of the other', async () => {
    const substituting = analyticsItem({
      OutputSchemaVersion: 1,
      Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
    });
    // A malformed CONTAINER, which the #1581 guard SKIPS rather than defaults.
    const skipping = { Id: 'a2', StorageClassAnalysis: 'not-an-object' };
    const liveA2 = { Id: 'a2', StorageClassAnalysis: {} };
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [substituting, skipping],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      AnalyticsConfigurations: [LIVE_ANALYTICS, liveA2],
    });

    // The two arms mean opposite things and must not be collapsed: the applied
    // item records what was SENT, the skipped one records what AWS still HOLDS.
    expect(result.effectiveProperties?.['AnalyticsConfigurations']).toEqual([
      analyticsItem({
        OutputSchemaVersion: 'V_1',
        Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
      }),
      liveA2,
    ]);
  });
});

describe('replay-CREATE: a substituted item is KEPT as sent, not dropped', () => {
  it('analytics: the item stays with V_1, unlike a skip which drops it', async () => {
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        analyticsItem({
          OutputSchemaVersion: 1,
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        }),
      ],
    };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    // The Put went out on a brand-new bucket, so the configuration EXISTS —
    // dropping the item (the skip arm's answer) would tell state the bucket has
    // no analytics configuration at all.
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent).toHaveLength(1);
    // Symmetric with the UPDATE rows: assert the WIRE value, not just the count.
    expect(
      at(
        sent[0]!.input,
        'AnalyticsConfiguration',
        'StorageClassAnalysis',
        'DataExport',
        'OutputSchemaVersion'
      )
    ).toBe('V_1');
    expect(result.effectiveProperties?.['AnalyticsConfigurations']).toEqual([
      analyticsItem({
        OutputSchemaVersion: 'V_1',
        Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
      }),
    ]);
  });

  it('inventory: the destination Format is recorded as sent', async () => {
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [inventoryItem({ BucketArn: DEST_ARN, Format: 1 })],
    };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(
      at(sent[0]!.input, 'InventoryConfiguration', 'Destination', 'S3BucketDestination', 'Format')
    ).toBe('CSV');
    expect(result.effectiveProperties?.['InventoryConfigurations']).toEqual([
      recordedInventoryItem({ BucketArn: DEST_ARN, Format: 'CSV' }),
    ]);
  });

  it('records the substituted item at ITS OWN index, behind a skipped and a clean one', async () => {
    // Index 0 applies cleanly, index 1 is SKIPPED (a malformed container, the
    // #1581 guard) so the applier `continue`s without incrementing anything but
    // its own counter, and index 2 is the substituted one.
    const clean = {
      Id: 'a0',
      StorageClassAnalysis: {
        DataExport: {
          OutputSchemaVersion: 'V_1',
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        },
      },
    };
    const skipping = { Id: 'a1', StorageClassAnalysis: 'not-an-object' };
    const substituting = {
      Id: 'a2',
      StorageClassAnalysis: {
        DataExport: {
          OutputSchemaVersion: 1,
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        },
      },
    };
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [clean, skipping, substituting],
    };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    // Hardcoding the recorded index to 0 (rather than the loop's own `index`)
    // passes every other row in this file: it would record a2's substituted bag
    // at slot 0 — DUPLICATING `Id: a0`'s position with a2's content — and leave
    // a2's malformed `OutputSchemaVersion` in place. Position and identity are
    // therefore both asserted, on an array where the substituted item is LAST.
    expect(result.effectiveProperties?.['AnalyticsConfigurations']).toEqual([
      clean,
      {
        Id: 'a2',
        StorageClassAnalysis: {
          DataExport: {
            OutputSchemaVersion: 'V_1',
            Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
          },
        },
      },
    ]);
  });
});

describe('inventory ScheduleFrequency: the FALL-THROUGH is a substitution too', () => {
  it('records the Schedule.Frequency it fell back to, not the malformed declared value', async () => {
    const desired = {
      Id: 'i1',
      IncludedObjectVersions: 'All',
      ScheduleFrequency: '   ',
      Schedule: { Frequency: 'Daily' },
      Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
    };
    const properties = { BucketName: BUCKET, InventoryConfigurations: [desired] };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    // The item was APPLIED — this arm falls through to the second source rather
    // than skipping — and `Daily` is what went on the wire...
    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(at(sent[0]!.input, 'InventoryConfiguration', 'Schedule', 'Frequency')).toBe('Daily');
    // ...so `Daily` is what the record must carry, at the CFn key
    // `inventorySdkToCfn` maps the live schedule back to.
    expect(at(result.effectiveProperties?.['InventoryConfigurations'], 0, 'ScheduleFrequency')).toBe(
      'Daily'
    );
    // The rest of the item is untouched — EXCEPT the second source itself,
    // which issue #1686 drops: `inventorySdkToCfn` emits only
    // `ScheduleFrequency`, so a recorded `Schedule` names a key the readback
    // can never produce. This assertion read `{ ...desired }` (keeping
    // `Schedule`) until #1686 settled the SHAPE half of the same defect.
    const { Schedule: _sdkSpelling, ...withoutSdkSpelling } = desired;
    expect(result.effectiveProperties?.['InventoryConfigurations']).toEqual([
      { ...withoutSdkSpelling, ScheduleFrequency: 'Daily', Enabled: true },
    ]);
  });

  it('a usable ScheduleFrequency records only the dropped SDK spelling', async () => {
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          Id: 'i1',
          IncludedObjectVersions: 'All',
          ScheduleFrequency: 'Weekly',
          Schedule: { Frequency: 'Daily' },
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        },
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    // Precedence unchanged: the first source wins and no VALUE is substituted.
    const sent = sentCommands(PutBucketInventoryConfigurationCommand);
    expect(at(sent[0]!.input, 'InventoryConfiguration', 'Schedule', 'Frequency')).toBe('Weekly');
    // But the item still DECLARED the SDK spelling, and it never reached the
    // wire — so issue #1686 drops it rather than leaving a key in state that
    // `inventorySdkToCfn` can never emit. This asserted `toBeUndefined()` while
    // the record was only ever rewritten for a substituted VALUE.
    const recorded = at(result.effectiveProperties?.['InventoryConfigurations'], 0) as Record<
      string,
      unknown
    >;
    expect(recorded['ScheduleFrequency']).toBe('Weekly');
    expect('Schedule' in recorded).toBe(false);
  });

  it('an UNUSABLE second source SKIPS the item instead — the #1605 arm is unchanged', async () => {
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          Id: 'i1',
          IncludedObjectVersions: 'All',
          ScheduleFrequency: '   ',
          Schedule: { Frequency: 1 },
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        },
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    // Nothing was sent, so the effective entry is what AWS still HOLDS — the
    // skip arm, not the substitute arm. Recording the fall-through value here
    // would describe a cadence no Put ever delivered.
    expect(sentCommands(PutBucketInventoryConfigurationCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['InventoryConfigurations']).toEqual([LIVE_INVENTORY]);
  });
});

/**
 * The readback pairing (issue #1670 review).
 *
 * `effectiveProperties` only removes drift if `readCurrentState` produces the
 * SAME shape — and `analyticsSdkToCfn` used to emit the SDK's nested
 * `Destination: { S3BucketDestination: … }` wrapper, which the CFn schema does
 * not declare at all (`tests/fixtures/cfn-schemas/AWS-S3-Bucket.json` contains
 * zero occurrences of that key). So the WHOLE sub-object differed on every
 * comparison and the analytics `Format` half of this fix did nothing.
 *
 * This row closes the loop end to end rather than asserting the mapper's output
 * against a hand-written literal: the AWS-current side is built by ECHOING the
 * configuration the provider actually PUT, so a wire-vs-readback disagreement
 * cannot hide behind two independently-written fixtures.
 */
describe('round trip: effective record vs readCurrentState', () => {
  it('a substituted analytics Format converges — the comparator sees no drift', async () => {
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        analyticsItem({
          OutputSchemaVersion: 1,
          Destination: { BucketArn: DEST_ARN, Format: ['CSV'], Prefix: 'live/' },
        }),
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      AnalyticsConfigurations: [LIVE_ANALYTICS],
    });
    const recorded = result.effectiveProperties!;

    // AWS now holds exactly what was PUT. Echo it back through the List API.
    const put = sentCommands(PutBucketAnalyticsConfigurationCommand)[0]!.input as {
      AnalyticsConfiguration: unknown;
    };
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof ListBucketAnalyticsConfigurationsCommand
          ? { AnalyticsConfigurationList: [put.AnalyticsConfiguration] }
          : {}
      )
    );

    const current = (await provider.readCurrentState(BUCKET, 'B', RESOURCE_TYPE))!;

    // The readback is the FLATTENED CFn shape the schema declares...
    expect(current['AnalyticsConfigurations']).toEqual([
      analyticsItem({
        OutputSchemaVersion: 'V_1',
        Destination: { BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' },
      }),
    ]);
    // ...so the recorded bag and the AWS-current bag agree, and the real
    // comparator reports nothing on the property this fix exists for.
    const drifts = calculateResourceDrift(
      { AnalyticsConfigurations: recorded['AnalyticsConfigurations'] },
      { AnalyticsConfigurations: current['AnalyticsConfigurations'] }
    );
    expect(drifts).toEqual([]);
  });

  it('the DECLARED malformed value does NOT converge — the row above has teeth', async () => {
    const declared = analyticsItem({
      OutputSchemaVersion: 1,
      Destination: { BucketArn: DEST_ARN, Format: ['CSV'], Prefix: 'live/' },
    });

    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof ListBucketAnalyticsConfigurationsCommand
          ? {
              AnalyticsConfigurationList: [
                {
                  Id: 'a1',
                  StorageClassAnalysis: {
                    DataExport: {
                      OutputSchemaVersion: 'V_1',
                      Destination: {
                        S3BucketDestination: {
                          Bucket: DEST_ARN,
                          Format: 'CSV',
                          Prefix: 'live/',
                        },
                      },
                    },
                  },
                },
              ],
            }
          : {}
      )
    );

    const current = (await provider.readCurrentState(BUCKET, 'B', RESOURCE_TYPE))!;

    // Recording the DECLARED bag (the pre-fix behavior) is what the fix
    // replaces, and it is still drift against the same readback — so the
    // convergence row above is testing the fix, not the fixture.
    const drifts = calculateResourceDrift(
      { AnalyticsConfigurations: [declared] },
      { AnalyticsConfigurations: current['AnalyticsConfigurations'] }
    );
    expect(drifts.length).toBeGreaterThan(0);
  });
});

describe('the WELL-FORMED polarity: nothing is recorded and nothing changes', () => {
  it('update: a valid analytics change records no effectiveProperties at all', async () => {
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        analyticsItem({
          OutputSchemaVersion: 'V_1',
          Destination: { BucketArn: DEST_ARN, Format: 'ORC' },
        }),
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      AnalyticsConfigurations: [LIVE_ANALYTICS],
    });

    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(1);
    // Absent, NOT "equal to properties": the engine gates on `??`, so an
    // implementation that always answers rewrites the record on every deploy
    // and a value compare cannot see it.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('update: a FULLY declared inventory item records no effectiveProperties at all', async () => {
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          ...inventoryItem({ BucketArn: DEST_ARN, Format: 'ORC' }),
          Enabled: true,
        },
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    expect(sentCommands(PutBucketInventoryConfigurationCommand)).toHaveLength(1);
    // Every fold identity-returns, so the whole answer is absent — the polarity
    // that keeps the folds from rewriting the record on every deploy.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('update: an ABSENT defaulted field takes the default on the wire AND is recorded', async () => {
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [inventoryItem({ BucketArn: DEST_ARN })],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    // `CSV` really is what AWS gets...
    expect(
      at(
        sentCommands(PutBucketInventoryConfigurationCommand)[0]!.input,
        'InventoryConfiguration',
        'Destination',
        'S3BucketDestination',
        'Format'
      )
    ).toBe('CSV');
    // ...and since issue #1718 that IS what the record says. This row asserted
    // `effectiveProperties` ABSENT until #1718, on the reasoning that an
    // omitted key is not a narrowing and `drift-calculator` only descends into
    // keys state carries. The second half is true of a TOP-LEVEL key and false
    // here: these items live inside an ARRAY, which the comparator compares
    // WHOLESALE, so an item missing a key the readback emits made the whole
    // array unequal — the #1670 record-what-was-SENT rule, reached through a
    // default rather than through a substitution.
    expect(result.effectiveProperties?.['InventoryConfigurations']).toEqual([
      { ...recordedInventoryItem({ BucketArn: DEST_ARN, Format: 'CSV' }) },
    ]);
  });

  it('template-path create: a malformed value still REFUSES, it is not substituted', async () => {
    const properties = {
      BucketName: BUCKET,
      AnalyticsConfigurations: [
        analyticsItem({
          OutputSchemaVersion: 1,
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        }),
      ],
    };

    // No replay context: the value is template-borne, so the read throws and
    // no substitution is reachable. Recording a value the provider merely
    // failed to send is what the "already ANNOUNCED" condition forbids.
    await expect(provider.create('B', RESOURCE_TYPE, properties)).rejects.toThrow(
      /OutputSchemaVersion must be a non-empty string/
    );
  });
});

/**
 * The `canonicalizeDesiredProperties` twin (issues #1717 / #1707).
 *
 * This block used to pin the OPPOSITE — "no twin" — and the reversal is the
 * point rather than an inconsistency, so the old reasoning is recorded here
 * instead of deleted. #1670 answered NO for the two SUBSTITUTED values on three
 * findings, the operative one being that canonicalizing would CONCEAL a
 * malformed value whose warning is the user's only signal to fix it.
 *
 * #1686 then added folds of a different class to the SAME items — a
 * never-emitted KEY (`Schedule` -> `ScheduleFrequency`) and, in #1707, a
 * never-emitted SHAPE (the nested `S3BucketDestination` wrapper and the
 * `Bucket` alias). Those have no fault to conceal and emit no warning at all: a
 * template declaring the SDK spelling is entirely valid input. So the twin's
 * absence bought nothing and cost a permanent `cdkd diff` line plus a redundant
 * per-`Id` Put on every deploy — measured on the #1686 fold as an unchanged
 * template redeploying `1 to update` forever.
 *
 * The rows below therefore assert BOTH directions: the folds reach the desired
 * side, and the #1670 concealment does NOT happen.
 */
describe('the canonicalizeDesiredProperties twin', () => {
  it('is declared on the ResourceProvider interface', () => {
    // Read through the INTERFACE, where the hook is an optional member.
    const asProvider: ResourceProvider = provider;
    expect(typeof asProvider.canonicalizeDesiredProperties).toBe('function');
  });

  it('folds the SDK Schedule spelling, so a record and its template compare EQUAL', () => {
    const template = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          Schedule: { Frequency: 'Daily' },
          Destination: { S3BucketDestination: { Bucket: DEST_ARN, Format: 'CSV' } },
        },
      ],
    };
    // What the applier RECORDS for that template (the #1686 / #1707 folds).
    const recorded = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          ScheduleFrequency: 'Daily',
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        },
      ],
    };

    const canonicalTemplate = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, template);
    const canonicalRecord = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, recorded);

    // BOTH sides are folded — a one-sided pass would flip the same difference
    // into a REMOVAL for every record written before the fold shipped.
    expect(canonicalTemplate).toEqual(canonicalRecord);
    // ...and the fold really did something, so the row is not vacuous.
    expect(canonicalTemplate).not.toEqual(template);
    expect(canonicalRecord).toEqual(recorded);
  });

  it('defaults the SENT members, so an under-declared template converges too', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      InventoryConfigurations: [{ Id: 'i1', Destination: { BucketArn: DEST_ARN } }],
    });

    expect(canonical['InventoryConfigurations']).toEqual([
      {
        Id: 'i1',
        Enabled: true,
        IncludedObjectVersions: 'All',
        ScheduleFrequency: 'Weekly',
        Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
      },
    ]);
  });

  it('folds the analytics data-export destination and schema version', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      AnalyticsConfigurations: [
        analyticsItem({
          Destination: { S3BucketDestination: { Bucket: DEST_ARN, Format: 'ORC' } },
        }),
      ],
    });

    expect(canonical['AnalyticsConfigurations']).toEqual([
      analyticsItem({
        OutputSchemaVersion: 'V_1',
        Destination: { BucketArn: DEST_ARN, Format: 'ORC' },
      }),
    ]);
  });

  it('does NOT conceal a malformed value — the #1670 finding still holds', () => {
    // The concealment the old "no twin" decision was protecting against: if the
    // fold substituted the default here, the desired side would equal the
    // record, the provider would never be called, and the WARNING that tells
    // the user what to fix would stop. The fold is keyed off the declared
    // SHAPE, never off the refusal, so a malformed value passes through intact
    // and `cdkd diff` keeps reporting it.
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          ScheduleFrequency: 'Daily',
          Destination: { BucketArn: DEST_ARN, Format: ['CSV'] },
        },
      ],
    });

    expect(at(canonical['InventoryConfigurations'], 0, 'Destination', 'Format')).toEqual(['CSV']);
  });

  it('identity-returns another resource type and an untouched bag', () => {
    const other = { Foo: 1 };
    expect(provider.canonicalizeDesiredProperties('AWS::SQS::Queue', other)).toBe(other);
    const noItems = { BucketName: BUCKET };
    expect(provider.canonicalizeDesiredProperties(RESOURCE_TYPE, noItems)).toBe(noItems);
    // A fully-declared item folds to nothing, so the BAG identity survives —
    // which is what keeps an ordinary template diffing byte-for-byte as before.
    const declared = {
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: false,
          IncludedObjectVersions: 'Current',
          ScheduleFrequency: 'Daily',
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        },
      ],
    };
    expect(provider.canonicalizeDesiredProperties(RESOURCE_TYPE, declared)).toBe(declared);
  });

  it('leaves a malformed list or element ALONE rather than reshaping it', () => {
    const malformedList = { InventoryConfigurations: 'not-an-array' };
    expect(provider.canonicalizeDesiredProperties(RESOURCE_TYPE, malformedList)).toBe(
      malformedList
    );
    const malformedElement = { InventoryConfigurations: ['not-an-object'] };
    expect(provider.canonicalizeDesiredProperties(RESOURCE_TYPE, malformedElement)).toBe(
      malformedElement
    );
    // A non-object StorageClassAnalysis is exactly what `requireConfigObject`
    // SKIPS on the wire, so folding it here would describe a call that never
    // went out.
    const skipped = { AnalyticsConfigurations: [{ Id: 'a1', StorageClassAnalysis: 'nope' }] };
    expect(provider.canonicalizeDesiredProperties(RESOURCE_TYPE, skipped)).toBe(skipped);
  });
});

/**
 * Issue #1718 item 2's sibling audit: the OTHER two per-item appliers.
 *
 * The issue asks to "check the sibling per-item appliers for the same shape
 * (analytics / metrics / intelligent-tiering all have defaulted members)". The
 * answer is not uniform, so both halves are pinned:
 *
 * - **intelligent tiering** defaults `Status` to `Enabled` on the wire and
 *   `intelligentTieringSdkToCfn` always reads it back, so an item omitting it
 *   recorded one key fewer than the readback produces — the same class, and it
 *   is now folded. Note this applier has NO warn-and-substitute arm (a
 *   malformed `Status` SKIPS the item, issue #1595), so the defaulted arm is
 *   the only thing its `substituted` map can ever carry.
 * - **metrics** has no defaulted scalar member at all — it sends `Id` plus a
 *   `Filter` derived from the declared predicates — so it needs no fold, and
 *   the row below fences that conclusion rather than leaving it as a claim in a
 *   comment.
 */
describe('#1718 the sibling per-item appliers', () => {
  const LIVE_TIERING = {
    Id: 't1',
    Status: 'Enabled',
    Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }],
  };

  it('intelligent tiering: an omitted Status is sent AND recorded', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 't1', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 120 }] },
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [LIVE_TIERING],
    });

    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([
      { Id: 't1', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 120 }], Status: 'Enabled' },
    ]);
  });

  it('intelligent tiering: a declared Status records nothing', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 't1', Status: 'Disabled', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 120 }] },
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [LIVE_TIERING],
    });

    expect(result.effectiveProperties).toBeUndefined();
  });

  it('metrics: the WIRE carries no defaulted member, which is why it needs no fold', async () => {
    const properties = {
      BucketName: BUCKET,
      MetricsConfigurations: [{ Id: 'm1', Prefix: 'logs/' }],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      MetricsConfigurations: [{ Id: 'm1', Prefix: 'old/' }],
    });

    // Asserting `effectiveProperties` ABSENT only says "no fold exists", which
    // would stay green if a defaulted wire member were added later and the
    // drift class re-opened (review of #1718). The CLAIM is about the WIRE, so
    // assert the wire: the sent configuration carries `Id` and a `Filter`
    // derived from the declared predicates, and nothing else.
    const sent = sentCommands(PutBucketMetricsConfigurationCommand);
    expect(sent).toHaveLength(1);
    const sentConfig = at(sent[0]!.input, 'MetricsConfiguration') as Record<string, unknown>;
    expect(Object.keys(sentConfig).sort()).toEqual(['Filter', 'Id']);
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('intelligent tiering: a MALFORMED Status skips the item, and the fold adds nothing', async () => {
    // The two mechanisms must not collide: `Status` is SKIP-guarded (#1595 —
    // defaulting to `Enabled` would start moving objects into archive tiers),
    // so a malformed value must retain the previous item rather than record a
    // defaulted one. The fold only ever supplies the create-path default, and
    // it must not reach a skipped item.
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 't1', Status: null, Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 120 }] },
      ],
    };
    const live = {
      Id: 't1',
      Status: 'Enabled',
      Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [live],
    });

    // The row's own title is "skips the item", so assert the SKIP directly
    // rather than only its consequence (review of #1718): no Put went out, and
    // the skip was announced.
    expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(0);
    expect(
      childLogger.warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('Skipping this intelligent tiering configuration'))
    ).toHaveLength(1);
    // ...so the effective entry is what AWS still HOLDS.
    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([live]);
  });

  it('the twin folds intelligent tiering too, so the diff converges', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      IntelligentTieringConfigurations: [{ Id: 't1', Tierings: [] }],
    });

    expect(canonical['IntelligentTieringConfigurations']).toEqual([
      { Id: 't1', Tierings: [], Status: 'Enabled' },
    ]);
  });
});

/**
 * The concealment fence for the twin (found by review of #1707 / #1717).
 *
 * The first cut of the folds resolved every default with `??`, which treats a
 * DECLARED `null` as absent. That silently folded the template side onto the
 * substituted value, so the comparison came out equal, the provider was never
 * called, and the warning that tells the user what to fix STOPPED — the exact
 * concealment #1670's finding 3 refused a twin over.
 *
 * Every unit row written before this one used a NON-nullish malformed value (a
 * blank string, an array, an unresolved intrinsic), so all of them passed
 * against the broken fold. These rows use the nullish spellings specifically.
 */
describe('the twin must not conceal a DECLARED-but-malformed value', () => {
  for (const [label, path, item] of [
    [
      'inventory destination Format: null',
      ['InventoryConfigurations', 0, 'Destination', 'Format'],
      {
        InventoryConfigurations: [
          {
            Id: 'i1',
            Enabled: true,
            IncludedObjectVersions: 'All',
            ScheduleFrequency: 'Daily',
            Destination: { BucketArn: DEST_ARN, Format: null },
          },
        ],
      },
    ],
    [
      'analytics OutputSchemaVersion: null',
      ['AnalyticsConfigurations', 0, 'StorageClassAnalysis', 'DataExport', 'OutputSchemaVersion'],
      {
        AnalyticsConfigurations: [
          analyticsItem({
            OutputSchemaVersion: null,
            Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
          }),
        ],
      },
    ],
    [
      'inventory ScheduleFrequency: null (must NOT fall through to Schedule)',
      ['InventoryConfigurations', 0, 'ScheduleFrequency'],
      {
        InventoryConfigurations: [
          {
            Id: 'i1',
            Enabled: true,
            IncludedObjectVersions: 'All',
            ScheduleFrequency: null,
            Schedule: { Frequency: 'Daily' },
            Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
          },
        ],
      },
    ],
  ] as Array<[string, Array<string | number>, Record<string, unknown>]>) {
    it(`keeps ${label} visible on the desired side`, () => {
      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, item);
      // The declared null survives the fold, so it can never compare equal to
      // the substituted value the provider records — `cdkd diff` goes on
      // reporting the property and the provider goes on warning.
      expect(at(canonical, ...path)).toBeNull();
    });
  }

  it('...while an ABSENT key still takes the default — the two are not the same case', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      InventoryConfigurations: [
        { Id: 'i1', Enabled: true, IncludedObjectVersions: 'All', ScheduleFrequency: 'Daily',
          Destination: { BucketArn: DEST_ARN } },
      ],
    });

    expect(at(canonical, 'InventoryConfigurations', 0, 'Destination', 'Format')).toBe('CSV');
  });

  it('an absent ScheduleFrequency DOES fall through to the SDK spelling', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      InventoryConfigurations: [
        { Id: 'i1', Enabled: true, IncludedObjectVersions: 'All',
          Schedule: { Frequency: 'Daily' }, Destination: { BucketArn: DEST_ARN, Format: 'CSV' } },
      ],
    });

    expect(at(canonical, 'InventoryConfigurations', 0, 'ScheduleFrequency')).toBe('Daily');
    expect('Schedule' in (at(canonical, 'InventoryConfigurations', 0) as object)).toBe(false);
  });
});

/**
 * The container-SHAPE route to the same concealment (found by the code review of
 * #1707 / #1717 — this one was INTRODUCED by the first cut of the folds).
 *
 * `declaredOrDefault` closes the route through `??`. It does not close the route
 * through a malformed CONTAINER: for `Schedule: 'Weekly'` / `[]` / `42` the
 * applier's `skipOnUnusableConfigString` refuses the non-object container and
 * SKIPS the item, so AWS keeps the PREVIOUS configuration and state retains it —
 * while a desired side folded to a bare `ScheduleFrequency: 'Weekly'` (with the
 * malformed key deleted) could compare EQUAL to exactly that retained item.
 * `update()` would then never be called and the skip warning would stop.
 */
describe('the Schedule container fold mirrors the WIRE, shape by shape', () => {
  // Measured against `configStringRefusal` / `readConfigString` directly, which
  // is what the applier consults. Two review rounds got this table wrong from a
  // hand-rolled predicate, and an earlier revision of THIS suite pinned the
  // wrong answer for `null` — so the table is stated explicitly and both arms
  // are asserted.
  const SKIPS = ['Weekly', [], 42, { Frequency: null }, { Frequency: '   ' }] as const;
  const SENDS = [null, {}, { Frequency: 'Daily' }] as const;

  const foldOne = (schedule: unknown) =>
    at(
      provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        InventoryConfigurations: [
          {
            Id: 'i1',
            Enabled: true,
            IncludedObjectVersions: 'All',
            Schedule: schedule,
            Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
          },
        ],
      }),
      'InventoryConfigurations',
      0
    ) as Record<string, unknown>;

  for (const schedule of SKIPS) {
    it(`leaves Schedule: ${JSON.stringify(schedule)} ALONE — the wire skips the item`, () => {
      // The applier refuses this container (or its `Frequency`) and SKIPS, so
      // AWS keeps the previous configuration and state retains it. Folding the
      // desired side to a bare `ScheduleFrequency` could compare EQUAL to that
      // retained item, so `update()` would never run and the skip warning would
      // stop — the concealment reached through the container SHAPE.
      const folded = foldOne(schedule);
      expect('Schedule' in folded).toBe(true);
      expect(folded['Schedule']).toEqual(schedule);
      expect('ScheduleFrequency' in folded).toBe(false);
    });
  }

  for (const schedule of SENDS) {
    it(`FOLDS Schedule: ${JSON.stringify(schedule)} — the wire sends a cadence`, () => {
      // `configStringRefusal` returns nothing for these, so the applier sends
      // (defaulting where the key is absent) and RECORDS the folded spelling.
      // Leaving the desired side unfolded here is the OTHER error direction: a
      // permanent `1 to update`, which is the defect issue #1717 exists to close.
      const folded = foldOne(schedule);
      expect('Schedule' in folded).toBe(false);
      expect(folded['ScheduleFrequency']).toBe(
        isPlainObjectWithFrequency(schedule) ? schedule.Frequency : 'Weekly'
      );
    });
  }

  it('a REFUSED ScheduleFrequency is not folded even when the container would carry it', () => {
    // The applier warns "Falling back to Schedule.Frequency" and records the
    // fallen-back value. Folding the desired side onto it would compare equal
    // and silence that warning — #1670's finding 3.
    const folded = at(
      provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        InventoryConfigurations: [
          {
            Id: 'i1',
            Enabled: true,
            IncludedObjectVersions: 'All',
            ScheduleFrequency: '   ',
            Schedule: { Frequency: 'Daily' },
            Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
          },
        ],
      }),
      'InventoryConfigurations',
      0
    ) as Record<string, unknown>;

    expect(folded['ScheduleFrequency']).toBe('   ');
    expect(folded['Schedule']).toEqual({ Frequency: 'Daily' });
  });

  it('a USABLE ScheduleFrequency wins and drops even a malformed container', () => {
    // The applier never reads `Schedule` in this case, so the item is sent and
    // the record cannot carry a key the readback never emits.
    const folded = at(
      provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        InventoryConfigurations: [
          {
            Id: 'i1',
            Enabled: true,
            IncludedObjectVersions: 'All',
            ScheduleFrequency: 'Daily',
            Schedule: 'Weekly',
            Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
          },
        ],
      }),
      'InventoryConfigurations',
      0
    ) as Record<string, unknown>;

    expect(folded['ScheduleFrequency']).toBe('Daily');
    expect('Schedule' in folded).toBe(false);
  });

  it('the APPLIER still records the fold when it actually sent a cadence', async () => {
    // The other side of the same gate: when the applier DID send something it
    // knows what went on the wire, so the fold must still run.
    const properties = {
      BucketName: BUCKET,
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          Schedule: { Frequency: 'Daily' },
          Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
        },
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      InventoryConfigurations: [LIVE_INVENTORY],
    });

    const recorded = at(result.effectiveProperties?.['InventoryConfigurations'], 0) as Record<
      string,
      unknown
    >;
    expect(recorded['ScheduleFrequency']).toBe('Daily');
    expect('Schedule' in recorded).toBe(false);
  });

  it('converges: a SENDS-shaped container folds to the same thing the applier records', async () => {
    // The end-to-end statement, and the row that would have caught the `null` /
    // `{}` regression directly: whatever the applier RECORDS for a shape the
    // wire sends, the twin must produce from the template.
    for (const schedule of SENDS) {
      mockSend.mockClear();
      const properties = {
        BucketName: BUCKET,
        InventoryConfigurations: [
          {
            Id: 'i1',
            Enabled: true,
            IncludedObjectVersions: 'All',
            Schedule: schedule,
            Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
          },
        ],
      };
      const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
        BucketName: BUCKET,
        InventoryConfigurations: [LIVE_INVENTORY],
      });
      // Assert the WIRE actually ran (round-3 review): without this the loop
      // reads only the two folds and could pass on a shape the applier had
      // silently skipped.
      expect(sentCommands(PutBucketInventoryConfigurationCommand)).toHaveLength(1);
      const recorded = at(result.effectiveProperties?.['InventoryConfigurations'], 0);
      const canonicalTemplate = at(
        provider.canonicalizeDesiredProperties(RESOURCE_TYPE, properties),
        'InventoryConfigurations',
        0
      );

      expect(canonicalTemplate).toEqual(recorded);
    }
  });
});

function isPlainObjectWithFrequency(v: unknown): v is { Frequency: string } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'Frequency' in v;
}

/**
 * The `BucketArn ?? Bucket` ALIAS read — the one `??` inside the folds, and NOT
 * an exception to the presence rule: it supplies no default, it picks between
 * two spellings of the same declared value exactly as the applier's own read
 * does. These rows pin that reading rather than leaving it as a comment.
 */
describe('the destination bucket ALIAS read', () => {
  it('falls through a nullish BucketArn to the Bucket alias, like the wire', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          ScheduleFrequency: 'Daily',
          Destination: { BucketArn: null, Bucket: DEST_ARN, Format: 'CSV' },
        },
      ],
    });

    expect(at(canonical, 'InventoryConfigurations', 0, 'Destination')).toEqual({
      BucketArn: DEST_ARN,
      Format: 'CSV',
    });
  });

  it('omits the key entirely when NEITHER spelling carries a bucket', () => {
    // The applier refuses such a block outright (`resolveS3BucketDestination`
    // drops it and the item is skipped), so the fold must not invent a
    // `BucketArn: undefined` that the readback could never match.
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          ScheduleFrequency: 'Daily',
          Destination: { Format: 'CSV' },
        },
      ],
    });
    const dest = at(canonical, 'InventoryConfigurations', 0, 'Destination') as Record<
      string,
      unknown
    >;

    expect('BucketArn' in dest).toBe(false);
    expect(dest).toEqual({ Format: 'CSV' });
  });
});

/**
 * Two shapes where the fold deliberately declines, pinned so a later "tidy-up"
 * cannot quietly re-open them (round-3 review).
 */
describe('the fold declines where the WIRE declines', () => {
  it('a destination with NEITHER BucketArn nor Bucket is left alone', () => {
    // `resolveS3BucketDestination` requires a bucket and drops the block, so the
    // item is SKIPPED. Folding it would invent a `Format: 'CSV'` describing a
    // call that never went out — the same mirror-the-wire rule the schedule fold
    // learned, one property over.
    const item = {
      Id: 'i1',
      Enabled: true,
      IncludedObjectVersions: 'All',
      ScheduleFrequency: 'Daily',
      Destination: { BucketAccountId: '123456789012' },
    };
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      InventoryConfigurations: [item],
    });

    expect(at(canonical, 'InventoryConfigurations', 0, 'Destination')).toEqual({
      BucketAccountId: '123456789012',
    });
  });

  it('...while a destination WITH a bucket still folds', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      InventoryConfigurations: [
        {
          Id: 'i1',
          Enabled: true,
          IncludedObjectVersions: 'All',
          ScheduleFrequency: 'Daily',
          Destination: { BucketAccountId: '123456789012', Bucket: DEST_ARN },
        },
      ],
    });

    expect(at(canonical, 'InventoryConfigurations', 0, 'Destination')).toEqual({
      BucketArn: DEST_ARN,
      BucketAccountId: '123456789012',
      Format: 'CSV',
    });
  });
});

/**
 * Issue #1751: the inventory `Enabled` member, which used to be the one read on
 * this item that coerced SILENTLY.
 *
 * This block replaces the CHARACTERIZATION rows that pinned the pre-fix
 * behavior (`Enabled: null` SENT as `true`, recorded as `null`, nothing
 * warning). The direction taken is the issue's option 2 — guard the WIRE —
 * because defaulting a malformed `Enabled` to `true` on a LIVE inventory
 * ENABLES a report the template may have been disabling, the destructive-default
 * class #1595 refuses. So the rows below are the same two questions asked of the
 * new behavior:
 *
 * 1. A declared-but-unusable value is REFUSED, per path: SKIP with a warning on
 *    the replay-reachable update path (the unit is one configuration item, since
 *    the Put is per-`Id`), THROW on a template-path create.
 * 2. A CFn STRING boolean is NOT malformed — CloudFormation is stringly typed —
 *    so it is sent COERCED and recorded coerced, which is what `inventorySdkToCfn`
 *    reads back.
 *
 * The nullish spelling is the one that has to be probed rather than assumed: it
 * is the only malformed shape `??` treated as absent, so every blank-string /
 * array / unresolved-intrinsic row written elsewhere in this file passed against
 * the bug.
 */
describe('issue #1751: a declared but unusable inventory Enabled', () => {
  const inventoryWithEnabled = (enabled: unknown) => ({
    Id: 'i1',
    Enabled: enabled,
    IncludedObjectVersions: 'All',
    ScheduleFrequency: 'Daily',
    Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
  });

  // Every shape `coerceCfnBoolean` cannot read. `null` leads deliberately: it is
  // the one the old `??` read treated as ABSENT.
  for (const value of [null, '', '   ', 'yes', 1, [], {}]) {
    it(`skips the item and warns on UPDATE (${JSON.stringify(value)})`, async () => {
      const properties = {
        BucketName: BUCKET,
        InventoryConfigurations: [inventoryWithEnabled(value)],
      };

      const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
        BucketName: BUCKET,
        InventoryConfigurations: [LIVE_INVENTORY],
      });

      // Nothing went on the wire for this item...
      expect(sentCommands(PutBucketInventoryConfigurationCommand)).toHaveLength(0);
      // ...so the effective value is the PREVIOUSLY-APPLIED item, which is what
      // AWS still holds — not the desired one, and not a dropped key.
      expect(at(result.effectiveProperties, 'InventoryConfigurations')).toEqual([LIVE_INVENTORY]);
      // And the skip is ANNOUNCED, naming both the member and the consequence
      // the guard exists to prevent.
      const warnings = childLogger.warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('Enabled'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('must be a boolean');
      expect(warnings[0]).toContain('Skipping this inventory configuration');
    });

    it(`REFUSES on a template-path create (${JSON.stringify(value)})`, async () => {
      await expect(
        provider.create('B', RESOURCE_TYPE, {
          BucketName: BUCKET,
          InventoryConfigurations: [inventoryWithEnabled(value)],
        })
      ).rejects.toThrow(/InventoryConfigurations\[\]\.Enabled must be a boolean/);
    });
  }

  // The counter-case, and the reason the guard runs `coerceCfnBoolean` rather
  // than a `typeof value === 'boolean'` twin: a hand-written or imported
  // template legitimately spells the boolean as a string, and refusing it would
  // break a template that deploys today.
  for (const [declared, sent] of [
    ['false', false],
    ['False', false],
    ['true', true],
    [false, false],
    [true, true],
  ] as const) {
    it(`sends and records the COERCED value for ${JSON.stringify(declared)}`, async () => {
      const properties = {
        BucketName: BUCKET,
        InventoryConfigurations: [inventoryWithEnabled(declared)],
      };

      const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
        BucketName: BUCKET,
        InventoryConfigurations: [LIVE_INVENTORY],
      });

      expect(
        at(
          sentCommands(PutBucketInventoryConfigurationCommand)[0]!.input,
          'InventoryConfiguration',
          'IsEnabled'
        )
      ).toBe(sent);
      // Recorded == sent. A declared BOOLEAN needs no fold at all, so the
      // effective bag only appears for the string spellings.
      const recordedEnabled = at(
        result.effectiveProperties ?? properties,
        'InventoryConfigurations',
        0,
        'Enabled'
      );
      expect(recordedEnabled).toBe(sent);
      // The twin folds the template side identically, or the next deploy would
      // read the coercion as a user-made change forever.
      expect(
        at(
          provider.canonicalizeDesiredProperties(RESOURCE_TYPE, properties),
          'InventoryConfigurations',
          0,
          'Enabled'
        )
      ).toBe(sent);
      // The caller's own bag is never mutated.
      expect(at(properties['InventoryConfigurations'], 0, 'Enabled')).toBe(declared);
      expect(
        childLogger.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Enabled'))
      ).toHaveLength(0);
    });
  }

  // An unusable value is left ALONE by the fold rather than normalized: nothing
  // was sent for that item, so there is no effective value to record, and
  // leaving it visible is what keeps `cdkd diff` reporting the fault until the
  // template is corrected.
  it('the twin leaves an unusable value untouched', () => {
    expect(
      at(
        provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
          InventoryConfigurations: [inventoryWithEnabled(null)],
        }),
        'InventoryConfigurations',
        0,
        'Enabled'
      )
    ).toBeNull();
  });
});
