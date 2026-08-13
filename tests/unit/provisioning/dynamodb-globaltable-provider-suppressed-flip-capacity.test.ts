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
 * The capacity member keys that can only reach AWS under ONE billing mode, per
 * container level — declared here INDEPENDENTLY of the provider's own two
 * tables, so deleting an entry from either makes a row below fail rather than
 * silently narrowing what is audited.
 *
 * The two legacy SDK spellings (`ProvisionedThroughput` /
 * `ProvisionedThroughputOverride` and their on-demand twins) are in the set for
 * the reason the helper's docstring gives: a pre-#1387 cdkd wrote them into
 * state, and a state replay is exactly that population.
 */
const PROVISIONED_ONLY_KEYS = {
  table: ['WriteProvisionedThroughputSettings'],
  index: [
    'WriteProvisionedThroughputSettings',
    'ReadProvisionedThroughputSettings',
    'ProvisionedThroughput',
  ],
  replica: ['ReadProvisionedThroughputSettings', 'ProvisionedThroughputOverride'],
  replicaIndex: ['ReadProvisionedThroughputSettings', 'ProvisionedThroughputOverride'],
} as const;

const ON_DEMAND_ONLY_KEYS = {
  table: ['WriteOnDemandThroughputSettings'],
  index: [
    'WriteOnDemandThroughputSettings',
    'ReadOnDemandThroughputSettings',
    'OnDemandThroughput',
  ],
  replica: ['ReadOnDemandThroughputSettings', 'OnDemandThroughputOverride'],
  replicaIndex: ['ReadOnDemandThroughputSettings', 'OnDemandThroughputOverride'],
} as const;

type Level = keyof typeof PROVISIONED_ONLY_KEYS;
const LEVELS: Level[] = ['table', 'index', 'replica', 'replicaIndex'];

/** The member name(s) each capacity block carries, so a block is never empty. */
const blockFor = (key: string, n: number): Record<string, number> => {
  switch (key) {
    case 'WriteProvisionedThroughputSettings':
      return { WriteCapacityUnits: n };
    case 'ReadProvisionedThroughputSettings':
    case 'ProvisionedThroughputOverride':
      return { ReadCapacityUnits: n };
    case 'ProvisionedThroughput':
      return { ReadCapacityUnits: n, WriteCapacityUnits: n };
    case 'WriteOnDemandThroughputSettings':
      return { MaxWriteRequestUnits: n };
    case 'ReadOnDemandThroughputSettings':
    case 'OnDemandThroughputOverride':
      return { MaxReadRequestUnits: n };
    case 'OnDemandThroughput':
      return { MaxReadRequestUnits: n, MaxWriteRequestUnits: n };
    default:
      throw new Error(`unmapped capacity key ${key}`);
  }
};

/** A stable per-(level, key) offset so every value in a bag is distinct. */
const offsetOf = (level: Level, key: string): number => {
  const provisionedIndex = (PROVISIONED_ONLY_KEYS[level] as readonly string[]).indexOf(key);
  const onDemandIndex = (ON_DEMAND_ONLY_KEYS[level] as readonly string[]).indexOf(key);
  const within = provisionedIndex >= 0 ? provisionedIndex : 4 + onDemandIndex;
  return LEVELS.indexOf(level) * 10 + within + 1;
};

const valueOf = (base: number, level: Level, key: string): number => base + offsetOf(level, key);

/** Every capacity key of BOTH halves, at one container level. */
const blocksAt = (base: number, level: Level): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of [...PROVISIONED_ONLY_KEYS[level], ...ON_DEMAND_ONLY_KEYS[level]]) {
    out[key] = blockFor(key, valueOf(base, level, key));
  }
  return out;
};

/**
 * A bag carrying EVERY capacity member of BOTH halves at all four container
 * levels, plus the non-capacity keys the effective bag must keep intact.
 */
const bag = (billingMode: unknown, base: number): Record<string, unknown> => ({
  TableName: TABLE_NAME,
  KeySchema: KEY_SCHEMA,
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  ...(billingMode !== undefined && { BillingMode: billingMode }),
  ...blocksAt(base, 'table'),
  GlobalSecondaryIndexes: [
    {
      IndexName: 'g1',
      KeySchema: KEY_SCHEMA,
      Projection: PROJECTION,
      ...blocksAt(base, 'index'),
    },
  ],
  Replicas: [
    {
      Region: 'us-east-1',
      ...blocksAt(base, 'replica'),
      GlobalSecondaryIndexes: [{ IndexName: 'g1', ...blocksAt(base, 'replicaIndex') }],
    },
  ],
});

