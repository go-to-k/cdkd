import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-suppressed-flip-table-xxx';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`;

const KEY_SCHEMA = [{ AttributeName: 'pk', KeyType: 'HASH' }];
const PROJECTION = { ProjectionType: 'ALL' };

/**
 * The UPDATE-side capacity twin of issue #1726, filed as issue #1738.
 *
 * When an unusable desired `BillingMode` suppresses the flip, the table keeps
 * the mode it already had — and the capacity call belonging to the OTHER mode
 * never fires, because every one of those emissions is gated on the billing
 * mode. The effective bag nevertheless recorded whatever the template declared,
 * so state described capacity AWS never received: a record
 * `readCurrentState` can never match, and one the NEXT update reads as its
 * previous side (the #1552 class).
 *
 * The create-side answer of #1726 does NOT transfer, which is why this arm has
 * its own suite: there the substituted mode is always PAY_PER_REQUEST so the
 * unsendable set is decidable outright, and the resource is NEW so a DROP is
 * right. Here the KEPT mode is resolved at run time and the table already
 * EXISTS, so `.claude/rules/providers.md`'s UPDATE row applies — retain the
 * PREVIOUS value, validated first.
 *
 * Every case below asserts the WIRE half before the record half. Retaining the
 * previous value is only correct BECAUSE the call was suppressed; a mutation
 * that sent the desired capacity anyway and still recorded the previous one
 * would satisfy a record-only assertion.
 */
