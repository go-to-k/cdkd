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
  collectDesiredKeyAttributeNames,
  collectTableOnDemandCeilings,
  collectRawOnDemandDeclarations,
  derivePerCallProvisionedThroughput,
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
      // TWO non-local replicas carrying the SAME malformed table-level
      // override: each pass through `toSdkReplicaThroughputOverrides` in the
      // pre-flight scan yields an identical diagnostic line (the table-level
      // context has no index name), so without the `seen` Set the user gets
      // the same sentence twice. A single-diagnostic fixture would pass with
      // the Set deleted and pin nothing.
      const twoReplicas = clone(OD_PROPS);
      (twoReplicas['Replicas'] as Record<string, unknown>[]).push(
        {
          Region: 'eu-west-1',
          ReadOnDemandThroughputSettings: { MaxReadRequestUnits: { Ref: 'Nope' } },
        },
        {
          Region: 'eu-central-1',
          ReadOnDemandThroughputSettings: { MaxReadRequestUnits: { Ref: 'Nope' } },
        }
      );

      await provider.update(
        'OnDemand',
        'od-table',
        RESOURCE_TYPE,
        clone(twoReplicas),
        clone(twoReplicas)
      );

      const hits = warnings().filter((m) => m.includes('did not resolve to a number'));
      expect(hits).toHaveLength(1);
    });
  });

  /**
   * Issue #1511: the #1444 A diagnostic covered the ON-DEMAND members only.
   * The PROVISIONED side has the same input class with a worse outcome — the
   * derivation falls through to 5/5 and a table the template explicitly sized
   * is deployed at the default, silently. It cannot suppress the way the
   * on-demand side does (AWS requires `ProvisionedThroughput` on a provisioned
   * table and on every GSI of one), so the correct behavior is
   * warn-and-default, which is what these pin.
   */
  describe('unresolvable PROVISIONED capacity warns instead of defaulting silently (issue #1511)', () => {
    /** `TableV2` with `Capacity.autoscaled(...)` on the write side. */
    const provProps = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingMode: 'PROVISIONED',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      Replicas: [
        { Region: REGION, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 11 } },
      ],
      WriteProvisionedThroughputSettings: {
        WriteCapacityAutoScalingSettings: { MinCapacity: 7, MaxCapacity: 70 },
      },
      ...overrides,
    });

    const provGsi = (gsi: Record<string, unknown>): Record<string, unknown> => ({
      IndexName: 'gsi1',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      ...gsi,
    });

    const capacityWarnings = (): string[] =>
      warnings().filter((m) => m.includes('did not resolve to a number'));

    it('names the auto-scaling member and the substituted default', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      const throughput = derivePerCallProvisionedThroughput(
        provProps({
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: { MinCapacity: { Ref: 'Unresolved' }, MaxCapacity: 70 },
          },
        }),
        REGION,
        'min',
        diagnostics
      );

      // The silent 5 the issue is about — still sent, because AWS requires a
      // number, but no longer silent.
      expect(throughput.WriteCapacityUnits).toBe(5);
      expect(throughput.ReadCapacityUnits).toBe(11);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.member).toBe('MinCapacity');
      expect(diagnostics[0]?.message).toContain(
        'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MinCapacity'
      );
      expect(diagnostics[0]?.message).toContain('cdkd sent 5 capacity units instead');
    });

    it('blames the member the FLIP would have read, which is not the one create reads', () => {
      // `SeedCapacity` is consulted first on a PAY_PER_REQUEST -> PROVISIONED
      // flip and `MinCapacity` everywhere else (#1435), so a diagnostic that
      // ignored `source` would name a member the failing call never looked at.
      const props = provProps({
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: {
            SeedCapacity: { Ref: 'Unresolved' },
            MinCapacity: { 'Fn::If': ['C', 1, 2] },
          },
        },
      });
      const onFlip: ThroughputDiagnostic[] = [];
      const onCreate: ThroughputDiagnostic[] = [];

      derivePerCallProvisionedThroughput(props, REGION, 'seed', onFlip);
      derivePerCallProvisionedThroughput(props, REGION, 'min', onCreate);

      expect(onFlip[0]?.member).toBe('SeedCapacity');
      expect(onCreate[0]?.member).toBe('MinCapacity');
    });

    it('blames the BLOCK when the block itself is the unusable value', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      derivePerCallProvisionedThroughput(
        provProps({ WriteProvisionedThroughputSettings: { 'Fn::If': ['C', {}, {}] } }),
        REGION,
        'min',
        diagnostics
      );

      expect(diagnostics[0]?.member).toBe('WriteProvisionedThroughputSettings');
    });

    it('stays silent for an ABSENT block, which legitimately defaults', () => {
      // The pre-existing contract for a template that never asked for a
      // capacity. Warning here would shout on every deploy of a fine table.
      const props = provProps();
      delete props['WriteProvisionedThroughputSettings'];
      delete props['Replicas'];
      const diagnostics: ThroughputDiagnostic[] = [];

      const throughput = derivePerCallProvisionedThroughput(props, REGION, 'min', diagnostics);

      expect(throughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
      expect(diagnostics).toEqual([]);
    });

    it('fires for a per-GSI block, naming the index', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      const [sdk] = toSdkGlobalSecondaryIndexes(
        provProps({
          GlobalSecondaryIndexes: [
            provGsi({
              WriteProvisionedThroughputSettings: { WriteCapacityUnits: 'not-a-number' },
            }),
          ],
        }),
        REGION,
        'PROVISIONED',
        'min',
        diagnostics
      );

      expect(sdk?.ProvisionedThroughput?.WriteCapacityUnits).toBe(5);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.indexName).toBe('gsi1');
      expect(diagnostics[0]?.member).toBe('WriteCapacityUnits');
    });

    it('blames the replica spelling for a per-GSI READ capacity, as the on-demand half does', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      toSdkGlobalSecondaryIndexes(
        {
          ...provProps({
            GlobalSecondaryIndexes: [provGsi({})],
          }),
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

      expect(diagnostics.map((d) => d.member)).toContain('ReadCapacityUnits');
      expect(diagnostics[0]?.message).toContain(
        'Replicas[local].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings'
      );
    });

    it('says nothing when an explicit SDK-shaped member stands in for the unreadable one', () => {
      // The merge takes the explicit member, so that value IS what reaches
      // AWS — warning about a substitution that did not happen would be wrong.
      const diagnostics: ThroughputDiagnostic[] = [];
      const [sdk] = toSdkGlobalSecondaryIndexes(
        provProps({
          GlobalSecondaryIndexes: [
            provGsi({
              ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 9 },
              WriteProvisionedThroughputSettings: { WriteCapacityUnits: { Ref: 'Unresolved' } },
            }),
          ],
        }),
        REGION,
        'PROVISIONED',
        'min',
        diagnostics
      );

      expect(sdk?.ProvisionedThroughput?.WriteCapacityUnits).toBe(9);
      expect(diagnostics).toEqual([]);
    });

    it('reports the SUPPRESSION, not a default, for a replica override', () => {
      // The one provisioned site that can suppress: an absent
      // `ProvisionedThroughputOverride` means "inherit the source table".
      const diagnostics: ThroughputDiagnostic[] = [];
      const [sdk] = toSdkReplicaGlobalSecondaryIndexes(
        [
          {
            IndexName: 'gsi1',
            ReadProvisionedThroughputSettings: { ReadCapacityUnits: { Ref: 'Unresolved' } },
          },
        ],
        'PROVISIONED',
        diagnostics
      ) ?? [];

      expect(sdk?.ProvisionedThroughputOverride).toBeUndefined();
      expect(diagnostics[0]?.message).toContain('no ProvisionedThroughputOverride was sent');
      expect(diagnostics[0]?.message).not.toContain('capacity units instead');
    });

    it('fires on CREATE, before any table exists', async () => {
      await provider.create(
        'Prov',
        RESOURCE_TYPE,
        provProps({
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: { MinCapacity: { Ref: 'Unresolved' }, MaxCapacity: 9 },
          },
        })
      );

      const create = mockSend.mock.calls
        .map((c) => c[0])
        .find((c): c is CreateTableCommand => c instanceof CreateTableCommand);
      expect(create?.input.ProvisionedThroughput?.WriteCapacityUnits).toBe(5);
      expect(capacityWarnings()).toHaveLength(1);
      // Same ordering rule as the on-demand half: the complaint must not
      // arrive after a real (billable) table exists.
      expect(warnSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockSend.mock.invocationCallOrder[0]!
      );
    });

    it('fires on a FIRST-TIME per-GSI set during update, where the reset gate never runs', async () => {
      const previous = provProps({ GlobalSecondaryIndexes: [provGsi({})] });
      const next = provProps({
        GlobalSecondaryIndexes: [
          provGsi({
            WriteProvisionedThroughputSettings: { WriteCapacityUnits: { Ref: 'Unresolved' } },
          }),
        ],
      });

      await provider.update('Prov', 'od-table', RESOURCE_TYPE, next, previous);

      expect(capacityWarnings().some((m) => m.includes('gsi1'))).toBe(true);
    });

    it('fires across a billing flip, where the table-level value is what gets sent', async () => {
      const previous = { ...provProps(), BillingMode: 'PAY_PER_REQUEST' };
      const next = provProps({
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: { SeedCapacity: { Ref: 'Unresolved' } },
        },
      });

      await provider.update('Prov', 'od-table', RESOURCE_TYPE, next, previous);

      expect(capacityWarnings().some((m) => m.includes('SeedCapacity'))).toBe(true);
      const flip = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.BillingMode === 'PROVISIONED'
        );
      expect(flip?.input.ProvisionedThroughput?.WriteCapacityUnits).toBe(5);
    });

    it('says nothing about the table-level value while the billing mode holds still', async () => {
      // Recorded rather than incidental: outside the flip nothing SENDS a
      // table-level `ProvisionedThroughput`, so no default is substituted and a
      // warning would name a value that never reached AWS.
      //
      // Driven through `update()` on purpose. An earlier version of this test
      // called the GSI translator directly with a table-level block, which that
      // function never reads — it passed for ANY implementation and pinned the
      // gate it names not at all. The sibling billing-flip case above is the
      // positive control that keeps this one honest.
      const bad = {
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: { MinCapacity: { Ref: 'Unresolved' } },
        },
      };

      await provider.update(
        'Prov',
        'od-table',
        RESOURCE_TYPE,
        provProps(bad),
        provProps({ ...bad, DeletionProtectionEnabled: true })
      );

      expect(capacityWarnings()).toEqual([]);
    });

    it('names the member the FLIP reads for a per-GSI block too, not just the table one', async () => {
      // Same #1435 precedence one level down: step 4's flip translates the
      // indexes with `'seed'`, so a diagnostic raised from the `'min'` pass
      // would name `MinCapacity` for a value the failing call never consulted.
      const gsiWithBothUnresolvable = {
        GlobalSecondaryIndexes: [
          provGsi({
            WriteProvisionedThroughputSettings: {
              WriteCapacityAutoScalingSettings: {
                SeedCapacity: { Ref: 'Unresolved' },
                MinCapacity: { 'Fn::If': ['C', 1, 2] },
              },
            },
          }),
        ],
      };

      await provider.update(
        'Prov',
        'od-table',
        RESOURCE_TYPE,
        provProps(gsiWithBothUnresolvable),
        { ...provProps(gsiWithBothUnresolvable), BillingMode: 'PAY_PER_REQUEST' }
      );

      const hits = capacityWarnings();
      expect(hits.some((m) => m.includes('SeedCapacity'))).toBe(true);
      expect(hits.some((m) => m.includes('MinCapacity'))).toBe(false);
    });

    it('reports nothing for the PREVIOUS side, so bad state cannot shout every deploy', async () => {
      // The #1428 asymmetry, re-asserted for the provisioned half: a value an
      // older binary recorded in cdkd state is not editable from the template.
      const previous = provProps({
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: { MinCapacity: { Ref: 'GarbageInState' } },
        },
      });
      const next = provProps({
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: { MinCapacity: 12, MaxCapacity: 70 },
        },
      });

      await provider.update('Prov', 'od-table', RESOURCE_TYPE, next, previous);

      expect(warnings().some((m) => m.includes('GarbageInState'))).toBe(false);
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

    it('emits the READ-side auto-scaling shape onto the replica index entry', async () => {
      // The read dimension's reverse map — a separate branch from the write
      // one, homed on the REPLICA entry rather than the top-level GSI.
      mockAutoScalingSend.mockImplementation((cmd: { input?: Record<string, unknown> }) => {
        if (cmd.input?.['ScalableDimension'] !== 'dynamodb:index:ReadCapacityUnits') {
          return Promise.resolve({ ScalableTargets: [], ScalingPolicies: [] });
        }
        return Promise.resolve({
          ScalableTargets: [{ MinCapacity: 7, MaxCapacity: 70 }],
          ScalingPolicies: [
            {
              PolicyType: 'TargetTrackingScaling',
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 65 },
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

      const localReplica = (state?.['Replicas'] as Record<string, unknown>[]).find(
        (r) => r['Region'] === REGION
      )!;
      expect((localReplica['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]).toEqual({
        IndexName: 'gsi1',
        ReadProvisionedThroughputSettings: {
          ReadCapacityAutoScalingSettings: {
            MinCapacity: 7,
            MaxCapacity: 70,
            TargetTrackingScalingPolicyConfiguration: { TargetValue: 65 },
          },
        },
      });
    });

    it('synthesizes the local replica entry when DescribeTable omits Replicas', async () => {
      // A single-region GlobalTable — every TableV2 without `replicas` — has
      // NO `Replicas` member in DescribeTable, but the CFn schema requires
      // the local entry, so the state baseline always has one. Without the
      // synthesis the read-half members this provider reverse-maps had
      // nowhere to land and their drift detection was silently dead for
      // exactly the common case.
      const { Replicas: _omitted, ...tableWithoutReplicas } = onDemandTable;
      describeWith(tableWithoutReplicas);

      const state = await provider.readCurrentState('od-table', 'OnDemand', RESOURCE_TYPE);

      const replicas = state?.['Replicas'] as Record<string, unknown>[];
      expect(replicas).toHaveLength(1);
      const local = replicas[0]!;
      expect(local['Region']).toBe(REGION);
      expect(local['ReadOnDemandThroughputSettings']).toEqual({ MaxReadRequestUnits: 100 });
      expect((local['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]).toEqual({
        IndexName: 'gsi1',
        ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 },
      });
    });

    it('keeps getDriftUnknownPaths EMPTY rather than switching drift off for the subtree', () => {
      // #1420's option 2 (declare `GlobalSecondaryIndexes` here) was the
      // honest stopgap, not the fix: it trades phantom drift for NO drift
      // detection on any GSI.
      expect(provider.getDriftUnknownPaths(RESOURCE_TYPE)).toEqual([]);
    });
  });

  /**
   * Review-driven coverage (this PR's 3-axis review): paths the first cut of
   * the suite could not fail on.
   */
  describe('review-closed gaps', () => {
    it('defers declared ceilings past a PROVISIONED -> PAY_PER_REQUEST flip', async () => {
      // Step 3 runs BEFORE step 4's flip, so on this direction the live table
      // is still PROVISIONED when the flat call goes out — sending the
      // template's new on-demand ceilings there would 400 and, since state is
      // only saved on success, make the flip template repeatedly
      // undeployable. The ceilings must ride a SEPARATE UpdateTable AFTER the
      // flip (the per-GSI path already had this shape for free via step 6).
      const previous: Record<string, unknown> = {
        ...clone(OD_PROPS),
        BillingMode: 'PROVISIONED',
        Replicas: [{ Region: REGION }],
      };
      delete previous['WriteOnDemandThroughputSettings'];
      const next = clone(OD_PROPS); // PAY_PER_REQUEST with read 100 / write 200

      // A live PROVISIONED table carries NO OnDemandThroughput — the blanket
      // beforeEach mock does, which would make the desired 100/200 read as
      // "unchanged" and hide the deferral entirely.
      mockSend.mockResolvedValue({
        Table: {
          TableName: 'od-table',
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          Replicas: [{ RegionName: REGION, ReplicaStatus: 'ACTIVE' }],
        },
      });

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const updates = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c): c is UpdateTableCommand => c instanceof UpdateTableCommand);
      const flipIndex = updates.findIndex((c) => c.input.BillingMode === 'PAY_PER_REQUEST');
      const ceilingIndex = updates.findIndex((c) => c.input.OnDemandThroughput !== undefined);
      expect(flipIndex).toBeGreaterThanOrEqual(0);
      expect(ceilingIndex).toBeGreaterThan(flipIndex);
      // The flip call itself carries no ceiling, and the post-flip send
      // carries BOTH halves.
      expect(updates[flipIndex]!.input.OnDemandThroughput).toBeUndefined();
      expect(updates[ceilingIndex]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 100,
        MaxWriteRequestUnits: 200,
      });
    });

    it('never sends a table-level on-demand ceiling while the table stays PROVISIONED', async () => {
      // The send-gate itself: PROVISIONED on both sides with a stale leftover
      // ceiling block that changed. Deleting the gate is exactly the deploy
      // that 400s in the field.
      const previous: Record<string, unknown> = {
        ...clone(OD_PROPS),
        BillingMode: 'PROVISIONED',
      };
      const next = clone(previous);
      next['WriteOnDemandThroughputSettings'] = { MaxWriteRequestUnits: 999 };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const withCeiling = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.OnDemandThroughput !== undefined
        );
      expect(withCeiling).toHaveLength(0);
    });

    it('carries a CHANGED non-local replica override on the Update action', async () => {
      // The modified-replica loop's override wiring plus the `hasUpdateField`
      // extension: an override-ONLY edit used to be classified "Tags-style"
      // and skipped entirely.
      withActiveCrossRegionReplica();
      const previous = clone(OD_PROPS);
      (previous['Replicas'] as Record<string, unknown>[]).push({
        Region: 'eu-west-1',
        ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 75 },
      });
      const next = clone(previous);
      (next['Replicas'] as Record<string, unknown>[])[1]!['ReadOnDemandThroughputSettings'] = {
        MaxReadRequestUnits: 90,
      };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(replicaUpdate('eu-west-1')?.['OnDemandThroughputOverride']).toEqual({
        MaxReadRequestUnits: 90,
      });
    });

    it('suppresses the dropped-override warning while the billing mode flips', async () => {
      // A flip re-shapes both sides by construction — "the old override is
      // gone" there is the translation, not a template edit, so warning would
      // cry wolf on every flip.
      withActiveCrossRegionReplica();
      const previous = clone(OD_PROPS);
      (previous['Replicas'] as Record<string, unknown>[]).push({
        Region: 'eu-west-1',
        ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 75 },
      });
      const next: Record<string, unknown> = { ...clone(previous), BillingMode: 'PROVISIONED' };
      delete (next['Replicas'] as Record<string, unknown>[])[1]!['ReadOnDemandThroughputSettings'];
      // Give the flipped replica a real edit so it still classifies modified.
      (next['Replicas'] as Record<string, unknown>[])[1]!['TableClassOverride'] =
        'STANDARD_INFREQUENT_ACCESS';

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(warnings().some((m) => m.includes('STILL IN'))).toBe(false);
    });

    it('allows an AttributeDefinitions removal that accompanies the GSI it belonged to', async () => {
      // Caught LIVE by the gsi-billing-flip integ: dropping a GSI from a
      // TableV2 also drops its key attribute from the synthesized
      // AttributeDefinitions (CDK derives the list from the keys in use, and
      // DynamoDB rejects an unused entry), so the pre-#1421 blanket
      // removal-refusal made EVERY GSI deletion a forced replacement. The
      // GSI Delete action takes no AttributeDefinitions at all.
      const gsi = (name: string, attr: string): Record<string, unknown> => ({
        IndexName: name,
        KeySchema: [{ AttributeName: attr, KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      });
      const previous: Record<string, unknown> = {
        ...clone(OD_PROPS),
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'keep', AttributeType: 'S' },
          { AttributeName: 'drop', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [gsi('flipKeep', 'keep'), gsi('flipDrop', 'drop')],
      };
      const next: Record<string, unknown> = {
        ...clone(OD_PROPS),
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'keep', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [gsi('flipKeep', 'keep')],
      };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const gsiDelete = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            c.input.GlobalSecondaryIndexUpdates?.[0]?.Delete?.IndexName === 'flipDrop'
        );
      expect(gsiDelete).toBeDefined();
    });

    it('still refuses an AttributeDefinitions removal a surviving key schema references', async () => {
      // The genuine redefine-in-place: the attribute vanishes from
      // AttributeDefinitions while an index still keys on it. AWS rejects
      // that; only a replacement can apply it.
      const previous: Record<string, unknown> = {
        ...clone(OD_PROPS),
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'keep', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'flipKeep',
            KeySchema: [{ AttributeName: 'keep', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      };
      const next = clone(previous);
      next['AttributeDefinitions'] = [{ AttributeName: 'pk', AttributeType: 'S' }];

      await expect(
        provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous)
      ).rejects.toThrow(/AttributeDefinitions removals are immutable.*keep/);
    });

    it('collects every desired key attribute across table, GSI and LSI schemas', () => {
      expect(
        collectDesiredKeyAttributeNames({
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          GlobalSecondaryIndexes: [
            { IndexName: 'g', KeySchema: [{ AttributeName: 'gpk', KeyType: 'HASH' }] },
          ],
          LocalSecondaryIndexes: [
            { IndexName: 'l', KeySchema: [{ AttributeName: 'lsk', KeyType: 'RANGE' }] },
          ],
        })
      ).toEqual(new Set(['pk', 'gpk', 'lsk']));
      // Malformed shapes contribute nothing — permissive, per the guard note.
      expect(
        collectDesiredKeyAttributeNames({ KeySchema: { 'Fn::If': ['C', [], []] } })
      ).toEqual(new Set());
    });

    it('reports a replica-level explicit block on the wrong billing mode', () => {
      const diagnostics: ThroughputDiagnostic[] = [];
      toSdkReplicaGlobalSecondaryIndexes(
        [
          {
            IndexName: 'gsi1',
            ProvisionedThroughputOverride: { ReadCapacityUnits: 7 },
          },
        ],
        'PAY_PER_REQUEST',
        diagnostics
      );
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          kind: 'billing-mode-mismatch',
          indexName: 'gsi1',
          member: 'ProvisionedThroughputOverride',
        })
      );
    });

    it('counts a table-level ceiling block that is ITSELF an intrinsic as declared', () => {
      const props = clone(OD_PROPS);
      props['WriteOnDemandThroughputSettings'] = {
        'Fn::If': ['Cond', { MaxWriteRequestUnits: 5 }, { Ref: 'AWS::NoValue' }],
      };
      expect(collectTableOnDemandCeilings(props, REGION).write).toEqual({
        declared: true,
        value: undefined,
      });
    });

    it('counts an explicit SDK-shaped block that is ITSELF an intrinsic as declared', () => {
      // `OnDemandThroughput: {"Fn::If": …}` has no member keys, so the member
      // test alone reported "not declared" for BOTH members and the -1 reset
      // cleared a ceiling a hand-authored template was setting — #1440 one
      // spelling over.
      const props: Record<string, unknown> = {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            OnDemandThroughput: {
              'Fn::If': ['Cond', { MaxWriteRequestUnits: 5 }, { Ref: 'AWS::NoValue' }],
            },
          },
        ],
      };
      expect(collectRawOnDemandDeclarations(props, REGION).get('gsi1')).toEqual({
        readDeclared: true,
        writeDeclared: true,
      });
    });
  });
});