/** Flatten a bag's capacity members into `<level>.<key>` -> block. */
const readBack = (props: Record<string, unknown> | undefined): Record<string, unknown> => {
  const indexes = (props?.['GlobalSecondaryIndexes'] ?? []) as Array<Record<string, unknown>>;
  const replicas = (props?.['Replicas'] ?? []) as Array<Record<string, unknown>>;
  const replicaIndexes = (replicas[0]?.['GlobalSecondaryIndexes'] ?? []) as Array<
    Record<string, unknown>
  >;
  const containers: Record<Level, Record<string, unknown> | undefined> = {
    table: props,
    index: indexes[0],
    replica: replicas[0],
    replicaIndex: replicaIndexes[0],
  };
  const out: Record<string, unknown> = {};
  for (const level of LEVELS) {
    for (const key of [...PROVISIONED_ONLY_KEYS[level], ...ON_DEMAND_ONLY_KEYS[level]]) {
      out[`${level}.${key}`] = containers[level]?.[key];
    }
  }
  return out;
};

/**
 * The map `readBack` must produce when the PROVISIONED half comes from one bag
 * and the ON-DEMAND half from another.
 */
const expectedSplit = (provisionedBase: number, onDemandBase: number): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const level of LEVELS) {
    for (const key of PROVISIONED_ONLY_KEYS[level]) {
      out[`${level}.${key}`] = blockFor(key, valueOf(provisionedBase, level, key));
    }
    for (const key of ON_DEMAND_ONLY_KEYS[level]) {
      out[`${level}.${key}`] = blockFor(key, valueOf(onDemandBase, level, key));
    }
  }
  return out;
};

const DESIRED_BASE = 100;
const PREVIOUS_BASE = 500;