describe('DynamoDBGlobalTableProvider suppressed-flip capacity retention (issue #1738)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBGlobalTableProvider();
  });

  /**
   * A live table running `mode`, carrying one ACTIVE index whose live capacity
   * deliberately differs from every value the fixtures declare — the #1630
   * skip compares member by member against this snapshot, so matching values
   * would suppress the very GSI update one case below asserts.
   */
  const liveTable = (mode: string) =>
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: mode },
        Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'g1',
            IndexStatus: 'ACTIVE',
            ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
          },
        ],
      },
    });

  const updateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  /** Every `GlobalSecondaryIndexUpdates[].Update` this update issued. */
  const gsiUpdateActions = (): Array<Record<string, unknown>> =>
    updateInputs()
      .flatMap((i) => (i['GlobalSecondaryIndexUpdates'] ?? []) as Array<Record<string, unknown>>)
      .map((u) => u['Update'] as Record<string, unknown> | undefined)
      .filter((u): u is Record<string, unknown> => u !== undefined);

  /** A bag carrying one capacity member at each of the four container levels. */
  const bag = (
    billingMode: unknown,
    values: { table: number; index: number; replica: number; replicaIndex: number },
    half: 'onDemand' | 'provisioned'
  ): Record<string, unknown> => {
    const tableBlock =
      half === 'onDemand'
        ? { WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: values.table } }
        : { WriteProvisionedThroughputSettings: { WriteCapacityUnits: values.table } };
    const indexBlock =
      half === 'onDemand'
        ? { WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: values.index } }
        : { WriteProvisionedThroughputSettings: { WriteCapacityUnits: values.index } };
    const replicaBlock =
      half === 'onDemand'
        ? { ReadOnDemandThroughputSettings: { MaxReadRequestUnits: values.replica } }
        : { ReadProvisionedThroughputSettings: { ReadCapacityUnits: values.replica } };
    const replicaIndexBlock =
      half === 'onDemand'
        ? { ReadOnDemandThroughputSettings: { MaxReadRequestUnits: values.replicaIndex } }
        : { ReadProvisionedThroughputSettings: { ReadCapacityUnits: values.replicaIndex } };
    return {
      TableName: TABLE_NAME,
      KeySchema: KEY_SCHEMA,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      ...(billingMode !== undefined && { BillingMode: billingMode }),
      ...tableBlock,
      GlobalSecondaryIndexes: [
        { IndexName: 'g1', KeySchema: KEY_SCHEMA, Projection: PROJECTION, ...indexBlock },
      ],
      Replicas: [
        {
          Region: 'us-east-1',
          ...replicaBlock,
          GlobalSecondaryIndexes: [{ IndexName: 'g1', ...replicaIndexBlock }],
        },
      ],
    };
  };

  const readBack = (
    props: Record<string, unknown> | undefined,
    half: 'onDemand' | 'provisioned'
  ) => {
    const tableKey =
      half === 'onDemand' ? 'WriteOnDemandThroughputSettings' : 'WriteProvisionedThroughputSettings';
    const replicaKey =
      half === 'onDemand' ? 'ReadOnDemandThroughputSettings' : 'ReadProvisionedThroughputSettings';
    const indexes = (props?.['GlobalSecondaryIndexes'] ?? []) as Array<Record<string, unknown>>;
    const replicas = (props?.['Replicas'] ?? []) as Array<Record<string, unknown>>;
    const replicaIndexes = (replicas[0]?.['GlobalSecondaryIndexes'] ?? []) as Array<
      Record<string, unknown>
    >;
    return {
      table: props?.[tableKey],
      index: indexes[0]?.[tableKey],
      replica: replicas[0]?.[replicaKey],
      replicaIndex: replicaIndexes[0]?.[replicaKey],
    };
  };

  // ─── KEPT mode PROVISIONED: the ON-DEMAND half is what never went out ───

  it('retains the PREVIOUS on-demand ceilings at every level when the kept mode is PROVISIONED', async () => {
    liveTable('PROVISIONED');
    const desired = bag('', { table: 500, index: 55, replica: 44, replicaIndex: 22 }, 'onDemand');
    const previous = bag(
      'PROVISIONED',
      { table: 100, index: 11, replica: 12, replicaIndex: 13 },
      'onDemand'
    );

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    // WIRE half: nothing on-demand left the process. The table-level ceiling is
    // gated on `newBilling !== 'PROVISIONED'`, and both translators drop their
    // on-demand branch under PROVISIONED.
    expect(updateInputs().some((i) => i['OnDemandThroughput'] !== undefined)).toBe(false);
    expect(gsiUpdateActions().some((u) => u['OnDemandThroughput'] !== undefined)).toBe(false);

    // RECORD half: state describes what AWS still holds, per level.
    expect(readBack(result.effectiveProperties, 'onDemand')).toEqual({
      table: { MaxWriteRequestUnits: 100 },
      index: { MaxWriteRequestUnits: 11 },
      replica: { MaxReadRequestUnits: 12 },
      replicaIndex: { MaxReadRequestUnits: 13 },
    });
  });

  it('keeps the DESIRED provisioned capacity when the kept mode is PROVISIONED', async () => {
    // The other polarity, and the reason the split is per MEMBER rather than a
    // blanket "strip anything throughput-shaped" (the #1726 name-shape trap
    // read from the opposite side): under PROVISIONED the provisioned half IS
    // delivered, so retaining it would record a loss that did not happen.
    liveTable('PROVISIONED');
    const desired = bag('', { table: 9, index: 7, replica: 3, replicaIndex: 2 }, 'provisioned');
    const previous = bag(
      'PROVISIONED',
      { table: 90, index: 70, replica: 30, replicaIndex: 20 },
      'provisioned'
    );

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    // WIRE half: step 6's GSI diff carries the desired per-index capacity.
    expect(gsiUpdateActions()).toContainEqual(
      expect.objectContaining({
        IndexName: 'g1',
        ProvisionedThroughput: expect.objectContaining({ WriteCapacityUnits: 7 }),
      })
    );

    // RECORD half: untouched by the retention pass.
    expect(readBack(result.effectiveProperties, 'provisioned')).toEqual({
      table: { WriteCapacityUnits: 9 },
      index: { WriteCapacityUnits: 7 },
      replica: { ReadCapacityUnits: 3 },
      replicaIndex: { ReadCapacityUnits: 2 },
    });
  });

  // ─── KEPT mode PAY_PER_REQUEST: the PROVISIONED half is what never went out ─

  it('retains the PREVIOUS provisioned capacity at every level when the kept mode is PAY_PER_REQUEST', async () => {
    liveTable('PAY_PER_REQUEST');
    const desired = bag('', { table: 9, index: 7, replica: 3, replicaIndex: 2 }, 'provisioned');
    const previous = bag(
      'PAY_PER_REQUEST',
      { table: 90, index: 70, replica: 30, replicaIndex: 20 },
      'provisioned'
    );

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    // WIRE half: the table-level `ProvisionedThroughput` rides step 4's flip
    // and nothing else, and both translators drop their provisioned branch
    // under PAY_PER_REQUEST.
    expect(updateInputs().some((i) => i['ProvisionedThroughput'] !== undefined)).toBe(false);
    expect(gsiUpdateActions().some((u) => u['ProvisionedThroughput'] !== undefined)).toBe(false);

    expect(readBack(result.effectiveProperties, 'provisioned')).toEqual({
      table: { WriteCapacityUnits: 90 },
      index: { WriteCapacityUnits: 70 },
      replica: { ReadCapacityUnits: 30 },
      replicaIndex: { ReadCapacityUnits: 20 },
    });
  });

  it('keeps the DESIRED on-demand ceilings when the kept mode is PAY_PER_REQUEST', async () => {
    liveTable('PAY_PER_REQUEST');
    const desired = bag('', { table: 500, index: 55, replica: 44, replicaIndex: 22 }, 'onDemand');
    const previous = bag(
      'PAY_PER_REQUEST',
      { table: 100, index: 11, replica: 12, replicaIndex: 13 },
      'onDemand'
    );

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    // WIRE half: step 3 sends the table-level ceilings under exactly this mode
    // — both halves, the write one top-level and the read one off the LOCAL
    // replica (issue #1436).
    expect(updateInputs()).toContainEqual(
      expect.objectContaining({
        OnDemandThroughput: { MaxReadRequestUnits: 44, MaxWriteRequestUnits: 500 },
      })
    );

    expect(readBack(result.effectiveProperties, 'onDemand')).toEqual({
      table: { MaxWriteRequestUnits: 500 },
      index: { MaxWriteRequestUnits: 55 },
      replica: { MaxReadRequestUnits: 44 },
      replicaIndex: { MaxReadRequestUnits: 22 },
    });
  });

  // ─── Validating the PREVIOUS side before retaining it (#1653 review) ────

  it.each([
    ['a bare string', 'nope'],
    ['null', null],
    ['an array', [{ MaxWriteRequestUnits: 100 }]],
    ['a number', 7],
  ])('DROPS the key when the previous side is %s', async (_label, previousBlock) => {
    // `previousProperties` is a cdkd STATE record, so a replay whose record was
    // written by an older binary can hold any of these. Copying one into
    // `effectiveProperties` would re-create the phantom drift this arm exists
    // to remove, sourced from the other side. Validated through `asRecord` —
    // the SAME predicate every wire read of these blocks applies.
    liveTable('PROVISIONED');
    const desired = bag('', { table: 500, index: 55, replica: 44, replicaIndex: 22 }, 'onDemand');
    const previous = {
      ...bag('PROVISIONED', { table: 100, index: 11, replica: 12, replicaIndex: 13 }, 'onDemand'),
      WriteOnDemandThroughputSettings: previousBlock,
    };

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    expect(result.effectiveProperties).toBeDefined();
    expect('WriteOnDemandThroughputSettings' in (result.effectiveProperties ?? {})).toBe(false);
  });

  it('DROPS the key when the previous record never declared the block', async () => {
    liveTable('PROVISIONED');
    const desired = bag('', { table: 500, index: 55, replica: 44, replicaIndex: 22 }, 'onDemand');
    const previous: Record<string, unknown> = {
      ...bag('PROVISIONED', { table: 100, index: 11, replica: 12, replicaIndex: 13 }, 'onDemand'),
    };
    delete previous['WriteOnDemandThroughputSettings'];

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    // Absent is not a special case: there is no value to vouch for, so the key
    // goes rather than being kept at a number AWS never received. Removed, not
    // set to `undefined` — a present-but-undefined key survives
    // `structuredClone` and every `Object.keys` walk still sees two key sets.
    expect('WriteOnDemandThroughputSettings' in (result.effectiveProperties ?? {})).toBe(false);
    // The sibling levels still retain, so the drop is scoped to the one key.
    expect(readBack(result.effectiveProperties, 'onDemand').index).toEqual({
      MaxWriteRequestUnits: 11,
    });
  });

  it('RETAINS a block the template REMOVED, so a later removal stays derivable', async () => {
    // The direction `.claude/rules/providers.md` calls out for the UPDATE row:
    // dropping instead would leave a later template that removes the block
    // deriving no removal, and the live setting would survive forever. Nothing
    // was sent here (the reset arm is mode-gated too), so AWS still holds it.
    liveTable('PROVISIONED');
    const desired: Record<string, unknown> = {
      ...bag('', { table: 500, index: 55, replica: 44, replicaIndex: 22 }, 'onDemand'),
    };
    delete desired['WriteOnDemandThroughputSettings'];
    const previous = bag(
      'PROVISIONED',
      { table: 100, index: 11, replica: 12, replicaIndex: 13 },
      'onDemand'
    );

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    expect(result.effectiveProperties?.['WriteOnDemandThroughputSettings']).toEqual({
      MaxWriteRequestUnits: 100,
    });
  });

  it('matches the previous entry by IndexName / Region rather than by position', async () => {
    // AWS does not guarantee readback order and a template edit can reorder
    // either list, so a positional retain would attach one index's ceiling to
    // another. The previous record lists the two indexes in the OTHER order and
    // names a replica region the desired side does not carry at all.
    liveTable('PROVISIONED');
    const desired = {
      TableName: TABLE_NAME,
      KeySchema: KEY_SCHEMA,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingMode: '',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'g1',
          KeySchema: KEY_SCHEMA,
          Projection: PROJECTION,
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 1 },
        },
        {
          IndexName: 'g2',
          KeySchema: KEY_SCHEMA,
          Projection: PROJECTION,
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 2 },
        },
      ],
      Replicas: [{ Region: 'us-east-1' }],
    };
    const previous = {
      ...desired,
      BillingMode: 'PROVISIONED',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'g2',
          KeySchema: KEY_SCHEMA,
          Projection: PROJECTION,
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 22 },
        },
        {
          IndexName: 'g1',
          KeySchema: KEY_SCHEMA,
          Projection: PROJECTION,
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 11 },
        },
      ],
    };

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    const indexes = (result.effectiveProperties?.['GlobalSecondaryIndexes'] ??
      []) as Array<Record<string, unknown>>;
    expect(indexes.map((g) => [g['IndexName'], g['WriteOnDemandThroughputSettings']])).toEqual([
      ['g1', { MaxWriteRequestUnits: 11 }],
      ['g2', { MaxWriteRequestUnits: 22 }],
    ]);
  });

  // ─── Fences ─────────────────────────────────────────────────────────────

  it('does NOT retain anything when the desired BillingMode is USABLE', async () => {
    // The whole pass rides the suppression. A usable mode means the capacity
    // calls were decided normally, so folding the previous side in would
    // manufacture exactly the phantom drift it exists to remove.
    liveTable('PROVISIONED');
    const desired = bag(
      'PROVISIONED',
      { table: 500, index: 55, replica: 44, replicaIndex: 22 },
      'onDemand'
    );
    const previous = bag(
      'PROVISIONED',
      { table: 100, index: 11, replica: 12, replicaIndex: 13 },
      'onDemand'
    );

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    expect(result.effectiveProperties).toBeUndefined();
  });

  it('does NOT mutate the previous record it retains from', async () => {
    // `rollback-executor.ts` spreads the answer shallowly and the caller still
    // holds the bag it handed in, so an in-place edit would corrupt a live
    // state record.
    liveTable('PROVISIONED');
    const desired = bag('', { table: 500, index: 55, replica: 44, replicaIndex: 22 }, 'onDemand');
    const previous = bag(
      'PROVISIONED',
      { table: 100, index: 11, replica: 12, replicaIndex: 13 },
      'onDemand'
    );
    const previousSnapshot = structuredClone(previous);

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    expect(previous).toEqual(previousSnapshot);
    // ...and the retained block is a COPY, not an alias into the caller's bag.
    expect(result.effectiveProperties?.['WriteOnDemandThroughputSettings']).not.toBe(
      previous['WriteOnDemandThroughputSettings']
    );
  });
});
