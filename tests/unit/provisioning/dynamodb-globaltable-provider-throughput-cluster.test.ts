import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

/**
 * The `AWS::DynamoDB::GlobalTable` throughput cluster: issues #1420, #1428,
 * #1434, #1436 and #1444 item A. They are covered together because they all
 * land in the same translation layer and several of them only make sense
 * against each other — the merge (#1428) is what makes the raw-declaration
 * map's UNION correct, and the read-half wiring (#1436) is what gives the
 * table-level reset (#1434) a second member to be per-member about.
 *
 * The property bags are `cdk synth` shapes for `dynamodb.TableV2`, so the
 * split that drives most of this is real rather than assumed: the WRITE
 * ceiling is a top-level property and the READ ceiling lives on the LOCAL
 * REPLICA, one level up from the per-GSI split #1387 established.
 */

const { mockSend, mockAutoScalingSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  DynamoDBGlobalTableProvider,
  collectTableOnDemandCeilings,
  collectRawOnDemandDeclarations,
  toSdkGlobalSecondaryIndexes,
  toSdkReplicaGlobalSecondaryIndexes,
  type ThroughputDiagnostic,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const REGION = 'us-east-1';
const TABLE_ARN = `arn:aws:dynamodb:${REGION}:123:table/od-table`;

/**
 * `cdk synth` for
 *
 * ```ts
 * new ddb.TableV2(stack, 'OnDemand', {
 *   partitionKey: { name: 'pk', type: STRING },
 *   billing: Billing.onDemand({ maxReadRequestUnits: 100, maxWriteRequestUnits: 200 }),
 * });
 * ```
 *
 * `maxWriteRequestUnits` renders as the top-level
 * `WriteOnDemandThroughputSettings` while `maxReadRequestUnits` renders on the
 * LOCAL replica — the drop issue #1436 filed.
 */
const OD_PROPS: Record<string, unknown> = {
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  Replicas: [{ Region: REGION, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 100 } }],
  WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 200 },
};

const clone = (v: Record<string, unknown>): Record<string, unknown> =>
  structuredClone(v) as Record<string, unknown>;

/** The step-3 flat UpdateTable: no per-GSI and no per-replica actions. */
const flatUpdate = (): UpdateTableCommand | undefined =>
  mockSend.mock.calls
    .map((c) => c[0])
    .find(
      (c): c is UpdateTableCommand =>
        c instanceof UpdateTableCommand &&
        c.input.GlobalSecondaryIndexUpdates === undefined &&
        c.input.ReplicaUpdates === undefined
    );

/** The ReplicaUpdates UpdateTable for a given region, if one was issued. */
const replicaUpdate = (region: string): Record<string, unknown> | undefined => {
  for (const call of mockSend.mock.calls) {
    const cmd = call[0];
    if (!(cmd instanceof UpdateTableCommand)) continue;
    for (const entry of cmd.input.ReplicaUpdates ?? []) {
      const action = (entry.Create ?? entry.Update) as Record<string, unknown> | undefined;
      if (action?.['RegionName'] === region) return action;
    }
  }
  return undefined;
};

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

/**
 * Report `eu-west-1` as an ACTIVE replica too. Any test that adds a non-local
 * replica needs this: `addReplica` ends in `waitForReplicaActive`, which polls
 * `DescribeTable` until the region shows up in `Replicas[]`, so the default
 * single-region response makes the call hang rather than fail.
 */
const withActiveCrossRegionReplica = (): void => {
  mockSend.mockResolvedValue({
    Table: {
      TableName: 'od-table',
      TableArn: TABLE_ARN,
      TableStatus: 'ACTIVE',
      Replicas: [
        { RegionName: REGION, ReplicaStatus: 'ACTIVE' },
        { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
      ],
      OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 200 },
    },
  });
};

