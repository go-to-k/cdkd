import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ListBucketAnalyticsConfigurationsCommand,
  PutBucketAnalyticsConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
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
 *    (`{S3BucketDestination: {...}}`); an implementation that always writes
 *    back at one of them leaves the malformed value in place at the other AND
 *    adds a stray key, so each nested row asserts the sibling key is absent.
 * 3. **The well-formed polarity asserts `effectiveProperties` is ABSENT**, not
 *    equal to the desired bag. An implementation that always answers is
 *    indistinguishable by value and would rewrite the record on every deploy —
 *    the engine gates on `??`, so absent is the contract.
 * 4. **The DESIRED bag is asserted UNMUTATED.** Rewriting the caller's own
 *    property object would silently narrow the template side of the next
 *    comparison, which is the `canonicalizeDesiredProperties` behavior this
 *    change deliberately does NOT have (see the last describe block).
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

describe('UPDATE: the destination Format records at the branch the template declared', () => {
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

  it('analytics, NESTED destination — and no stray flattened key', async () => {
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
    // Written back where it was declared...
    expect(recordedDest).toEqual({ S3BucketDestination: { BucketArn: DEST_ARN, Format: 'CSV' } });
    // ...and NOT at the flattened key, which an implementation hardcoding one
    // branch would add while leaving the malformed value untouched.
    expect('Format' in recordedDest).toBe(false);
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
      inventoryItem({ BucketArn: DEST_ARN, Format: 'CSV', Prefix: 'live/' }),
    ]);
  });

  it('inventory, NESTED destination — and no stray flattened key', async () => {
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
    expect(recordedDest).toEqual({ S3BucketDestination: { BucketArn: DEST_ARN, Format: 'CSV' } });
    expect('Format' in recordedDest).toBe(false);
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
      inventoryItem({ BucketArn: DEST_ARN, Format: 'CSV' }),
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
      { ...withoutSdkSpelling, ScheduleFrequency: 'Daily' },
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

  it('update: an ABSENT field takes the default on the wire but records nothing', async () => {
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
    // ...but an omitted key is not a NARROWING, and `drift-calculator` only
    // descends into keys the state record carries, so writing one in would
    // start comparing a field the user never declared.
    expect(result.effectiveProperties).toBeUndefined();
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
 * The `canonicalizeDesiredProperties` decision, pinned (issue #1670).
 *
 * `.claude/rules/providers.md` pairs `effectiveProperties` with a
 * `canonicalizeDesiredProperties` twin for a NARROWING, and a substitution IS
 * a pure function of the desired value — so the twin question is live here and
 * was answered NO on the merits, not by citing the #1612 skip carve-out. The
 * reasoning is recorded on `readSubstitutedConfigString`; in short: the twin's
 * hazard (a create-only property re-reading as a REPLACEMENT) cannot arise for
 * these two properties, the twin could not be SHARED with a provisioning path
 * that still THROWS on the template-borne create, and it would silence the one
 * warning the user gets.
 *
 * This row is the fence. Implementing the hook later is allowed — but it must
 * be a deliberate re-derivation, not a reflex, so it has to delete this test.
 */
describe('no canonicalizeDesiredProperties twin', () => {
  it('the provider leaves the desired side alone, so the malformed value stays visible', () => {
    // Read through the INTERFACE, where the hook is an optional member: on the
    // concrete class the property does not exist at all, which is the fact
    // being pinned but is a type error rather than an assertion.
    const asProvider: ResourceProvider = provider;
    expect(asProvider.canonicalizeDesiredProperties).toBeUndefined();
  });
});
