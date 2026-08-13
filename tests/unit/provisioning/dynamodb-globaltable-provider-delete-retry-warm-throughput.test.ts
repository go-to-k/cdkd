import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DeleteTableCommand,
  UpdateTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

/**
 * Two defects in `AWS::DynamoDB::GlobalTable`, filed separately and fixed
 * together because they live in the same provider.
 *
 * **Issue #1830** — `cdkd destroy` failed one table out of ten with
 * `Attempt to change a resource which is still in use: Cannot delete table
 * while indexes are being created, updated, or deleted.`, surfaced as a hard
 * `PartialFailureError` with state preserved. The verify script's cleanup pass
 * re-ran `cdkd destroy` seconds later and the SAME table deleted cleanly, so
 * the condition is transient and self-resolving. The pre-existing #1521 gate
 * does not cover it: that gate reads the PRE-DELETE describe, taken before a
 * long auto-scaling teardown sequence, and application auto-scaling can start
 * an index capacity change inside that window.
 *
 * **Issue #1857** — the provider forwarded `WarmThroughput` verbatim at three
 * `UpdateTable` sites and on create: no numeric coercion (CloudFormation is
 * stringly typed, so `'12000'` reached a numeric wire field as a STRING), no
 * decrease guard (warm throughput only rises, and AWS rejects a call that
 * lowers it), and no refusal warning (a malformed block was forwarded into an
 * opaque AWS validation error naming neither cdkd nor the property).
 */

const { mockSend, mockAutoScalingSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  DynamoDBGlobalTableProvider,
  deleteTableRetryDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
// The two WarmThroughput RULES live in a module both DynamoDB providers read,
// so `AWS::DynamoDB::Table` (issue #1808) and `AWS::DynamoDB::GlobalTable`
// (issue #1857) cannot answer the same question differently. Exercised from
// here because this is the suite that owns the GlobalTable send sites reading
// them; `dynamodb-table-provider-warm-throughput*.test.ts` exercises the same
// module through the sibling provider's four write sites.
import {
  coerceWarmThroughput,
  isWarmThroughputDecrease,
} from '../../../src/provisioning/dynamodb-warm-throughput.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'warm-table';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:123:table/${TABLE_NAME}`;

/**
 * The refusal AWS raised on the real 2026-08-13 destroy, verbatim — including
 * the `ResourceInUseException` NAME it arrives under and the generic
 * "Attempt to change a resource which is still in use:" prefix that wraps it.
 * The name is deliberately part of the fixture: it is shared with the terminal
 * conflicts below, which is why the classifier keys on the MESSAGE.
 */
function indexBusyError(): ResourceInUseException {
  return new ResourceInUseException({
    message:
      'Attempt to change a resource which is still in use: Cannot delete table while ' +
      'indexes are being created, updated, or deleted.',
    $metadata: {},
  });
}

/**
 * A `ResourceInUseException` that is NOT self-clearing: deleting a table that
 * is still being created never succeeds by waiting for an index. Same
 * exception name, same prefix — so a classifier that keyed on the name (or on
 * the prefix) would burn the whole retry budget and then fail identically.
 */
function terminalInUseError(): ResourceInUseException {
  return new ResourceInUseException({
    message: `Attempt to change a resource which is still in use: Table is being created: ${TABLE_NAME}`,
    $metadata: {},
  });
}

function newRnf(): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: 'not found', $metadata: {} });
}

const LIVE_TABLE = {
  TableName: TABLE_NAME,
  TableArn: TABLE_ARN,
  TableId: 'tid-1',
  TableStatus: 'ACTIVE',
  // ACTIVE on purpose: the #1521 pre-delete gate must NOT fire, so anything
  // these tests observe is the #1830 retry rather than the older wait.
  GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
  Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
};

/**
 * `DeleteTable` fails `failures` times with `error`, then succeeds.
 * `DescribeTable` serves the live table until the delete lands and raises
 * `ResourceNotFoundException` afterwards, so `waitForTableGone` terminates.
 */
