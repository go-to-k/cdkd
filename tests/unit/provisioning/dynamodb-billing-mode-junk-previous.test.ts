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
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const TABLE_NAME = 'my-test-table-xxx';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`;

/**
 * The recovery half of the malformed-BillingMode guard (issue #1552).
 *
 * The update-path guard added by #1545 / #1542 WARNS and suppresses the flip
 * rather than throwing — correct for replay safety, but the deploy then
 * SUCCEEDS, so the engine records the junk desired value as the new state.
 * That makes the warn path a producer of junk state, and recovery wedges:
 *
 *   1. state carries `BillingMode: null`, the table really runs PAY_PER_REQUEST
 *   2. the user fixes the template to `PAY_PER_REQUEST`
 *   3. the comparison sees `null !== 'PAY_PER_REQUEST'` — a "change" — and
 *      sends a same-mode `UpdateTable`
 *   4. DynamoDB rejects a same-mode flip with no capacity change riding along,
 *      so the deploy fails, state stays unchanged, and it repeats forever
 *
 * The fix seeds the comparison baseline from the table's ACTUAL billing mode
 * (already held by the `DescribeTable` each `update()` issues) whenever the
 * state-recorded previous is itself unusable. An ABSENT previous is NOT
 * unusable — seeding it would turn a no-op into a spurious change.
 */
describe('DynamoDBTableProvider junk previous BillingMode (issue #1552)', () => {
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

  /** A live table running `mode` (BillingModeSummary is what DescribeTable returns). */
  const liveTable = (mode?: string) =>
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        ...(mode !== undefined && { BillingModeSummary: { BillingMode: mode } }),
      },
    });

  const updateTableInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  it.each([
    ['null', null],
    ['a blank string', ''],
    ['an unresolved intrinsic', { Ref: 'Unresolved' }],
  ])(
    'issues NO UpdateTable when the template re-asserts the live mode over %s in state',
    async (_label, junk) => {
      liveTable('PAY_PER_REQUEST');

      await provider.update(
        'MyTable',
        TABLE_NAME,
        'AWS::DynamoDB::Table',
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
        { ...baseProps, BillingMode: junk }
      );

      // The wedge: pre-fix this sent `UpdateTable { TableName }` with no
      // mutable field (the mode matched, so `billingMode` was dropped by the
      // `if (billingOrThroughputChanged && billingMode)` gate) and AWS
      // rejected it on every deploy.
      expect(updateTableInputs()).toEqual([]);
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('recorded previous BillingMode is unusable')
      );
    }
  );

  it('still applies a REAL flip against a junk previous', async () => {
    liveTable('PAY_PER_REQUEST');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::Table',
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
      { ...baseProps, BillingMode: null }
    );

    expect(updateTableInputs()).toHaveLength(1);
    expect(updateTableInputs()[0]).toMatchObject({ BillingMode: 'PROVISIONED' });
  });

  it('treats a live table with NO BillingModeSummary as PROVISIONED', async () => {
    // DescribeTable omits the summary for a table created without an explicit
    // mode, which is PROVISIONED — the same default `readCurrentState` assumes.
    liveTable(undefined);

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::Table',
      { ...baseProps, BillingMode: 'PROVISIONED' },
      { ...baseProps, BillingMode: null }
    );

    expect(updateTableInputs()).toEqual([]);
  });

  it('leaves an ABSENT previous alone (no AWS-seeded baseline, no spurious change)', async () => {
    liveTable('PAY_PER_REQUEST');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::Table',
      { ...baseProps },
      { ...baseProps }
    );

    expect(updateTableInputs()).toEqual([]);
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('recorded previous BillingMode')
    );
  });

  it('resolves an ABSENT previous from the LIVE mode when the DESIRED side DECLARES one', async () => {
    // The convergence fence for issue #1733. `AWS::DynamoDB::GlobalTable`
    // ADOPTED this provider's long-standing gate — `properties['BillingMode']
    // !== undefined ? liveBillingMode : <type default>` — rather than diverging
    // from it, so the two providers must keep agreeing on this shape. The row
    // above cannot pin it: its desired side declares no mode, so it passes
    // whether or not the seed reaches this provider.
    //
    // Assert-only, deliberately: `dynamodb-table-provider.ts` belongs to
    // another lane and is not edited by the change this file fences.
    liveTable('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::Table',
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps }
    );

    expect(updateTableInputs()).toHaveLength(1);
    expect(updateTableInputs()[0]).toMatchObject({ BillingMode: 'PAY_PER_REQUEST' });
  });

  it('keeps the live mode when the DESIRED value is unusable and the previous is junk too', async () => {
    // The live mode is PROVISIONED, deliberately NOT the create-path default:
    // pre-fix the desired `null` fell back to the junk previous (`''`) and
    // "nothing sent" was true for the WRONG reason (`'' === ''`), so an
    // assertion on the calls alone passed either way. Asserting the #1552 warn
    // AND the live mode pins that the baseline actually came from AWS.
    liveTable('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::Table',
      { ...baseProps, BillingMode: null },
      { ...baseProps, BillingMode: '' }
    );

    // Both sides junk: the baseline is AWS's mode and the desired falls back
    // to it, so nothing is sent — the table is not re-priced.
    expect(updateTableInputs()).toEqual([]);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('recorded previous BillingMode is unusable')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('(PROVISIONED)'));
  });
});

