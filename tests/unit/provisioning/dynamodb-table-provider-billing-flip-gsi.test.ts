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

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

/**
 * Issue #1588: a `PAY_PER_REQUEST -> PROVISIONED` flip on a table that HAS a
 * GSI must carry per-index `ProvisionedThroughput` in the SAME `UpdateTable`.
 *
 * Measured against real AWS on 2026-08-11, both halves, because "AWS probably
 * rejects it" is not a basis for a fix:
 *
 *   A) BillingMode + table-level ProvisionedThroughput only (the pre-fix call)
 *      -> `ValidationException: One or more parameter values were invalid:
 *      ProvisionedThroughput must be specified for index: gsi1`. Nothing
 *      applied — so the flip was not degraded, it was IMPOSSIBLE for any table
 *      with an index.
 *   B) the same call plus `GlobalSecondaryIndexUpdates[].Update.
 *      ProvisionedThroughput` -> accepted; the readback showed the table at its
 *      declared capacity and `gsi1` at its own.
 *
 * The scope is exactly the flip: an already-PROVISIONED table taking a capacity
 * bump must NOT re-assert its indexes (AWS rejects a no-op index capacity), and
 * a flip in the other direction has no per-index capacity to send at all.
 */
function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

const LIVE_GSI = (name: string) => ({
  IndexName: name,
  IndexStatus: 'ACTIVE',
  // What DescribeTable reports for an index on a PAY_PER_REQUEST table — the
  // zeros are the AWS-side default for a mode the table is not in, never a
  // capacity to echo back (the #1571 lesson, one type over).
  ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
});

const cfnGsi = (name: string, read: unknown, write: unknown) => ({
  ...cfnGsiNoCapacity(name),
  ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: write },
});

// The on-demand shape: same KeySchema / Projection, no capacity. Sharing the
// key schema matters — a differing one trips the separate immutable-KeySchema
// refusal and the test would fail for a reason it is not about.
const cfnGsiNoCapacity = (name: string) => ({
  IndexName: name,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
});

let provider: DynamoDBTableProvider;

beforeEach(() => {
  // `mockReset`, not just `clearAllMocks`: the latter clears call RECORDS but
  // leaves the `mockResolvedValueOnce` QUEUE intact, so a test that primes more
  // responses than its update() consumes shifts every later test's queue by one
  // and they silently read the wrong DescribeTable. That is not hypothetical —
  // it made the last test in this file see a table with no indexes and skip the
  // branch it exists to pin, while still passing its other assertion.
  mockSend.mockReset();
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new DynamoDBTableProvider();
});

function primeDescribeTable(liveMode: string, indexes: unknown[]): void {
  mockSend.mockResolvedValueOnce({
    Table: {
      TableName: TABLE_NAME,
      TableArn: TABLE_ARN,
      TableStatus: 'ACTIVE',
      BillingModeSummary: { BillingMode: liveMode },
      ...(indexes.length > 0 && { GlobalSecondaryIndexes: indexes }),
    },
  });
}

function primeWaitActive(): void {
  mockSend.mockResolvedValueOnce({
    Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
  });
}

describe('flip to PROVISIONED carries per-GSI ProvisionedThroughput (issue #1588)', () => {
  it('sends GlobalSecondaryIndexUpdates in the SAME UpdateTable as the flip', async () => {
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({}); // UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      },
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] }
    );

    const calls = findCalls(UpdateTableCommand);
    // ONE call, not two: AWS requires them combined, and a second call would
    // race the first one's still-UPDATING index.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.BillingMode).toBe('PROVISIONED');
    expect(calls[0]!.input.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    });
    expect(calls[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
      {
        Update: {
          IndexName: 'gsi1',
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 3 },
        },
      },
    ]);
  });

  it('covers EVERY live index, not just the first', async () => {
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1'), LIVE_GSI('gsi2')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3), cfnGsi('gsi2', 7, 11)],
      },
      // Same index SET on both sides: this test is about the flip, and a
      // differing set would additionally engage the separate add/remove GSI
      // path (its own UpdateTable round-trips), which is covered elsewhere.
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3), cfnGsi('gsi2', 7, 11)],
      }
    );

    const updates = findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates ?? [];
    expect(updates.map((u) => u.Update?.IndexName).sort()).toEqual(['gsi1', 'gsi2']);
    expect(
      updates.find((u) => u.Update?.IndexName === 'gsi2')?.Update?.ProvisionedThroughput
    ).toEqual({ ReadCapacityUnits: 7, WriteCapacityUnits: 11 });
  });

  it('coerces string capacities, since CFn emits numerics as strings', async () => {
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', '3', '4')],
      },
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsi('gsi1', '3', '4')] }
    );

    expect(
      findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates?.[0]?.Update
        ?.ProvisionedThroughput
    ).toEqual({ ReadCapacityUnits: 3, WriteCapacityUnits: 4 });
  });

  it('takes the LIVE index list, so an index the template no longer declares is still named', async () => {
    // AWS's refusal names LIVE indexes. A template-only list would omit the
    // undeclared one — precisely the index AWS complains about — so the warning
    // has to be driven by what DescribeTable reports.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1'), LIVE_GSI('ghost')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      },
      // `ghost` is in the PREVIOUS side too, so the index set is unchanged and
      // no add/remove path runs — the only thing that omits it is the DESIRED
      // template, which is exactly the case being pinned.
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      }
    );

    const updates = findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates ?? [];
    expect(updates.map((u) => u.Update?.IndexName)).toEqual(['gsi1']);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('ghost'));
  });
});