function stubDeleteFailingTimes(failures: number, error: () => Error): { attempts: () => number } {
  let attempts = 0;
  let deleted = false;
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeTableCommand) {
      return deleted ? Promise.reject(newRnf()) : Promise.resolve({ Table: LIVE_TABLE });
    }
    if (command instanceof DeleteTableCommand) {
      attempts += 1;
      if (attempts <= failures) return Promise.reject(error());
      deleted = true;
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  return { attempts: () => attempts };
}

const deleteCommands = (): DeleteTableCommand[] =>
  mockSend.mock.calls
    .map((c) => c[0])
    .filter((c): c is DeleteTableCommand => c instanceof DeleteTableCommand);

const gsiUpdateCommands = (): UpdateTableCommand[] =>
  mockSend.mock.calls
    .map((c) => c[0])
    .filter(
      (c): c is UpdateTableCommand =>
        c instanceof UpdateTableCommand &&
        (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Update !== undefined)
    );

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

describe('DynamoDBGlobalTable delete retry on the index-busy refusal (issue #1830)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    // Skip `withRetry`'s real ~47s backoff. Set per-suite rather than
    // per-test so no test can silently pay it if an expectation moves.
    deleteTableRetryDelays.sleep = () => Promise.resolve();
    provider = new DynamoDBGlobalTableProvider();
  });

  afterEach(() => {
    delete deleteTableRetryDelays.sleep;
  });

  it('retries the transient index-busy refusal instead of failing the destroy', async () => {
    const stub = stubDeleteFailingTimes(1, indexBusyError);

    await expect(
      provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {})
    ).resolves.toBeUndefined();

    // Two sends, not one: the pre-fix provider issued exactly one and
    // converted the refusal into a ProvisioningError.
    expect(stub.attempts()).toBe(2);
    expect(deleteCommands().map((c) => c.input.TableName)).toEqual([TABLE_NAME, TABLE_NAME]);
  });

  it('re-polls the index state between attempts rather than only sleeping', async () => {
    // The backoff grid alone cannot cover an index BACKFILL, which outlasts
    // any fixed schedule. Each retry therefore re-runs the settle poll, which
    // returns on its first DescribeTable once the index is ACTIVE. Measured
    // as "a DescribeTable happened between the failed delete and the retry":
    // a regression that dropped the re-arm leaves the two deletes adjacent.
    stubDeleteFailingTimes(1, indexBusyError);

    await provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {});

    const kinds = mockSend.mock.calls.map((c) => {
      if (c[0] instanceof DeleteTableCommand) return 'delete';
      if (c[0] instanceof DescribeTableCommand) return 'describe';
      return 'other';
    });
    const firstDelete = kinds.indexOf('delete');
    const secondDelete = kinds.indexOf('delete', firstDelete + 1);
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(secondDelete).toBeGreaterThan(firstDelete);
    expect(kinds.slice(firstDelete + 1, secondDelete)).toContain('describe');
  });

  it('does NOT retry a ResourceInUseException that is not the index-busy one', async () => {
    // The exception NAME and the "still in use" prefix are shared with
    // genuinely terminal conflicts, so the classifier keys on the message
    // clause. Pinned by its exact emitted shape, not by "it threw": a
    // name-keyed classifier would also end up throwing here, just 47s later
    // and after 9 sends.
    const stub = stubDeleteFailingTimes(Number.POSITIVE_INFINITY, terminalInUseError);

    await expect(provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {})).rejects.toThrow(
      `Failed to delete DynamoDB GlobalTable Warm: Attempt to change a resource which is ` +
        `still in use: Table is being created: ${TABLE_NAME}`
    );
    expect(stub.attempts()).toBe(1);
  });

  it('gives up after the bounded budget instead of retrying forever', async () => {
    // A condition that never clears must still terminate, and must surface the
    // real AWS sentence rather than a cdkd-invented timeout message.
    const stub = stubDeleteFailingTimes(Number.POSITIVE_INFINITY, indexBusyError);

    await expect(provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {})).rejects.toThrow(
      'Failed to delete DynamoDB GlobalTable Warm: Attempt to change a resource which is ' +
        'still in use: Cannot delete table while indexes are being created, updated, or deleted.'
    );
    // DELETE_INDEX_BUSY_MAX_RETRIES (8) retries after the first attempt.
    expect(stub.attempts()).toBe(9);
  });
});

