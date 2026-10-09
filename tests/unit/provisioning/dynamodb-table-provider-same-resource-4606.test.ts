import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier DynamoDB table (only `'different'` lets it
// delete), and the `TableId` a failed CREATE journals beside the orphan's
// table name for the settle to compare, so a table re-created under the name
// is never deleted as the orphan.

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const providerLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

const sharedClient = vi.hoisted(() => ({
  send: mockSend,
  config: { region: () => Promise.resolve(clientRegion.value) },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ dynamoDB: sharedClient }),
}));

// Issue #4639: `CreateTable` goes through a dedicated client built in the
// shared client's region; route it to the same double.
vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  return { ...actual, DynamoDBClient: vi.fn().mockImplementation(() => sharedClient) };
});

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';

const TYPE = 'AWS::DynamoDB::Table';
const CTX = { expectedRegion: 'us-east-1' };

const notFound = (name: string): Error =>
  new ResourceNotFoundException({ message: `Requested resource not found: Table: ${name} not found`, $metadata: {} });

const denied = (op: string): Error =>
  Object.assign(new Error(`User is not authorized to perform: dynamodb:${op}`), {
    name: 'AccessDeniedException',
  });

/**
 * One table name's DescribeTable answer: its `TableId`, gone, an error, a
 * response naming another table, or one naming no `TableId`.
 */
type Entry = string | 'gone' | Error | { answeredAs: string } | 'no-id';

/** DescribeTable answers per table name, exactly as asked (names are case-sensitive). */
function live(entries: Record<string, Entry>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeTableCommand)) throw new Error('unexpected command');
    const asked = cmd.input.TableName!;
    const entry = entries[asked];
    if (entry === undefined || entry === 'gone') throw notFound(asked);
    if (entry instanceof Error) throw entry;
    if (entry === 'no-id') return { Table: { TableName: asked, TableStatus: 'ACTIVE' } };
    if (typeof entry === 'object') {
      return { Table: { TableName: entry.answeredAs, TableId: 'tid-OTHER' } };
    }
    return { Table: { TableName: asked, TableId: entry, TableStatus: 'ACTIVE' } };
  });
}

const askedNames = (): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) =>
    cmd instanceof DescribeTableCommand ? cmd.input.TableName : `<${String(cmd)}>`
  );

