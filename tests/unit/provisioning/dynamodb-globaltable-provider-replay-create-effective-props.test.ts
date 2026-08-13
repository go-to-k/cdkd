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

import {
  DynamoDBGlobalTableProvider,
  stripProvisionedCapacityKeys,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

/**
 * The two replay-CREATE `effectiveProperties` arms `DynamoDBGlobalTableProvider`
 * left unanswered after issue #1683 / PR #1722:
 *
 * - issue #1724 — the `GlobalSecondaryIndexes` downgrade OMITS the block, so
 *   `CreateTable` carries no indexes while the engine recorded the malformed
 *   desired blob. Nothing was applied, so the answer is DROP the key (the
 *   `.claude/rules/providers.md` replay-CREATE + SKIP row).
 * - issue #1726 — the `BillingMode` warn-and-SUBSTITUTE arm rewrote only
 *   `BillingMode`, although sending PAY_PER_REQUEST ALSO skips every
 *   PROVISIONED-only capacity member. Those keys stayed recorded although
 *   nothing sent them, which is the same permanent phantom drift the arm exists
 *   to remove, one key over.
 *
 * Both are only reachable through the rollback executor's reverse-replacement
 * create (`CreateContext.replayingState`), which HONOURS `effectiveProperties`
 * as of issue #1682.
 */
describe('DynamoDBGlobalTableProvider replay-CREATE effectiveProperties (issues #1724 / #1726)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBGlobalTableProvider();
    mockSend.mockResolvedValue({ Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' } });
  });

  /** What actually went on the wire — the half an effectiveProperties-only
   *  assertion cannot see. Without it, an arm that stopped OMITTING and started
   *  substituting would leave this file green. */
  const createInput = () =>
    mockSend.mock.calls.find((c) => c[0].constructor.name === 'CreateTableCommand')?.[0]
      .input as Record<string, unknown>;

  const baseProps = {
    TableName: TABLE_NAME,
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    Replicas: [{ Region: 'us-east-1' }],
  };

  const replayCreate = (props: Record<string, unknown>) =>
    provider.create('MyTable', RESOURCE_TYPE, props, { replayingState: true });

  // ─── issue #1724: the GSI omit DROPS the key ──────────────────────────

  it('DROPS GlobalSecondaryIndexes from the effective bag when the block was omitted', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: 'bad',
    });

    // The key is REMOVED, not set to `[]` / `undefined`: a present-but-undefined
    // key survives `structuredClone` and every `Object.keys` consumer (the
    // `unionWalkObjects` drift path) still sees two different key sets.
    expect(result.effectiveProperties).toBeDefined();
    expect('GlobalSecondaryIndexes' in result.effectiveProperties!).toBe(false);
    // Every other declared key is preserved — this replaces the desired bag
    // WHOLESALE, so an incomplete answer would blank the record.
    expect(result.effectiveProperties).toMatchObject({
      TableName: TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('also drops the LOCAL replica index block, keeping the rest of the entry', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: 'bad',
      Replicas: [
        {
          Region: 'us-east-1',
          Tags: [{ Key: 'k', Value: 'v' }],
          GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
        },
      ],
    });

    // The local replica's index block is NOT a separate send path — it is only
    // a capacity SOURCE that `toSdkGlobalSecondaryIndexes` reads through
    // `localByName`, and that call returned the EMPTY list. `readCurrentState`
    // attaches it only when the live table HAS indexes, so on a zero-index
    // table a retained block is the same never-matchable record the top-level
    // drop exists to remove, one level down.
    //
    // Everything else on the entry survives — the drop is per-KEY, and a
    // replica-wide sweep would discard tags the create really did send.
    expect(result.effectiveProperties?.['Replicas']).toEqual([
      { Region: 'us-east-1', Tags: [{ Key: 'k', Value: 'v' }] },
    ]);
  });

  it('reports NO effective bag when the GSI blob is VALID on a replay', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });

    // Absent means "record the desired properties" — the arm must not fire on
    // a well-formed bag.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('keeps the GSI refusal on a TEMPLATE-path create, recording nothing', async () => {
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, {
        ...baseProps,
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: 'bad',
      })
    ).rejects.toThrow(/GlobalSecondaryIndexes must be an array/);
  });

  // ─── issue #1741: the omit must PRUNE the orphaned AttributeDefinitions ──

  /**
   * The shape the omit arm actually fails on, and the reason the fixture that
   * found it has to key its index on the table's own partition key. DynamoDB
   * requires `AttributeDefinitions` to be EXACTLY the attributes referenced by
   * `KeySchema` and by the indexes being created, so omitting the indexes
   * while still sending `gsipk` earns:
   *
   *   ValidationException: One or more parameter values were invalid: Some
   *   AttributeDefinitions are not used. AttributeDefinitions: [pk, gsipk],
   *   KeySchema: [pk]
   *
   * Measured us-east-1 2026-08-13 on run 3 of
   * `tests/integration/rollback-replay-effective-props/`.
   */
  const ORPHANING_PROPS = {
    ...baseProps,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'gsipk', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: 'bad',
  };

  it('prunes the omitted indexes key attribute off the CreateTable call', async () => {
    await replayCreate(ORPHANING_PROPS);

    // The WIRE assertion is the one that matters — this is a real AWS
    // rejection, and every mock in this file returns success, which is exactly
    // why unit tests could not see it before.
    expect(createInput()?.['AttributeDefinitions']).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
    ]);
    expect(createInput()?.['GlobalSecondaryIndexes']).toBeUndefined();
  });

  it('records the PRUNED AttributeDefinitions, not the declared list', async () => {
    const result = await replayCreate(ORPHANING_PROPS);

    // Same reason the index key itself is dropped (#1724): an attribute
    // definition that was not SENT is a record `readCurrentState` can never
    // match, which the next update reads as its previous side.
    expect(result.effectiveProperties?.['AttributeDefinitions']).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
    ]);
    expect('GlobalSecondaryIndexes' in result.effectiveProperties!).toBe(false);
  });

  it('KEEPS an LSI key attribute, which the same create still sends', async () => {
    // `LocalSecondaryIndexes` is create-only and is NOT omitted by this arm, so
    // a naive "keep only the table KeySchema" prune would strip `lsisk` and
    // break the call in the opposite direction.
    const result = await replayCreate({
      ...ORPHANING_PROPS,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'gsipk', AttributeType: 'S' },
        { AttributeName: 'lsisk', AttributeType: 'S' },
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: 'lsi1',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'lsisk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });

    const expected = [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'lsisk', AttributeType: 'S' },
    ];
    expect(createInput()?.['AttributeDefinitions']).toEqual(expected);
    expect(result.effectiveProperties?.['AttributeDefinitions']).toEqual(expected);
  });

  it('leaves AttributeDefinitions untouched when the omit orphans nothing', async () => {
    // The fixture's own workaround shape — an index keyed on the table's own
    // partition key. Nothing is orphaned, so both the wire and the record must
    // carry the DECLARED list verbatim.
    //
    // The key is still PRESENT in the effective bag, and that is not the prune
    // firing: the bag replaces the desired properties WHOLESALE, so it carries
    // every declared key whether or not this arm touched it. Asserting the
    // VALUE is what discriminates — an assertion on presence alone would pass
    // against a prune that had stripped `pk` too.
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: 'bad',
    });

    const declared = [{ AttributeName: 'pk', AttributeType: 'S' }];
    expect(createInput()?.['AttributeDefinitions']).toEqual(declared);
    expect(result.effectiveProperties?.['AttributeDefinitions']).toEqual(declared);
  });

  it('does NOT prune on a create whose GSI block is valid', async () => {
    await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'gsipk', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });

    // `gsipk` is genuinely referenced here, so the definitions go out whole.
    expect(createInput()?.['AttributeDefinitions']).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'gsipk', AttributeType: 'S' },
    ]);
  });

  it('fails OPEN on a NON-ARRAY AttributeDefinitions instead of throwing a raw TypeError', async () => {
    // A single state record can carry MORE than one malformed value — the arm's
    // own comment says the three replay arms compose for exactly that reason —
    // so `AttributeDefinitions` can be junk on the very path the prune runs on.
    // `.filter` on a non-array throws a raw TypeError OUTSIDE any try, which
    // would escape untyped into the deploy engine's retry loop; before the
    // prune existed this input simply reached AWS and came back as a
    // ValidationException.
    await expect(
      replayCreate({
        ...baseProps,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: 'bad',
        GlobalSecondaryIndexes: 'bad',
      })
    ).resolves.toBeDefined();

    // ...and the junk still goes on the wire, which is the pre-fix behavior the
    // fail-open arm deliberately preserves.
    expect(createInput()?.['AttributeDefinitions']).toBe('bad');
  });

  it('leaves a NON-OBJECT definition entry alone rather than silently pruning it', async () => {
    // A malformed ENTRY is not an orphan — cdkd cannot read its AttributeName,
    // so it cannot know whether some key schema references it. Dropping it
    // would be a silent loss on the strength of a value that was never parsed,
    // which is the class the provider rules exist to refuse.
    await replayCreate({
      ...ORPHANING_PROPS,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, 'junk'],
    });

    expect(createInput()?.['AttributeDefinitions']).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
      'junk',
    ]);
  });

  it('KEEPS a CROSS-REGION replica index block while dropping the LOCAL one', async () => {
    // The fence for the region guard the omit arm relies on. A cross-region
    // block has its OWN send path (`toSdkReplicaGlobalSecondaryIndexes`, wired
    // after CreateTable), so withdrawing it would record a loss that did not
    // happen; the LOCAL block is only a capacity source for the translation
    // that returned empty. Without this case, deleting the region guard so BOTH
    // are dropped passes the entire suite.
    //
    // A cross-region replica makes `create()` run `addReplica`, which polls
    // until the replica reports ACTIVE — the file's blanket mock returns a
    // Table with no `Replicas`, so the waiter would never settle.
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableStatus: 'ACTIVE',
        Replicas: [
          { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
          { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
        ],
      },
    });

    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: 'bad',
      Replicas: [
        { Region: 'us-east-1', GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }] },
        { Region: 'eu-west-1', GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }] },
      ],
    });

    const replicas = result.effectiveProperties?.['Replicas'] as Record<string, unknown>[];
    expect(replicas.find((r) => r['Region'] === 'us-east-1')).toEqual({ Region: 'us-east-1' });
    expect(replicas.find((r) => r['Region'] === 'eu-west-1')).toEqual({
      Region: 'eu-west-1',
      GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
    });
  });

  it('COMPOSES with the sibling BillingMode arm on one record', async () => {
    // The arms compose via `?? properties`, and a single-arm fixture cannot
    // tell a composed answer from one that overwrote its predecessor.
    const result = await replayCreate({
      ...ORPHANING_PROPS,
      BillingMode: '',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 25 },
    });

    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
    expect(result.effectiveProperties?.['AttributeDefinitions']).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
    ]);
    expect('GlobalSecondaryIndexes' in result.effectiveProperties!).toBe(false);
  });

  it('prunes to an EMPTY list when nothing the call keys on is defined', async () => {
    // Reachable, and shipped deliberately: AWS rejects an empty
    // AttributeDefinitions just as it rejects the orphaned one, so the prune is
    // not making anything worse. Pinned because a future `length > 0` guard
    // would flip this silently, and the fail-open comment above covers the
    // unreadable-KeySchema case rather than this one.
    const result = await replayCreate({
      ...ORPHANING_PROPS,
      AttributeDefinitions: [{ AttributeName: 'gsipk', AttributeType: 'S' }],
    });

    expect(createInput()?.['AttributeDefinitions']).toEqual([]);
    expect(result.effectiveProperties?.['AttributeDefinitions']).toEqual([]);
  });

  it('records a DISTINCT array from the one it puts on the wire', async () => {
    // The rollback executor spreads the effective bag shallowly, so aliasing
    // would let a later mutation of either side reach the other. Without this
    // case, replacing the copy with the same reference passes the whole suite.
    const result = await replayCreate(ORPHANING_PROPS);

    const wire = createInput()?.['AttributeDefinitions'];
    const recorded = result.effectiveProperties?.['AttributeDefinitions'];
    expect(recorded).toEqual(wire);
    expect(recorded).not.toBe(wire);
  });

  it('fails OPEN when the KeySchema resolves to no attribute name', async () => {
    // An intrinsic-valued / malformed `KeySchema` means the prune has nothing
    // to keep, and stripping EVERY definition would turn a template defect
    // into a different, more confusing AWS error. Pre-fix behavior stands and
    // AWS still rejects the genuinely-bad call loudly.
    await replayCreate({
      ...ORPHANING_PROPS,
      KeySchema: [{ AttributeName: { Ref: 'SomeParam' }, KeyType: 'HASH' }],
    });

    expect(createInput()?.['AttributeDefinitions']).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'gsipk', AttributeType: 'S' },
    ]);
  });

  // ─── issue #1726: the BillingMode substitution strips capacity keys ────

  it('records the SUBSTITUTED BillingMode and strips the top-level provisioned block', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 25 },
    });

    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
    // `createParams.ProvisionedThroughput` is skipped entirely under the
    // substituted mode, and `readCurrentState` emits `{}` here — so recording
    // `{ WriteCapacityUnits: 25 }` is a value AWS never received.
    expect('WriteProvisionedThroughputSettings' in result.effectiveProperties!).toBe(false);
  });

  it('strips the per-replica and per-index provisioned capacity blocks', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 7 },
        },
      ],
      Replicas: [
        {
          Region: 'us-east-1',
          ReadProvisionedThroughputSettings: { ReadCapacityUnits: 11 },
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              ReadProvisionedThroughputSettings: { ReadCapacityUnits: 13 },
            },
          ],
        },
      ],
    });

    const indexes = result.effectiveProperties?.['GlobalSecondaryIndexes'] as Array<
      Record<string, unknown>
    >;
    expect('WriteProvisionedThroughputSettings' in indexes[0]!).toBe(false);
    // The rest of the index entry is untouched — the strip is per MEMBER, not
    // per entry.
    expect(indexes[0]).toMatchObject({ IndexName: 'gsi1', Projection: { ProjectionType: 'ALL' } });

    const replicas = result.effectiveProperties?.['Replicas'] as Array<Record<string, unknown>>;
    expect('ReadProvisionedThroughputSettings' in replicas[0]!).toBe(false);
    // The replica index entry existed ONLY to carry the capacity override, so
    // once that is stripped the whole key goes: an entry reduced to a bare
    // `IndexName` is a husk `readCurrentState` never emits (it attaches the key
    // only for entries with more than `IndexName`), and leaving it behind
    // re-creates the phantom drift one level down. Measured live.
    expect('GlobalSecondaryIndexes' in replicas[0]!).toBe(false);
  });

  it('PRESERVES the on-demand ceilings, which the substituted mode does send', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 100 },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 50 },
        },
      ],
      Replicas: [
        {
          Region: 'us-east-1',
          ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 200 },
        },
      ],
    });

    // `OnDemandThroughput` is attached to CreateTable precisely when the mode
    // is NOT PROVISIONED, so these WERE sent. A blanket "strip every throughput
    // key" would pass every assertion above and fail here.
    expect(result.effectiveProperties?.['WriteOnDemandThroughputSettings']).toEqual({
      MaxWriteRequestUnits: 100,
    });
    const indexes = result.effectiveProperties?.['GlobalSecondaryIndexes'] as Array<
      Record<string, unknown>
    >;
    expect(indexes[0]!['WriteOnDemandThroughputSettings']).toEqual({ MaxWriteRequestUnits: 50 });
    const replicas = result.effectiveProperties?.['Replicas'] as Array<Record<string, unknown>>;
    expect(replicas[0]!['ReadOnDemandThroughputSettings']).toEqual({ MaxReadRequestUnits: 200 });
  });

  it('reports NO effective bag when BillingMode is VALID, even if capacity keys are present', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PROVISIONED',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 25 },
    });

    // Nothing was substituted, so the provisioned block really was sent and
    // must stay recorded. Stripping unconditionally would erase a live value.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('sends NO indexes on the wire when the GSI blob was malformed', async () => {
    await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: 'bad',
    });
    // The drop's whole justification is "CreateTable carried no indexes".
    expect(createInput()['GlobalSecondaryIndexes']).toBeUndefined();
  });

  it('sends NO ProvisionedThroughput on the wire when the mode was substituted', async () => {
    await replayCreate({
      ...baseProps,
      BillingMode: '',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 25 },
    });
    expect(createInput()['ProvisionedThroughput']).toBeUndefined();
    expect(createInput()['BillingMode']).toBe('PAY_PER_REQUEST');
  });

  it('strips the LEGACY SDK-shaped capacity spellings a pre-#1387 record carries', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          // The translator reads both only under PROVISIONED, so neither was
          // sent — and `readCurrentState` emits neither, so both are phantom.
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 3 },
          ReadProvisionedThroughputSettings: { ReadCapacityUnits: 3 },
        },
      ],
      Replicas: [
        {
          Region: 'us-east-1',
          ProvisionedThroughputOverride: { ReadCapacityUnits: 3 },
          GlobalSecondaryIndexes: [
            { IndexName: 'gsi1', ProvisionedThroughputOverride: { ReadCapacityUnits: 3 } },
          ],
        },
      ],
    });

    const gsi = (result.effectiveProperties?.['GlobalSecondaryIndexes'] as Record<
      string,
      unknown
    >[])[0]!;
    expect('ProvisionedThroughput' in gsi).toBe(false);
    expect('ReadProvisionedThroughputSettings' in gsi).toBe(false);
    const replica = (result.effectiveProperties?.['Replicas'] as Record<string, unknown>[])[0]!;
    expect('ProvisionedThroughputOverride' in replica).toBe(false);
    // Both members stripped leaves a bare-`IndexName` husk, which is dropped.
    expect('GlobalSecondaryIndexes' in replica).toBe(false);
  });

  it('strips capacity on the ABSENT-BillingMode replay sibling WITHOUT inventing a mode', async () => {
    const desired = { ...baseProps, WriteProvisionedThroughputSettings: { WriteCapacityUnits: 9 } };
    delete (desired as Record<string, unknown>)['BillingMode'];

    const result = await replayCreate(desired);

    // Same unsent capacity as the substitute arm, so the same strip...
    expect('WriteProvisionedThroughputSettings' in result.effectiveProperties!).toBe(false);
    // ...but the record must NOT gain a BillingMode it never had: whether an
    // absent recorded mode may be materialized is issue #1733's question.
    expect('BillingMode' in result.effectiveProperties!).toBe(false);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('declares no BillingMode')
    );
  });

  it('reports NO effective bag for an absent BillingMode on a TEMPLATE-path create', async () => {
    const desired = { ...baseProps, WriteProvisionedThroughputSettings: { WriteCapacityUnits: 9 } };
    delete (desired as Record<string, unknown>)['BillingMode'];

    const result = await provider.create('MyTable', RESOURCE_TYPE, desired);

    // The arm is gated on the replay downgrade existing at all — an ordinary
    // template create that omits BillingMode is declaring the default, not
    // replaying a lossy record.
    expect(result.effectiveProperties).toBeUndefined();
  });

  // ─── both arms in ONE create ──────────────────────────────────────────

  it('composes the BillingMode strip and the GSI drop when a record carries both', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 25 },
      GlobalSecondaryIndexes: 'bad',
    });

    // The GSI arm runs LAST and must compose onto the BillingMode arm's bag
    // (`?? properties`) rather than overwrite it.
    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
    expect('WriteProvisionedThroughputSettings' in result.effectiveProperties!).toBe(false);
    expect('GlobalSecondaryIndexes' in result.effectiveProperties!).toBe(false);
  });
});

