/**
 * go-to-k/cdkd#5574: the index-busy `DeleteTable` settle wait read only
 * `GlobalSecondaryIndexes`, so on an `AWS::DynamoDB::Table` whose VECTOR index
 * was still CREATING / DELETING it returned at once and every retry spent only
 * its backoff; and `create()`'s rollback `DeleteTable` (sent when a post-create
 * step, such as the create-time vector-index wait, failed) had no index-busy
 * retry at all, so one refusal left the table behind as an orphan.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  type DescribeTableCommandOutput,
} from '@aws-sdk/client-dynamodb';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Issue #4639: `CreateTable` goes through a dedicated client built in the
// shared client's region; route it to the shared double.
vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  const { getAwsClients } = await import('../../../src/utils/aws-clients.js');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) =>
      cfg?.region === 'us-east-1' ? getAwsClients().dynamoDB : new actual.DynamoDBClient(cfg ?? {})
    ),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
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
import {
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  TABLE_INDEX_NOUN,
  hasTransitionalTableIndex,
  waitForIndexesSettled,
} from '../../../src/provisioning/dynamodb-index-busy-delete.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import {
  DYNAMODB_DELETE_DEADLINE_MARGIN_MS,
  dynamoDbDeleteBudgetOverride,
} from '../../../src/provisioning/providers/dynamodb-delete-budget.js';
import type { Logger } from '../../../src/types/config.js';
import { ElapsedBudget } from '../../../src/utils/elapsed-budget.js';
import { beginDeleteWait } from '../../../src/provisioning/providers/dynamodb-delete-budget.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const LOGICAL_ID = 'Vectors';
const TABLE_NAME = 'vectors-table';

function indexBusyError(): ResourceInUseException {
  return new ResourceInUseException({
    message:
      'Attempt to change a resource which is still in use: Cannot delete table while ' +
      'indexes are being created, updated, or deleted.',
    $metadata: {},
  });
}

function accessDenied(op: string): Error {
  return Object.assign(new Error(`User is not authorized to perform: dynamodb:${op}`), {
    name: 'AccessDeniedException',
    $metadata: { httpStatusCode: 400 },
  });
}

/** A live table whose only index is a vector index in `status`. */
function tableWithVectorIndex(status: string): Record<string, unknown> {
  return {
    TableName: TABLE_NAME,
    TableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE_NAME}`,
    TableStatus: 'ACTIVE',
    GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
    VectorIndexes: [{ IndexName: 'vec1', IndexStatus: status }],
  };
}

const kindOf = (c: unknown[]): string =>
  c[0] instanceof DeleteTableCommand
    ? 'delete'
    : c[0] instanceof DescribeTableCommand
      ? 'describe'
      : (c[0] as { constructor: { name: string } }).constructor.name;

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
const debugs = (): string[] => debugSpy.mock.calls.map((c) => String(c[0]));

describe('hasTransitionalTableIndex (go-to-k/cdkd#5574)', () => {
  it.each([
    ['no table', undefined, false],
    ['no index lists', {}, false],
    ['every GSI and vector index ACTIVE', tableWithVectorIndex('ACTIVE'), false],
    ['a CREATING vector index', tableWithVectorIndex('CREATING'), true],
    ['a DELETING vector index', tableWithVectorIndex('DELETING'), true],
    ['an UPDATING vector index', tableWithVectorIndex('UPDATING'), true],
    [
      'a CREATING GSI beside an ACTIVE vector index',
      {
        GlobalSecondaryIndexes: [{ IndexStatus: 'CREATING' }],
        VectorIndexes: [{ IndexStatus: 'ACTIVE' }],
      },
      true,
    ],
    ['an absent vector status', { VectorIndexes: [{}] }, false],
  ])('%s', (_name, table, expected) => {
    expect(hasTransitionalTableIndex(table as never)).toBe(expected);
  });
});

describe('waitForIndexesSettled waits on a busy vector index (go-to-k/cdkd#5574)', () => {
  it('keeps polling while the vector index is CREATING and returns once it is ACTIVE', async () => {
    vi.useFakeTimers();
    try {
      const warns: string[] = [];
      const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (m: string) => {
          warns.push(m);
        },
        error: () => {},
      };
      let describes = 0;
      const pending = waitForIndexesSettled({
        tableName: TABLE_NAME,
        logicalId: LOGICAL_ID,
        logger,
        maxAttempts: 10,
        proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
        describeTable: () => {
          describes += 1;
          return Promise.resolve({
            Table: tableWithVectorIndex(describes < 3 ? 'CREATING' : 'ACTIVE'),
          } as unknown as DescribeTableCommandOutput);
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      // Pre-fix: 1 (the GSI was ACTIVE, so the first poll returned).
      expect(describes).toBe(3);
      expect(warns).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the long re-arm cap is spent only while a vector index alone builds (go-to-k/cdkd#5574)', () => {
  function recording(): { logger: Logger; warns: string[]; debugs: string[] } {
    const warns: string[] = [];
    const debugs: string[] = [];
    return {
      warns,
      debugs,
      logger: {
        debug: (m: string) => {
          debugs.push(m);
        },
        info: () => {},
        warn: (m: string) => {
          warns.push(m);
        },
        error: () => {},
      },
    };
  }

  async function run(
    table: (poll: number) => Record<string, unknown> | Error,
    shortCap: number | undefined,
    budgetWait?: ReturnType<typeof beginDeleteWait>
  ): Promise<{ describes: number; warns: string[]; debugs: string[] }> {
    vi.useFakeTimers();
    try {
      const { logger, warns, debugs } = recording();
      let describes = 0;
      const pending = waitForIndexesSettled({
        tableName: TABLE_NAME,
        logicalId: LOGICAL_ID,
        logger,
        maxAttempts: budgetWait?.grantedPolls ?? 20,
        ...(budgetWait !== undefined && { budgetWait }),
        ...(shortCap !== undefined && { shortCapUnlessVectorBusy: shortCap }),
        proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
        describeTable: () => {
          describes += 1;
          const t = table(describes);
          return t instanceof Error
            ? Promise.reject(t)
            : Promise.resolve({ Table: t } as unknown as DescribeTableCommandOutput);
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
      return { describes, warns, debugs };
    } finally {
      vi.useRealTimers();
    }
  }

  it('waits a vector-index build past the short cap, in one wait', async () => {
    // The live build outlasted the 60-poll re-arm five times over (the
    // constant's dated measurement); here the build takes 8 polls, cap 3.
    const r = await run((n) => tableWithVectorIndex(n <= 8 ? 'CREATING' : 'ACTIVE'), 3);
    expect(r.describes).toBe(9);
    expect(r.warns).toEqual([]);
    // The two lines the integ arm greps (verify.sh Phase V3b): once per wait.
    expect(r.debugs.filter((d) => d.includes(': a vector index still transitioning'))).toHaveLength(
      1
    );
    expect(r.debugs).toContain(
      `Indexes on ${TABLE_NAME} (${LOGICAL_ID}) settled after 9 DescribeTable polls`
    );
  });

  it('a throttled poll mid-build keeps the long cap (the last reading carries over)', async () => {
    const throttle = (): Error =>
      Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 400 },
      });
    // Polls 3 and 4 (at the short cap) are throttled; the build ends at 8.
    const r = await run(
      (n) => (n === 3 || n === 4 ? throttle() : tableWithVectorIndex(n <= 8 ? 'CREATING' : 'ACTIVE')),
      3
    );
    expect(r.describes).toBe(9);
    expect(r.warns).toEqual([]);
  });

  it('a GSI wait stopped at the short cap carries no allowance note', async () => {
    // 120s of allowance grants ~100 of the 900 polls: an ENTRY-clamped wait,
    // whose note() would claim the allowance capped it although the short
    // cap is what stopped it.
    const wait = beginDeleteWait(900, new ElapsedBudget(120_000));
    expect(wait.grantedPolls).toBeLessThan(900);
    const r = await run(
      () => ({ GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'CREATING' }] }),
      3,
      wait
    );
    expect(r.describes).toBe(3);
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]).toContain('within 3 DescribeTable polls');
    expect(r.warns[0]).not.toContain('allowance');
  });

  it('a GSI wait the allowance cut short quotes the SHORT cap, not the granted 900', async () => {
    // 2.5s of allowance at the ~1.2s poll cost grants 2 polls, under the cap of 3.
    const wait = beginDeleteWait(900, new ElapsedBudget(2_500));
    const r = await run(
      () => ({ GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'CREATING' }] }),
      3,
      wait
    );
    expect(r.describes).toBe(2);
    expect(r.warns[0]).toContain('made only 2 of its 3 polls');
    expect(r.warns[0]).not.toContain('of its 900');
  });

  it('keeps the short cap for a busy GSI, with no allowance note', async () => {
    const r = await run(
      () => ({
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'CREATING' }],
        VectorIndexes: [{ IndexName: 'vec1', IndexStatus: 'ACTIVE' }],
      }),
      3
    );
    expect(r.describes).toBe(3);
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]).toContain('did not all reach ACTIVE within 3 DescribeTable polls');
    expect(r.debugs.some((d) => d.includes('a global secondary index still transitioning'))).toBe(
      true
    );
  });

  it('keeps the short cap while a GSI is busy beside a building vector index', async () => {
    const r = await run(
      () => ({
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'UPDATING' }],
        VectorIndexes: [{ IndexName: 'vec1', IndexStatus: 'CREATING' }],
      }),
      3
    );
    expect(r.describes).toBe(3);
    expect(r.debugs.some((d) => d.includes('a global secondary index and a vector index'))).toBe(
      true
    );
  });

  it('still stops at the long bound when the vector build never ends', async () => {
    const r = await run(() => tableWithVectorIndex('CREATING'), 3);
    expect(r.describes).toBe(20);
    expect(r.warns[0]).toContain('within 20 DescribeTable polls');
  });

  it('the shared allowance still ends a long vector wait, and says so', async () => {
    // A 10s allowance on a clock moving 1s per poll: the grant is ~8 polls of
    // the 900 cap, far below the build, so the ALLOWANCE ends the wait.
    let now = 0;
    const budget = new ElapsedBudget(10_000, () => now);
    const wait = beginDeleteWait(900, budget);
    const { logger, warns } = recording();
    vi.useFakeTimers();
    try {
      const pending = waitForIndexesSettled({
        tableName: TABLE_NAME,
        logicalId: LOGICAL_ID,
        logger,
        maxAttempts: wait.grantedPolls,
        budgetWait: wait,
        shortCapUnlessVectorBusy: 3,
        proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
        describeTable: () => {
          now += 1_000;
          return Promise.resolve({
            Table: tableWithVectorIndex('CREATING'),
          } as unknown as DescribeTableCommandOutput);
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(wait.pollsRun).toBeGreaterThan(3);
    expect(wait.pollsRun).toBeLessThan(900);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('delete allowance');
  });

  it('without the option, a vector-only build is bounded by maxAttempts alone (the GlobalTable shape)', async () => {
    const r = await run((n) => tableWithVectorIndex(n <= 8 ? 'CREATING' : 'ACTIVE'), undefined);
    expect(r.describes).toBe(9);
  });
});

describe('DynamoDBTableProvider index-busy DeleteTable and vector indexes (go-to-k/cdkd#5574)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    deleteTableRetryDelays.sleep = () => Promise.resolve();
    provider = new DynamoDBTableProvider();
  });

  afterEach(() => {
    delete deleteTableRetryDelays.sleep;
    delete dynamoDbDeleteBudgetOverride.totalMs;
    delete dynamoDbDeleteBudgetOverride.clock;
  });

  it('delete(): the re-arm waits for a CREATING vector index before the retry', async () => {
    let deletes = 0;
    let rearmDescribes = 0;
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        rearmDescribes += 1;
        return Promise.resolve({
          Table: tableWithVectorIndex(rearmDescribes < 2 ? 'CREATING' : 'ACTIVE'),
        });
      }
      if (command instanceof DeleteTableCommand) {
        deletes += 1;
        if (deletes === 1) return Promise.reject(indexBusyError());
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete(LOGICAL_ID, TABLE_NAME, RESOURCE_TYPE, {})
    ).resolves.toBeUndefined();

    const kinds = mockSend.mock.calls.map(kindOf);
    const first = kinds.indexOf('delete');
    const second = kinds.indexOf('delete', first + 1);
    // Two re-arm polls between the deletes: one saw CREATING, one ACTIVE.
    // Pre-fix the GSI-only predicate returned on the first.
    expect(kinds.slice(first + 1, second).filter((k) => k === 'describe')).toHaveLength(2);
    // The first-retry warning names the index kinds THIS type can have.
    expect(warnings().some((w) => w.includes(`because ${TABLE_INDEX_NOUN} is still being`))).toBe(
      true
    );
  });

  describe('create() rollback DeleteTable', () => {
    const PROPS = {
      TableName: TABLE_NAME,
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
      // The post-ACTIVE step that fails and sends create() into its rollback.
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    };

    /**
     * CreateTable succeeds, the ACTIVE wait reads ACTIVE, PITR is denied, and
     * the rollback DeleteTable is refused `refusals` times with the index-busy
     * message while the re-arm reads the vector index CREATING once, then
     * ACTIVE.
     */
    function route(refusals: number): { deletes: () => number } {
      let deletes = 0;
      let rearmDescribes = 0;
      mockSend.mockImplementation(async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'CreateTableCommand') return { TableDescription: { TableId: 'tid-1' } };
        if (name === 'UpdateContinuousBackupsCommand') {
          throw accessDenied('UpdateContinuousBackups');
        }
        if (command instanceof DeleteTableCommand) {
          deletes += 1;
          if (deletes <= refusals) throw indexBusyError();
          return {};
        }
        if (command instanceof DescribeTableCommand) {
          if (deletes === 0) return { Table: tableWithVectorIndex('ACTIVE') };
          rearmDescribes += 1;
          return { Table: tableWithVectorIndex(rearmDescribes < 2 ? 'CREATING' : 'ACTIVE') };
        }
        return {};
      });
      return { deletes: () => deletes };
    }

    async function createError(
      p: DynamoDBTableProvider,
      maskSecrets?: (text: string) => string
    ): Promise<unknown> {
      try {
        await p.create(
          LOGICAL_ID,
          RESOURCE_TYPE,
          PROPS,
          maskSecrets ? ({ maskSecrets } as never) : undefined
        );
      } catch (error) {
        return error;
      }
      throw new Error('create() did not throw');
    }

    it('retries an index-busy refusal after the indexes settle, leaving nothing behind', async () => {
      const stub = route(1);
      const error = await createError(provider);

      // Pre-fix: one DeleteTable, and the table reported left behind.
      expect(stub.deletes()).toBe(2);
      expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBeUndefined();
      const kinds = mockSend.mock.calls.map(kindOf);
      const first = kinds.indexOf('delete');
      expect(kinds.slice(first + 1, kinds.indexOf('delete', first + 1))).toEqual([
        'describe',
        'describe',
      ]);
      // A rollback line, never the destroy's "re-run the destroy" advice.
      const line = warnings().find((w) => w.includes('rolling back'));
      expect(line).toContain(`because ${TABLE_INDEX_NOUN} is still being`);
      expect(warnings().some((w) => w.includes('the destroy fails'))).toBe(false);
    });

    it('waits a vector build past the 60-poll re-arm in ONE wait (the long cap is wired here too)', async () => {
      // 70 CREATING polls: over the GSI re-arm, under the vector cap.
      let deletes = 0;
      let rearmDescribes = 0;
      mockSend.mockImplementation(async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'CreateTableCommand') return { TableDescription: { TableId: 'tid-1' } };
        if (name === 'UpdateContinuousBackupsCommand') {
          throw accessDenied('UpdateContinuousBackups');
        }
        if (command instanceof DeleteTableCommand) {
          deletes += 1;
          if (deletes === 1) throw indexBusyError();
          return {};
        }
        if (command instanceof DescribeTableCommand) {
          if (deletes === 0) return { Table: tableWithVectorIndex('ACTIVE') };
          rearmDescribes += 1;
          return { Table: tableWithVectorIndex(rearmDescribes <= 70 ? 'CREATING' : 'ACTIVE') };
        }
        return {};
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      let error: unknown;
      try {
        const pending = createError(provider);
        await vi.advanceTimersByTimeAsync(200_000);
        error = await pending;
      } finally {
        vi.useRealTimers();
      }
      expect(deletes).toBe(2);
      expect(rearmDescribes).toBe(71);
      expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBeUndefined();
      expect(warnings().some((w) => w.includes('did not all reach ACTIVE'))).toBe(false);
    });

    it('keeps a busy GSI at the 60-poll re-arm in the rollback too', async () => {
      let deletes = 0;
      mockSend.mockImplementation(async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'CreateTableCommand') return { TableDescription: { TableId: 'tid-1' } };
        if (name === 'UpdateContinuousBackupsCommand') {
          throw accessDenied('UpdateContinuousBackups');
        }
        if (command instanceof DeleteTableCommand) {
          deletes += 1;
          if (deletes === 1) throw indexBusyError();
          return {};
        }
        if (command instanceof DescribeTableCommand) {
          if (deletes === 0) return { Table: tableWithVectorIndex('ACTIVE') };
          return {
            Table: {
              ...tableWithVectorIndex('ACTIVE'),
              GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'CREATING' }],
            },
          };
        }
        return {};
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        const pending = createError(provider);
        await vi.advanceTimersByTimeAsync(200_000);
        await pending;
      } finally {
        vi.useRealTimers();
      }
      expect(deletes).toBe(2);
      expect(
        warnings().some((w) => w.includes('did not all reach ACTIVE within 60 DescribeTable polls'))
      ).toBe(true);
    });

    it('masks the table name in the retry line', async () => {
      route(1);
      await createError(provider, (text) => text.split(TABLE_NAME).join('***'));
      const line = warnings().find((w) => w.includes('rolling back'));
      expect(line).toBeDefined();
      expect(warnings().join('\n')).not.toContain(TABLE_NAME);
      // withRetry's per-attempt debug line quotes AWS's text, and the settle
      // wait's lines name the table: both go through the same masked sink.
      expect(debugs().some((d) => d.includes('***'))).toBe(true);
      expect(debugs().join('\n')).not.toContain(TABLE_NAME);
    });

    it('still reports the table left behind when the refusal outlasts the retries', async () => {
      const stub = route(Number.POSITIVE_INFINITY);
      const error = await createError(provider);
      expect(stub.deletes()).toBeGreaterThan(1);
      expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBe(TABLE_NAME);
    });

    it('stops retrying when the allowance runs out mid-loop, and reports the table left behind', async () => {
      // A clock that advances 40s per DeleteTable against a 60s allowance:
      // room for the first retry, none after the second refusal.
      let now = 0;
      dynamoDbDeleteBudgetOverride.totalMs = 60_000;
      dynamoDbDeleteBudgetOverride.clock = () => now;
      const stub = route(Number.POSITIVE_INFINITY);
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof DeleteTableCommand) now += 40_000;
        return base(command);
      });
      const error = await createError(provider);
      expect(stub.deletes()).toBeGreaterThan(1);
      expect(stub.deletes()).toBeLessThan(15);
      expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBe(TABLE_NAME);
    });

    it('retries when the enclosing deadline leaves room past the margin', async () => {
      const stub = route(1);
      const error = await withResourceDeadline(() => createError(provider), {
        warnAfterMs: 1_000,
        timeoutMs: DYNAMODB_DELETE_DEADLINE_MARGIN_MS + 120_000,
        onTimeout: () => new Error('deadline'),
      });
      expect(stub.deletes()).toBe(2);
      expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBeUndefined();
    });

    it('does not retry once the enclosing deadline has no room left', async () => {
      // 60s left is under the delete path's 4-minute margin: a retry loop here
      // would keep deleting behind a run the deadline already failed.
      const stub = route(1);
      const error = await withResourceDeadline(() => createError(provider), {
        warnAfterMs: 30_000,
        timeoutMs: 60_000,
        onTimeout: () => new Error('deadline'),
      });
      expect(stub.deletes()).toBe(1);
      expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBe(TABLE_NAME);
    });

    it('does not retry a refusal that is not the index-busy one', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'CreateTableCommand') return { TableDescription: { TableId: 'tid-1' } };
        if (name === 'UpdateContinuousBackupsCommand') {
          throw accessDenied('UpdateContinuousBackups');
        }
        if (command instanceof DeleteTableCommand) throw accessDenied('DeleteTable');
        if (command instanceof DescribeTableCommand) {
          return { Table: tableWithVectorIndex('ACTIVE') };
        }
        return {};
      });
      const error = await createError(provider);
      expect(mockSend.mock.calls.filter((c) => c[0] instanceof DeleteTableCommand)).toHaveLength(
        1
      );
      expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBe(TABLE_NAME);
    });
  });
});
