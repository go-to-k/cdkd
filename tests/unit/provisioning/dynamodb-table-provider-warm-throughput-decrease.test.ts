import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

const mockSend = vi.fn();
const warn = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

/**
 * What AWS holds for the table under test — the floor it reports for a table
 * that declared no warm throughput at all (measured us-east-1, 2026-08-13).
 */
const LIVE_WARM_THROUGHPUT = {
  ReadUnitsPerSecond: 12000,
  WriteUnitsPerSecond: 4000,
  Status: 'ACTIVE',
};

function warmThroughputUpdates(): UpdateTableCommand[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof UpdateTableCommand)
    .map((c) => c[0] as UpdateTableCommand)
    .filter((cmd) => cmd.input.WarmThroughput !== undefined);
}

/**
 * Answer every `DescribeTable` with the same live snapshot (the one at the top
 * of `update()`, and every post-`UpdateTable` ACTIVE wait), so no test depends
 * on how many describes the method happens to issue.
 */
function primeLiveTable(table: Record<string, unknown>): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE', ...table },
      });
    }
    return Promise.resolve({});
  });
}

/**
 * Issue #1768 — a declared `WarmThroughput` AWS has since GROWN is
 * unrevertable: warm throughput only ever RISES with a table's traffic, so the
 * `UpdateTable` cdkd issues to put the declared value back is rejected.
 *
 * Measured us-east-1, 2026-08-13, against a table AWS reports
 * `{12000, 4000}` for:
 *
 *   {6000, 2000}  -> ValidationException: ... Requested ReadUnitsPerSecond for
 *                    WarmThroughput for table is lower than current
 *                    WarmThroughput, decreasing WarmThroughput is not supported
 *   {6000}        -> same rejection
 *   {_, 2000}     -> same rejection, naming WriteUnitsPerSecond
 *   {12000, 4000} -> ACCEPTED (a re-assert is fine)
 *
 * So the answer is REPORT the drift, REFUSE the doomed call — not "compare
 * one-directionally", which would hide a template edit, and not "leave as is",
 * which fails the whole revert with an AWS error.
 */