describe('the flip-handled index is not re-asserted by the per-index path', () => {
  it('issues exactly ONE UpdateTable carrying the index, not a second no-op one', async () => {
    // Found by the real-AWS `dynamodb-ondemand` integ on this change's FIRST
    // run, not by a unit test — and the reason is structural: every other test
    // here mocks a single call, while this defect is an INTERACTION between
    // two. The flip delivered the capacity, then `applyGsiUpdates` saw the
    // template's 2/2 against a previous side with none and issued a SECOND
    // UpdateTable, which AWS rejects outright:
    //   "The provisioned throughput for the index billing-removal-gsi will not
    //    change. The requested value equals the current value."
    // That failed the whole deploy, so the fix without this suppression was
    // strictly worse than the bug it replaced.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({}); // the flip UpdateTable
    primeWaitActive();
    // Deliberately primed so a SECOND UpdateTable would succeed if one were
    // sent — the assertion has to catch the extra call, not a mock underrun.
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 2, 2)],
      },
      // The integ's exact shape: the baseline is on-demand, so the recorded
      // index carries NO capacity and the desired one does — which is what made
      // `applyGsiUpdates` think it had work to do.
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsiNoCapacity('gsi1')],
      }
    );

    const calls = findCalls(UpdateTableCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.GlobalSecondaryIndexUpdates?.[0]?.Update?.ProvisionedThroughput).toEqual(
      { ReadCapacityUnits: 2, WriteCapacityUnits: 2 }
    );
  });

  it('still applies a per-index capacity change when there is NO flip', async () => {
    // The suppression must be scoped to indexes the flip handled; an ordinary
    // capacity edit on an already-PROVISIONED table still needs its own op.
    primeDescribeTable('PROVISIONED', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({}); // the per-index UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 9, 9)],
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 2, 2)],
      }
    );

    const calls = findCalls(UpdateTableCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.GlobalSecondaryIndexUpdates?.[0]?.Update).toMatchObject({
      IndexName: 'gsi1',
      ProvisionedThroughput: { ReadCapacityUnits: 9, WriteCapacityUnits: 9 },
    });
  });
});