describe('DynamoDBGlobalTableProvider junk previous BillingMode (issue #1552)', () => {
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

  const liveTable = (mode: string) =>
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: mode },
        Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
      },
    });

  const billingUpdateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>)
      .filter((i) => i['BillingMode'] !== undefined);

  it('does not flip a live PROVISIONED table when state recorded a blank previous', async () => {
    // The sharpest case for the GlobalTable provider: its `?? 'PAY_PER_REQUEST'`
    // rescues `null` but NOT `''`, and its create-path default is on-demand —
    // so a blank previous read as PAY_PER_REQUEST against a PROVISIONED
    // template looked like a real PROVISIONED flip on a table already
    // provisioned, and the reverse case silently re-priced one.
    liveTable('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::GlobalTable',
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 5, TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 } },
        },
      },
      { ...baseProps, BillingMode: '' }
    );

    expect(billingUpdateInputs()).toEqual([]);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('recorded previous BillingMode is unusable')
    );
  });

  it('still applies a REAL flip against a junk previous', async () => {
    liveTable('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::GlobalTable',
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps, BillingMode: null }
    );

    expect(billingUpdateInputs()).toHaveLength(1);
    expect(billingUpdateInputs()[0]).toMatchObject({ BillingMode: 'PAY_PER_REQUEST' });
  });

  // ─── issue #1733: an ABSENT recorded previous consults AWS too ──────────
  //
  // The residual #1552 deliberately left open. An absent recorded previous
  // resolved to the create-path default WITHOUT asking the table, so a record
  // with no `BillingMode` — left by `cdkd import` of a PROVISIONED table, or by
  // the update path's own DROP arm — made a corrected `PAY_PER_REQUEST`
  // template compare EQUAL, issue no `UpdateTable`, and silently lose the flip.
  // `readCurrentState` emits `BillingMode` only where AWS reports a
  // `BillingModeSummary`, so `cdkd drift` could not report it either.

  const liveTableWithoutSummary = () =>
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
      },
    });

  it('APPLIES the flip a corrected template asks for over an ABSENT previous', async () => {
    // The headline #1733 case. Pre-fix this asserted the OPPOSITE (no call),
    // which is the bug: the live table is PROVISIONED, the template says
    // PAY_PER_REQUEST, and cdkd compared it against its own create-path default
    // instead of against AWS.
    liveTable('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::GlobalTable',
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps }
    );

    expect(billingUpdateInputs()).toHaveLength(1);
    expect(billingUpdateInputs()[0]).toMatchObject({ BillingMode: 'PAY_PER_REQUEST' });
    // Announced, and distinctly from the #1552 unusable-previous warning — the
    // two describe different record shapes and an integ grep must be able to
    // tell them apart.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /AWS::DynamoDB::GlobalTable MyTable: the cdkd state record declares no BillingMode — using PROVISIONED as the comparison baseline.*the mode DescribeTable reports/s
      )
    );
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('recorded previous BillingMode is unusable')
    );
  });

  it('issues NO UpdateTable when the ABSENT previous seeds a mode the template re-asserts', async () => {
    // The other polarity of the same seed: reading live must not manufacture a
    // change. Pre-fix this ALSO passed (default == live), so it is only a fence
    // in company with the row above.
    liveTable('PAY_PER_REQUEST');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::GlobalTable',
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps }
    );

    expect(billingUpdateInputs()).toEqual([]);
    // No announcement: the seeded baseline equals the pre-#1733 default, so
    // nothing about this deploy changed.
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('declares no BillingMode')
    );
  });

  it('issues NO UpdateTable when the ABSENT previous seeds a live PROVISIONED mode the template keeps', async () => {
    // The seed also REMOVES a spurious call: pre-fix the absent record read as
    // PAY_PER_REQUEST, so a PROVISIONED template on an already-PROVISIONED
    // table looked like a real flip and sent one.
    liveTable('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::GlobalTable',
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: {
            MinCapacity: 1,
            MaxCapacity: 5,
            TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
          },
        },
      },
      { ...baseProps }
    );

    expect(billingUpdateInputs()).toEqual([]);
  });

  it('seeds PROVISIONED when AWS reports NO BillingModeSummary, and APPLIES the flip', async () => {
    // The population issue #1733's own step 1 names — a `cdkd import` of a
    // PROVISIONED table — is EXACTLY the no-summary shape: DynamoDB omits the
    // summary for a table created without an explicit mode, and `create()`
    // always sends one, so only a non-cdkd table can lack it. Resolving that to
    // this provider's create-path default (the first cut of the fix) left #1733
    // inert on its own headline case.
    liveTableWithoutSummary();

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::GlobalTable',
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps }
    );

    expect(billingUpdateInputs()).toHaveLength(1);
    expect(billingUpdateInputs()[0]).toMatchObject({ BillingMode: 'PAY_PER_REQUEST' });
    // The announcement says the mode was INFERRED, not reported — asserting
    // "the table's actual billing mode" over an absent summary would overstate
    // what cdkd knows.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/declares no BillingMode.*inferred: DescribeTable reports no/s)
    );
  });

  it('issues NO UpdateTable when the no-summary inference MATCHES the template', async () => {
    // The other polarity of the same inference, and the one the create-path
    // default got backwards: pre-fix a PROVISIONED template over an absent
    // record read as PAY_PER_REQUEST -> PROVISIONED and flipped a table that
    // was already provisioned — the #1552 same-mode call, re-opened from the
    // other side.
    liveTableWithoutSummary();

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::GlobalTable',
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: {
            MinCapacity: 1,
            MaxCapacity: 5,
            TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
          },
        },
      },
      { ...baseProps }
    );

    expect(billingUpdateInputs()).toEqual([]);
  });

  it('does NOT consult AWS when the DESIRED side declares no BillingMode either', async () => {
    // The narrowing that keeps #1733 from re-pricing a table nobody asked
    // about: a template that OMITS the property means "GlobalTable's own
    // default", and seeding AWS's mode there would flip an IMPORTED
    // PROVISIONED table to on-demand on its next deploy. Only a DECLARED
    // desired mode is compared against the live one.
    liveTable('PROVISIONED');

    const previous: Record<string, unknown> = { ...baseProps };

    await provider.update(
      'MyTable',
      TABLE_NAME,
      'AWS::DynamoDB::GlobalTable',
      { ...baseProps },
      previous
    );

    expect(billingUpdateInputs()).toEqual([]);
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('declares no BillingMode')
    );
  });
});
