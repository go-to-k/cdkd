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
// (issue #1857) cannot answer the same question differently. The RULE is
// pinned in `dynamodb-warm-throughput.test.ts`, named for the module so a
// third consumer's author finds it; this file exercises it through THIS
// provider's send sites, and `dynamodb-table-provider-warm-throughput*.test.ts`
// through the sibling's.

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

  it('matches the refusal case-INSENSITIVELY (the classifier`s /i flag)', async () => {
    // The clause arrives inside a wrapper prefix whose casing is not ours, so
    // the classifier is anchored with `/i`. Nothing else in the suite exercises
    // that flag, and a regression dropping it turns this run into the
    // one-attempt hard failure the `terminalInUseError` case pins.
    const stub = stubDeleteFailingTimes(
      1,
      () =>
        new ResourceInUseException({
          message:
            'ATTEMPT TO CHANGE A RESOURCE WHICH IS STILL IN USE: CANNOT DELETE TABLE WHILE ' +
            'INDEXES ARE BEING CREATED, UPDATED, OR DELETED.',
          $metadata: {},
        })
    );

    await expect(provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {})).resolves.toBeUndefined();
    expect(stub.attempts()).toBe(2);
  });

  it('WARNS once at default verbosity when it starts absorbing the refusal', async () => {
    // `withRetry` announces its retries through `opts.logger?.debug`, so
    // without this line a delete spending minutes re-polling printed NOTHING
    // naming the cause — and the bounded re-arm below can end in a timeout that
    // has to be diagnosable from an ordinary run's output.
    const stub = stubDeleteFailingTimes(2, indexBusyError);

    await provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {});

    expect(stub.attempts()).toBe(3);
    const refusalWarnings = warnings().filter((w) => w.includes('AWS refused DeleteTable'));
    // ONE line even across two retries: this announces the CONDITION, not each
    // attempt (which is what `withRetry`'s debug line already does).
    expect(refusalWarnings).toHaveLength(1);
    expect(refusalWarnings[0]).toContain(TABLE_NAME);
    expect(refusalWarnings[0]).toContain('global secondary index');
    // It must NOT carry AWS's own sentence: `verify.sh` step 15b greps the
    // destroy log for `Cannot delete table while indexes are being` to prove
    // AWS really refused, and a cdkd-authored copy would satisfy that grep
    // without the refusal having happened.
    expect(refusalWarnings[0]).not.toContain('Cannot delete table while indexes are being');
  });

  it('counts the REMAINING attempts in the warning, not the whole retry budget', async () => {
    // The line fires from inside attempt 2 of `1 + DELETE_INDEX_BUSY_MAX_RETRIES`
    // (= 9), so 7 attempts are left, not 8. It shipped saying 8 because the
    // number was the raw `DELETE_INDEX_BUSY_MAX_RETRIES` constant — a promise
    // of one more attempt than the loop can actually make. Pinned as an exact
    // phrase: an off-by-one here is invisible to a reader and only ever
    // discovered by someone counting the retries in the log.
    stubDeleteFailingTimes(1, indexBusyError);

    await provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {});

    const refusalWarnings = warnings().filter((w) => w.includes('AWS refused DeleteTable'));
    expect(refusalWarnings).toHaveLength(1);
    expect(refusalWarnings[0]).toContain('up to 7 more attempts');
    // ...and the settle budget is stated as POLLS, not as seconds: the
    // constant is a DescribeTable count, and rendering it as `60s` claimed a
    // wall clock the loop does not have (each poll also pays a round trip).
    expect(refusalWarnings[0]).toContain('up to 60 DescribeTable polls');
    expect(refusalWarnings[0]).not.toMatch(/\b60s\b/);
  });

  it('does not warn when the delete succeeds first time', async () => {
    stubDeleteFailingTimes(0, indexBusyError);

    await provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {});

    expect(warnings().filter((w) => w.includes('AWS refused DeleteTable'))).toHaveLength(0);
  });

  it('reads the sleep seam at CALL time, not when the retry options are built', async () => {
    // Set the seam from INSIDE the first refusal — i.e. after `delete()` has
    // already built `withRetry`'s options bag. A spread-at-construction seam
    // captures `undefined` there and silently falls back to the real ~47s
    // schedule; reading it per sleep picks the override up.
    delete deleteTableRetryDelays.sleep;
    const sleepSpy = vi.fn(() => Promise.resolve());
    let attempts = 0;
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return deleted ? Promise.reject(newRnf()) : Promise.resolve({ Table: LIVE_TABLE });
      }
      if (command instanceof DeleteTableCommand) {
        attempts += 1;
        if (attempts === 1) {
          deleteTableRetryDelays.sleep = sleepSpy;
          return Promise.reject(indexBusyError());
        }
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await provider.delete('Warm', TABLE_NAME, RESOURCE_TYPE, {});

    expect(attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalled();
  });
});

