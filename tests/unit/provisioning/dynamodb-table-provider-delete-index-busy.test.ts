import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

/**
 * Issue #1931 — `AWS::DynamoDB::Table` destroy failed hard on the transient
 * index-busy refusal that issue #1830 removed for `AWS::DynamoDB::GlobalTable`.
 *
 * AWS refuses a `DeleteTable` while any GSI is mid-transition:
 *
 *   Attempt to change a resource which is still in use: Cannot delete table
 *   while indexes are being created, updated, or deleted.
 *
 * On a real `dynamodb-globaltable` destroy (us-east-1, 2026-08-13) the very
 * next `cdkd destroy` succeeded with no other change, so the condition is
 * transient and self-resolving; application auto-scaling can start an index
 * capacity change at any moment, so any table with an autoscaled GSI can reach
 * it. PR #1930 fixed the GlobalTable type only — THIS provider's `delete()`
 * issued a single `DeleteTable` and converted the refusal into a
 * `PartialFailureError` with state preserved.
 *
 * The rule is not re-spelled here: it comes from
 * `src/provisioning/dynamodb-index-busy-delete.ts`, which both DynamoDB
 * providers read. `dynamodb-index-busy-delete.test.ts` pins the RULE and the
 * fact that both providers route through it; this file exercises it through
 * THIS provider's delete path.
 */

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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
  DynamoDBTableProvider,
  deleteTableRetryDelays,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const LOGICAL_ID = 'Orders';
const TABLE_NAME = 'orders-table';

/**
 * The refusal AWS raised on the real destroy, verbatim — including the
 * `ResourceInUseException` NAME it arrives under and the generic "Attempt to
 * change a resource which is still in use:" prefix that wraps it. The name is
 * deliberately part of the fixture: it is shared with the terminal conflict
 * below, which is why the classifier keys on the MESSAGE.
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
  TableStatus: 'ACTIVE',
  // ACTIVE on purpose: the re-arm poll returns on its first DescribeTable, so
  // nothing in this suite waits on the 1s poll cadence.
  GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
};

/**
 * `DeleteTable` fails `failures` times with `error`, then succeeds.
 * `DescribeTable` (the retry's re-arm poll) serves the live table.
 */
function stubDeleteFailingTimes(failures: number, error: () => Error): { attempts: () => number } {
  let attempts = 0;
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeTableCommand) {
      return Promise.resolve({ Table: LIVE_TABLE });
    }
    if (command instanceof DeleteTableCommand) {
      attempts += 1;
      if (attempts <= failures) return Promise.reject(error());
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  return { attempts: () => attempts };
}

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

