import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * Issue #3135: every `AWS::DynamoDB::GlobalTable` capacity / throughput
 * FORWARDER reads its Integer through `coerceCfnInteger` — CloudFormation's
 * MEASURED DynamoDB Integer grammar (`/^[+-]?\d+$/`, NO trim; the table is on
 * `toCfnInteger` in `dynamodb-warm-throughput.ts`) — instead of `Number()`,
 * which forwarded `7` / `9` / `10` for a template CloudFormation REJECTS.
 *
 * The four spellings below are the four the live A/B rejected
 * (`AWS::DynamoDB::Table.ProvisionedThroughput.ReadCapacityUnits`, us-east-1,
 * 2026-09-14): a padded string (rejected at properties validation, BEFORE the
 * handler — the one row where DynamoDB is STRICTER than the Logs handler),
 * hex, exponent and decimal point (rejected by the handler).
 *
 * What a rejected spelling BECOMES is the arm each site already had for an
 * unusable value (an unresolved intrinsic, `''`, an object) — issue #1428's
 * warn-and-fall-back, never a throw, because these translators also run on
 * `previousProperties` (a state record the user cannot edit) and on the
 * replica path AFTER `CreateTable` committed. So a rejected spelling is: on a
 * PROVISIONED site, the announced `DEFAULT_CAPACITY_UNITS` fallback (AWS
 * requires a concrete capacity); on an ON-DEMAND site, an announced
 * suppression (nothing sent, the live ceiling stands). Never silent, never
 * absent, never `Number()`'s reading — and every case here asserts the
 * DIAGNOSTIC beside the wire value, because the predicates that gate those
 * diagnostics are the sites a partial switch leaves inconsistent.
 */

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
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