describe('DynamoDB GlobalTable throughput cluster', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    mockSend.mockResolvedValue({
      Table: {
        TableName: 'od-table',
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        Replicas: [{ RegionName: REGION, ReplicaStatus: 'ACTIVE' }],
        OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 200 },
      },
    });
    provider = new DynamoDBGlobalTableProvider();
  });

  /**
   * Issue #1436: the table-level READ ceiling is authored on the local replica
   * and was never read, so `Billing.onDemand({ maxReadRequestUnits })` produced
   * a table with NO read ceiling and a success report. The symptom is a
   * surprise bill or an unthrottled read spike, not an error.
   */
  describe('table-level read ceiling (issue #1436)', () => {
    it('collects BOTH halves from the two places CFn puts them', () => {
      expect(collectTableOnDemandCeilings(OD_PROPS, REGION)).toEqual({
        read: { declared: true, value: 100 },
        write: { declared: true, value: 200 },
      });
    });

    it('reads the LOCAL replica only — a same-shaped foreign replica is not the table ceiling', () => {
      const props = clone(OD_PROPS);
      props['Replicas'] = [
        { Region: 'eu-west-1', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 999 } },
      ];
      expect(collectTableOnDemandCeilings(props, REGION).read).toEqual({
        declared: false,
        value: undefined,
      });
    });

    it('sends MaxReadRequestUnits on CreateTable alongside the write half', async () => {
      await provider.create('OnDemand', RESOURCE_TYPE, clone(OD_PROPS));

      const create = mockSend.mock.calls
        .map((c) => c[0])
        .find((c): c is CreateTableCommand => c instanceof CreateTableCommand);
      expect(create?.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 100,
        MaxWriteRequestUnits: 200,
      });
    });

    it('never sends an on-demand ceiling on a PROVISIONED CreateTable', async () => {
      const props = clone(OD_PROPS);
      props['BillingMode'] = 'PROVISIONED';

      await provider.create('OnDemand', RESOURCE_TYPE, props);

      const create = mockSend.mock.calls
        .map((c) => c[0])
        .find((c): c is CreateTableCommand => c instanceof CreateTableCommand);
      expect(create?.input.OnDemandThroughput).toBeUndefined();
    });

    it('applies a CHANGED read ceiling on update', async () => {
      const next = clone(OD_PROPS);
      (next['Replicas'] as Record<string, unknown>[])[0]!['ReadOnDemandThroughputSettings'] = {
        MaxReadRequestUnits: 300,
      };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, clone(OD_PROPS));

      expect(flatUpdate()?.input.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 300 });
    });

    it('resets a REMOVED read ceiling with the -1 sentinel, leaving the write sibling alone', async () => {
      const next = clone(OD_PROPS);
      delete (next['Replicas'] as Record<string, unknown>[])[0]!['ReadOnDemandThroughputSettings'];

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, clone(OD_PROPS));

      // Per-member, not whole-block: the untouched write ceiling must not ride
      // along, since re-asserting it is a needless AWS-side write.
      expect(flatUpdate()?.input.OnDemandThroughput).toEqual({ MaxReadRequestUnits: -1 });
    });

    it('repairs a pre-fix table whose state carries the ceiling AWS never received', async () => {
      // The convergence case that makes AWS-observed the right baseline. A
      // table deployed before this fix has `maxReadRequestUnits` recorded in
      // cdkd state (state stores template intent) while AWS never got it, so a
      // state-vs-state diff sees "unchanged" and the drop is permanent.
      mockSend.mockResolvedValue({
        Table: {
          TableName: 'od-table',
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          Replicas: [{ RegionName: REGION, ReplicaStatus: 'ACTIVE' }],
          OnDemandThroughput: { MaxWriteRequestUnits: 200 },
        },
      });

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, clone(OD_PROPS), clone(OD_PROPS));

      expect(flatUpdate()?.input.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 100 });
    });

    it('wires a NON-LOCAL replica read ceiling as OnDemandThroughputOverride', async () => {
      withActiveCrossRegionReplica();
      const props = clone(OD_PROPS);
      (props['Replicas'] as Record<string, unknown>[]).push({
        Region: 'eu-west-1',
        ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 75 },
      });

      await provider.create('OnDemand', RESOURCE_TYPE, props);

      expect(replicaUpdate('eu-west-1')?.['OnDemandThroughputOverride']).toEqual({
        MaxReadRequestUnits: 75,
      });
    });

    it('wires a NON-LOCAL replica read CAPACITY as ProvisionedThroughputOverride', async () => {
      withActiveCrossRegionReplica();
      const props = clone(OD_PROPS);
      props['BillingMode'] = 'PROVISIONED';
      (props['Replicas'] as Record<string, unknown>[]).push({
        Region: 'eu-west-1',
        ReadProvisionedThroughputSettings: { ReadCapacityUnits: 9 },
      });

      await provider.create('OnDemand', RESOURCE_TYPE, props);

      expect(replicaUpdate('eu-west-1')?.['ProvisionedThroughputOverride']).toEqual({
        ReadCapacityUnits: 9,
      });
    });

    it('reports rather than resets a DROPPED non-local replica override', async () => {
      // Live probe (issue #1436, us-east-1 + us-west-2, 2026-08-09): the
      // replica override has NO reset payload — `-1` is stored literally, and
      // the empty-block form wedged the table in UPDATING for over an hour and
      // then blocked deletion for 24h. So this path deliberately stops at a
      // warning instead of guessing a third payload.
      withActiveCrossRegionReplica();
      const previous = clone(OD_PROPS);
      (previous['Replicas'] as Record<string, unknown>[]).push({
        Region: 'eu-west-1',
        ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 75 },
      });
      const next = clone(previous);
      delete (next['Replicas'] as Record<string, unknown>[])[1]!['ReadOnDemandThroughputSettings'];

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(replicaUpdate('eu-west-1')?.['OnDemandThroughputOverride']).toBeUndefined();
      expect(
        warnings().some(
          (m) => m.includes('ReadOnDemandThroughputSettings') && m.includes('STILL IN')
        )
      ).toBe(true);
    });
  });

  /**
   * Issue #1428: an explicitly SDK-shaped throughput block used to be
   * forwarded VERBATIM. Three defects followed and fixing any subset leaves a
   * live one, so all three are pinned here.
   */
  describe('explicit SDK-shaped blocks (issue #1428)', () => {
    const gsiProps = (gsi: Record<string, unknown>): Record<string, unknown> => ({
      ...clone(OD_PROPS),
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ...gsi,
        },
      ],
    });

    it('coerces a stringly-typed explicit member instead of forwarding it raw', () => {
      const [sdk] = toSdkGlobalSecondaryIndexes(
        gsiProps({ OnDemandThroughput: { MaxWriteRequestUnits: '5' } }),
        REGION,
        'PAY_PER_REQUEST'
      );
      expect(sdk?.OnDemandThroughput?.MaxWriteRequestUnits).toBe(5);
    });

    it('merges a PARTIAL explicit block over the derived siblings instead of replacing them', () => {
      const [sdk] = toSdkGlobalSecondaryIndexes(
        gsiProps({
          OnDemandThroughput: { MaxReadRequestUnits: 41 },
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 60 },
        }),
        REGION,
        'PAY_PER_REQUEST'
      );
      expect(sdk?.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 41,
        MaxWriteRequestUnits: 60,
      });
    });

    it('drops an explicit ProvisionedThroughput on a PAY_PER_REQUEST table and says so', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      const [sdk] = toSdkGlobalSecondaryIndexes(
        gsiProps({ ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } }),
        REGION,
        'PAY_PER_REQUEST',
        'min',
        diagnostics
      );
      expect(sdk?.ProvisionedThroughput).toBeUndefined();
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ kind: 'billing-mode-mismatch', member: 'ProvisionedThroughput' })
      );
    });

    it('drops an explicit OnDemandThroughput on a PROVISIONED table and says so', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      const [sdk] = toSdkGlobalSecondaryIndexes(
        gsiProps({ OnDemandThroughput: { MaxWriteRequestUnits: 60 } }),
        REGION,
        'PROVISIONED',
        'min',
        diagnostics
      );
      expect(sdk?.OnDemandThroughput).toBeUndefined();
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ kind: 'billing-mode-mismatch', member: 'OnDemandThroughput' })
      );
    });

    it('falls back to the derived value for an uncoercible explicit member, never throwing', () => {
      // Three earlier designs threw here and each was broken by the same lever:
      // the helper also runs on `previousProperties`, so a garbage value in
      // STATE made every subsequent update() throw — including the deploy that
      // would have removed it.
      const diagnostics: ThroughputDiagnostic[] = [];
      const [sdk] = toSdkGlobalSecondaryIndexes(
        gsiProps({
          OnDemandThroughput: { MaxWriteRequestUnits: { Ref: 'Unresolved' } },
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 60 },
        }),
        REGION,
        'PAY_PER_REQUEST',
        'min',
        diagnostics
      );
      expect(sdk?.OnDemandThroughput?.MaxWriteRequestUnits).toBe(60);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ kind: 'unresolved-member', member: 'MaxWriteRequestUnits' })
      );
    });

    it('never produces an EMPTY block, which AWS reads as "inherit the source table"', () => {
      const [sdk] = toSdkGlobalSecondaryIndexes(
        gsiProps({ OnDemandThroughput: { MaxWriteRequestUnits: {} } }),
        REGION,
        'PAY_PER_REQUEST'
      );
      expect(sdk?.OnDemandThroughput).toBeUndefined();
      const [replica] = toSdkReplicaGlobalSecondaryIndexes(
        [{ IndexName: 'gsi1', OnDemandThroughputOverride: { MaxReadRequestUnits: [] } }],
        'PAY_PER_REQUEST'
      )!;
      expect(replica?.OnDemandThroughputOverride).toBeUndefined();
    });

    it('rejects the shapes bare Number() would have accepted', () => {
      // `Number([])` is 0, `Number(true)` is 1 — both slip through a bare
      // coercion as plausible capacities, and `[]` additionally flipped the
      // presence gate ON. The predicate is `number | string` for that reason.
      for (const bad of [true, [], [5], {}] as unknown[]) {
        const [sdk] = toSdkGlobalSecondaryIndexes(
          gsiProps({ OnDemandThroughput: { MaxWriteRequestUnits: bad } }),
          REGION,
          'PAY_PER_REQUEST'
        );
        expect(sdk?.OnDemandThroughput?.MaxWriteRequestUnits).toBeUndefined();
      }
    });

    it('reports nothing for the PREVIOUS side, so bad state cannot shout every deploy', async () => {
      // The asymmetry #1428 requires: strict handling may apply to the
      // template, never to `previousProperties`.
      const previous = gsiProps({
        OnDemandThroughput: { MaxWriteRequestUnits: { Ref: 'GarbageInState' } },
      });
      const next = gsiProps({ WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 60 } });

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(warnings().some((m) => m.includes('GarbageInState'))).toBe(false);
    });

    it('counts an explicit member as DECLARED so the reset cannot clear it', () => {
      // The raw-declaration map has to be the UNION of the explicit and
      // derived sources now that they merge. Reading the explicit block alone
      // would report a derived-only member not-declared and clear it.
      const declared = collectRawOnDemandDeclarations(
        gsiProps({
          OnDemandThroughput: { MaxReadRequestUnits: 41 },
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 60 },
        }),
        REGION
      ).get('gsi1');
      expect(declared).toEqual({ readDeclared: true, writeDeclared: true });
    });
  });

  /**
   * Issue #1444 item A: the diagnostic lived in the per-GSI reset gate, which
   * only runs for an index the diff already classified `modified`, only when a
   * previous ceiling existed, and only when the billing mode held still. The
   * SAME template defect was therefore silent in the two likeliest cases.
   */
  describe('unresolved-value diagnostic reaches every case (issue #1444 A)', () => {
    const withGsi = (
      gsi: Record<string, unknown>,
      billing = 'PAY_PER_REQUEST'
    ): Record<string, unknown> => ({
      ...clone(OD_PROPS),
      BillingMode: billing,
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ...gsi,
        },
      ],
    });

    it('fires on a FIRST-TIME set, where the index is not even `modified`', async () => {
      // Both translated sides lack `OnDemandThroughput`, so the index never
      // enters the modified loop and the old gate never ran.
      const same = { WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: { Ref: 'Nope' } } };

      await provider.update(
        'OnDemand',
        'od-table',
        RESOURCE_TYPE,
        withGsi(same),
        withGsi({ WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: { Ref: 'Nope' } } })
      );

      expect(
        warnings().some(
          (m) => m.includes("gsi1") && m.includes('did not resolve to a number')
        )
      ).toBe(true);
    });

    it('fires across a billing flip, which short-circuited the old gate', async () => {
      await provider.update(
        'OnDemand',
        'od-table',
        RESOURCE_TYPE,
        withGsi({ WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: { Ref: 'Nope' } } }),
        withGsi({ ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } }, 'PROVISIONED')
      );

      expect(warnings().some((m) => m.includes('did not resolve to a number'))).toBe(true);
    });

    it('fires on CREATE, before any table exists', async () => {
      await provider.create(
        'OnDemand',
        RESOURCE_TYPE,
        withGsi({ WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: { Ref: 'Nope' } } })
      );

      const warnIndex = warnSpy.mock.invocationCallOrder[0];
      const createIndex = mockSend.mock.invocationCallOrder[0];
      expect(warnings().some((m) => m.includes('did not resolve to a number'))).toBe(true);
      // Ordering matters: #1428's third rejected design complained from inside
      // the post-CreateTable wiring, which meant a detectable garbage value
      // created a real table first.
      expect(warnIndex).toBeLessThan(createIndex!);
    });

    it('de-duplicates so one malformed block is not reported twice', async () => {
      await provider.update(
        'OnDemand',
        'od-table',
        RESOURCE_TYPE,
        withGsi({ WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: { Ref: 'Nope' } } }),
        withGsi({ WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 60 } })
      );

      const hits = warnings().filter((m) => m.includes('did not resolve to a number'));
      expect(hits).toHaveLength(1);
    });
  });

  /**
   * Issue #1420: `readCurrentState` wrote the raw SDK
   * `GlobalSecondaryIndexDescription[]` into the CFn-shaped state key, so
   * `cdkd drift` compared a CFn baseline against an SDK snapshot and reported
   * permanent phantom drift on any GlobalTable with a GSI.
   */
  describe('readCurrentState GSI reverse map (issue #1420)', () => {
    const describeWith = (table: Record<string, unknown>): void => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'DescribeTableCommand') return Promise.resolve({ Table: table });
        if (name === 'ListTagsOfResourceCommand') return Promise.resolve({ Tags: [] });
        return Promise.resolve({});
      });
    };

    const onDemandTable = {
      TableName: 'od-table',
      TableArn: TABLE_ARN,
      TableStatus: 'ACTIVE',
      BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
      Replicas: [{ RegionName: REGION, ReplicaStatus: 'ACTIVE' }],
      OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 200 },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          OnDemandThroughput: { MaxReadRequestUnits: 50, MaxWriteRequestUnits: 60 },
          // SDK-only members with no CFn counterpart — the phantom-drift source.
          IndexArn: `${TABLE_ARN}/index/gsi1`,
          IndexStatus: 'ACTIVE',
          ItemCount: 42,
          IndexSizeBytes: 1024,
        },
      ],
    };

    it('strips the SDK-only members CFn has no concept of', async () => {
      describeWith(onDemandTable);

      const state = await provider.readCurrentState('od-table', 'OnDemand', RESOURCE_TYPE);

      const gsi = (state?.['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]!;
      for (const sdkOnly of ['IndexArn', 'IndexStatus', 'ItemCount', 'IndexSizeBytes']) {
        expect(gsi).not.toHaveProperty(sdkOnly);
      }
    });

    it('re-maps the on-demand halves to their CFn homes (write top-level, read on the replica)', async () => {
      describeWith(onDemandTable);

      const state = await provider.readCurrentState('od-table', 'OnDemand', RESOURCE_TYPE);

      const gsi = (state?.['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]!;
      expect(gsi['WriteOnDemandThroughputSettings']).toEqual({ MaxWriteRequestUnits: 60 });
      expect(gsi).not.toHaveProperty('OnDemandThroughput');

      const localReplica = (state?.['Replicas'] as Record<string, unknown>[]).find(
        (r) => r['Region'] === REGION
      )!;
      expect(
        (localReplica['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]
      ).toEqual({ IndexName: 'gsi1', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } });
      // The TABLE-level read ceiling lands on the same replica entry (#1436).
      expect(localReplica['ReadOnDemandThroughputSettings']).toEqual({
        MaxReadRequestUnits: 100,
      });
    });

    it('round-trips a CFn-shaped baseline with no diff, which is the whole point', async () => {
      describeWith(onDemandTable);

      const state = await provider.readCurrentState('od-table', 'OnDemand', RESOURCE_TYPE);

      // The template side, as `cdk synth` would render this table.
      const templateGsi = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 60 },
      };
      expect(state?.['GlobalSecondaryIndexes']).toEqual([templateGsi]);
    });

    it('emits the flat provisioned shape when auto-scaling does NOT own the dimension', async () => {
      describeWith({
        ...onDemandTable,
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 2 },
          },
        ],
      });

      const state = await provider.readCurrentState('od-table', 'OnDemand', RESOURCE_TYPE);

      const gsi = (state?.['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]!;
      expect(gsi['WriteProvisionedThroughputSettings']).toEqual({ WriteCapacityUnits: 2 });
      const localReplica = (state?.['Replicas'] as Record<string, unknown>[]).find(
        (r) => r['Region'] === REGION
      )!;
      expect(
        (localReplica['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]
      ).toEqual({ IndexName: 'gsi1', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 } });
    });

    it('emits the auto-scaling shape when a per-INDEX target exists', async () => {
      // Recovering this is what made the correct reverse map possible at all —
      // #1420 offered the drift-off stopgap because the per-index registration
      // did not exist yet (it shipped in #1419). Emitting the flat number
      // against an autoscaled template would fire drift on every clean run.
      mockAutoScalingSend.mockImplementation((cmd: { input?: Record<string, unknown> }) => {
        const dimension = cmd.input?.['ScalableDimension'];
        if (dimension !== 'dynamodb:index:WriteCapacityUnits') {
          return Promise.resolve({ ScalableTargets: [], ScalingPolicies: [] });
        }
        const resourceId = (cmd.input?.['ResourceIds'] as string[] | undefined)?.[0];
        if (resourceId !== undefined) {
          expect(resourceId).toBe('table/od-table/index/gsi1');
        }
        return Promise.resolve({
          ScalableTargets: [{ MinCapacity: 2, MaxCapacity: 20 }],
          ScalingPolicies: [
            {
              PolicyType: 'TargetTrackingScaling',
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 60 },
            },
          ],
        });
      });
      describeWith({
        ...onDemandTable,
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 2 },
          },
        ],
      });

      const state = await provider.readCurrentState('od-table', 'OnDemand', RESOURCE_TYPE);

      const gsi = (state?.['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]!;
      expect(gsi['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityAutoScalingSettings: {
          MinCapacity: 2,
          MaxCapacity: 20,
          TargetTrackingScalingPolicyConfiguration: { TargetValue: 60 },
        },
      });
    });

    it('keeps getDriftUnknownPaths EMPTY rather than switching drift off for the subtree', () => {
      // #1420's option 2 (declare `GlobalSecondaryIndexes` here) was the
      // honest stopgap, not the fix: it trades phantom drift for NO drift
      // detection on any GSI.
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE)).toEqual([]);
    });
  });
});