describe('capacity is never invented (PR review)', () => {
  // A default here would be worse than at create(): the flip SUPPRESSES the
  // per-index path for every index it handles, so an invented capacity is never
  // corrected by a later call and lands in state as if the user declared it.
  const unusable: Array<[string, unknown]> = [
    ['only ReadCapacityUnits declared', { ReadCapacityUnits: 2 }],
    ['only WriteCapacityUnits declared', { WriteCapacityUnits: 2 }],
    ['a non-object block (unresolved intrinsic)', 'two'],
    ['a non-numeric capacity', { ReadCapacityUnits: 'abc', WriteCapacityUnits: 2 }],
    ['an empty-string capacity', { ReadCapacityUnits: '', WriteCapacityUnits: 2 }],
  ];

  for (const [label, throughput] of unusable) {
    it(`omits the index and warns for ${label}`, async () => {
      primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
      mockSend.mockResolvedValueOnce({});
      primeWaitActive();

      const gsi = { ...cfnGsiNoCapacity('gsi1'), ProvisionedThroughput: throughput };
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          GlobalSecondaryIndexes: [gsi],
        },
        { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [gsi] }
      );

      expect(findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates).toBeUndefined();
      expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('gsi1'));
    });
  }

  it('accepts a numeric STRING pair, since CFn is stringly typed', async () => {
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', '6', '7')],
      },
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsi('gsi1', '6', '7')] }
    );

    expect(
      findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates?.[0]?.Update
        ?.ProvisionedThroughput
    ).toEqual({ ReadCapacityUnits: 6, WriteCapacityUnits: 7 });
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('names a live index the deploy does NOT declare and cannot remove', async () => {
    // The residual case after issue #1617 moved the REMOVAL ahead of the flip:
    // an index live in AWS but in NEITHER the template nor cdkd's previous
    // record was created out of band, so this deploy never asked for its
    // deletion and cdkd will not invent one. It is still live at flip time and
    // still has no declared capacity, so AWS rejects the flip by name — the
    // contract is that cdkd names it first.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('keep'), LIVE_GSI('outofband')]);
    mockSend.mockResolvedValueOnce({}); // the flip UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('keep', 2, 2)],
      },
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsiNoCapacity('keep')] }
    );

    const calls = findCalls(UpdateTableCommand);
    // Exactly the flip: no Delete was invented for the out-of-band index.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.BillingMode).toBe('PROVISIONED');
    expect(
      (calls[0]!.input.GlobalSecondaryIndexUpdates ?? []).map((u) => u.Update?.IndexName)
    ).toEqual(['keep']);
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('outofband');
    expect(warned).not.toContain('keep,');
  });
});

/**
 * Issue #1617: removing a GSI in the SAME deploy as a flip to PROVISIONED.
 *
 * The shape #1588 left unconvergeable. The removed index is still LIVE when the
 * flip runs, so AWS demands per-index `ProvisionedThroughput` for it
 * (`ProvisionedThroughput must be specified for index: <name>`, measured
 * 2026-08-11) while the template no longer declares any — and cdkd's Delete op
 * lived in `applyGsiUpdates`, which runs AFTER the flip and was therefore never
 * reached. Every deploy failed identically with no template-side remedy.
 *
 * The fix issues the Delete FIRST (what CloudFormation does on this shape).
 * Only the removal moves; creates and capacity updates stay after the flip.
 */
