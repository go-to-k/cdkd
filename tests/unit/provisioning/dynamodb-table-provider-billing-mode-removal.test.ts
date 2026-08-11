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

const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const TABLE_NAME = 'my-test-table-xxx';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-test-table-xxx';

/**
 * `AWS::DynamoDB::Table.BillingMode` REMOVAL semantics (issue #1553) — the
 * #1160 absent-field class on a property whose behavior had to be MEASURED
 * rather than inferred from the type default.
 *
 * **Before:** the update path left an absent desired `BillingMode`
 * `undefined`. Against a recorded previous of `PAY_PER_REQUEST` that read as a
 * change, but the `updateInput.BillingMode = …` assignment was gated on the
 * value being truthy — so `UpdateTable({TableName})` went out with NO mutable
 * field and DynamoDB rejected it. Not a silent drop, but a bogus call and a
 * confusing error on every deploy.
 *
 * **The measurement** (live CloudFormation A/B, us-east-1, 2026-08-11, stack
 * `CdkdIssue1553BillingModeAb`):
 *
 * - a table deployed with `BillingMode: PAY_PER_REQUEST`, then UPDATE'd with
 *   the property REMOVED and no `ProvisionedThroughput`, fails the stack:
 *   `UPDATE_FAILED … Property ProvisionedThroughput cannot be empty` ->
 *   `UPDATE_ROLLBACK_COMPLETE`;
 * - the same removal WITH `ProvisionedThroughput: {3, 4}` reaches
 *   `UPDATE_COMPLETE` and the table reads back `PROVISIONED` at 3/4.
 *
 * So CFn RESETS to the type default `PROVISIONED` on removal — it does NOT
 * retain the old mode. That is what `create()` already substituted for an
 * absent value, so the fix is to make the two paths agree.
 */