/**
 * The wall-clock half of issue #1830, which the retry-count tests above cannot
 * see: every retry RE-RUNS the settle poll, so the count MULTIPLIES the poll.
 * Driven on fake timers because the quantities under test are minutes.
 */
describe('DynamoDBGlobalTable index-busy delete retry: wall-clock budget (issue #1830)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    deleteTableRetryDelays.sleep = () => Promise.resolve();
    provider = new DynamoDBGlobalTableProvider();
  });

  afterEach(() => {
    delete deleteTableRetryDelays.sleep;
    vi.useRealTimers();
  });

  /** Advance virtual time in 1s steps until `settled` or `maxSeconds` elapse. */
  async function drive(settled: () => boolean, maxSeconds: number): Promise<number> {
    for (let second = 1; second <= maxSeconds; second++) {
      if (settled()) return second;
      await vi.advanceTimersByTimeAsync(1000);
    }
    return maxSeconds;
  }

  it('bounds the per-retry re-arm poll instead of re-running the 15-minute one', async () => {
    // The index NEVER settles after the first delete attempt, so every re-arm
    // poll runs to its cap. With the cap at `waitForIndexesActive`'s 15-minute
    // default the budget is 8 x 900s ~= 2h — inside a call `destroy-runner.ts`
    // caps at 30 min, so a genuinely stuck index produced a 30-minute wait and
    // a generic `ResourceTimeoutError` that never mentions indexes, instead of
    // AWS's own actionable sentence. Bounded, the whole sequence is
    // 8 x 60s + `withRetry`'s backoff, so it SETTLES inside the window driven
    // below; unbounded, the FIRST re-arm poll alone outlasts it and the
    // promise is still pending when the drive gives up.
    let deleteAttempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return Promise.resolve({
          Table: {
            ...LIVE_TABLE,
            // ACTIVE until the first delete goes out, so the #1521 pre-delete
            // gate (which keeps its full 15-minute poll) never fires and this
            // test measures only the #1830 re-arm.
            GlobalSecondaryIndexes: [
              { IndexName: 'gsi1', IndexStatus: deleteAttempts === 0 ? 'ACTIVE' : 'UPDATING' },
            ],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        deleteAttempts += 1;
        return Promise.reject(indexBusyError());
      }
      return Promise.resolve({});
    });

    let settled = false;
    const outcome = provider
      .delete('Warm', TABLE_NAME, RESOURCE_TYPE, {})
      .then(
        () => 'resolved',
        () => 'rejected'
      )
      .finally(() => {
        settled = true;
      });

    // 700 virtual seconds: comfortably past the bounded 8 x 60s of polling,
    // and well short of even ONE 900s poll.
    await drive(() => settled, 700);

    expect(settled).toBe(true);
    await expect(outcome).resolves.toBe('rejected');
    // 1 initial + DELETE_INDEX_BUSY_MAX_RETRIES (8).
    expect(deleteAttempts).toBe(9);
  });

  it('keeps waiting through a THROTTLED DescribeTable rather than treating it as settled', async () => {
    // A throttled describe says nothing about the indexes. Reading it as
    // "settled" degraded the re-arm to no wait at all, so every retry burned
    // inside `withRetry`'s ~47s grid against a condition needing minutes.
    // Driven through the #1521 pre-delete gate, which is the same poll.
    const throttle = (): Error =>
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    let describes = 0;
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        describes += 1;
        if (deleted) return Promise.reject(newRnf());
        // 1: the pre-delete describe, reporting a TRANSITIONING index so the
        //    #1521 gate fires.
        // 2-4: the gate's poll, throttled.
        // 5+: settled.
        if (describes === 1) {
          return Promise.resolve({
            Table: {
              ...LIVE_TABLE,
              GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'UPDATING' }],
            },
          });
        }
        if (describes <= 4) return Promise.reject(throttle());
        return Promise.resolve({ Table: LIVE_TABLE });
      }
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    let settled = false;
    const outcome = provider
      .delete('Warm', TABLE_NAME, RESOURCE_TYPE, {})
      .then(
        () => 'resolved',
        (e: unknown) => String(e)
      )
      .finally(() => {
        settled = true;
      });
    await drive(() => settled, 60);

    await expect(outcome).resolves.toBe('resolved');
    // Pre-delete + 3 throttled polls + the settled one: the poll SURVIVED the
    // throttles. Returning on the first one leaves this at 2.
    expect(
      mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof DescribeTableCommand)
        // Only the describes issued BEFORE the delete belong to the wait.
        .length
    ).toBeGreaterThanOrEqual(5);
  });

  it('WARNS and proceeds when the settle poll`s DescribeTable fails for another reason', async () => {
    // Giving up the WAIT is right — a delete path must tolerate a stale read
    // rather than fail fast — but doing it at debug level made the degradation
    // invisible. The operation still goes ahead and AWS stays the backstop.
    let describes = 0;
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        describes += 1;
        if (deleted) return Promise.reject(newRnf());
        if (describes === 1) {
          return Promise.resolve({
            Table: {
              ...LIVE_TABLE,
              GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'UPDATING' }],
            },
          });
        }
        return Promise.reject(new Error('AccessDeniedException: not authorized'));
      }
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    let settled = false;
    const outcome = provider
      .delete('Warm', TABLE_NAME, RESOURCE_TYPE, {})
      .then(
        () => 'resolved',
        (e: unknown) => String(e)
      )
      .finally(() => {
        settled = true;
      });
    await drive(() => settled, 60);

    await expect(outcome).resolves.toBe('resolved');
    const stopped = warnings().filter((w) => w.includes('DescribeTable failed while waiting'));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain('not authorized');
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