describe('DynamoDBTableProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new DynamoDBTableProvider();
  });

  it('another live table under another TableId is different', async () => {
    live({ 'orders-a': 'tid-A', 'orders-b': 'tid-B' });
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
    ).resolves.toBe('different');
    // The record's table is read first: it must exist for any verdict.
    expect(askedNames()).toEqual(['orders-b', 'orders-a']);
  });

  it('two names reading back under one TableId are the same table', async () => {
    live({ 'orders-a': 'tid-A', 'orders-b': 'tid-A' });
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
    ).resolves.toBe('same');
  });

  it('a journaled table AWS reports gone is different once the record reads back', async () => {
    live({ 'orders-b': 'tid-B' });
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
    ).resolves.toBe('different');
  });

  it("the record's table gone is unknown, not different, whatever the journaled one reads", async () => {
    for (const journaled of ['tid-A', 'gone'] as const) {
      mockSend.mockReset();
      live({ 'orders-a': journaled });
      await expect(
        provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
      ).resolves.toBe('unknown');
    }
  });

  it('equal names are the same without a read', async () => {
    live({});
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-a' }, TYPE, CTX)
    ).resolves.toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('names differing only in case are two names, each read as written (names are case-sensitive)', async () => {
    live({ Orders: 'tid-UPPER', orders: 'tid-lower' });
    await expect(
      provider.isSameResource('Orders', { physicalId: 'orders' }, TYPE, CTX)
    ).resolves.toBe('different');
    expect(askedNames()).toEqual(['orders', 'Orders']);
  });

  it('a read failing other than with ResourceNotFoundException throws (the caller reads it as unknown)', async () => {
    live({ 'orders-a': denied('DescribeTable'), 'orders-b': 'tid-B' });
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
    ).rejects.toThrow('not authorized');
  });

  it('"not found" in the message of another error class never reads as gone', async () => {
    const lookalike = Object.assign(new Error('Table: orders-a not found'), {
      name: 'ValidationException',
    });
    live({ 'orders-a': lookalike, 'orders-b': 'tid-B' });
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
    ).rejects.toThrow('not found');
  });

  it('a response naming another table, or no TableId, throws rather than comparing it', async () => {
    live({ 'orders-a': { answeredAs: 'someone-else' }, 'orders-b': 'tid-B' });
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
    ).rejects.toThrow('another table');
    mockSend.mockReset();
    live({ 'orders-a': 'no-id', 'orders-b': 'tid-B' });
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
    ).rejects.toThrow('no TableId');
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'us-west-2';
    live({ 'orders-a': 'tid-A', 'orders-b': 'tid-B' });
    await expect(
      provider.isSameResource('orders-a', { physicalId: 'orders-b' }, TYPE, CTX)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an ARN', 'arn:aws:dynamodb:us-east-1:123456789012:table/orders-a'],
    ['a too-short name', 'ab'],
    ['a name with a slash', 'orders/a'],
    ['an empty id', ''],
    ['a name one past the longest', 'a'.repeat(256)],
  ])('%s on either side is unknown, with no read', async (_label, bad) => {
    live({});
    await expect(
      provider.isSameResource(bad, { physicalId: 'orders-b' }, TYPE, CTX)
    ).resolves.toBe('unknown');
    await expect(
      provider.isSameResource('orders-a', { physicalId: bad }, TYPE, CTX)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the longest legal name, and one using every legal character class, are read', async () => {
    const longest = 'a'.repeat(255);
    const mixed = 'My_Table.v2-x';
    live({ [longest]: 'tid-L', [mixed]: 'tid-M' });
    await expect(
      provider.isSameResource(longest, { physicalId: mixed }, TYPE, CTX)
    ).resolves.toBe('different');
    expect(askedNames()).toEqual([mixed, longest]);
  });

  it.each(['AWS::DynamoDB::GlobalTable', 'AWS::S3::Bucket'])(
    'another type (%s) is unknown, with no read',
    async (other) => {
      live({ 'orders-a': 'tid-A', 'orders-b': 'tid-B' });
      await expect(
        provider.isSameResource('orders-a', { physicalId: 'orders-b' }, other, CTX)
      ).resolves.toBe('unknown');
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});

describe('DynamoDBTableProvider.resourceIdentity (go-to-k/cdkd#4606)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new DynamoDBTableProvider();
  });

  it('is the live TableId, read under the name as written', async () => {
    live({ 'orders-a': 'tid-A' });
    await expect(provider.resourceIdentity('orders-a', TYPE, CTX)).resolves.toBe('tid-A');
    expect(askedNames()).toEqual(['orders-a']);
  });

  it('is RESOURCE_NOT_FOUND on ResourceNotFoundException', async () => {
    live({});
    await expect(provider.resourceIdentity('orders-a', TYPE, CTX)).resolves.toBe(
      RESOURCE_NOT_FOUND
    );
  });

  it('throws on any other failure, "not found" in the message included (never gone)', async () => {
    live({ 'orders-a': denied('DescribeTable') });
    await expect(provider.resourceIdentity('orders-a', TYPE, CTX)).rejects.toThrow(
      'not authorized'
    );
    mockSend.mockReset();
    live({
      'orders-a': Object.assign(new Error('orders-a not found'), { name: 'InternalServerError' }),
    });
    await expect(provider.resourceIdentity('orders-a', TYPE, CTX)).rejects.toThrow('not found');
  });

  it('throws on a response naming no TableId, or another table', async () => {
    live({ 'orders-a': 'no-id' });
    await expect(provider.resourceIdentity('orders-a', TYPE, CTX)).rejects.toThrow('no TableId');
    mockSend.mockReset();
    live({ 'orders-a': { answeredAs: 'orders-z' } });
    await expect(provider.resourceIdentity('orders-a', TYPE, CTX)).rejects.toThrow(
      'another table'
    );
  });

  it('is undefined, with no read, for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    live({ 'orders-a': 'tid-A' });
    await expect(provider.resourceIdentity('orders-a', TYPE, CTX)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is undefined, with no read, for an id that is not a table name, or another type', async () => {
    live({ 'orders-a': 'tid-A' });
    await expect(
      provider.resourceIdentity('arn:aws:dynamodb:us-east-1:123456789012:table/orders-a', TYPE, CTX)
    ).resolves.toBeUndefined();
    await expect(
      provider.resourceIdentity('orders-a', 'AWS::DynamoDB::GlobalTable', CTX)
    ).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("the created-before-failure mark carries CreateTable's TableId (go-to-k/cdkd#4606)", () => {
  const PROPS = {
    TableName: 'orders-a',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /**
   * CreateTable answers `tableId` on the first call (a later one
   * ResourceInUseException); the ACTIVE wait reads the table back under
   * `describedId`; UpdateTimeToLive and DeleteTable are denied unless
   * `deleteSucceeds`.
   */
  function aws(opts: {
    tableId: string | undefined;
    describedId?: string;
    deleteSucceeds?: boolean;
  }): void {
    let creates = 0;
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd instanceof CreateTableCommand) {
        if (creates++ > 0) {
          throw new ResourceInUseException({
            message: 'Table already exists: orders-a',
            $metadata: {},
          });
        }
        return {
          TableDescription: { TableName: 'orders-a', TableStatus: 'CREATING', TableId: opts.tableId },
        };
      }
      if (cmd instanceof DescribeTableCommand) {
        return {
          Table: {
            TableName: 'orders-a',
            TableStatus: 'ACTIVE',
            TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/orders-a',
            TableId: opts.describedId ?? 'tid-DESCRIBED',
          },
        };
      }
      if (cmd instanceof DeleteTableCommand) {
        if (opts.deleteSucceeds === true) return {};
        throw denied('DeleteTable');
      }
      if (cmd.constructor.name === 'UpdateTimeToLiveCommand') throw denied('UpdateTimeToLive');
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });
  }

  const failureOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => {
        throw new Error('the create succeeded');
      },
      (e: unknown) => e
    );

  it("a post-create failure whose rollback DeleteTable fails marks the name and CreateTable's TableId", async () => {
    aws({ tableId: 'tid-CREATED' });
    const error = await failureOf(new DynamoDBTableProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('orders-a');
    // The create response's id, never a later read's.
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBe('tid-CREATED');
  });

  // The retry the AccessDenied triggers replays the create, which fails with
  // ResourceInUseException: the error finally thrown keeps the FIRST
  // attempt's mark, identity included.
  it("a replay failing with ResourceInUseException keeps the first attempt's TableId", async () => {
    aws({ tableId: 'tid-CREATED' });
    const provider = new DynamoDBTableProvider();
    let attempts = 0;
    const error = await failureOf(
      withRetry(
        () => {
          attempts++;
          return provider.create('Orphan', TYPE, PROPS);
        },
        'Orphan',
        { sleep: async () => {}, maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 }
      )
    );
    expect(attempts).toBeGreaterThan(1);
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('orders-a');
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBe('tid-CREATED');
  });

  it('a CreateTable response with no TableId marks the name alone', async () => {
    aws({ tableId: undefined });
    const error = await failureOf(new DynamoDBTableProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('orders-a');
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
  });

  it('a rollback DeleteTable that succeeded marks nothing, identity included', async () => {
    aws({ tableId: 'tid-CREATED', deleteSucceeds: true });
    const error = await failureOf(new DynamoDBTableProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
  });
});

describe('DynamoDBTableProvider.delete of a journaled table already gone (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  it('names it once at info, since the settle then exits 0 with nothing deleted', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DescribeTableCommand || cmd instanceof DeleteTableCommand) {
        throw notFound('orphan-table');
      }
      throw new Error('unexpected command');
    });
    const provider = new DynamoDBTableProvider();
    await provider.delete('Orphan', 'orphan-table', TYPE, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('DynamoDB table orphan-table (Orphan)');
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line, the flag absent or false.
    const skipDebugLines = (): number =>
      providerLogger.debug.mock.calls.filter(([m]) =>
        String(m).includes('does not exist, skipping deletion')
      ).length;
    for (const context of [
      { expectedRegion: 'us-east-1' },
      { expectedRegion: 'us-east-1', failedCreateOrphan: false },
    ]) {
      providerLogger.info.mockClear();
      providerLogger.debug.mockClear();
      await provider.delete('Orphan', 'orphan-table', TYPE, {}, context);
      expect(providerLogger.info).not.toHaveBeenCalled();
      expect(skipDebugLines()).toBe(1);
    }
  });
});