describe('DynamoDBTableProvider BillingMode removal resets to PROVISIONED (issue #1553)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBTableProvider();
    mockSend.mockResolvedValue({
      Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
    });
  });

  const baseProps = {
    TableName: TABLE_NAME,
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  };

  const updateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  it('flips a PAY_PER_REQUEST table to PROVISIONED with the declared capacity', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } },
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
    );

    expect(updateInputs()).toHaveLength(1);
    expect(updateInputs()[0]).toMatchObject({
      TableName: TABLE_NAME,
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
    });
  });

  it('never emits an UpdateTable carrying no mutable field', async () => {
    // The pre-fix shape: the change was detected, the BillingMode assignment
    // was skipped because the value was `undefined`, and no throughput rode
    // along — so `{TableName}` alone went out and AWS rejected it. The call
    // now always carries the resolved mode; a missing `ProvisionedThroughput`
    // is left to AWS, matching CFn's own handler failure for the same shape.
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps },
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
    );

    expect(updateInputs()).toHaveLength(1);
    expect(updateInputs()[0]).toEqual({ TableName: TABLE_NAME, BillingMode: 'PROVISIONED' });
  });

  it('gives a BillingMode FLIP the long ACTIVE-wait budget, not the 60s default', async () => {
    // Found by the real-AWS re-run of this very fixture: a PAY_PER_REQUEST ->
    // PROVISIONED flip exceeded the 60s budget calibrated on capacity edits
    // and failed the deploy with `did not reach ACTIVE status within 60
    // seconds`, rolling the whole stack back. Invisible before this issue
    // because the removal never produced a valid UpdateTable to wait on.
    let describeCalls = 0;
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'DescribeTableCommand') {
        describeCalls += 1;
        return Promise.resolve({
          Table: {
            TableName: TABLE_NAME,
            TableArn: TABLE_ARN,
            // First DescribeTable is update()'s own read; the table then sits
            // in UPDATING past the 60-poll default before settling.
            TableStatus: describeCalls > 90 ? 'ACTIVE' : 'UPDATING',
            BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          },
        });
      }
      return Promise.resolve({});
    });

    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } },
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
      )
    ).resolves.toBeDefined();

    expect(describeCalls).toBeGreaterThan(60);
  }, 200_000);

  it('is a NO-OP when the previous side never recorded a BillingMode either', async () => {
    // Both sides normalize to PROVISIONED, so a table that never declared the
    // property does not acquire a spurious change on every deploy — the
    // regression a one-sided normalization would have introduced.
    await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, { ...baseProps }, { ...baseProps });

    expect(updateInputs()).toHaveLength(0);
  });

  it('is a NO-OP when the previous side recorded PROVISIONED', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps },
      { ...baseProps, BillingMode: 'PROVISIONED' }
    );

    expect(updateInputs()).toHaveLength(0);
  });

  it('does NOT suppress an EXPLICIT flip against an unrecorded previous mode', async () => {
    // The regression a review caught in the first cut: normalizing an absent
    // recorded previous to the type default compared PROVISIONED against an
    // explicit `BillingMode: PROVISIONED` and suppressed the flip, leaving a
    // live PAY_PER_REQUEST table on-demand forever. When the desired side is
    // EXPLICIT the previous side comes from the LIVE table instead.
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
      },
    });

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
      },
      { ...baseProps }
    );

    expect(updateInputs()).toHaveLength(1);
    expect(updateInputs()[0]).toMatchObject({ BillingMode: 'PROVISIONED' });
  });

  it('sends the resolved mode alongside a capacity change when BOTH sides are absent', async () => {
    // The one wire-shape change that affects existing users: a pure capacity
    // bump on a table that never declared BillingMode now carries
    // `BillingMode: PROVISIONED` too. AWS accepts a re-asserted mode when a
    // capacity change rides along (the shape a template declaring PROVISIONED
    // already produced), so this is the same call one spelling over.
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, ProvisionedThroughput: { ReadCapacityUnits: 9, WriteCapacityUnits: 9 } },
      { ...baseProps, ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } }
    );

    expect(updateInputs()).toHaveLength(1);
    expect(updateInputs()[0]).toMatchObject({
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 9, WriteCapacityUnits: 9 },
    });
  });

  it('does NOT send an on-demand ceiling once the resolved mode is PROVISIONED', async () => {
    // Newly reachable via this issue (review catch): a template that removes
    // BillingMode while KEEPING OnDemandThroughput would flip the table and
    // then send an on-demand ceiling to a provisioned table, which AWS
    // rejects — leaving the flip half-applied.
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
        OnDemandThroughput: { MaxReadRequestUnits: 50 },
      },
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
    );

    expect(updateInputs()).toHaveLength(1);
    expect(updateInputs()[0]?.['OnDemandThroughput']).toBeUndefined();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('OnDemandThroughput is declared but the')
    );
  });

  it('does not re-assert throughput or BillingMode for a TableClass-only change', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
      },
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
      }
    );

    expect(updateInputs()).toHaveLength(1);
    expect(updateInputs()[0]).toEqual({
      TableName: TABLE_NAME,
      TableClass: 'STANDARD_INFREQUENT_ACCESS',
    });
  });

  it('still flips INTO PAY_PER_REQUEST from an unrecorded previous mode', async () => {
    // The other direction of the same normalization: an absent PREVIOUS is a
    // PROVISIONED table, so declaring PAY_PER_REQUEST is a real flip and must
    // not be swallowed.
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps }
    );

    expect(updateInputs()).toHaveLength(1);
    expect(updateInputs()[0]).toMatchObject({ BillingMode: 'PAY_PER_REQUEST' });
    expect(updateInputs()[0]['ProvisionedThroughput']).toBeUndefined();
  });

  it('does not forward ProvisionedThroughput when the reset target is PAY_PER_REQUEST', async () => {
    // Defensive: AWS rejects provisioned capacity on an on-demand table, and
    // the normalization must not open a path that sends both.
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        BillingMode: 'PAY_PER_REQUEST',
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
      },
      { ...baseProps, BillingMode: 'PROVISIONED' }
    );

    expect(updateInputs()).toHaveLength(1);
    expect(updateInputs()[0]['ProvisionedThroughput']).toBeUndefined();
  });
});