/**
 * A GSI carrying `WarmThroughput` on a PROVISIONED table, for the billing-flip
 * ride-along. `maxRead` has no place here — an on-demand ceiling cannot be sent
 * under PROVISIONED — so the per-index capacity is what varies instead.
 */
function provisionedPropsWithWarm(
  billingMode: 'PROVISIONED' | 'PAY_PER_REQUEST',
  warm: unknown,
  readCapacity = 5
): Record<string, unknown> {
  return {
    TableName: TABLE_NAME,
    BillingMode: billingMode,
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
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 10 },
        },
        ...(warm !== undefined && { WarmThroughput: warm }),
      },
    ],
    Replicas: [
      {
        Region: 'us-east-1',
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            ReadProvisionedThroughputSettings: { ReadCapacityUnits: readCapacity },
          },
        ],
      },
    ],
  };
}

/**
 * `DescribeTable` for the flip: the table is still PAY_PER_REQUEST (which is
 * what makes the next deploy a flip) and its gsi1 reports a live warm value.
 */
function stubLiveFlipWarm(live: Record<string, unknown> | undefined): void {
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

/** The `GlobalSecondaryIndexUpdates` of the UpdateTable that carries the flip. */
const billingFlipIndexUpdates = (): Array<Record<string, unknown>> => {
  const flip = mockSend.mock.calls
    .map((c) => c[0])
    .find(
      (c): c is UpdateTableCommand =>
        c instanceof UpdateTableCommand && c.input.BillingMode !== undefined
    );
  return (flip?.input.GlobalSecondaryIndexUpdates ?? []) as Array<Record<string, unknown>>;
};

/**
 * The billing-flip RIDE-ALONG (issue #1857), which no other test in the
 * provisioning suite reaches.
 *
 * Every other WarmThroughput wire test runs PAY_PER_REQUEST on both sides, so
 * `oldBilling === newBilling` and step 4's flip branch never executes at all.
 * A code review replaced the guarded `warmToSend` with a bare
 * `gsi.WarmThroughput` and the ENTIRE suite stayed green — this describe is
 * what makes that mutation fail.
 *
 * The direction is PAY_PER_REQUEST -> PROVISIONED, which is where the site
 * lives: AWS requires per-index `ProvisionedThroughput` in the same UpdateTable
 * that flips a table TO provisioned, so the ride-along exists only on that arm.
 */
describe('WarmThroughput on the billing-flip ride-along (issue #1857)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  it('rides a changed WarmThroughput along with the flip when it is an INCREASE', async () => {
    // The positive polarity first: the ride-along has to keep working, or a
    // guard that returned `undefined` unconditionally would satisfy the
    // decrease case below while silently dropping every legitimate change.
    stubLiveFlipWarm({ ReadUnitsPerSecond: 12000, Status: 'ACTIVE' });
    const previous = provisionedPropsWithWarm('PAY_PER_REQUEST', { ReadUnitsPerSecond: 12000 });
    const next = provisionedPropsWithWarm('PROVISIONED', { ReadUnitsPerSecond: 20000 });

    await provider.update('Warm', TABLE_NAME, RESOURCE_TYPE, next, previous);

    const updates = billingFlipIndexUpdates();
    expect(updates).toHaveLength(1);
    const update = updates[0]!['Update'] as Record<string, unknown>;
    expect(update['IndexName']).toBe('gsi1');
    expect(update['ProvisionedThroughput']).toBeDefined();
    expect(update['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 20000 });
  });

  it('does NOT ride a DECREASE along, and still carries the ProvisionedThroughput the flip needs', async () => {
    // The template has fallen behind a value AWS grew on its own. Forwarding
    // the doomed member fails the WHOLE flip — a `ValidationException` on a
    // property the user was not changing — so the member is dropped and the
    // flip goes out intact. The regression's shape is
    // `WarmThroughput: {ReadUnitsPerSecond: 12000}` on this very Update.
    stubLiveFlipWarm({ ReadUnitsPerSecond: 20000, Status: 'ACTIVE' });
    const previous = provisionedPropsWithWarm('PAY_PER_REQUEST', { ReadUnitsPerSecond: 20000 });
    const next = provisionedPropsWithWarm('PROVISIONED', { ReadUnitsPerSecond: 12000 });

    await provider.update('Warm', TABLE_NAME, RESOURCE_TYPE, next, previous);

    const updates = billingFlipIndexUpdates();
    expect(updates).toHaveLength(1);
    const update = updates[0]!['Update'] as Record<string, unknown>;
    expect(update['IndexName']).toBe('gsi1');
    // The flip itself is unharmed — this is the whole reason the member is
    // dropped rather than the update refused.
    expect(update['ProvisionedThroughput']).toBeDefined();
    expect(update['WarmThroughput']).toBeUndefined();

    const refusal = warnings().filter((w) => w.includes('WarmThroughput was NOT sent'));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain("GSI 'gsi1'");
    expect(refusal[0]).toContain('ReadUnitsPerSecond=12000');
    expect(refusal[0]).toContain('ReadUnitsPerSecond=20000');
    // Both sides always render at least one member here — `isWarmThroughputDecrease`
    // answers `true` only when a declared member is strictly below a finite
    // live counterpart — so the empty-render placeholder an earlier cut carried
    // was unreachable and is gone. Pinned so it cannot come back as an
    // untestable branch.
    expect(refusal[0]).not.toContain('(none)');
  });

  it('skips the live-warm baseline for an index whose live block carries only Status', async () => {
    // `DescribeTable` reports `WarmThroughput: {Status: 'UPDATING'}` with no
    // units while the value is being applied. The live map's
    // `Object.keys(spec).length > 0` gate drops that entry, so the guard has no
    // counterpart to compare against and FAILS OPEN — AWS, not cdkd, decides.
    // Without a test feeding this shape the gate was pure assertion.
    stubLiveFlipWarm({ Status: 'UPDATING' });
    const previous = provisionedPropsWithWarm('PAY_PER_REQUEST', { ReadUnitsPerSecond: 20000 });
    const next = provisionedPropsWithWarm('PROVISIONED', { ReadUnitsPerSecond: 12000 });

    await provider.update('Warm', TABLE_NAME, RESOURCE_TYPE, next, previous);

    const update = billingFlipIndexUpdates()[0]!['Update'] as Record<string, unknown>;
    // Failing OPEN means the value goes out: a lower number with no live number
    // to compare it against is not evidence of a decrease.
    expect(update['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 12000 });
    expect(warnings().filter((w) => w.includes('WarmThroughput was NOT sent'))).toHaveLength(0);
  });
});

/**
 * `toFiniteNumber` — this file's coercion for every OTHER numeric CFn member
 * (capacity units, on-demand ceilings) — and the WHITESPACE shape (code review
 * of the issue #1857 PR).
 *
 * `Number('   ')` is **0**, so before the `trim()` guard a whitespace-only
 * `MaxReadRequestUnits` was read as a request for ZERO capacity — in the very
 * file that now REFUSES exactly that shape for `WarmThroughput`, via the shared
 * `dynamodb-warm-throughput.ts` rule. That divergence is what the extraction
 * exists to prevent, so the two coercions have to answer alike.
 */
describe('toFiniteNumber whitespace parity with the shared WarmThroughput rule', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    mockSend.mockResolvedValue({
      Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableId: 'tid-1', TableStatus: 'ACTIVE' },
    });
    provider = new DynamoDBGlobalTableProvider();
  });

  const createdIndex = (): Record<string, unknown> => {
    const creates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is CreateTableCommand => c instanceof CreateTableCommand);
    expect(creates).toHaveLength(1);
    return creates[0]!.input.GlobalSecondaryIndexes![0]! as unknown as Record<string, unknown>;
  };

  it('refuses a WHITESPACE-only on-demand ceiling instead of sending zero', async () => {
    // `propsWithWarm`'s `maxRead` lands on the replica's
    // `ReadOnDemandThroughputSettings.MaxReadRequestUnits`. The regression's
    // shape is `OnDemandThroughput: {MaxReadRequestUnits: 0}` — a ceiling of
    // zero, which nobody declared.
    await provider.create(
      'Warm',
      RESOURCE_TYPE,
      propsWithWarm(undefined, '   ' as unknown as number)
    );

    expect(createdIndex()['OnDemandThroughput']).toBeUndefined();
    // ...and the refusal is ANNOUNCED, naming the member, exactly as an
    // unresolved intrinsic is.
    const unresolved = warnings().filter((w) => w.includes('MaxReadRequestUnits'));
    expect(unresolved.length).toBeGreaterThanOrEqual(1);
  });

  it('still accepts a QUOTED numeric ceiling — the guard must not refuse a real template', async () => {
    // Both polarities: a template really can carry `MaxReadRequestUnits: '77'`
    // (CloudFormation is stringly typed), and a guard that rejected it would
    // break working stacks.
    await provider.create('Warm', RESOURCE_TYPE, propsWithWarm(undefined, '77' as unknown as number));

    expect(createdIndex()['OnDemandThroughput']).toEqual({ MaxReadRequestUnits: 77 });
    expect(warnings().filter((w) => w.includes('MaxReadRequestUnits'))).toHaveLength(0);
  });

  it('agrees with the shared WarmThroughput coercion on the same bag', async () => {
    // The two coercions read DIFFERENT members of the same index, so the point
    // is that neither accepts the whitespace: a run where the ceiling is
    // dropped but the warm value is not (or vice versa) is the divergence.
    await provider.create(
      'Warm',
      RESOURCE_TYPE,
      propsWithWarm({ ReadUnitsPerSecond: '   ' }, '   ' as unknown as number)
    );

    const index = createdIndex();
    expect(index['OnDemandThroughput']).toBeUndefined();
    expect(index['WarmThroughput']).toBeUndefined();
  });
});
