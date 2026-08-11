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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const TABLE_NAME = 'my-test-table-xxx';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-test-table-xxx';

/**
 * The `||` spelling of the malformed-value defaulting class (issue #1545), on
 * `AWS::DynamoDB::Table` — the sibling of the GlobalTable guard PR #1542
 * shipped for the `??` spelling.
 *
 * `BillingMode || 'PROVISIONED'` reads correctly and is wrong for a
 * present-but-unusable value: `BillingMode: null` (an `Fn::If` the resolver
 * could not resolve, a hand-authored L1 typo) substitutes PROVISIONED on a
 * template that says PAY_PER_REQUEST, silently creating a continuously-billed
 * table with no error anywhere.
 *
 * Per-site decisions, following the PR #1542 precedent:
 *
 * - `BillingMode` is ENUM-valued, so it does NOT take `coerceNumber` — a
 *   number here is a template bug, not the unquoted-YAML scalar CFn coerces.
 * - THROW on a template-path create, WARN on a state replay (`replayWarn`) and
 *   on the update path, which is a replay path unconditionally.
 * - An UNUSABLE desired value on update falls back to the PREVIOUS billing
 *   mode, never the create-path default — a malformed template must not
 *   silently re-price a live table.
 * - The `previousProperties` sibling stays unguarded: that side comes from
 *   cdkd STATE, and refusing a value an older binary recorded would make the
 *   stack permanently un-updatable with no template-side remedy.
 */