describe('DynamoDBTable delete retry on the index-busy refusal (issue #1931)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    // Skip `withRetry`'s real ~47s backoff. Set per-suite rather than per-test
    // so no test can silently pay it if an expectation moves.
    deleteTableRetryDelays.sleep = () => Promise.resolve();
    provider = new DynamoDBTableProvider();
  });

  afterEach(() => {
    delete deleteTableRetryDelays.sleep;
  });

  it('retries the transient index-busy refusal instead of failing the destroy', async () => {
    const stub = stubDeleteFailingTimes(1, indexBusyError);

    await expect(
      provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {})
    ).resolves.toBeUndefined();

    // Two sends, not one: the pre-fix provider issued exactly one and
    // converted the refusal into a ProvisioningError.
    expect(stub.attempts()).toBe(2);
    const deletes = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is DeleteTableCommand => c instanceof DeleteTableCommand);
    expect(deletes.map((c) => c.input.TableName)).toEqual([TABLE_NAME, TABLE_NAME]);
  });

  it('re-polls the index state between attempts rather than only sleeping', async () => {
    // The backoff grid alone cannot cover an index BACKFILL, which outlasts any
    // fixed schedule. Each retry therefore re-runs the settle poll, which
    // returns on its first DescribeTable once the index is ACTIVE. Measured as
    // "a DescribeTable happened between the failed delete and the retry": a
    // regression that dropped the re-arm leaves the two deletes adjacent.
    stubDeleteFailingTimes(1, indexBusyError);

    await provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {});

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
    // name-keyed classifier would also end up throwing here, just 47s later and
    // after 9 sends.
    const stub = stubDeleteFailingTimes(Number.POSITIVE_INFINITY, terminalInUseError);

    await expect(provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {})).rejects.toThrow(
      `Failed to delete DynamoDB table ${LOGICAL_ID}: Attempt to change a resource which is ` +
        `still in use: Table is being created: ${TABLE_NAME}`
    );
    expect(stub.attempts()).toBe(1);
    // ...and no re-arm poll either: a name-keyed classifier would have spent 8
    // settle polls waiting out a condition that never clears.
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof DescribeTableCommand)
    ).toHaveLength(0);
  });

  it('gives up after the bounded budget instead of retrying forever', async () => {
    // A condition that never clears must still terminate, and must surface the
    // real AWS sentence rather than a cdkd-invented timeout message.
    const stub = stubDeleteFailingTimes(Number.POSITIVE_INFINITY, indexBusyError);

    await expect(provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {})).rejects.toThrow(
      `Failed to delete DynamoDB table ${LOGICAL_ID}: Attempt to change a resource which is ` +
        'still in use: Cannot delete table while indexes are being created, updated, or deleted.'
    );
    // DELETE_INDEX_BUSY_MAX_RETRIES (8) retries after the first attempt.
    expect(stub.attempts()).toBe(9);
  });

  it('matches the refusal case-INSENSITIVELY (the classifier`s /i flag)', async () => {
    // The clause arrives inside a wrapper prefix whose casing is not ours, so
    // the classifier is anchored with `/i`. A regression dropping it turns this
    // run into the one-attempt hard failure the terminal case above pins.
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

    await expect(
      provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {})
    ).resolves.toBeUndefined();
    expect(stub.attempts()).toBe(2);
  });

  it('WARNS once at default verbosity when it starts absorbing the refusal', async () => {
    // `withRetry` announces its retries through `opts.logger?.debug`, so
    // without this line a delete spending minutes re-polling printed NOTHING
    // naming the cause — and the bounded re-arm can end in a timeout that has
    // to be diagnosable from an ordinary run's output.
    const stub = stubDeleteFailingTimes(2, indexBusyError);

    await provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {});

    expect(stub.attempts()).toBe(3);
    const refusalWarnings = warnings().filter((w) => w.includes('AWS refused DeleteTable'));
    // ONE line even across two retries: this announces the CONDITION, not each
    // attempt (which is what `withRetry`'s debug line already does).
    expect(refusalWarnings).toHaveLength(1);
    // The subject is THIS type, not the sibling's: the shared module takes the
    // label from the caller, and a copy-paste that left `GlobalTable` behind
    // would name a resource type the user's template does not contain.
    expect(refusalWarnings[0]).toContain(`DynamoDB table ${LOGICAL_ID}`);
    expect(refusalWarnings[0]).not.toContain('GlobalTable');
    expect(refusalWarnings[0]).toContain(TABLE_NAME);
    expect(refusalWarnings[0]).toContain('global secondary index');
    // It fires from inside attempt 2 of `1 + DELETE_INDEX_BUSY_MAX_RETRIES`
    // (= 9), so 7 attempts are left, not 8 — the off-by-one the shared module
    // derives rather than spells.
    expect(refusalWarnings[0]).toContain('up to 7 more attempts');
    // ...and the settle budget is stated as POLLS, not as seconds: the constant
    // is a DescribeTable count, and rendering it as `60s` claims a wall clock
    // the loop does not have (each poll also pays a round trip).
    expect(refusalWarnings[0]).toContain('up to 60 DescribeTable polls');
    expect(refusalWarnings[0]).not.toMatch(/\b60s\b/);
    // It must NOT carry AWS's own sentence: the integ arm greps the destroy log
    // for `Cannot delete table while indexes are being` to prove AWS really
    // refused, and a cdkd-authored copy would satisfy that grep without the
    // refusal having happened.
    expect(refusalWarnings[0]).not.toContain('Cannot delete table while indexes are being');
  });

  it('does not warn when the delete succeeds first time', async () => {
    stubDeleteFailingTimes(0, indexBusyError);

    await provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {});

    expect(warnings().filter((w) => w.includes('AWS refused DeleteTable'))).toHaveLength(0);
  });

  it('still treats a gone table as a no-op rather than an error', async () => {
    // The pre-existing idempotency arm has to survive the retry wrapper: a
    // `ResourceNotFoundException` is NOT the index-busy message, so it must
    // fall straight through `withRetry` to the region-checked skip.
    let attempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteTableCommand) {
        attempts += 1;
        return Promise.reject(newRnf());
      }
      return Promise.resolve({ Table: LIVE_TABLE });
    });

    await expect(
      provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {})
    ).resolves.toBeUndefined();
    expect(attempts).toBe(1);
  });

  it('reads the sleep seam at CALL time, not when the retry options are built', async () => {
    // Set the seam from INSIDE the first refusal — i.e. after `delete()` has
    // already built `withRetry`'s options bag. A spread-at-construction seam
    // captures `undefined` there and silently falls back to the real ~47s
    // schedule; reading it per sleep picks the override up.
    delete deleteTableRetryDelays.sleep;
    const sleepSpy = vi.fn(() => Promise.resolve());
    let attempts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteTableCommand) {
        attempts += 1;
        if (attempts === 1) {
          deleteTableRetryDelays.sleep = sleepSpy;
          return Promise.reject(indexBusyError());
        }
        return Promise.resolve({});
      }
      return Promise.resolve({ Table: LIVE_TABLE });
    });

    await provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {});

    expect(attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalled();
  });
});