describe('WarmThroughput coercion helpers (issue #1857)', () => {
  it('coerces a stringly-typed CFn member to a number', () => {
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: '12000' })).toEqual({
      spec: { ReadUnitsPerSecond: 12000 },
      droppedMembers: [],
    });
  });

  it('produces a wire-identical block for a quoted and an already-numeric value', () => {
    // The whole point of coercion: the two templates must be indistinguishable
    // downstream. Compared by SERIALIZATION, not by `toEqual`, because
    // `toEqual` treats 12000 and '12000' as different anyway while a member
    // ORDER divergence — which does change the wire bytes — it would miss.
    const quoted = coerceWarmThroughput({ ReadUnitsPerSecond: '12000', WriteUnitsPerSecond: '4000' });
    const numeric = coerceWarmThroughput({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 });
    expect(JSON.stringify(quoted.spec)).toBe(JSON.stringify(numeric.spec));
    expect(JSON.stringify(quoted.spec)).toBe('{"ReadUnitsPerSecond":12000,"WriteUnitsPerSecond":4000}');
  });

  it('emits members in a fixed order regardless of the template order', () => {
    const reversed = coerceWarmThroughput({ WriteUnitsPerSecond: 4000, ReadUnitsPerSecond: 12000 });
    expect(JSON.stringify(reversed.spec)).toBe(
      '{"ReadUnitsPerSecond":12000,"WriteUnitsPerSecond":4000}'
    );
  });

  it('drops only the unusable member and NAMES it, sending the usable one', () => {
    expect(
      coerceWarmThroughput({ ReadUnitsPerSecond: '12000', WriteUnitsPerSecond: { Ref: 'Unresolved' } })
    ).toEqual({
      spec: { ReadUnitsPerSecond: 12000 },
      droppedMembers: ['WriteUnitsPerSecond'],
    });
  });

  it('refuses the whole block when no member is usable', () => {
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: { Ref: 'Unresolved' } })).toEqual({
      droppedMembers: ['ReadUnitsPerSecond'],
    });
    // Present-but-not-an-object: no member to name, so no dropped list.
    expect(coerceWarmThroughput('nonsense')).toEqual({ droppedMembers: [] });
    // An empty declaration asks for nothing; there is nothing to send.
    expect(coerceWarmThroughput({})).toEqual({ droppedMembers: [] });
  });

  it('reports an ABSENT member as absent rather than as dropped', () => {
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: 12000 })).toEqual({
      spec: { ReadUnitsPerSecond: 12000 },
      droppedMembers: [],
    });
  });

  it('answers sendability through the ONE predicate — the presence of `spec`', () => {
    // Anything asking "should this be sent?" tests `spec` rather than deriving
    // a second opinion about the same bag; a second spelling is what
    // eventually disagrees with the coercion that builds the request.
    // `dynamodb-table-provider.ts` names that test `isSendableWarmThroughput`
    // and defines it AS this success, so the two providers agree structurally.
    // Both polarities pinned so a future refactor cannot make `spec` present
    // for an unusable bag or absent for a usable one.
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: '12000' }).spec).toBeDefined();
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: { Ref: 'X' } }).spec).toBeUndefined();
    expect(coerceWarmThroughput(undefined).spec).toBeUndefined();
  });

  it('refuses a WHITESPACE-only member instead of reading it as zero', () => {
    // The ONE input the two providers' independent spellings disagreed on
    // before they were merged (issue #1857 vs issue #1808): a bare
    // `Number('   ')` is 0, not NaN, so a naive coercion would have sent a
    // request for zero warm units — a value nobody declared and one AWS
    // cannot honour. The shared rule takes the REFUSING answer, and NAMES the
    // member so the refusal message can say which half was unusable.
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: '   ' })).toEqual({
      droppedMembers: ['ReadUnitsPerSecond'],
    });
    // The usable half of a partially-whitespace block still goes out.
    expect(
      coerceWarmThroughput({ ReadUnitsPerSecond: '\t\n', WriteUnitsPerSecond: 4000 })
    ).toEqual({
      spec: { WriteUnitsPerSecond: 4000 },
      droppedMembers: ['ReadUnitsPerSecond'],
    });
  });
});