describe('stripProvisionedCapacityKeys (issue #1726)', () => {
  it('does NOT mutate the caller bag or its nested containers', () => {
    const replicaIndex = { IndexName: 'gsi1', ReadProvisionedThroughputSettings: { x: 1 } };
    const replica = {
      Region: 'us-east-1',
      ReadProvisionedThroughputSettings: { y: 2 },
      GlobalSecondaryIndexes: [replicaIndex],
    };
    const index = { IndexName: 'gsi1', WriteProvisionedThroughputSettings: { z: 3 } };
    const input = {
      WriteProvisionedThroughputSettings: { w: 4 },
      GlobalSecondaryIndexes: [index],
      Replicas: [replica],
    };

    stripProvisionedCapacityKeys(input);

    // The replay caller's bag IS `previousState.properties`, and the rollback
    // executor spreads the answer shallowly — an in-place edit would corrupt
    // the record the caller still holds.
    expect(input.WriteProvisionedThroughputSettings).toEqual({ w: 4 });
    expect(index.WriteProvisionedThroughputSettings).toEqual({ z: 3 });
    expect(replica.ReadProvisionedThroughputSettings).toEqual({ y: 2 });
    expect(replicaIndex.ReadProvisionedThroughputSettings).toEqual({ x: 1 });
  });

  it('passes non-object array entries through untouched', () => {
    const out = stripProvisionedCapacityKeys({
      GlobalSecondaryIndexes: [null, 'unresolved'],
      Replicas: [null, 42],
    });

    // An unresolved intrinsic must not be rewritten into `{}` — AWS surfaces
    // the real validation error instead.
    expect(out['GlobalSecondaryIndexes']).toEqual([null, 'unresolved']);
    expect(out['Replicas']).toEqual([null, 42]);
  });

  it('KEEPS a replica index entry that still has members beyond IndexName', () => {
    // The husk filter's KEEP arm. Every other row leaves the entry as a bare
    // `IndexName` husk, so `kept.length > 0` was never executed — a filter
    // mutated to drop NON-husk entries (the "deletes real data" direction)
    // left the whole suite green. `ReadOnDemandThroughputSettings` is the
    // realistic survivor: the strip deliberately keeps on-demand members.
    const out = stripProvisionedCapacityKeys({
      Replicas: [
        {
          Region: 'us-east-1',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              ReadProvisionedThroughputSettings: { ReadCapacityUnits: 5 },
              ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 },
            },
            { IndexName: 'gsi2', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 5 } },
          ],
        },
      ],
    });

    const replica = (out['Replicas'] as Record<string, unknown>[])[0]!;
    const indexes = replica['GlobalSecondaryIndexes'] as Record<string, unknown>[];
    // gsi1 survives (its on-demand member is real, and WAS sent); gsi2 was a
    // husk once its only member was stripped.
    expect(indexes).toEqual([
      { IndexName: 'gsi1', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } },
    ]);
  });

  it('passes NON-ARRAY containers through untouched', () => {
    // A state record written by an older binary can carry an unresolved
    // intrinsic here; rewriting it into `{}` would be the silent-drop class
    // this whole family exists to close.
    const input = { Replicas: 'bad', GlobalSecondaryIndexes: {} };
    const out = stripProvisionedCapacityKeys(input);
    expect(out['Replicas']).toBe('bad');
    expect(out['GlobalSecondaryIndexes']).toEqual({});
  });

  it('leaves a bag with no capacity keys structurally unchanged', () => {
    const input = { TableName: 't', Replicas: [{ Region: 'us-east-1' }] };
    expect(stripProvisionedCapacityKeys(input)).toEqual(input);
  });
});
