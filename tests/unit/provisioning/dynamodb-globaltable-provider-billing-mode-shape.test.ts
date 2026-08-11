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
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

/**
 * The TOP-LEVEL half of the `??` defaulting class (issue #1513), on the one
 * site that issue left open — `dynamodb-globaltable-provider.ts` was owned by
 * a parallel lane when the rest of the per-site sweep shipped in PR #1524.
 *
 * `BillingMode ?? 'PAY_PER_REQUEST'` reads correctly and is wrong for a
 * present-but-unusable value: `BillingMode: null` (an `Fn::If` the resolver
 * could not resolve, a hand-authored L1 typo) substitutes ON-DEMAND on a
 * template that says PROVISIONED, and every `ProvisionedThroughput` block
 * below is then dropped by the billing gate with only a diagnostic to show
 * for it.
 *
 * Per-site decisions, following the precedent PR #1524 recorded:
 *
 * - `BillingMode` is ENUM-valued, so it does NOT take `coerceNumber` — a
 *   number here is a template bug, not the unquoted-YAML scalar CFn coerces.
 * - THROW on a template-path create, WARN on a state replay (`replayWarn`) and
 *   on the update path, which is a replay path unconditionally.
 * - The `previousProperties` sibling stays unguarded: that side comes from
 *   cdkd STATE, and refusing a value an older binary recorded would make the
 *   stack permanently un-updatable with no template-side remedy.
 */