import {
  collectTableOnDemandCeilings,
  collectUncomparableCapacityGsiNames,
  derivePerCallProvisionedThroughput,
  deriveReadCapacityUnits,
  deriveWriteCapacityUnits,
  toSdkGlobalSecondaryIndexes,
  toSdkReplicaGlobalSecondaryIndexes,
  type ThroughputDiagnostic,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { toFiniteNumber } from '../../../src/provisioning/dynamodb-warm-throughput.js';

/** The four spellings CloudFormation rejected, with the number `Number()` read for each. */
const REJECTED_SPELLINGS: ReadonlyArray<readonly [label: string, value: string, wide: number]> = [
  ['padded', ' 7 ', 7],
  ['hex', '0x9', 9],
  ['exponent', '1e1', 10],
  ['decimal-point', '6.5', 6.5],
];

const REGION = 'us-east-1';

/** A GSI whose only capacity source is the explicit SDK-shaped block. */
function gsiWithExplicit(block: Record<string, unknown>): Record<string, unknown> {
  return {
    BillingMode: 'PROVISIONED',
    GlobalSecondaryIndexes: [
      {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: block,
      },
    ],
  };
}

describe('GlobalTable capacity forwarders read the measured DynamoDB Integer grammar (issue #3135)', () => {
  // The premise every case below rests on, asserted once so a future widening
  // of `toFiniteNumber` cannot make the file vacuous: the guard reader DOES
  // accept each spelling, i.e. the pre-fix forwarders sent a number for it.
  it('premise: the guard reader `toFiniteNumber` accepts every rejected spelling', () => {
    for (const [, value, wide] of REJECTED_SPELLINGS) expect(toFiniteNumber(value)).toBe(wide);
  });

  describe('deriveRead/WriteCapacityUnits (the literal arm and the auto-scaling arm)', () => {
    it.each(REJECTED_SPELLINGS)('a %s literal ReadCapacityUnits is NOT a capacity', (_l, value) => {
      expect(deriveReadCapacityUnits({ ReadCapacityUnits: value })).toBeUndefined();
    });

    it.each(REJECTED_SPELLINGS)('a %s literal WriteCapacityUnits is NOT a capacity', (_l, value) => {
      expect(deriveWriteCapacityUnits({ WriteCapacityUnits: value })).toBeUndefined();
    });

    it.each(REJECTED_SPELLINGS)(
      'a %s MinCapacity / SeedCapacity is NOT a capacity under either source',
      (_l, value) => {
        const block = {
          WriteCapacityAutoScalingSettings: { MinCapacity: value, SeedCapacity: value },
        };
        expect(deriveWriteCapacityUnits(block, 'min')).toBeUndefined();
        expect(deriveWriteCapacityUnits(block, 'seed')).toBeUndefined();
      }
    );

    it('a rejected literal falls THROUGH to a usable auto-scaling member rather than winning', () => {
      // The literal arm answers `undefined` for `" 7 "`, so the derivation
      // consults the auto-scaling block exactly as it does for an unresolved
      // intrinsic literal. (CloudFormation would REJECT this whole template at
      // properties validation; cdkd's warn-and-fall-back is #1428's decision
      // for a translator that also runs on state records -- the point here is
      // only that the rejected spelling never WINS over a usable sibling.)
      expect(
        deriveWriteCapacityUnits({
          WriteCapacityUnits: ' 7 ',
          WriteCapacityAutoScalingSettings: { MinCapacity: '+2', MaxCapacity: 20 },
        })
      ).toBe(2);
    });

    it('still accepts the spellings CloudFormation accepts', () => {
      expect(deriveReadCapacityUnits({ ReadCapacityUnits: '+8' })).toBe(8);
      expect(deriveReadCapacityUnits({ ReadCapacityUnits: '010' })).toBe(10);
      expect(deriveReadCapacityUnits({ ReadCapacityUnits: 5 })).toBe(5);
    });
  });

  describe('toSdkGlobalSecondaryIndexes — PROVISIONED: the explicit block and its mirror predicate', () => {
    it.each(REJECTED_SPELLINGS)(
      'an explicit %s ReadCapacityUnits is dropped by the merge, named, and the default stands in',
      (_l, value) => {
        const diagnostics: ThroughputDiagnostic[] = [];
        const [gsi] = toSdkGlobalSecondaryIndexes(
          gsiWithExplicit({ ReadCapacityUnits: value, WriteCapacityUnits: 3 }),
          REGION,
          'PROVISIONED',
          'min',
          diagnostics
        );
        // The wire value: the 5 fallback for the unreadable read half (AWS
        // REQUIRES a capacity on a provisioned GSI), the usable write half
        // sent as declared — never `Number(value)`.
        expect(gsi!.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 3 });
        // The merge's own "present but did not resolve" diagnostic names the
        // member, the grammar, AND the value that stood in: on this
        // explicit-only shape (no CFn `Read...Settings` block) the #1511
        // fallback diagnostic has no block to blame and never fires, so this
        // line is the only announcement of the 5 that went to AWS (parent
        // review finding -- the earlier version of this case pinned the 5 on
        // the wire and let it go unannounced).
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.indexName).toBe('gsi1');
        expect(diagnostics[0]!.message).toContain('ProvisionedThroughput.ReadCapacityUnits');
        expect(diagnostics[0]!.message).toContain('it was ignored and 5 was sent instead');
        expect(diagnostics[0]!.message).toContain('accepts only an optional sign');
      }
    );

    it.each(REJECTED_SPELLINGS)(
      'the `explicitCovers` mirror does NOT count an explicit %s spelling as covering the read side',
      (_l, value) => {
        // The predicate's job: when the CFn-spelled block is unresolvable, the
        // #1511 "cdkd sent 5 instead" diagnostic is SUPPRESSED if the explicit
        // SDK-shaped block covers the member — because the merge will forward
        // the explicit value. On the wider reader `" 7 "` counted as covering,
        // the merge then dropped it, and the 5 fallback shipped with the
        // fallback diagnostic silenced. Reading the predicate through the
        // merge's own grammar keeps the two in step.
        const diagnostics: ThroughputDiagnostic[] = [];
        const [gsi] = toSdkGlobalSecondaryIndexes(
          {
            ...gsiWithExplicit({ ReadCapacityUnits: value, WriteCapacityUnits: 3 }),
            Replicas: [
              {
                Region: REGION,
                GlobalSecondaryIndexes: [
                  {
                    IndexName: 'gsi1',
                    ReadProvisionedThroughputSettings: { ReadCapacityUnits: { Ref: 'Unresolved' } },
                  },
                ],
              },
            ],
          },
          REGION,
          'PROVISIONED',
          'min',
          diagnostics
        );
        expect(gsi!.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 3 });
        const messages = diagnostics.map((d) => d.message);
        // The fallback diagnostic — the one the mirror gates.
        expect(messages.some((m) => m.includes('so cdkd sent 5 capacity units instead'))).toBe(true);
        // And the merge's own, for the explicit member it dropped.
        expect(messages.some((m) => m.includes('ProvisionedThroughput.ReadCapacityUnits'))).toBe(
          true
        );
        expect(diagnostics.every((d) => d.indexName === 'gsi1')).toBe(true);
      }
    );

    it('the mirror DOES count an explicit "+7" as covering, so no fallback diagnostic fires', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      const [gsi] = toSdkGlobalSecondaryIndexes(
        {
          ...gsiWithExplicit({ ReadCapacityUnits: '+7', WriteCapacityUnits: 3 }),
          Replicas: [
            {
              Region: REGION,
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'gsi1',
                  ReadProvisionedThroughputSettings: { ReadCapacityUnits: { Ref: 'Unresolved' } },
                },
              ],
            },
          ],
        },
        REGION,
        'PROVISIONED',
        'min',
        diagnostics
      );
      expect(gsi!.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 7, WriteCapacityUnits: 3 });
      expect(diagnostics).toEqual([]);
    });

    it('an explicit "+8" / "010" pair is forwarded as 8 / 10 with no diagnostic', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      const [gsi] = toSdkGlobalSecondaryIndexes(
        gsiWithExplicit({ ReadCapacityUnits: '+8', WriteCapacityUnits: '010' }),
        REGION,
        'PROVISIONED',
        'min',
        diagnostics
      );
      expect(gsi!.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 8, WriteCapacityUnits: 10 });
      expect(diagnostics).toEqual([]);
    });
  });

  describe('toSdkGlobalSecondaryIndexes — PAY_PER_REQUEST: the ceiling and its raw-member diagnostic', () => {
    it.each(REJECTED_SPELLINGS)(
      'a %s MaxWriteRequestUnits is SUPPRESSED and reported, never forwarded',
      (_l, value) => {
        const diagnostics: ThroughputDiagnostic[] = [];
        const [gsi] = toSdkGlobalSecondaryIndexes(
          {
            BillingMode: 'PAY_PER_REQUEST',
            GlobalSecondaryIndexes: [
              {
                IndexName: 'gsi1',
                KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
                Projection: { ProjectionType: 'ALL' },
                WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: value },
              },
            ],
          },
          REGION,
          'PAY_PER_REQUEST',
          'min',
          diagnostics
        );
        // Nothing sent for the ceiling: the live value stands (the on-demand
        // arm CAN suppress, unlike the provisioned one).
        expect(gsi!.OnDemandThroughput).toBeUndefined();
        // `reportUnresolvedRawMember` reads through the FORWARDER's grammar,
        // so the suppression is announced; on the wider reader it answered
        // "usable", the forwarder dropped the value, and nothing said so.
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.member).toBe('MaxWriteRequestUnits');
        expect(diagnostics[0]!.message).toContain('no throughput value was sent for it');
        expect(diagnostics[0]!.message).toContain('accepts only an optional sign');
      }
    );
  });

  describe('toSdkGlobalSecondaryIndexes — PAY_PER_REQUEST: the READ ceiling, both spellings', () => {
    // The read ceiling has TWO sources (the local replica's index entry, the
    // GSI-level fallback) read through one `??` chain; a case per source so a
    // revert of either arm alone is caught (review probe: the pair was inert
    // under the write-only case above).
    it.each(REJECTED_SPELLINGS)(
      'a %s replica-level MaxReadRequestUnits is SUPPRESSED, never forwarded',
      (_l, value) => {
        const diagnostics: ThroughputDiagnostic[] = [];
        const [gsi] = toSdkGlobalSecondaryIndexes(
          {
            BillingMode: 'PAY_PER_REQUEST',
            GlobalSecondaryIndexes: [
              {
                IndexName: 'gsi1',
                KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
                Projection: { ProjectionType: 'ALL' },
              },
            ],
            Replicas: [
              {
                Region: REGION,
                GlobalSecondaryIndexes: [
                  {
                    IndexName: 'gsi1',
                    ReadOnDemandThroughputSettings: { MaxReadRequestUnits: value },
                  },
                ],
              },
            ],
          },
          REGION,
          'PAY_PER_REQUEST',
          'min',
          diagnostics
        );
        expect(gsi!.OnDemandThroughput).toBeUndefined();
        expect(diagnostics.map((d) => d.member)).toEqual(['MaxReadRequestUnits']);
      }
    );

    it.each(REJECTED_SPELLINGS)(
      'a %s GSI-level MaxReadRequestUnits (the documented fallback) is SUPPRESSED, never forwarded',
      (_l, value) => {
        const diagnostics: ThroughputDiagnostic[] = [];
        const [gsi] = toSdkGlobalSecondaryIndexes(
          {
            BillingMode: 'PAY_PER_REQUEST',
            GlobalSecondaryIndexes: [
              {
                IndexName: 'gsi1',
                KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
                Projection: { ProjectionType: 'ALL' },
                ReadOnDemandThroughputSettings: { MaxReadRequestUnits: value },
              },
            ],
          },
          REGION,
          'PAY_PER_REQUEST',
          'min',
          diagnostics
        );
        expect(gsi!.OnDemandThroughput).toBeUndefined();
        expect(diagnostics.map((d) => d.member)).toEqual(['MaxReadRequestUnits']);
      }
    );

    it('a "+41" replica read ceiling beside a "010" write ceiling is forwarded as 41 / 10, with NO diagnostic', () => {
      // `diagnostics` is PASSED so `reportUnresolvedRawMember`'s accepting arm
      // is on the line (without the array it short-circuits before reading
      // the value, and a predicate accepting only JSON numbers would pass).
      const diagnostics: ThroughputDiagnostic[] = [];
      const [gsi] = toSdkGlobalSecondaryIndexes(
        {
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: '010' },
            },
          ],
          Replicas: [
            {
              Region: REGION,
              GlobalSecondaryIndexes: [
                { IndexName: 'gsi1', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: '+41' } },
              ],
            },
          ],
        },
        REGION,
        'PAY_PER_REQUEST',
        'min',
        diagnostics
      );
      expect(gsi!.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 41, MaxWriteRequestUnits: 10 });
      expect(diagnostics).toEqual([]);
    });
  });

  describe('collectTableOnDemandCeilings (the table-level ceilings CreateTable / UpdateTable forward)', () => {
    it.each(REJECTED_SPELLINGS)(
      'a %s MaxWriteRequestUnits is DECLARED but has no value, and is reported',
      (_l, value) => {
        const diagnostics: ThroughputDiagnostic[] = [];
        const ceilings = collectTableOnDemandCeilings(
          { WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: value } },
          REGION,
          diagnostics
        );
        // `declared: true` keeps the `-1` reset OFF (the template is trying
        // to SET a ceiling, not remove one); `value: undefined` keeps the
        // spelling off the wire. Both halves matter: with a value the call
        // would carry `Number()`'s reading, and without `declared` the
        // update path would CLEAR the live ceiling.
        expect(ceilings.write).toEqual({ declared: true, value: undefined });
        expect(diagnostics.map((d) => d.member)).toEqual(['MaxWriteRequestUnits']);
      }
    );

    it.each(REJECTED_SPELLINGS)(
      'a %s local-replica MaxReadRequestUnits is DECLARED but has no value, and is reported',
      (_l, value) => {
        // The READ half lives on the LOCAL replica, read by its own `value:`
        // line (review probe: reverting it alone was inert under the write
        // cases above).
        const diagnostics: ThroughputDiagnostic[] = [];
        const ceilings = collectTableOnDemandCeilings(
          { Replicas: [{ Region: REGION, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: value } }] },
          REGION,
          diagnostics
        );
        expect(ceilings.read).toEqual({ declared: true, value: undefined });
        expect(diagnostics.map((d) => d.member)).toEqual(['MaxReadRequestUnits']);
      }
    );

    it('a "+100" write ceiling and a "010" replica read ceiling are forwarded as 100 / 10', () => {
      const ceilings = collectTableOnDemandCeilings(
        {
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: '+100' },
          Replicas: [{ Region: REGION, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: '010' } }],
        },
        REGION,
        []
      );
      expect(ceilings.write).toEqual({ declared: true, value: 100 });
      expect(ceilings.read).toEqual({ declared: true, value: 10 });
    });
  });

  describe('derivePerCallProvisionedThroughput (the table-level capacity on create and the billing flip)', () => {
    it('a padded local-replica ReadCapacityUnits takes the announced 5 fallback, named by path', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      const capacity = derivePerCallProvisionedThroughput(
        {
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 4 },
          Replicas: [{ Region: REGION, ReadProvisionedThroughputSettings: { ReadCapacityUnits: ' 7 ' } }],
        },
        REGION,
        'min',
        diagnostics
      );
      expect(capacity).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 4 });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.message).toContain(
        'Replicas[local].ReadProvisionedThroughputSettings.ReadCapacityUnits'
      );
      // The blamed VALUE is the raw spelling, so the user sees `" 7 "`.
      expect(diagnostics[0]!.message).toContain('" 7 "');
    });
  });

  describe('collectUncomparableCapacityGsiNames mirrors the translation (the live-baseline guard)', () => {
    it.each(REJECTED_SPELLINGS)(
      'an explicit %s ReadCapacityUnits makes the index NOT template-determined',
      (_l, value) => {
        // The destructive arm this predicate exists for: the translation sends
        // the 5/5 fallback for this index, so if the live baseline carried the
        // real 25/25 the diff would read a scale-DOWN nobody asked for. The
        // predicate must therefore answer with the FORWARDER's reader — on the
        // wider one `" 7 "` counted as determined and the index was compared.
        const names = collectUncomparableCapacityGsiNames(
          gsiWithExplicit({ ReadCapacityUnits: value, WriteCapacityUnits: 3 }),
          REGION
        );
        expect([...names]).toEqual(['gsi1']);
      }
    );

    it.each(REJECTED_SPELLINGS)(
      'an explicit %s WriteCapacityUnits makes the index NOT template-determined (the write arm)',
      (_l, value) => {
        // The write half has its own `coerceCfnInteger` read one line below
        // the read one (review probe: reverting it alone stayed green under
        // the read-side cases, whose write member was a usable 3).
        const names = collectUncomparableCapacityGsiNames(
          gsiWithExplicit({ ReadCapacityUnits: 3, WriteCapacityUnits: value }),
          REGION
        );
        expect([...names]).toEqual(['gsi1']);
      }
    );

    it('an explicit "+7" / "010" pair keeps the index comparable', () => {
      const names = collectUncomparableCapacityGsiNames(
        gsiWithExplicit({ ReadCapacityUnits: '+7', WriteCapacityUnits: '010' }),
        REGION
      );
      expect([...names]).toEqual([]);
    });
  });

  describe('toSdkReplicaGlobalSecondaryIndexes (a remote replica`s per-index override)', () => {
    it.each(REJECTED_SPELLINGS)(
      'a %s ReadCapacityUnits sends NO ProvisionedThroughputOverride and reports the suppression',
      (_l, value) => {
        const diagnostics: ThroughputDiagnostic[] = [];
        const [index] = toSdkReplicaGlobalSecondaryIndexes(
          [{ IndexName: 'gsi1', ReadProvisionedThroughputSettings: { ReadCapacityUnits: value } }],
          'PROVISIONED',
          diagnostics
        )!;
        // The one PROVISIONED site that CAN suppress (absent = inherit the
        // source table), so the replica keeps the inherited capacity instead
        // of taking `Number()`'s reading OR a 5 fallback.
        expect(index).toEqual({ IndexName: 'gsi1' });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.message).toContain('keeps the source table');
      }
    );

    it('a "+8" ReadCapacityUnits is forwarded as ProvisionedThroughputOverride 8 with NO diagnostic', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      const [index] = toSdkReplicaGlobalSecondaryIndexes(
        [{ IndexName: 'gsi1', ReadProvisionedThroughputSettings: { ReadCapacityUnits: '+8' } }],
        'PROVISIONED',
        diagnostics
      )!;
      expect(index).toEqual({
        IndexName: 'gsi1',
        ProvisionedThroughputOverride: { ReadCapacityUnits: 8 },
      });
      expect(diagnostics).toEqual([]);
    });

    it.each(REJECTED_SPELLINGS)(
      'an explicit %s ProvisionedThroughputOverride does NOT count as covering the suppression diagnostic',
      (_l, value) => {
        // The suppression diagnostic is gated on "neither the CFn block nor
        // the explicit SDK-shaped override yields a capacity". On the wider
        // reader an explicit `" 7 "` counted as a capacity, the diagnostic was
        // suppressed, and the merge then dropped the value -- an inherited
        // capacity with nothing saying so.
        const diagnostics: ThroughputDiagnostic[] = [];
        const [index] = toSdkReplicaGlobalSecondaryIndexes(
          [
            {
              IndexName: 'gsi1',
              ReadProvisionedThroughputSettings: { ReadCapacityUnits: { Ref: 'Unresolved' } },
              ProvisionedThroughputOverride: { ReadCapacityUnits: value },
            },
          ],
          'PROVISIONED',
          diagnostics
        )!;
        expect(index).toEqual({ IndexName: 'gsi1' });
        const messages = diagnostics.map((d) => d.message);
        expect(messages.some((m) => m.includes('keeps the source table'))).toBe(true);
        expect(messages.some((m) => m.includes('ProvisionedThroughputOverride.ReadCapacityUnits'))).toBe(
          true
        );
      }
    );

    it.each(REJECTED_SPELLINGS)(
      'an on-demand %s MaxReadRequestUnits sends NO OnDemandThroughputOverride and reports it',
      (_l, value) => {
        const diagnostics: ThroughputDiagnostic[] = [];
        const [index] = toSdkReplicaGlobalSecondaryIndexes(
          [{ IndexName: 'gsi1', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: value } }],
          'PAY_PER_REQUEST',
          diagnostics
        )!;
        expect(index).toEqual({ IndexName: 'gsi1' });
        expect(diagnostics.map((d) => d.member)).toEqual(['MaxReadRequestUnits']);
      }
    );
  });
});
