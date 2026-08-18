import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

/**
 * The index-busy `DeleteTable` rule BOTH DynamoDB providers read
 * (`src/provisioning/dynamodb-index-busy-delete.ts`).
 *
 * It lives in its own file, named for the module, because a third consumer's
 * author looks for `<module>.test.ts`. The per-provider suites
 * (`dynamodb-globaltable-provider-delete-retry-warm-throughput.test.ts`,
 * `dynamodb-table-provider-delete-index-busy.test.ts`) exercise the same module
 * through each provider's delete path; this file pins the RULE, and pins that
 * both providers actually route through it rather than each holding a copy.
 *
 * Provenance: the rule shipped for `AWS::DynamoDB::GlobalTable` first (issue
 * #1830, PR #1930), provider-locally. Issue #1931 is the sibling
 * `AWS::DynamoDB::Table` gap that left — its `delete()` had no retry at all —
 * and lifting the rule here is what makes "the same refusal, the same answer"
 * a fact rather than a convention.
 */

const { mockSend, mockAutoScalingSend, retrySpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  retrySpy: vi.fn(),
}));

/**
 * Spread the REAL module and wrap ONE export. Everything the rule tests below
 * assert is therefore the real implementation; the wrapper exists so the
 * binding test can see WHICH providers went through the shared retry — a
 * provider that re-spelled the loop locally would still pass every behavioural
 * test in its own suite while never touching this module.
 */
vi.mock('../../../src/provisioning/dynamodb-index-busy-delete.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/dynamodb-index-busy-delete.js')>();
  return {
    ...actual,
    deleteTableWithIndexBusyRetry: (opts: Parameters<typeof actual.deleteTableWithIndexBusyRetry>[0]) => {
      retrySpy(opts);
      return actual.deleteTableWithIndexBusyRetry(opts);
    },
  };
});

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
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-application-auto-scaling')>(
      '@aws-sdk/client-application-auto-scaling'
    );
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

