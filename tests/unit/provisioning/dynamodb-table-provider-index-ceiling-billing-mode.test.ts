/**
 * Issue [#3392](https://github.com/go-to-k/cdkd/issues/3392) — a per-GSI
 * `OnDemandThroughput` on a table whose EFFECTIVE billing mode is PROVISIONED
 * is refused at PRE-FLIGHT, before any AWS call.
 *
 * DynamoDB accepts `OnDemandThroughput` only on a PAY_PER_REQUEST table.
 * `applyGsiUpdates` has THREE per-index send sites — the `Create` action (since
 * issue #3265) and both `Update` arms (since issue #3287) — and all three ride
 * the same `GlobalSecondaryIndexUpdates` array, so on a PROVISIONED table AWS
 * rejects the whole request and an otherwise-valid per-index CAPACITY edit
 * sharing the action goes down with it, AFTER the BillingMode flip has landed.
 *
 * **What these cases fence is the mode DERIVATION, not the outcome.** A test
 * review on PR go-to-k/cdkd#3380 measured that swapping the effective-mode
 * expression for `prevBillingMode` left all 1242 `dynamodb*` cases green, so an
 * outcome-only fence proves nothing here. The three bindings disagree on shapes
 * this provider documents as reachable (a `cdkd import`, an out-of-band console
 * flip, `BillingMode` absent on both sides), and each case below is chosen so
 * that at least one of `billingMode` / `prevBillingMode` / `liveBillingMode`
 * gives the WRONG answer on its own:
 *
 * | case | desired | recorded | live | effective | verdict |
 * | --- | --- | --- | --- | --- | --- |
 * | flip INTO PROVISIONED | PROVISIONED | PAY_PER_REQUEST | PAY_PER_REQUEST | PROVISIONED | refuse |
 * | flip INTO PAY_PER_REQUEST | PAY_PER_REQUEST | PROVISIONED | PROVISIONED | PAY_PER_REQUEST | allow |
 * | absent on BOTH sides, live on-demand | (absent) | (absent) | PAY_PER_REQUEST | PAY_PER_REQUEST | allow |
 * | record lies, live provisioned | PAY_PER_REQUEST | PAY_PER_REQUEST | PROVISIONED | PROVISIONED | refuse |
 *
 * Rows 3 and 4 are the two the issue names: row 3 is what `billingMode` alone
 * FALSELY REFUSES (both sides normalize to the type default PROVISIONED while
 * no flip is sent), and row 4 is what it FALSELY ACCEPTS.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateTableCommand } from '@aws-sdk/client-dynamodb';

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
import type { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const TABLE_NAME = 'ceiling-mode-table';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:123:table/${TABLE_NAME}`;

const KEY_SCHEMA = [{ AttributeName: 'pk', KeyType: 'HASH' }];
const ATTRS = [
  { AttributeName: 'pk', AttributeType: 'S' },
  { AttributeName: 'gsipk', AttributeType: 'S' },
];
const GSI_BASE = {
  IndexName: 'gsi1',
  KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
};
const CEILING = { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 };

/**
 * Prime the `DescribeTable` at the top of `update()` with a live billing mode.
 *
 * `BillingModeSummary: undefined` is NOT the same as PROVISIONED here by
 * accident: DynamoDB omits the summary for a table created without an explicit
 * mode, and such a table IS provisioned — so the absent-summary spelling is the
 * one a real PROVISIONED table produces and is worth exercising on its own.
 */
function primeDescribe(live: 'PROVISIONED' | 'PAY_PER_REQUEST' | 'no-summary'): void {
  mockSend.mockResolvedValue({
    Table: {
      TableName: TABLE_NAME,
      TableArn: TABLE_ARN,
      TableStatus: 'ACTIVE',
      GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
      ...(live === 'no-summary' ? {} : { BillingModeSummary: { BillingMode: live } }),
    },
  });
}

function updateInputs(): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof UpdateTableCommand)
    .map((c) => (c[0] as UpdateTableCommand).input as unknown as Record<string, unknown>);
}