describe('DynamoDBTableProvider WarmThroughput decrease (issue #1768)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    warn.mockReset();
    provider = new DynamoDBTableProvider();
  });

  it('skips the UpdateTable when BOTH members would decrease, and says why', async () => {
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: 6000, WriteUnitsPerSecond: 2000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
    const message = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('decreasing WarmThroughput is not supported');
    // The user's only remedy is a template edit, so the message has to carry
    // the number AWS actually holds.
    expect(message).toContain('12000');
    expect(message).toContain('4000');
  });

  it('skips when only the READ member would decrease', async () => {
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: 6000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 24000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
  });

  it('skips when only the WRITE member would decrease', async () => {
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { WriteUnitsPerSecond: 2000 } },
      { WarmThroughput: { WriteUnitsPerSecond: 8000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
  });

  it('still SENDS an increase', async () => {
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
    );

    expect(warmThroughputUpdates().map((c) => c.input.WarmThroughput)).toEqual([
      { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still SENDS a value equal to what AWS holds (a re-assert is accepted)', async () => {
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(1);
  });

  it('still SENDS a MIXED request (one member up, one down) — AWS names the offender', async () => {
    // Failing OPEN: skipping would silently drop the increase the user asked
    // for, and the worst case of sending is the pre-fix behavior.
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 2000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(1);
  });

  it('still SENDS when AWS reports no WarmThroughput at all (fail open)', async () => {
    primeLiveTable({});

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: 6000, WriteUnitsPerSecond: 2000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(1);
  });

  it('still SENDS when an unusable member sits beside a usable INCREASE (fail open)', async () => {
    // Fail-open still means fail-open: an unresolved intrinsic must not suppress
    // the member cdkd CAN act on.
    //
    // This row used to pair the intrinsic with `WriteUnitsPerSecond: 2000` and
    // assert the call went out — which pinned the defect PR review round 7
    // found. The gate read the RAW bag, bailed on the unusable member and
    // failed open, and the request actually sent was the coerced
    // `{WriteUnitsPerSecond: 2000}`: a DECREASE against the live
    // `{12000, 4000}`, i.e. the one call this branch exists to withhold, so the
    // deploy FAILED. The teeth are re-supplied from an input where fail-open is
    // the right answer — the usable member is an INCREASE — and the decrease
    // shape now has its own row below.
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        WarmThroughput: { ReadUnitsPerSecond: { Ref: 'Unresolved' }, WriteUnitsPerSecond: 8000 },
      },
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 4000 } }
    );

    expect(warmThroughputUpdates().map((c) => c.input.WarmThroughput)).toEqual([
      { WriteUnitsPerSecond: 8000 },
    ]);
  });

  it('SKIPS when the COERCED remainder is a decrease, though the raw bag is unanalysable', async () => {
    // Item 1 of PR review round 7, at the table level: the gate must analyse
    // what will actually be SENT. Reading the raw bag here fails open on the
    // unresolved member and then transmits `{WriteUnitsPerSecond: 2000}` — a
    // decrease AWS refuses — so the deploy dies instead of warning and
    // continuing, which is what the per-index arm does on the identical input.
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        WarmThroughput: { ReadUnitsPerSecond: { Ref: 'Unresolved' }, WriteUnitsPerSecond: 2000 },
      },
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
    // Asserted PER MESSAGE, not against the joined blob (PR review round 8).
    // The earlier version checked the blob for `ReadUnitsPerSecond` as its
    // "the drop is still announced" fence — but the DECREASE warning prints
    // both member names in its own live-side JSON, so that assertion passed
    // whether or not the announcement fired at all.
    const messages = warn.mock.calls.map((c) => String(c[0]));
    const decrease = messages.find((m) => m.includes('decreasing WarmThroughput is not supported'));
    const announcement = messages.find((m) => m.includes('were dropped from the request'));
    expect(decrease).toBeDefined();
    // The decrease warning quotes the REQUEST, not the raw bag with the member
    // cdkd already dropped.
    expect(decrease).toContain('{"WriteUnitsPerSecond":2000}');
    // The announcement is a SEPARATE message and must survive the skip (round
    // 7 item 7) — it is the only place the dropped member is named.
    expect(announcement).toBeDefined();
    expect(announcement).toContain('ReadUnitsPerSecond');
  });

  it('accepts a YAML-borne numeric STRING on the desired side', async () => {
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: '6000', WriteUnitsPerSecond: '2000' } },
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
  });

  it('reverts everything ELSE on the resource and leaves only this key (the --revert caller)', async () => {
    // The shape `cdkd drift --revert` produces: the AWS-CURRENT snapshot with
    // the drifted subtrees overlaid from the baseline. The declared warm
    // throughput can never be restored, and the point of skipping rather than
    // throwing is that the resource's OTHER reverts still land.
    primeLiveTable({
      WarmThroughput: LIVE_WARM_THROUGHPUT,
      TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        TableClass: 'STANDARD',
        WarmThroughput: { ReadUnitsPerSecond: 6000, WriteUnitsPerSecond: 2000 },
      },
      {
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
        WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
      }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
    const tableClassUpdates = mockSend.mock.calls
      .filter((c) => c[0] instanceof UpdateTableCommand)
      .map((c) => (c[0] as UpdateTableCommand).input)
      .filter((input) => input.TableClass !== undefined);
    expect(tableClassUpdates.map((i) => i.TableClass)).toEqual(['STANDARD']);
  });

  it('sends NOTHING for an empty or non-object WarmThroughput', async () => {
    // The send rule was bare truthiness, so `{}` went out as
    // `UpdateTable{WarmThroughput: {}}` and a string as
    // `WarmThroughput: 'nonsense'` — calls AWS can only reject, re-issued on
    // every deploy because state records what the template said.
    for (const junk of [{}, 'nonsense', []]) {
      mockSend.mockReset();
      warn.mockReset();
      provider = new DynamoDBTableProvider();
      primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { WarmThroughput: junk },
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
      );

      expect({ junk, calls: warmThroughputUpdates().length }).toEqual({ junk, calls: 0 });
    }
  });

  it('WARNS when the table-level send rule refuses a declared value', async () => {
    // The table-level twin of the per-index warn: the same tightening made a
    // member typo / junk value vanish here with no signal at all.
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecnd: 20000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
    const message = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('carries no usable');
    expect(message).toContain('ReadUnitsPerSecnd');
  });

  it('stays SILENT when WarmThroughput is absent or falsy', async () => {
    for (const declared of [{}, { WarmThroughput: null }]) {
      mockSend.mockReset();
      warn.mockReset();
      provider = new DynamoDBTableProvider();
      primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, declared, {
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      });

      expect({ declared, warned: warn.mock.calls.length }).toEqual({ declared, warned: 0 });
    }
  });

  it('the announcement does NOT claim the value was sent when a gate then skips it', async () => {
    // The announcement fires AHEAD of the gates (round 7 item 7) so a skip
    // cannot swallow it — which made its old tail, "...; {spec} was sent.",
    // false on exactly the paths that motivated the move. Round 8 reworded it
    // to "...which leaves {spec}"; nothing asserted that, so the correction
    // could be reverted silently (PR review round 9).
    //
    // Bound to `which leaves`, which appears at exactly ONE site in the
    // provider — the same uniqueness check that replaced the member-name
    // assertion in round 8. The negative is the semantic half: on a SKIPPED
    // send, the message must not say anything was sent, and it is scoped to
    // the announcement so the decrease warning's own "it was NOT sent" cannot
    // satisfy or break it.
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      // Coerces to `{WriteUnitsPerSecond: 2000}` — a DECREASE against the live
      // {12000, 4000}, so the send is skipped and nothing reaches AWS.
      { WarmThroughput: { ReadUnitsPerSecond: { Ref: 'Unresolved' }, WriteUnitsPerSecond: 2000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
    const announcement = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('were dropped from the request'));
    expect(announcement).toBeDefined();
    expect(announcement).toContain('which leaves {"WriteUnitsPerSecond":2000}');
    expect(announcement).not.toContain('was sent');
  });

  it('does NOT re-warn for an UNCHANGED unsendable value when something else changed', async () => {
    // The table-level twin of the per-index placement fence in
    // `dynamodb-table-provider-index-write-path.test.ts`. Every warn in this
    // provider sits behind a CHANGE gate so an unusable value is announced once,
    // on the deploy that introduces it — hoisting `warnRefusedWarmThroughput`
    // above that gate makes it re-warn on every later deploy that touches
    // anything else on the table, and every other row here CHANGES the value
    // under test, so none of them can see it (PR review round 9).
    primeLiveTable({
      WarmThroughput: LIVE_WARM_THROUGHPUT,
      TableClassSummary: { TableClass: 'STANDARD' },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      // The junk WarmThroughput is IDENTICAL on both sides; only TableClass
      // changed, which is what makes update() do work at all.
      { WarmThroughput: {}, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
      { WarmThroughput: {}, TableClass: 'STANDARD' }
    );

    // The unrelated change still went out, so this is not passing because
    // update() did nothing.
    const tableClassSent = mockSend.mock.calls
      .filter((c) => c[0] instanceof UpdateTableCommand)
      .map((c) => (c[0] as UpdateTableCommand).input)
      .filter((i) => i.TableClass !== undefined);
    expect(tableClassSent.map((i) => i.TableClass)).toEqual(['STANDARD_INFREQUENT_ACCESS']);
    // ...and the untouched junk said nothing.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('carries no usable');
  });

  it('SKIPS on a partially-reported live value, and fails OPEN on the member AWS omits', async () => {
    // AWS reporting only one member is the edge the guard walks member by
    // member: the DECLARED read member is below the live one, so the request is
    // a decrease and must be skipped...
    primeLiveTable({ WarmThroughput: { ReadUnitsPerSecond: 12000, Status: 'ACTIVE' } });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: 6000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 24000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(0);
  });

  it('fails OPEN when the declared member has no live counterpart', async () => {
    // ...while a declared member AWS reports NOTHING for is unresolvable on the
    // live side, so the call still goes out and AWS answers.
    primeLiveTable({ WarmThroughput: { ReadUnitsPerSecond: 12000, Status: 'ACTIVE' } });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { WriteUnitsPerSecond: 2000 } },
      { WarmThroughput: { WriteUnitsPerSecond: 8000 } }
    );

    expect(warmThroughputUpdates()).toHaveLength(1);
  });

  it('returns a usable result rather than throwing — a rollback replay must stay applicable', async () => {
    // The rollback executor's revert arms send `previousState.properties`, a
    // TEMPLATE recorded earlier; a refusal there would leave the resource
    // un-rollbackable with no template-side remedy. Asserted on the RESULT
    // rather than with `resolves.toBeDefined()`, which passes for anything short
    // of a throw — including a result that reported a replacement.
    primeLiveTable({ WarmThroughput: LIVE_WARM_THROUGHPUT });

    const result = await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { WarmThroughput: { ReadUnitsPerSecond: 6000, WriteUnitsPerSecond: 2000 } },
      { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } }
    );

    expect(result.physicalId).toBe(TABLE_NAME);
    expect(result.wasReplaced).toBe(false);
    // No `effectiveProperties`: recording AWS's value would make the drift
    // comparison equal and silence the report the skip deliberately leaves
    // standing on the revert path.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('the warning does NOT promise a drift report the deploy path erases', async () => {
    // The message says a successful deploy re-captures AWS's value as the drift
    // baseline. This drives that mechanism: `deploy-engine.ts`'s observed
    // capture calls `readCurrentState` with the TEMPLATE-resolved bag, which for
    // a DECLARING template emits AWS's CURRENT value — so the baseline equals
    // the next read and `cdkd drift` reports the table CLEAN even though cdkd's
    // template still asks for less. A warning claiming otherwise would be
    // telling the user to wait for a signal that never comes.
    const declared = { TableName: TABLE_NAME, WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } };
    mockSend.mockImplementation(() =>
      Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          // AWS has GROWN past the declared value.
          WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000, Status: 'ACTIVE' },
        },
      })
    );

    const captured = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, declared);
    const current = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, declared);

    expect(captured?.['WarmThroughput']).toEqual({
      ReadUnitsPerSecond: 24000,
      WriteUnitsPerSecond: 8000,
    });
    expect(
      calculateResourceDrift(captured!, current!, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
        unionWalkObjects: true,
      })
    ).toEqual([]);
    // ...whereas the TEMPLATE baseline — which is what `drift --revert` leaves
    // in place, since the skip records nothing — still reports it.
    expect(
      calculateResourceDrift(declared, current!, {
        ignorePaths: provider.getDriftUnknownPaths(RESOURCE_TYPE, declared),
      }).map((d) => d.path)
    ).toEqual(['WarmThroughput.ReadUnitsPerSecond', 'WarmThroughput.WriteUnitsPerSecond']);
  });
});