describe('a GSI removed in the same deploy is deleted BEFORE the flip (issue #1617)', () => {
  it('deletes the removed index first, then flips without naming it', async () => {
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('keep'), LIVE_GSI('dropme')]);
    mockSend.mockResolvedValueOnce({}); // the pre-flip Delete UpdateTable
    primeWaitActive();
    mockSend.mockResolvedValueOnce({}); // the flip UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('keep', 2, 2)],
      },
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsiNoCapacity('keep'), cfnGsiNoCapacity('dropme')],
      }
    );

    const calls = findCalls(UpdateTableCommand);
    // TWO calls, in this ORDER — the whole fix. A reversed order is the bug.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.input.BillingMode).toBeUndefined();
    expect(calls[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
      { Delete: { IndexName: 'dropme' } },
    ]);
    expect(calls[1]!.input.BillingMode).toBe('PROVISIONED');
    // The flip's per-index list is built from the LIVE indexes MINUS the ones
    // just deleted: naming `dropme` here would re-introduce the rejection.
    expect(
      (calls[1]!.input.GlobalSecondaryIndexUpdates ?? []).map((u) => u.Update?.IndexName)
    ).toEqual(['keep']);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('does not delete the index a SECOND time from the post-flip GSI path', async () => {
    // `applyGsiUpdates` still sees `dropme` in the previous side and absent
    // from the desired one, so without the already-deleted set it would issue a
    // duplicate Delete and fail the deploy with ResourceNotFoundException.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('keep'), LIVE_GSI('dropme')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('keep', 2, 2)],
      },
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsiNoCapacity('keep'), cfnGsiNoCapacity('dropme')],
      }
    );

    const deletes = findCalls(UpdateTableCommand).flatMap((c) =>
      (c.input.GlobalSecondaryIndexUpdates ?? []).filter((u) => u.Delete)
    );
    expect(deletes).toHaveLength(1);
  });

  it('removes EVERY dropped index, one UpdateTable each', async () => {
    // AWS allows one GSI create/delete per UpdateTable, so two removals are two
    // calls with a table+indexes ACTIVE wait between them.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('keep'), LIVE_GSI('d1'), LIVE_GSI('d2')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('keep', 2, 2)],
      },
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [
          cfnGsiNoCapacity('keep'),
          cfnGsiNoCapacity('d1'),
          cfnGsiNoCapacity('d2'),
        ],
      }
    );

    const calls = findCalls(UpdateTableCommand);
    expect(calls).toHaveLength(3);
    expect(calls.slice(0, 2).map((c) => c.input.GlobalSecondaryIndexUpdates)).toEqual([
      [{ Delete: { IndexName: 'd1' } }],
      [{ Delete: { IndexName: 'd2' } }],
    ]);
    expect(calls[2]!.input.BillingMode).toBe('PROVISIONED');
  });

  it('deletes NOTHING when an index that REMAINS declares no usable capacity', async () => {
    // The pre-validation. A Delete is not undoable, and the flip fails at AWS
    // either way here — so deleting first would buy nothing and leave a
    // partially-applied deploy (index gone, mode unchanged). Keep the shape at
    // "nothing applied" and say why.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('keep'), LIVE_GSI('dropme')]);
    mockSend.mockResolvedValueOnce({}); // the flip UpdateTable (AWS would reject it live)
    primeWaitActive();
    mockSend.mockResolvedValueOnce({}); // the post-flip Delete, still owned by applyGsiUpdates
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsiNoCapacity('keep')],
      },
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsiNoCapacity('keep'), cfnGsiNoCapacity('dropme')],
      }
    );

    const calls = findCalls(UpdateTableCommand);
    // The FIRST call is the flip, not a Delete — nothing was removed ahead of it.
    expect(calls[0]!.input.BillingMode).toBe('PROVISIONED');
    expect(calls[0]!.input.GlobalSecondaryIndexUpdates).toBeUndefined();
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('Nothing was removed');
    expect(warned).toContain('dropme');
    expect(warned).toContain('keep');
  });

  it('does NOT reorder the removal on a flip to PAY_PER_REQUEST', async () => {
    // Scope. The other direction needs no per-index capacity, so the removal
    // has no reason to move and stays where it always was — after the flip.
    primeDescribeTable('PROVISIONED', [LIVE_GSI('keep'), LIVE_GSI('dropme')]);
    mockSend.mockResolvedValueOnce({}); // the flip UpdateTable
    primeWaitActive();
    mockSend.mockResolvedValueOnce({}); // the Delete UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsiNoCapacity('keep')] },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('keep', 2, 2), cfnGsi('dropme', 2, 2)],
      }
    );

    const calls = findCalls(UpdateTableCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(calls[1]!.input.GlobalSecondaryIndexUpdates).toEqual([
      { Delete: { IndexName: 'dropme' } },
    ]);
  });

  it('does NOT reorder the removal on a capacity bump with no flip', async () => {
    // Same scope check on the other axis: an already-PROVISIONED table never
    // enumerates live indexes, so its removal is untouched.
    primeDescribeTable('PROVISIONED', [LIVE_GSI('keep'), LIVE_GSI('dropme')]);
    mockSend.mockResolvedValueOnce({}); // the capacity-bump UpdateTable
    primeWaitActive();
    mockSend.mockResolvedValueOnce({}); // the Delete UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 9, WriteCapacityUnits: 9 },
        GlobalSecondaryIndexes: [cfnGsi('keep', 2, 2)],
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('keep', 2, 2), cfnGsi('dropme', 2, 2)],
      }
    );

    const calls = findCalls(UpdateTableCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.input.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 9,
      WriteCapacityUnits: 9,
    });
    expect(calls[1]!.input.GlobalSecondaryIndexUpdates).toEqual([
      { Delete: { IndexName: 'dropme' } },
    ]);
  });
});