describe('AWS::DynamoDB::Table: per-GSI OnDemandThroughput vs the billing mode (issue #3392)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  it('REFUSES a flip INTO PROVISIONED while a GSI still declares OnDemandThroughput', async () => {
    primeDescribe('PAY_PER_REQUEST');

    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
        },
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [GSI_BASE],
        }
      )
    ).rejects.toThrow(/gsi1 declare OnDemandThroughput/);

    // The discriminator, and the whole point of a PRE-FLIGHT refusal: the flip
    // is what would otherwise land FIRST, leaving the table half-changed when
    // the per-index ceiling is rejected afterwards. Asserting only that the
    // update threw would also pass for a refusal raised inside
    // `applyGsiUpdates`, which runs after the flip.
    expect(updateInputs()).toHaveLength(0);
  });

  it('REFUSES on a steady PROVISIONED table with no BillingMode change at all', async () => {
    // `billingOrThroughputChanged` is FALSE here, so `billingMode` never
    // reaches AWS and the effective mode is the LIVE one. A gate reading the
    // desired mode alone still answers PROVISIONED and happens to be right;
    // one reading `prevBillingMode` answers PROVISIONED too. What this case
    // pins is that the refusal is not scoped to a FLIP — the ceiling can never
    // take effect on this table, and issue #3287 made the same-name `Update`
    // arm send it as soon as it changes.
    primeDescribe('PROVISIONED');

    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
        },
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: { MaxReadRequestUnits: 9 } }],
        }
      )
    ).rejects.toThrow(/billing mode is PROVISIONED/);

    expect(updateInputs()).toHaveLength(0);
  });

  it('says WHICH of the two refusal shapes fired, and what was left untouched', async () => {
    // The two message branches the refusal owns, neither of which any other
    // case reads (the go-to-k/cdkd#3401 test review, nit 4). `modeNote` is
    // what tells a user reading the error that their template declares no flip
    // at all -- without it the sentence "the table's billing mode is
    // PROVISIONED" reads as an accusation about a `BillingMode` line they do
    // not have. And the closing sentence must NOT claim "nothing was applied":
    // `applyTagDiff` has already run by the time this throws.
    primeDescribe('PROVISIONED');
    const steady = await provider
      .update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
        },
        { KeySchema: KEY_SCHEMA, AttributeDefinitions: ATTRS }
      )
      .catch((error: unknown) => (error as Error).message);
    expect(steady).toContain('already PROVISIONED in AWS and this update sends no BillingMode');
    expect(steady).toContain('No BillingMode flip and no index change were applied.');
    expect(steady).not.toContain('Nothing was applied');

    // ...and the FLIP shape omits that note, because there the template really
    // does carry the `BillingMode` line the message asks the user to change.
    vi.clearAllMocks();
    primeDescribe('PAY_PER_REQUEST');
    const flip = await provider
      .update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
        },
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [GSI_BASE],
        }
      )
      .catch((error: unknown) => (error as Error).message);
    expect(flip).not.toContain('already PROVISIONED in AWS');
  });

  it('renders an UNNAMEABLE index name rather than handing it to the masker', async () => {
    // `IndexName` reaches this walk from an unchecked template, so a NUMERIC
    // name really does arrive -- and the real masker is a
    // `String.prototype.replace` call that THROWS on a number, which would take
    // the whole deploy down from a diagnostic path. The fallback shares
    // `indexScopeAt`'s wording; nothing else read it (the test review's nit 4).
    primeDescribe('PROVISIONED');
    const message = await provider
      .update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          GlobalSecondaryIndexes: [{ ...GSI_BASE, IndexName: 2024, OnDemandThroughput: CEILING }],
        },
        { KeySchema: KEY_SCHEMA, AttributeDefinitions: ATTRS },
        // A masker that is a real `String.replace` call, not the identity.
        { maskSecrets: (text: string) => text.replace(/s3cr3t/g, '<redacted>') }
      )
      .catch((error: unknown) => (error as Error).message);
    // The SAME literal `indexScopeAt` renders, asserted as such: a user
    // grepping their log for one must find the other (the go-to-k/cdkd#3401
    // security review's second nit).
    expect(message).toContain('<unnamed>');
    expect(message).not.toContain('2024');
  });

  it('REFUSES when the RECORD and the template both say PAY_PER_REQUEST but AWS is PROVISIONED', async () => {
    // Row 4: the shape `billingMode` alone FALSELY ACCEPTS. Reachable from an
    // out-of-band console flip or a `cdkd import` whose recorded properties
    // came from the template rather than from AWS. Nothing is flipped by this
    // update (both sides agree), so the ceiling would be sent against a live
    // PROVISIONED table and rejected.
    primeDescribe('PROVISIONED');

    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
        },
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [GSI_BASE],
        }
      )
    ).rejects.toThrow(/billing mode is PROVISIONED/);

    expect(updateInputs()).toHaveLength(0);
  });

  it('ALLOWS a flip INTO PAY_PER_REQUEST that adds a per-GSI ceiling', async () => {
    // The other polarity. `prevBillingMode` and `liveBillingMode` are both
    // PROVISIONED, so a gate reading either alone REFUSES a deploy that is
    // perfectly valid — the flip lands first and the table is on-demand by the
    // time the ceiling is applied.
    primeDescribe('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRS,
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
      },
      {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRS,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
        GlobalSecondaryIndexes: [GSI_BASE],
      }
    );

    // The ceiling reached the wire on the per-index action, which is the
    // observable a "did not throw" assertion would miss.
    const ceilingOps = updateInputs().filter((input) =>
      (
        (input['GlobalSecondaryIndexUpdates'] ?? []) as Array<{
          Update?: { OnDemandThroughput?: unknown };
        }>
      ).some((op) => op.Update?.OnDemandThroughput !== undefined)
    );
    expect(ceilingOps).toHaveLength(1);
  });

  it('ALLOWS a per-GSI ceiling on a live on-demand table whose template omits BillingMode', async () => {
    // Row 3: the shape `billingMode` alone FALSELY REFUSES. Both sides omit
    // `BillingMode`, so both normalize to the CFn type default PROVISIONED and
    // `billingOrThroughputChanged` is FALSE — nothing is sent, and the table
    // stays on-demand. This shape reaches state (it deployed green before), so
    // refusing it would also break a rollback replay of a record the user
    // cannot edit.
    primeDescribe('PAY_PER_REQUEST');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRS,
        GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
      },
      {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRS,
        GlobalSecondaryIndexes: [GSI_BASE],
      }
    );

    const ceilingOps = updateInputs().filter((input) =>
      (
        (input['GlobalSecondaryIndexUpdates'] ?? []) as Array<{
          Update?: { OnDemandThroughput?: unknown };
        }>
      ).some((op) => op.Update?.OnDemandThroughput !== undefined)
    );
    expect(ceilingOps).toHaveLength(1);
  });

  it('REFUSES on a table with NO BillingModeSummary, the spelling a real PROVISIONED table produces', async () => {
    // The absent-summary reading is MEASURED, not defensive: DynamoDB omits
    // `BillingModeSummary` for a table created without an explicit mode, and
    // such a table is provisioned. A derivation that resolved the absence to
    // the GlobalTable-style PAY_PER_REQUEST default would let the ceiling
    // through on exactly the population the refusal exists for.
    primeDescribe('no-summary');

    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
        },
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          GlobalSecondaryIndexes: [GSI_BASE],
        }
      )
    ).rejects.toThrow(/billing mode is PROVISIONED/);

    expect(updateInputs()).toHaveLength(0);
  });

  it('names EVERY offending index, and masks the index name', async () => {
    // The name is a RESOLVED property value, so a resolved secret used as an
    // index name would otherwise print in plaintext into a thrown message.
    primeDescribe('PROVISIONED');
    const SECRET_NAME = 'gsi-super-secret-name';
    const maskSecrets = (text: string): string => text.split(SECRET_NAME).join('***');

    // Bound to a MESSAGE rather than to a `.rejects.not.toThrow(...)` matcher:
    // a negated throw matcher also passes for a promise that RESOLVES, so it
    // would endorse a refusal that silently stopped firing.
    let message: string | undefined;
    try {
      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          GlobalSecondaryIndexes: [
            { ...GSI_BASE, IndexName: SECRET_NAME, OnDemandThroughput: CEILING },
            { ...GSI_BASE, IndexName: 'gsi2', OnDemandThroughput: CEILING },
          ],
        },
        { KeySchema: KEY_SCHEMA, AttributeDefinitions: ATTRS },
        { maskSecrets }
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/\*\*\*, gsi2/);
    expect(message).not.toContain(SECRET_NAME);
  });

  it('reports the refusal with resourceType and logicalId the right way round', async () => {
    // `ProvisioningError(message, resourceType, logicalId, physicalId?)`. The
    // two were TRANSPOSED at this file's TABLE-level twin from issue #1553
    // until #3392 swept them, and nothing caught it: the fields never reach a
    // message, only `deployments/*.jsonl` and the error display, so every
    // behavioural assertion in the suite passed either way. Both refusals are
    // pinned here rather than only the new one, so a copy-paste of the wrong
    // order cannot come back.
    primeDescribe('PROVISIONED');

    const perIndex = await provider
      .update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
        },
        { KeySchema: KEY_SCHEMA, AttributeDefinitions: ATTRS }
      )
      .catch((error: unknown) => error as ProvisioningError);
    expect(perIndex).toMatchObject({
      resourceType: RESOURCE_TYPE,
      logicalId: 'MyTable',
      physicalId: TABLE_NAME,
    });

    vi.clearAllMocks();
    primeDescribe('PAY_PER_REQUEST');
    const tableLevel = await provider
      .update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
          OnDemandThroughput: CEILING,
        },
        { KeySchema: KEY_SCHEMA, AttributeDefinitions: ATTRS, BillingMode: 'PAY_PER_REQUEST' }
      )
      .catch((error: unknown) => error as ProvisioningError);
    expect(tableLevel).toMatchObject({ resourceType: RESOURCE_TYPE, logicalId: 'MyTable' });
  });

  it('DOWNGRADES for `drift --revert` too, whose bag is an AWS readback (go-to-k/cdkd#3401 finding 3)', async () => {
    // `.claude/rules/provider-diff-record-folds.md` says to ask, per site, what
    // each of the THREE `update()` callers means by the flag. Two of them mean
    // the same thing here: the rollback executor's revert arms set
    // `replayingState`, `cdkd drift --revert` sets `desiredFromAwsReadback`,
    // and NEITHER hands a bag the user can edit from the template -- which is
    // the entire justification for the downgrade.
    //
    // Gating on `replayingState` alone left `drift --revert` hard-throwing on
    // exactly the legitimate pre-go-to-k/cdkd#3287 record the downgrade exists
    // for, aborting the revert of every OTHER drifted property on that table.
    primeDescribe('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRS,
        GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
      },
      { KeySchema: KEY_SCHEMA, AttributeDefinitions: ATTRS },
      { desiredFromAwsReadback: true }
    );

    const warned = childLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('declare OnDemandThroughput'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/did not come from the template/);
  });

  it('still THROWS for the deploy engine, which sets neither flag', async () => {
    // The other direction of the same gate: `deploy-engine.ts` passes a
    // template-borne bag and sets neither field, so a downgrade keyed on
    // "a context was supplied at all" would silence the refusal on the one
    // path where the user CAN fix it.
    primeDescribe('PROVISIONED');

    await expect(
      provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRS,
          GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
        },
        { KeySchema: KEY_SCHEMA, AttributeDefinitions: ATTRS },
        { maskSecrets: (text: string) => text }
      )
    ).rejects.toThrow(/billing mode is PROVISIONED/);
  });

  it('DOWNGRADES to a warning when the desired bag is a replayed state record', async () => {
    // The asymmetry with the TABLE-level twin, and it is load-bearing rather
    // than cautious: before issue #3287 neither `Update` arm sent the member,
    // so a PROVISIONED table carrying a per-index ceiling DEPLOYED GREEN and
    // was recorded. A hard throw on the rollback executor's revert arms would
    // leave such a stack un-rollbackable with no template-side remedy.
    primeDescribe('PROVISIONED');

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRS,
        GlobalSecondaryIndexes: [{ ...GSI_BASE, OnDemandThroughput: CEILING }],
      },
      { KeySchema: KEY_SCHEMA, AttributeDefinitions: ATTRS },
      { replayingState: true }
    );

    const warned = childLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('declare OnDemandThroughput'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/did not come from the template/);
  });
});