describe('isWarmThroughputDecrease (issue #1857)', () => {
  it('is a decrease when every declared member is at-or-below live and one is strictly below', () => {
    expect(
      isWarmThroughputDecrease(
        { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
        { ReadUnitsPerSecond: 20000, WriteUnitsPerSecond: 4000 }
      )
    ).toBe(true);
  });

  it('is NOT a decrease when the value is unchanged', () => {
    expect(
      isWarmThroughputDecrease({ ReadUnitsPerSecond: 12000 }, { ReadUnitsPerSecond: 12000 })
    ).toBe(false);
  });

  it('is NOT a decrease when the value rises — the increase must still be sent', () => {
    expect(
      isWarmThroughputDecrease({ ReadUnitsPerSecond: 20000 }, { ReadUnitsPerSecond: 12000 })
    ).toBe(false);
  });

  it('fails OPEN on a MIXED block: one member down, one up is a real increase', () => {
    expect(
      isWarmThroughputDecrease(
        { ReadUnitsPerSecond: 8000, WriteUnitsPerSecond: 9000 },
        { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }
      )
    ).toBe(false);
  });

  it('considers DECLARED members only — an absent member cannot lower anything', () => {
    // Write is 4000 live and not declared at all. Only the declared read half
    // decides, and it IS below live.
    expect(
      isWarmThroughputDecrease(
        { ReadUnitsPerSecond: 8000 },
        { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }
      )
    ).toBe(true);
  });

  it('fails OPEN when the live side is absent or has no counterpart', () => {
    expect(isWarmThroughputDecrease({ ReadUnitsPerSecond: 8000 }, undefined)).toBe(false);
    expect(
      isWarmThroughputDecrease({ ReadUnitsPerSecond: 8000 }, { WriteUnitsPerSecond: 4000 })
    ).toBe(false);
  });

  it('fails OPEN when nothing is declared', () => {
    expect(isWarmThroughputDecrease({}, { ReadUnitsPerSecond: 12000 })).toBe(false);
    expect(isWarmThroughputDecrease(undefined, { ReadUnitsPerSecond: 12000 })).toBe(false);
  });
});

/**
 * Property bag shaped like a `cdk synth` of `dynamodb.TableV2` with one
 * on-demand GSI carrying a `WarmThroughput` block. `warm` is injected raw so a
 * test can pin the stringly-typed form CloudFormation really produces.
 */
/**
 * Sentinel for "declare no on-demand ceiling at all". A plain `undefined` would
 * hit the default-parameter value instead, which is the same 50 the other tests
 * use — and the on-demand block is exactly what a decrease test must NOT carry.
 */
const NO_ON_DEMAND = null;

function propsWithWarm(warm: unknown, maxRead: number | null = 50): Record<string, unknown> {
  return {
    TableName: TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'g1pk', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ...(warm !== undefined && { WarmThroughput: warm }),
      },
    ],
    Replicas: [
      {
        Region: 'us-east-1',
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            ...(maxRead !== null && {
              ReadOnDemandThroughputSettings: { MaxReadRequestUnits: maxRead },
            }),
          },
        ],
      },
    ],
  };
}

/** `DescribeTable` always answers with the given live per-index warm block. */
function stubLiveWarm(live: Record<string, unknown> | undefined): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableId: 'tid-1',
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              IndexStatus: 'ACTIVE',
              ...(live !== undefined && { WarmThroughput: live }),
            },
          ],
          Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
        },
      });
    }
    return Promise.resolve({});
  });
}