describe('the widened OnDemandThroughput refusal does not over-refuse (PR review round 2)', () => {
  it('does NOT refuse when no flip is sent at all, even against a live on-demand table', async () => {
    // The refusal was widened to the LIVE mode so a flip that now SUCCEEDS
    // cannot half-apply. Without `billingOrThroughputChanged` leading it, this
    // shape hard-errors a deploy that used to work: neither side declares
    // BillingMode, so both normalize to the type default PROVISIONED and no
    // flip is issued — while the live table is on-demand and legitimately
    // takes an OnDemandThroughput ceiling update. That shape also REACHES
    // state (it used to succeed), so refusing it would make a rollback /
    // `drift --revert` replay throw on a record the user cannot edit.
    primeDescribeTable('PAY_PER_REQUEST', []);
    mockSend.mockResolvedValueOnce({}); // the OnDemandThroughput UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } },
      { OnDemandThroughput: { MaxReadRequestUnits: 8, MaxWriteRequestUnits: 4 } }
    );

    const sent = findCalls(UpdateTableCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.OnDemandThroughput).toEqual({
      MaxReadRequestUnits: 10,
      MaxWriteRequestUnits: 5,
    });
  });

  it('refuses when the RECORD disagrees with LIVE — the case the widening exists for', async () => {
    // The intended catch, and the one the pre-existing suites cannot express:
    // their DescribeTable fixtures omit `BillingModeSummary` entirely, so
    // `liveBillingMode` silently defaults to PROVISIONED and this arm stays
    // dormant. A real on-demand table always reports it.
    //
    // Shape: state says PROVISIONED (a `cdkd import`, or an out-of-band console
    // flip to on-demand), AWS is on-demand, and a capacity change makes
    // `billingOrThroughputChanged` true — so a real flip WOULD be sent. Before
    // the widening the refusal keyed only on the recorded previous, missed it,
    // and the flip (now that it succeeds for indexed tables) would leave the
    // following OnDemandThroughput call to fail against a provisioned table.
    primeDescribeTable('PAY_PER_REQUEST', []);

    await expect(
      provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
          OnDemandThroughput: { MaxReadRequestUnits: 10 },
        },
        {
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }
      )
    ).rejects.toThrow(/OnDemandThroughput/);
    // Refused BEFORE any mutation — that is the whole point of moving it ahead
    // of the flip rather than letting AWS reject the second call.
    expect(findCalls(UpdateTableCommand)).toHaveLength(0);
  });

  it('STILL refuses a real flip that carries OnDemandThroughput', async () => {
    // The widening must keep its point: a genuine flip to PROVISIONED while the
    // template still declares on-demand ceilings is refused before any mutation.
    primeDescribeTable('PAY_PER_REQUEST', []);

    await expect(
      provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          OnDemandThroughput: { MaxReadRequestUnits: 10 },
        },
        { BillingMode: 'PAY_PER_REQUEST' }
      )
    ).rejects.toThrow(/OnDemandThroughput/);
    expect(findCalls(UpdateTableCommand)).toHaveLength(0);
  });
});

describe('scope: only the flip, and only when indexes exist', () => {
  it('does NOT send index updates on a capacity bump of an already-PROVISIONED table', async () => {
    // AWS rejects an UpdateTable that re-asserts an index's current capacity,
    // so widening the gate to "any throughput change" would break the ordinary
    // capacity bump this provider already supported.
    primeDescribeTable('PROVISIONED', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 100, WriteCapacityUnits: 50 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      }
    );

    expect(
      findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates
    ).toBeUndefined();
  });

  it('does NOT send index updates on a flip TO PAY_PER_REQUEST', async () => {
    primeDescribeTable('PROVISIONED', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      }
    );

    const call = findCalls(UpdateTableCommand)[0]!;
    expect(call.input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(call.input.GlobalSecondaryIndexUpdates).toBeUndefined();
  });

  it('flips a table with NO indexes exactly as before (the #1553 shape is untouched)', async () => {
    primeDescribeTable('PAY_PER_REQUEST', []);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
      { BillingMode: 'PAY_PER_REQUEST' }
    );

    const call = findCalls(UpdateTableCommand)[0]!;
    expect(call.input.BillingMode).toBe('PROVISIONED');
    expect(call.input.GlobalSecondaryIndexUpdates).toBeUndefined();
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('warns and sends no index update when the template declares no per-index capacity', async () => {
    // Deliberately NOT a pre-flight refusal: AWS names the offending index a
    // moment later, which is the CFn-parity outcome and a better message than a
    // guessed capacity. The warning only makes the cause visible in cdkd output.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsiNoCapacity('gsi1')],
      },
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsiNoCapacity('gsi1')],
      }
    );

    expect(
      findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates
    ).toBeUndefined();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ProvisionedThroughput for live index(es) gsi1')
    );
  });
});