import {
  DELETE_INDEX_BUSY_MAX_RETRIES,
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  hasTransitionalIndex,
  indexBusyRetryWarning,
  isIndexBusyDeleteError,
} from '../../../src/provisioning/dynamodb-index-busy-delete.js';
import {
  DynamoDBTableProvider,
  deleteTableRetryDelays as tableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import {
  DynamoDBGlobalTableProvider,
  deleteTableRetryDelays as globalTableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const INDEX_BUSY_MESSAGE =
  'Attempt to change a resource which is still in use: Cannot delete table while ' +
  'indexes are being created, updated, or deleted.';

describe('isIndexBusyDeleteError (the ONE classifier, issues #1830 / #1931)', () => {
  // The whole safety argument for retrying at all is that this predicate says
  // YES only to a condition that clears itself. AWS reports it as a plain
  // `ResourceInUseException` — a NAME it also uses for terminal conflicts — so
  // the message clause is the only discriminator there is.
  it.each([
    ['AWS`s verbatim refusal', INDEX_BUSY_MESSAGE, true],
    [
      'the same clause upper-cased (the wrapper prefix`s casing is not ours)',
      INDEX_BUSY_MESSAGE.toUpperCase(),
      true,
    ],
    [
      'the clause without AWS`s trailing status list (which AWS may reword)',
      'Cannot delete table while indexes are being changed',
      true,
    ],
    [
      'a table still being created — same exception NAME, never self-clearing',
      'Attempt to change a resource which is still in use: Table is being created: t',
      false,
    ],
    [
      'a table already existing — same exception NAME, never self-clearing',
      'Attempt to change a resource which is still in use: Table already exists: t',
      false,
    ],
    [
      'the generic in-use prefix ALONE (a prefix-keyed classifier would say yes)',
      'Attempt to change a resource which is still in use:',
      false,
    ],
    ['a table-not-found', 'Requested resource not found: Table: t not found', false],
    ['a throttle', 'Throughput exceeds the current capacity of your table', false],
    ['an empty message', '', false],
  ])('%s', (_name, message, expected) => {
    expect(isIndexBusyDeleteError(message)).toBe(expected);
  });
});

describe('hasTransitionalIndex (the CONDITION the re-arm waits on)', () => {
  // The test is on the TRANSITIONAL values rather than on `!== ACTIVE`: an
  // absent or unrecognized status must not park a delete for the whole cap on a
  // table that is fine.
  it.each([
    ['no index list at all', undefined, false],
    ['an empty list', [], false],
    ['every index ACTIVE', [{ IndexStatus: 'ACTIVE' }], false],
    ['a CREATING index', [{ IndexStatus: 'ACTIVE' }, { IndexStatus: 'CREATING' }], true],
    ['an UPDATING index', [{ IndexStatus: 'UPDATING' }], true],
    ['a DELETING index (it reports until it is gone)', [{ IndexStatus: 'DELETING' }], true],
    ['an absent status (a partial response is not a reason to wait)', [{}], false],
    ['an unrecognized status', [{ IndexStatus: 'SOMETHING_NEW' }], false],
  ])('%s', (_name, indexes, expected) => {
    expect(hasTransitionalIndex(indexes as { IndexStatus?: string }[] | undefined)).toBe(expected);
  });
});

describe('indexBusyRetryWarning (the ONE line printed at default verbosity)', () => {
  it('derives the remaining attempts from the budget rather than spelling it', () => {
    // `withRetry` runs `1 + maxRetries` attempts and the line fires from inside
    // the attempt now starting, so the first retry has 7 left, not 8. It
    // shipped saying 8 because the number was the raw budget constant.
    const first = indexBusyRetryWarning({
      typeLabel: 'table',
      logicalId: 'Orders',
      physicalId: 'orders-table',
      attemptNumber: 2,
    });
    expect(first).toContain(`up to ${DELETE_INDEX_BUSY_MAX_RETRIES - 1} more attempts`);
    expect(first).toContain(`up to ${DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS} DescribeTable polls`);
    expect(first).toContain('DynamoDB table Orders');
    expect(first).toContain('orders-table');
  });

  it('names the caller`s resource type, so neither provider claims the other`s', () => {
    const gt = indexBusyRetryWarning({
      typeLabel: 'GlobalTable',
      logicalId: 'Warm',
      physicalId: 'warm-table',
      attemptNumber: 2,
    });
    expect(gt).toContain('DynamoDB GlobalTable Warm');
  });

  it('never quotes AWS`s own sentence', () => {
    // `tests/integration/dynamodb-globaltable/verify.sh` step 15b greps the
    // destroy log for `Cannot delete table while indexes are being` to prove
    // AWS really refused; a cdkd-authored copy would satisfy that grep with no
    // refusal having happened, and the arm would stop discriminating.
    expect(
      indexBusyRetryWarning({
        typeLabel: 'table',
        logicalId: 'Orders',
        physicalId: 'orders-table',
        attemptNumber: 2,
      })
    ).not.toContain('Cannot delete table while indexes are being');
  });
});

describe('the shared budget constants', () => {
  it('bounds the re-arm poll well under the per-resource destroy deadline', () => {
    // `destroy-runner.ts` caps a single `delete()` at 30 min and neither
    // provider lifts it. The LOOP's worst case is
    // `maxRetries x rearm polls (~1s each) + withRetry's ~47s of backoff`.
    const worstCaseSeconds =
      DELETE_INDEX_BUSY_MAX_RETRIES * DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS + 47;
    expect(worstCaseSeconds).toBeLessThan(15 * 60);
  });

  it('states what proceeding costs on the delete path, not the auto-scaling one', () => {
    expect(DELETE_INDEX_WAIT_PROCEED_NOTE).toContain('DeleteTable goes ahead anyway');
  });
});

/**
 * The binding: both providers' `delete()` go through THIS module.
 *
 * Behavioural suites cannot see this — a provider holding its own copy of the
 * loop would satisfy every retry expectation in its own file while being free
 * to drift on the next edit, which is exactly the failure that made
 * `dynamodb-warm-throughput.ts` exist.
 */
describe('both DynamoDB providers route DeleteTable through the shared retry', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    retrySpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    tableDeleteDelays.sleep = () => Promise.resolve();
    globalTableDeleteDelays.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    delete tableDeleteDelays.sleep;
    delete globalTableDeleteDelays.sleep;
  });

  /** Refuse the first `DeleteTable` with the index-busy message, then succeed. */
  function stubOneRefusal(): { deletes: () => number } {
    let deletes = 0;
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return deleted
          ? Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }))
          : Promise.resolve({
              Table: {
                TableName: 'shared-table',
                TableStatus: 'ACTIVE',
                GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
                Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
              },
            });
      }
      if (command instanceof DeleteTableCommand) {
        deletes += 1;
        if (deletes === 1) {
          return Promise.reject(
            new ResourceInUseException({ message: INDEX_BUSY_MESSAGE, $metadata: {} })
          );
        }
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    return { deletes: () => deletes };
  }

  it('AWS::DynamoDB::Table', async () => {
    const stub = stubOneRefusal();

    await new DynamoDBTableProvider().delete(
      'Orders',
      'shared-table',
      'AWS::DynamoDB::Table',
      {}
    );

    expect(stub.deletes()).toBe(2);
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({ typeLabel: 'table' });
  });

  it('AWS::DynamoDB::GlobalTable', async () => {
    const stub = stubOneRefusal();

    await new DynamoDBGlobalTableProvider().delete(
      'Warm',
      'shared-table',
      'AWS::DynamoDB::GlobalTable',
      {}
    );

    expect(stub.deletes()).toBe(2);
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({ typeLabel: 'GlobalTable' });
  });
});