describe('WarmThroughput on the wire (issue #1857)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  it('sends a quoted WarmThroughput as a NUMBER on update', async () => {
    stubLiveWarm({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' });
    const previous = propsWithWarm({ ReadUnitsPerSecond: 12000 });
    const next = propsWithWarm({ ReadUnitsPerSecond: '15000' });

    await provider.update('Warm', TABLE_NAME, RESOURCE_TYPE, next, previous);

    const updates = gsiUpdateCommands();
    expect(updates).toHaveLength(1);
    const warm = updates[0]!.input.GlobalSecondaryIndexUpdates![0]!.Update!.WarmThroughput;
    // The regression forwarded the raw bag, so this pins the exact shape it
    // would emit: a STRING in a numeric field.
    expect(warm).toEqual({ ReadUnitsPerSecond: 15000 });
    expect(typeof warm!.ReadUnitsPerSecond).toBe('number');
    expect(JSON.stringify(warm)).toBe('{"ReadUnitsPerSecond":15000}');
  });

  it('sends a byte-identical block whether the template quoted the number or not', async () => {
    stubLiveWarm({ ReadUnitsPerSecond: 12000 });
    const capture = async (declaredRead: unknown): Promise<string> => {
      mockSend.mockClear();
      await provider.update(
        'Warm',
        TABLE_NAME,
        RESOURCE_TYPE,
        propsWithWarm({ ReadUnitsPerSecond: declaredRead }),
        propsWithWarm({ ReadUnitsPerSecond: 12000 })
      );
      return JSON.stringify(
        gsiUpdateCommands()[0]!.input.GlobalSecondaryIndexUpdates![0]!.Update!.WarmThroughput
      );
    };

    const quoted = await capture('15000');
    const numeric = await capture(15000);
    expect(quoted).toBe(numeric);
    // Pinned literally too: an equality that both sides satisfy as `undefined`
    // would pass while proving nothing.
    expect(quoted).toBe('{"ReadUnitsPerSecond":15000}');
  });

  it('still sends an INCREASE — the guard must not swallow a real capacity change', async () => {
    stubLiveWarm({ ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' });
    const previous = propsWithWarm({ ReadUnitsPerSecond: 12000 });
    const next = propsWithWarm({ ReadUnitsPerSecond: 20000 });

    await provider.update('Warm', TABLE_NAME, RESOURCE_TYPE, next, previous);

    const updates = gsiUpdateCommands();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.GlobalSecondaryIndexUpdates![0]!.Update!.WarmThroughput).toEqual({
      ReadUnitsPerSecond: 20000,
    });
    expect(warnings().filter((w) => w.includes('decreasing WarmThroughput'))).toHaveLength(0);
  });

  it('refuses a DECREASE, names the property, and issues no UpdateTable for it', async () => {
    // AWS has grown the value past what the template declares. The pre-fix
    // provider issued a call that can only fail; `drift --revert` re-issued it
    // on every run.
    stubLiveWarm({ ReadUnitsPerSecond: 20000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' });
    // No on-demand ceilings on either side, so the decrease is the index's
    // ONLY change — which makes "was any call issued at all?" the assertion.
    const previous = propsWithWarm({ ReadUnitsPerSecond: 20000 }, NO_ON_DEMAND);
    const next = propsWithWarm({ ReadUnitsPerSecond: 12000 }, NO_ON_DEMAND);

    await provider.update('Warm', TABLE_NAME, RESOURCE_TYPE, next, previous);

    // The regression's shape: a GSI Update carrying the doomed member,
    // i.e. `[{Update: {IndexName: 'gsi1', WarmThroughput: {ReadUnitsPerSecond: 12000}}}]`.
    expect(gsiUpdateCommands()).toHaveLength(0);
    const decrease = warnings().filter((w) => w.includes('WarmThroughput was NOT sent'));
    expect(decrease).toHaveLength(1);
    expect(decrease[0]).toContain("GSI 'gsi1'");
    expect(decrease[0]).toContain('ReadUnitsPerSecond=12000');
    expect(decrease[0]).toContain('ReadUnitsPerSecond=20000');
    // A refused decrease must NOT also draw the immutable-field advice: it
    // would tell the user to recreate the index, which cannot lower a warm
    // throughput AWS itself raised.
    expect(warnings().filter((w) => w.includes('KeySchema / Projection are immutable'))).toEqual(
      []
    );
  });

  it('applies the rest of the index change while refusing only the decrease', async () => {
    // The decrease must not cost the user the edit they actually made.
    stubLiveWarm({ ReadUnitsPerSecond: 20000, Status: 'ACTIVE' });
    const previous = propsWithWarm({ ReadUnitsPerSecond: 20000 }, 50);
    const next = propsWithWarm({ ReadUnitsPerSecond: 12000 }, 99);

    await provider.update('Warm', TABLE_NAME, RESOURCE_TYPE, next, previous);

    const updates = gsiUpdateCommands();
    expect(updates).toHaveLength(1);
    const update = updates[0]!.input.GlobalSecondaryIndexUpdates![0]!.Update!;
    expect(update.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 99 });
    expect(update.WarmThroughput).toBeUndefined();
  });

  it('sends WarmThroughput on a newly ADDED index, which has no live value to decrease from', async () => {
    stubLiveWarm(undefined);
    const previous = propsWithWarm(undefined);
    (previous['GlobalSecondaryIndexes'] as unknown[]).length = 0;
    const next = propsWithWarm({ ReadUnitsPerSecond: '18000' });

    await provider.update('Warm', TABLE_NAME, RESOURCE_TYPE, next, previous);

    const creates = mockSend.mock.calls
      .map((c) => c[0])
      .filter(
        (c): c is UpdateTableCommand =>
          c instanceof UpdateTableCommand &&
          (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Create !== undefined)
      );
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input.GlobalSecondaryIndexUpdates![0]!.Create!.WarmThroughput).toEqual({
      ReadUnitsPerSecond: 18000,
    });
  });

  it('refuses an unusable block on create, naming the property instead of forwarding it', async () => {
    mockSend.mockResolvedValue({
      Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableId: 'tid-1', TableStatus: 'ACTIVE' },
    });

    await provider.create('Warm', RESOURCE_TYPE, propsWithWarm({ ReadUnitsPerSecond: { Ref: 'X' } }));

    const creates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is CreateTableCommand => c instanceof CreateTableCommand);
    expect(creates).toHaveLength(1);
    // The regression's shape: `{ReadUnitsPerSecond: {Ref: 'X'}}` forwarded
    // into a numeric wire field.
    expect(creates[0]!.input.GlobalSecondaryIndexes![0]!.WarmThroughput).toBeUndefined();
    const refusal = warnings().filter((w) => w.includes('WarmThroughput is declared but no member'));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain("GSI 'gsi1'");
    expect(refusal[0]).toContain('ReadUnitsPerSecond');
  });

  it('sends the usable half of a partial block on create and names the dropped half', async () => {
    mockSend.mockResolvedValue({
      Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableId: 'tid-1', TableStatus: 'ACTIVE' },
    });

    await provider.create(
      'Warm',
      RESOURCE_TYPE,
      propsWithWarm({ ReadUnitsPerSecond: '12000', WriteUnitsPerSecond: { Ref: 'X' } })
    );

    const creates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is CreateTableCommand => c instanceof CreateTableCommand);
    expect(creates[0]!.input.GlobalSecondaryIndexes![0]!.WarmThroughput).toEqual({
      ReadUnitsPerSecond: 12000,
    });
    const dropped = warnings().filter((w) => w.includes('WarmThroughput.WriteUnitsPerSecond'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('was DROPPED');
    expect(dropped[0]).toContain('ReadUnitsPerSecond is still sent');
  });
});