/**
 * The UPDATE-side capacity twin of issue #1726, filed as issue #1738.
 *
 * When an unusable desired `BillingMode` suppresses the flip, the table keeps
 * the mode it already had — and the capacity call belonging to the OTHER mode
 * never fires, because every one of those emissions is gated on the billing
 * mode. The effective bag nevertheless recorded whatever the template declared,
 * so state described capacity AWS never received: a record `readCurrentState`
 * can never match, and one the NEXT update reads as its previous side (the
 * #1552 class).
 *
 * The create-side answer of #1726 does NOT transfer, which is why this arm has
 * its own suite: there the substituted mode is always PAY_PER_REQUEST so the
 * unsendable set is decidable outright, and the resource is NEW so a DROP is
 * right. Here the KEPT mode is resolved at run time and the table already
 * EXISTS, so `.claude/rules/providers.md`'s UPDATE row applies — retain the
 * PREVIOUS value, validated first.
 *
 * Every retain / drop row asserts the WIRE half too, and with a POSITIVE
 * CONTROL: an "and nothing of the other half was sent" assertion holds
 * vacuously over an empty call list, so each row also pins a call that MUST
 * have gone out under the kept mode.
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
   * deliberately differs from every value the fixtures declare — the #1630 skip
   * compares member by member against this snapshot, so matching values would
   * suppress the very GSI update the PROVISIONED rows use as their control.
   */
  const liveTable = (mode?: string) =>
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        ...(mode !== undefined && { BillingModeSummary: { BillingMode: mode } }),
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

  /** Every `ReplicaUpdates[].Update` this update issued. */
  const replicaUpdateActions = (): Array<Record<string, unknown>> =>
    updateInputs()
      .flatMap((i) => (i['ReplicaUpdates'] ?? []) as Array<Record<string, unknown>>)
      .map((u) => u['Update'] as Record<string, unknown> | undefined)
      .filter((u): u is Record<string, unknown> => u !== undefined);

  const sentAnyProvisionedCapacity = (): boolean =>
    updateInputs().some((i) => i['ProvisionedThroughput'] !== undefined) ||
    gsiUpdateActions().some((u) => u['ProvisionedThroughput'] !== undefined) ||
    replicaUpdateActions().some((u) => u['ProvisionedThroughputOverride'] !== undefined);

  const sentAnyOnDemandCapacity = (): boolean =>
    updateInputs().some((i) => i['OnDemandThroughput'] !== undefined) ||
    gsiUpdateActions().some((u) => u['OnDemandThroughput'] !== undefined) ||
    replicaUpdateActions().some((u) => u['OnDemandThroughputOverride'] !== undefined);

  // ─── KEPT mode PROVISIONED: the ON-DEMAND half is what never went out ───

  it('retains the PREVIOUS on-demand half and keeps the DESIRED provisioned half when the kept mode is PROVISIONED', async () => {
    liveTable('PROVISIONED');

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('', DESIRED_BASE),
      bag('PROVISIONED', PREVIOUS_BASE)
    );

    // WIRE, positive control: the provisioned half IS delivered under this mode
    // (step 6's GSI diff), which is what makes the negative assertion below
    // mean something rather than holding over an empty call list. The value is
    // the LEGACY `ProvisionedThroughput` block's, not the CFn-shaped one's,
    // because `mergeExplicitThroughputBlock` merges an explicit SDK-shaped
    // block OVER the derived members — which is exactly the pre-#1387 state
    // shape the retain set includes that key for.
    expect(gsiUpdateActions()).toContainEqual(
      expect.objectContaining({
        IndexName: 'g1',
        ProvisionedThroughput: expect.objectContaining({
          WriteCapacityUnits: valueOf(DESIRED_BASE, 'index', 'ProvisionedThroughput'),
        }),
      })
    );
    // WIRE, negative: nothing on-demand left the process. Step 3's table-level
    // ceiling is gated on `newBilling !== 'PROVISIONED'`, and both translators
    // drop their on-demand branch under PROVISIONED.
    expect(sentAnyOnDemandCapacity()).toBe(false);

    // RECORD: on-demand from the PREVIOUS record, provisioned from the DESIRED
    // template — per member, at all four container levels.
    expect(readBack(result.effectiveProperties)).toEqual(
      expectedSplit(DESIRED_BASE, PREVIOUS_BASE)
    );
  });

  // ─── KEPT mode PAY_PER_REQUEST: the PROVISIONED half never went out ─────

  it('retains the PREVIOUS provisioned half and keeps the DESIRED on-demand half when the kept mode is PAY_PER_REQUEST', async () => {
    liveTable('PAY_PER_REQUEST');

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('', DESIRED_BASE),
      bag('PAY_PER_REQUEST', PREVIOUS_BASE)
    );

    // WIRE, positive control: step 3 sends the table-level ceilings under
    // exactly this mode — both halves, the write one top-level and the read one
    // off the LOCAL replica (issue #1436).
    expect(updateInputs()).toContainEqual(
      expect.objectContaining({
        OnDemandThroughput: {
          MaxReadRequestUnits: valueOf(DESIRED_BASE, 'replica', 'ReadOnDemandThroughputSettings'),
          MaxWriteRequestUnits: valueOf(
            DESIRED_BASE,
            'table',
            'WriteOnDemandThroughputSettings'
          ),
        },
      })
    );
    // WIRE, negative: the table-level `ProvisionedThroughput` rides step 4's
    // flip and nothing else, and both translators drop their provisioned branch
    // under PAY_PER_REQUEST.
    expect(sentAnyProvisionedCapacity()).toBe(false);

    expect(readBack(result.effectiveProperties)).toEqual(
      expectedSplit(PREVIOUS_BASE, DESIRED_BASE)
    );
  });

  // ─── The two fixes INTERACT: #1733 decides WHICH half #1738 keeps ───────

  it.each([
    ['PROVISIONED', DESIRED_BASE, PREVIOUS_BASE],
    ['PAY_PER_REQUEST', PREVIOUS_BASE, DESIRED_BASE],
  ])(
    'seeds the kept mode from the live read on an ABSENT recorded BillingMode (live %s)',
    async (liveMode, provisionedBase, onDemandBase) => {
      // With no recorded mode, issue #1733 resolves the baseline from
      // `DescribeTable` (the desired side DECLARES a mode — malformed, but
      // declared, which is the only way this arm is reached at all). That
      // decides `newBilling`, which decides which half #1738 retains — so the
      // two fixes compose rather than sitting side by side.
      liveTable(liveMode);
      const previous: Record<string, unknown> = bag(undefined, PREVIOUS_BASE);

      const result = await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        bag('', DESIRED_BASE),
        previous
      );

      // The mode itself is DROPPED (the record never carried the key)...
      expect('BillingMode' in (result.effectiveProperties ?? {})).toBe(false);
      // ...but the capacity split still follows the seeded kept mode.
      expect(readBack(result.effectiveProperties)).toEqual(
        expectedSplit(provisionedBase, onDemandBase)
      );
    }
  );

  it('seeds a live table with NO BillingModeSummary as PROVISIONED', async () => {
    // DynamoDB omits the summary for a table created without an explicit mode,
    // and such a table IS provisioned — the reading `liveBillingMode` and the
    // sibling `AWS::DynamoDB::Table` provider already take. Resolving it to
    // this provider's create-path default instead (the first cut of #1733) made
    // the fix inert on its own headline population, since `create()` always
    // sends an explicit mode and only a non-cdkd table lacks a summary.
    liveTable(undefined);

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('', DESIRED_BASE),
      bag(undefined, PREVIOUS_BASE)
    );

    // PROVISIONED kept => the on-demand half is the unsendable one.
    expect(readBack(result.effectiveProperties)).toEqual(
      expectedSplit(DESIRED_BASE, PREVIOUS_BASE)
    );
    expect(sentAnyOnDemandCapacity()).toBe(false);
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
    const previous = {
      ...bag('PROVISIONED', PREVIOUS_BASE),
      WriteOnDemandThroughputSettings: previousBlock,
    };

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('', DESIRED_BASE),
      previous
    );

    expect(result.effectiveProperties).toBeDefined();
    expect('WriteOnDemandThroughputSettings' in (result.effectiveProperties ?? {})).toBe(false);
    // The desired value was not sent either, which is WHY the key goes rather
    // than staying at a number AWS never received.
    expect(sentAnyOnDemandCapacity()).toBe(false);
    // ...and the sibling levels still retain, so the drop is scoped to one key.
    expect(readBack(result.effectiveProperties)['index.WriteOnDemandThroughputSettings']).toEqual(
      blockFor(
        'WriteOnDemandThroughputSettings',
        valueOf(PREVIOUS_BASE, 'index', 'WriteOnDemandThroughputSettings')
      )
    );
  });

  it('ACCEPTS an intrinsic-only previous block, because the wire read does', async () => {
    // The honest bound the helper's docstring states: `asRecord` refuses
    // exactly the not-a-plain-object shapes, and a block whose numeric member is
    // an unresolved intrinsic passes it — correctly, since the wire accepts the
    // block too and then sends nothing for the member, which is the same "AWS
    // keeps what it had" outcome the retention records.
    liveTable('PROVISIONED');
    const intrinsic = { MaxWriteRequestUnits: { Ref: 'SomeParam' } };
    const previous = {
      ...bag('PROVISIONED', PREVIOUS_BASE),
      WriteOnDemandThroughputSettings: intrinsic,
    };

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('', DESIRED_BASE),
      previous
    );

    expect(result.effectiveProperties?.['WriteOnDemandThroughputSettings']).toEqual(intrinsic);
  });

  it.each([
    ['is not an array', 'oops-not-an-array'],
    ['holds a non-object entry', ['oops']],
    ['holds an entry with a non-string IndexName', [{ IndexName: 42, OnDemandThroughput: {} }]],
  ])('DROPS the per-index keys when the previous GlobalSecondaryIndexes %s', async (
    _label,
    previousIndexes
  ) => {
    // Each shape makes the previous COUNTERPART unfindable, which is the ABSENT
    // case rather than a separate one: there is nothing to vouch for, so the
    // key goes.
    liveTable('PROVISIONED');
    const previous = {
      ...bag('PROVISIONED', PREVIOUS_BASE),
      GlobalSecondaryIndexes: previousIndexes,
    };

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('', DESIRED_BASE),
      previous
    );

    const indexes = (result.effectiveProperties?.['GlobalSecondaryIndexes'] ??
      []) as Array<Record<string, unknown>>;
    for (const key of ON_DEMAND_ONLY_KEYS.index) {
      expect(key in (indexes[0] ?? {})).toBe(false);
    }
    // The index itself survives with its non-capacity members intact.
    expect(indexes[0]?.['IndexName']).toBe('g1');
    expect(indexes[0]?.['Projection']).toEqual(PROJECTION);
  });

  it('DROPS the key when the previous record never declared the block', async () => {
    liveTable('PROVISIONED');
    const previous: Record<string, unknown> = { ...bag('PROVISIONED', PREVIOUS_BASE) };
    delete previous['WriteOnDemandThroughputSettings'];

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('', DESIRED_BASE),
      previous
    );

    // Removed, not set to `undefined` — a present-but-undefined key survives
    // `structuredClone` and every `Object.keys` walk still sees two key sets.
    expect('WriteOnDemandThroughputSettings' in (result.effectiveProperties ?? {})).toBe(false);
    expect(sentAnyOnDemandCapacity()).toBe(false);
  });

  it('PRUNES a per-replica index husk the drop leaves behind', async () => {
    // A per-replica index block exists ONLY to carry capacity overrides, and
    // `readCurrentState` attaches `Replicas[].GlobalSecondaryIndexes` only for
    // entries with more than `IndexName` — so an entry emptied down to
    // `{IndexName}` by the drop arm would close one never-matchable shape by
    // opening another. Same husk prune `stripProvisionedCapacityKeys` applies.
    liveTable('PROVISIONED');
    const previous: Record<string, unknown> = { ...bag('PROVISIONED', PREVIOUS_BASE) };
    previous['Replicas'] = [
      // The replica is present (so its own levels still retain) but its index
      // entry carries no on-demand block at all.
      { ...blocksAt(PREVIOUS_BASE, 'replica'), Region: 'us-east-1' },
    ];
    // The DESIRED replica index declares ONLY the on-demand half, so once that
    // is dropped nothing but `IndexName` is left.
    const desired = bag('', DESIRED_BASE);
    (desired['Replicas'] as Array<Record<string, unknown>>)[0]!['GlobalSecondaryIndexes'] = [
      {
        IndexName: 'g1',
        ...Object.fromEntries(
          ON_DEMAND_ONLY_KEYS.replicaIndex.map((k) => [
            k,
            blockFor(k, valueOf(DESIRED_BASE, 'replicaIndex', k)),
          ])
        ),
      },
    ];

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    const replicas = (result.effectiveProperties?.['Replicas'] ?? []) as Array<
      Record<string, unknown>
    >;
    expect('GlobalSecondaryIndexes' in (replicas[0] ?? {})).toBe(false);
  });

  it('RETAINS a block the template REMOVED, so a later removal stays derivable', async () => {
    // The direction `.claude/rules/providers.md` calls out for the UPDATE row:
    // dropping instead would leave a later template that removes the block
    // deriving no removal, and the live setting would survive forever. Nothing
    // was sent here (the reset arm is mode-gated too), so AWS still holds it.
    liveTable('PROVISIONED');
    const desired: Record<string, unknown> = { ...bag('', DESIRED_BASE) };
    delete desired['WriteOnDemandThroughputSettings'];

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      desired,
      bag('PROVISIONED', PREVIOUS_BASE)
    );

    expect(result.effectiveProperties?.['WriteOnDemandThroughputSettings']).toEqual(
      blockFor(
        'WriteOnDemandThroughputSettings',
        valueOf(PREVIOUS_BASE, 'table', 'WriteOnDemandThroughputSettings')
      )
    );
    expect(sentAnyOnDemandCapacity()).toBe(false);
  });

  // ─── Identity matching, not position ────────────────────────────────────

  it('matches the previous entry by IndexName and by Region rather than by position', async () => {
    // AWS does not guarantee readback order and a template edit can reorder
    // either list, so a positional retain would attach one index's — or one
    // REGION's — ceiling to another. The previous record lists both the indexes
    // and the replicas in the OTHER order, and carries an extra replica the
    // desired side does not.
    liveTable('PROVISIONED');
    const gsi = (name: string, n: number) => ({
      IndexName: name,
      KeySchema: KEY_SCHEMA,
      Projection: PROJECTION,
      WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: n },
    });
    const replica = (region: string, n: number) => ({
      Region: region,
      ReadOnDemandThroughputSettings: { MaxReadRequestUnits: n },
      GlobalSecondaryIndexes: [
        { IndexName: 'g1', OnDemandThroughputOverride: { MaxReadRequestUnits: n + 1 } },
        { IndexName: 'g2', OnDemandThroughputOverride: { MaxReadRequestUnits: n + 2 } },
      ],
    });
    const base = {
      TableName: TABLE_NAME,
      KeySchema: KEY_SCHEMA,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    };
    const desired = {
      ...base,
      BillingMode: '',
      GlobalSecondaryIndexes: [gsi('g1', 1), gsi('g2', 2)],
      Replicas: [replica('us-east-1', 10)],
    };
    const previous = {
      ...base,
      BillingMode: 'PROVISIONED',
      // Reversed relative to the desired side.
      GlobalSecondaryIndexes: [gsi('g2', 22), gsi('g1', 11)],
      // Reversed AND carrying a region the desired side does not declare, so a
      // positional read would attach eu-west-1's ceiling to us-east-1.
      Replicas: [replica('eu-west-1', 70), replica('us-east-1', 40)],
    };

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);

    const indexes = (result.effectiveProperties?.['GlobalSecondaryIndexes'] ??
      []) as Array<Record<string, unknown>>;
    expect(indexes.map((g) => [g['IndexName'], g['WriteOnDemandThroughputSettings']])).toEqual([
      ['g1', { MaxWriteRequestUnits: 11 }],
      ['g2', { MaxWriteRequestUnits: 22 }],
    ]);

    const replicas = (result.effectiveProperties?.['Replicas'] ?? []) as Array<
      Record<string, unknown>
    >;
    expect(replicas).toHaveLength(1);
    expect(replicas[0]?.['Region']).toBe('us-east-1');
    expect(replicas[0]?.['ReadOnDemandThroughputSettings']).toEqual({ MaxReadRequestUnits: 40 });
    // ...and one level further down, the per-replica index entries too.
    const replicaIndexes = (replicas[0]?.['GlobalSecondaryIndexes'] ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      replicaIndexes.map((g) => [g['IndexName'], g['OnDemandThroughputOverride']])
    ).toEqual([
      ['g1', { MaxReadRequestUnits: 41 }],
      ['g2', { MaxReadRequestUnits: 42 }],
    ]);
  });

  // ─── Fences ─────────────────────────────────────────────────────────────

  it('returns a COMPLETE bag, not only the keys it touched', async () => {
    // `effectiveProperties` REPLACES the desired bag wholesale, so a version
    // returning just the retained capacity keys would blank the record. Every
    // row above reads only capacity members, so nothing else pins this.
    liveTable('PROVISIONED');
    const desired = bag('', DESIRED_BASE);

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      desired,
      bag('PROVISIONED', PREVIOUS_BASE)
    );

    expect(result.effectiveProperties?.['TableName']).toBe(TABLE_NAME);
    expect(result.effectiveProperties?.['KeySchema']).toEqual(KEY_SCHEMA);
    expect(result.effectiveProperties?.['AttributeDefinitions']).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
    ]);
    const indexes = (result.effectiveProperties?.['GlobalSecondaryIndexes'] ??
      []) as Array<Record<string, unknown>>;
    expect(indexes[0]?.['KeySchema']).toEqual(KEY_SCHEMA);
    expect(indexes[0]?.['Projection']).toEqual(PROJECTION);
    // The key SET matches the desired bag's exactly — nothing added, nothing
    // lost (both halves are declared on both sides in this fixture).
    expect(Object.keys(result.effectiveProperties ?? {}).sort()).toEqual(
      Object.keys(desired).sort()
    );
  });

  it('does NOT retain anything when the desired BillingMode is USABLE', async () => {
    // The whole pass rides the suppression. A usable mode means the capacity
    // calls were decided normally, so folding the previous side in would
    // manufacture exactly the phantom drift it exists to remove.
    liveTable('PROVISIONED');

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('PROVISIONED', DESIRED_BASE),
      bag('PROVISIONED', PREVIOUS_BASE)
    );

    expect(result.effectiveProperties).toBeUndefined();
  });

  it('does NOT mutate the previous record it retains from', async () => {
    // `rollback-executor.ts` spreads the answer shallowly and the caller still
    // holds the bag it handed in, so an in-place edit would corrupt a live
    // state record.
    liveTable('PROVISIONED');
    const previous = bag('PROVISIONED', PREVIOUS_BASE);
    const previousSnapshot = structuredClone(previous);

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      bag('', DESIRED_BASE),
      previous
    );

    expect(previous).toEqual(previousSnapshot);
    // ...and the retained block is a COPY, not an alias into the caller's bag.
    expect(result.effectiveProperties?.['WriteOnDemandThroughputSettings']).not.toBe(
      previous['WriteOnDemandThroughputSettings']
    );
  });
});