describe('DynamoDBGlobalTableProvider malformed BillingMode (issue #1513)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBGlobalTableProvider();
  });

  const baseProps = {
    TableName: TABLE_NAME,
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    Replicas: [{ Region: 'us-east-1' }],
  };

  const activeTable = () =>
    mockSend.mockResolvedValue({ Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' } });

  const createCommandNames = () => mockSend.mock.calls.map((c) => c[0].constructor.name);

  // ─── CREATE: refuse ────────────────────────────────────────────────────

  it.each([
    ['null', null, 'null'],
    ['a blank string', '', 'a blank string'],
    ['a number', 5, 'a number'],
    ['an object', { Ref: 'Unresolved' }, 'an object'],
    ['an array', ['PROVISIONED'], 'an array'],
  ])(
    'refuses %s on create instead of silently deploying an on-demand table',
    async (_label, value, described) => {
      activeTable();

      await expect(
        provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, BillingMode: value })
      ).rejects.toThrow(
        new RegExp(
          `AWS::DynamoDB::GlobalTable BillingMode must be a non-empty string \\(got ${described}\\)`
        )
      );

      // The refusal must land BEFORE CreateTable, never after a real table
      // exists — the whole point of a pre-flight refusal.
      expect(createCommandNames()).not.toContain('CreateTableCommand');
    }
  );

  it('surfaces the create refusal as a ProvisioningError, not a bare Error', async () => {
    activeTable();
    // The read sits OUTSIDE `create()`'s try, so an unwrapped throw would
    // escape untyped into the deploy engine's retry loop — same treatment as
    // the sibling `StreamSpecification` guard in the same method.
    const err = await provider
      .create('MyTable', RESOURCE_TYPE, { ...baseProps, BillingMode: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err).toMatchObject({ resourceType: RESOURCE_TYPE, logicalId: 'MyTable' });
  });

  it('names the field and the way out in the message', async () => {
    activeTable();
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, BillingMode: null })
    ).rejects.toThrow(/Omit the field entirely to use the default \(PAY_PER_REQUEST\)/);
  });

  // ─── CREATE: still default / pass through ──────────────────────────────

  it('still defaults an ABSENT BillingMode to PAY_PER_REQUEST', async () => {
    activeTable();

    await provider.create('MyTable', RESOURCE_TYPE, { ...baseProps });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateTableCommand'
    );
    expect(createCall?.[0].input.BillingMode).toBe('PAY_PER_REQUEST');
  });

  it('passes an explicit PROVISIONED through unchanged', async () => {
    activeTable();

    await provider.create('MyTable', RESOURCE_TYPE, {
      ...baseProps,
      BillingMode: 'PROVISIONED',
      WriteProvisionedThroughputSettings: {
        WriteCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 1 },
      },
      Replicas: [
        {
          Region: 'us-east-1',
          ReadProvisionedThroughputSettings: {
            ReadCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 1 },
          },
        },
      ],
    });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateTableCommand'
    );
    expect(createCall?.[0].input.BillingMode).toBe('PROVISIONED');
    // The billing gate must NOT have dropped the provisioned block — that is
    // the consequence the guard exists to prevent, so assert it positively.
    expect(createCall?.[0].input.ProvisionedThroughput).toBeDefined();
  });

  // ─── CREATE: state replay downgrades to a warning ──────────────────────

  it('WARNS instead of throwing when the create is a state replay', async () => {
    activeTable();

    // `rollback-executor.ts`'s reverse-replacement arm revives the OLD
    // resource from `previousState.properties`. A record written by an older
    // binary can carry the malformed value this guard refuses, and the user
    // has no template-side remedy for a state record — so the refusal must
    // downgrade, per the `CreateContext.replayingState` contract.
    await expect(
      provider.create(
        'MyTable',
        RESOURCE_TYPE,
        { ...baseProps, BillingMode: null },
        { replayingState: true }
      )
    ).resolves.toBeDefined();

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateTableCommand'
    );
    expect(createCall?.[0].input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable BillingMode must be a non-empty string')
    );
  });

  it('keeps the refusal when the context is present but carries no replay flag', async () => {
    activeTable();

    // `replayWarn` tests `=== true`, so an empty context bag is an ordinary
    // create. Pinned so a future `!== false` refactor cannot silently turn
    // every context-carrying create into a warn.
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, BillingMode: null }, {})
    ).rejects.toThrow(/AWS::DynamoDB::GlobalTable BillingMode must be a non-empty string/);
  });

  it('passes a non-canonical enum spelling through, by design', async () => {
    activeTable();

    // The guard is a SHAPE guard, not an enum validator: `requireConfigString`
    // only requires a non-blank string and does not trim. So 'provisioned'
    // reaches AWS verbatim and AWS rejects it — which is the intended division
    // of labour, but worth pinning because every comment here calls the field
    // "enum-valued" and a reader could assume membership is checked.
    await provider.create('MyTable', RESOURCE_TYPE, {
      ...baseProps,
      BillingMode: 'provisioned',
    });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateTableCommand'
    );
    expect(createCall?.[0].input.BillingMode).toBe('provisioned');
  });

  it('keeps the refusal on an ordinary template-path create that passes a context', async () => {
    activeTable();

    // An explicit `replayingState: false` is an ordinary deploy, not a replay
    // — the downgrade is opt-in, so the guard must still fire.
    await expect(
      provider.create(
        'MyTable',
        RESOURCE_TYPE,
        { ...baseProps, BillingMode: null },
        { replayingState: false }
      )
    ).rejects.toThrow(/AWS::DynamoDB::GlobalTable BillingMode must be a non-empty string/);
  });

  // ─── UPDATE: warn, never throw ─────────────────────────────────────────

  it('WARNS and falls back on update rather than stranding a rollback replay', async () => {
    activeTable();

    // `rollback-executor.ts` replays a revert via
    // `provider.update(..., previousState.properties, ...)`, so the DESIRED
    // bag an update sees can itself be a historical state record. A hard
    // refusal there would make the resource not merely un-updatable but
    // UN-ROLLBACKABLE, with only a hand-edit of state.json as a remedy.
    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, BillingMode: null },
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
      )
    ).resolves.toBeDefined();

    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable BillingMode must be a non-empty string')
    );
  });

  it('leaves the PREVIOUS side unguarded, so a malformed state record still deploys', async () => {
    activeTable();

    // The previous side comes from cdkd STATE, never from the template.
    // Guarding it would make a stack whose state an older binary wrote
    // permanently undeployable — editing the CDK code does not help, because
    // the previous side stays malformed until a deploy succeeds.
    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
        { ...baseProps, BillingMode: null }
      )
    ).resolves.toBeDefined();

    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable BillingMode')
    );
  });

  it('an UNUSABLE desired value must NOT flip a live PROVISIONED table to on-demand', async () => {
    activeTable();

    // The consequential arm, and the one the first version of this suite
    // missed: with `previous === desired` there is no flip to observe at all,
    // so a wrong fallback was invisible. Before the guard existed the junk
    // value reached `UpdateTable` and AWS REJECTED it — billing unchanged.
    // Defaulting to PAY_PER_REQUEST would instead make the flip REAL, tearing
    // down the write scalable target and every per-GSI capacity setting on a
    // production table with only a warn.
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: null },
      { ...baseProps, BillingMode: 'PROVISIONED' }
    );

    const billingUpdates = mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .filter((c) => c[0].input.BillingMode !== undefined);
    expect(billingUpdates).toHaveLength(0);

    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("The table's current billing mode (PROVISIONED) is kept")
    );
  });

  it('an ABSENT desired value still flips to the PAY_PER_REQUEST default', async () => {
    activeTable();

    // The suppression above is scoped to present-but-unusable ONLY. A genuinely
    // absent property IS a template-declared flip and must keep working, or the
    // fix would break the ordinary remove-the-property deploy.
    await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, { ...baseProps }, {
      ...baseProps,
      BillingMode: 'PROVISIONED',
    });

    const billingUpdates = mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .filter((c) => c[0].input.BillingMode !== undefined);
    expect(billingUpdates).toHaveLength(1);
    expect(billingUpdates[0][0].input.BillingMode).toBe('PAY_PER_REQUEST');
  });

  it('does not warn on a well-formed update', async () => {
    activeTable();

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
    );

    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable BillingMode')
    );
  });
});