describe('DynamoDBTableProvider malformed BillingMode (issue #1545)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBTableProvider();
  });

  const baseProps = {
    TableName: TABLE_NAME,
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  };

  const activeTable = () =>
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
      },
    });

  const commandNames = () => mockSend.mock.calls.map((c) => c[0].constructor.name);

  const billingUpdateCalls = () =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .filter((c) => c[0].input.BillingMode !== undefined);

  // ─── CREATE: refuse ────────────────────────────────────────────────────

  it.each([
    ['null', null, 'null'],
    ['a blank string', '', 'a blank string'],
    ['a number', 5, 'a number'],
    ['an object', { Ref: 'Unresolved' }, 'an object'],
    ['an array', ['PAY_PER_REQUEST'], 'an array'],
  ])(
    'refuses %s on create instead of silently deploying a PROVISIONED table',
    async (_label, value, described) => {
      activeTable();

      await expect(
        provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, BillingMode: value })
      ).rejects.toThrow(
        new RegExp(
          `AWS::DynamoDB::Table BillingMode must be a non-empty string \\(got ${described}\\)`
        )
      );

      // The refusal must land BEFORE CreateTable, never after a real table
      // exists — the whole point of a pre-flight refusal.
      expect(commandNames()).not.toContain('CreateTableCommand');
    }
  );

  it('surfaces the create refusal as a ProvisioningError, not a bare Error', async () => {
    activeTable();
    // The read sits inside `create()`'s try, so the existing catch wraps the
    // refusal into the typed error the deploy engine expects.
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
    ).rejects.toThrow(/Omit the field entirely to use the default \(PROVISIONED\)/);
  });

  // ─── CREATE: still default / pass through ──────────────────────────────

  it('still defaults an ABSENT BillingMode to PROVISIONED', async () => {
    activeTable();

    await provider.create('MyTable', RESOURCE_TYPE, { ...baseProps });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateTableCommand'
    );
    expect(createCall?.[0].input.BillingMode).toBe('PROVISIONED');
    // The PROVISIONED default carries the default capacity block too.
    expect(createCall?.[0].input.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    });
  });

  it('passes an explicit PAY_PER_REQUEST through unchanged, with no capacity block', async () => {
    activeTable();

    await provider.create('MyTable', RESOURCE_TYPE, {
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
    });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateTableCommand'
    );
    expect(createCall?.[0].input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(createCall?.[0].input).not.toHaveProperty('ProvisionedThroughput');
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
    expect(createCall?.[0].input.BillingMode).toBe('PROVISIONED');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::Table BillingMode must be a non-empty string')
    );
  });

  it('keeps the refusal when the context is present but carries no replay flag', async () => {
    activeTable();

    // `replayWarn` tests `=== true`, so an empty context bag is an ordinary
    // create. Pinned so a future `!== false` refactor cannot silently turn
    // every context-carrying create into a warn.
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, BillingMode: null }, {})
    ).rejects.toThrow(/AWS::DynamoDB::Table BillingMode must be a non-empty string/);
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
    ).rejects.toThrow(/AWS::DynamoDB::Table BillingMode must be a non-empty string/);
  });

  // ─── UPDATE: warn, never throw; fall back to the PREVIOUS mode ─────────

  it.each([
    ['null', null],
    ['a blank string', ''],
    ['a number', 5],
    ['an object', { Ref: 'Unresolved' }],
    ['an array', ['PAY_PER_REQUEST']],
  ])(
    'an UNUSABLE desired value (%s) must NOT flip a live PROVISIONED table',
    async (_label, value) => {
      activeTable();

      // The consequential arm: before the guard existed a truthy junk value
      // flowed into `UpdateTable` and AWS REJECTED it (loud, billing
      // unchanged) while a falsy one silently issued a bogus empty
      // UpdateTable. Falling back to the create-path default instead would
      // make the flip REAL — a malformed template silently re-pricing a
      // production table with only a warn to show for it.
      await expect(
        provider.update(
          'MyTable',
          TABLE_NAME,
          RESOURCE_TYPE,
          { ...baseProps, BillingMode: value },
          { ...baseProps, BillingMode: 'PROVISIONED' }
        )
      ).resolves.toBeDefined();

      expect(billingUpdateCalls()).toHaveLength(0);
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('AWS::DynamoDB::Table BillingMode must be a non-empty string')
      );
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("The table's current billing mode (PROVISIONED) is kept")
      );
    }
  );

  it('handles an unusable desired value with NO previous mode on record', async () => {
    activeTable();

    // prevBillingMode === undefined + unusable desired: the fallback is
    // undefined, the comparison reads "unchanged", and the warn renders
    // without the parenthesized mode.
    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, BillingMode: '' },
        { ...baseProps }
      )
    ).resolves.toBeDefined();

    expect(billingUpdateCalls()).toHaveLength(0);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("The table's current billing mode is kept")
    );
  });

  it('keeps the PREVIOUS mode (not the default) when an unusable value rides a capacity change', async () => {
    activeTable();

    // With a real ProvisionedThroughput change alongside the junk value, the
    // UpdateTable DOES fire — and its BillingMode must be the previous
    // PROVISIONED (the re-assert the well-formed path also sends), never a
    // default-driven flip.
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        BillingMode: null,
        ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
      },
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      }
    );

    const updates = billingUpdateCalls();
    expect(updates).toHaveLength(1);
    expect(updates[0][0].input.BillingMode).toBe('PROVISIONED');
    expect(updates[0][0].input.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 10,
      WriteCapacityUnits: 10,
    });
  });

  it('a well-formed flip still reaches AWS', async () => {
    activeTable();

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps, BillingMode: 'PROVISIONED' }
    );

    const updates = billingUpdateCalls();
    expect(updates).toHaveLength(1);
    expect(updates[0][0].input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::Table BillingMode')
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
        { ...baseProps, BillingMode: 'PROVISIONED' },
        { ...baseProps, BillingMode: null }
      )
    ).resolves.toBeDefined();

    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::Table BillingMode')
    );
    // The well-formed desired mode still goes out.
    const updates = billingUpdateCalls();
    expect(updates).toHaveLength(1);
    expect(updates[0][0].input.BillingMode).toBe('PROVISIONED');
  });

  it('an ABSENT desired value is not treated as unusable', async () => {
    activeTable();

    // Absence means "no flip requested" in this provider (no BillingMode
    // FIELD is sent — the removal itself still emits an UpdateTable carrying
    // no mutable field, the pre-existing #1160-class behavior this suite
    // deliberately does not change; tracked in issue #1553), and it must
    // keep meaning that — the suppression is scoped to present-but-unusable
    // ONLY.
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps },
      { ...baseProps, BillingMode: 'PROVISIONED' }
    );

    expect(billingUpdateCalls()).toHaveLength(0);
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::Table BillingMode')
    );
  });

  it('does not warn on a no-op update', async () => {
    activeTable();

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: 'PROVISIONED' },
      { ...baseProps, BillingMode: 'PROVISIONED' }
    );

    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::Table BillingMode')
    );
    expect(billingUpdateCalls()).toHaveLength(0);
  });
});