// The settle end to end with the real provider: the journaled orphan
// `orders-a` carries `tid-ORPHAN` (its CreateTable response's id).
describe('the success settle with DynamoDBTableProvider (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /**
   * `fixForward`: the fix-forward's record under the orphan's logical id holds
   * `orders-b` (this deploy's CREATE), read live under `recordTableId`.
   */
  async function settle(liveEntry: Entry, fixForward?: { recordTableId: string }) {
    const provider = new DynamoDBTableProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live({
      'orders-a': liveEntry,
      ...(fixForward !== undefined && { 'orders-b': fixForward.recordTableId }),
    });
    const journal = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [
            {
              logicalId: 'Orphan',
              changeType: 'CREATE',
              resourceType: TYPE,
              physicalId: 'orders-a',
              provisionedBy: 'sdk',
              physicalIdRecoveredFromError: true,
              deletionPolicy: 'Delete',
              createdResourceIdentity: 'tid-ORPHAN',
              attemptedProperties: {},
            },
          ],
        },
      ],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
        getProvider: vi.fn(() => provider),
      },
      region: 'us-east-1',
      logger,
    } as unknown as RollbackExecutorContext;
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: {
        loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      } as never,
      stackName: 'S',
      region: 'us-east-1',
      stateResources: (fixForward === undefined
        ? {}
        : {
            Orphan: {
              physicalId: 'orders-b',
              resourceType: TYPE,
              provisionedBy: 'sdk',
              properties: {},
              attributes: {},
            },
          }) as never,
      rollbackOrphans: undefined,
      newerOperations: (fixForward === undefined
        ? []
        : [{ logicalId: 'Orphan', changeType: 'CREATE', resourceType: TYPE, physicalId: 'orders-b' }]) as never,
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      logger: logger as never,
    });
    return {
      out,
      del,
      warned: logger.warn.mock.calls.map((m) => String(m[0])).join('\n'),
      infos: logger.info.mock.calls.map((m) => String(m[0])).join('\n'),
    };
  }

  // The fix-forward itself: the record under the same logical id holds the
  // new `orders-b`, and DynamoDBTableProvider.isSameResource decides.
  it('the fix-forward: deletes `orders-a` when the record `orders-b` reads back under another TableId', async () => {
    const r = await settle('tid-ORPHAN', { recordTableId: 'tid-NEW' });
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.del.mock.calls[0]?.[1]).toBe('orders-a');
    expect(r.out.unaddressed).toBe(0);
  });

  it('the fix-forward: keeps it, silently, when the record reads back under the same TableId', async () => {
    const r = await settle('tid-ORPHAN', { recordTableId: 'tid-ORPHAN' });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(0);
  });

  it('the fix-forward: keeps it when `orders-a` was re-created (another TableId) before the settle', async () => {
    const r = await settle('tid-SOMEONE-ELSE', { recordTableId: 'tid-NEW' });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });

  it('the fix-forward: an earlier table already gone is named, not deleted, and settles', async () => {
    const r = await settle('gone', { recordTableId: 'tid-NEW' });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(0);
  });

  it('with no record under the id: deletes it when the name still reads back under the journaled TableId (control)', async () => {
    const r = await settle('tid-ORPHAN');
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.out.unaddressed).toBe(0);
  });

  it('with no record under the id: keeps it when the name now reads back under another TableId', async () => {
    const r = await settle('tid-SOMEONE-ELSE');
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });
});
