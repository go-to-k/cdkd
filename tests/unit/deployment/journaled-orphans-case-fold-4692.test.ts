/**
 * go-to-k/cdkd#4692: every check whose match KEEPS a journaled proven orphan
 * (a state record, another stack's record, a rollback-orphan record or a newer
 * journaled op holds it) compares physical ids under the type's case rule
 * (`physicalIdKey`). RDS, DocumentDB, Neptune and ElastiCache identifiers are
 * case-insensitive, and a provider records the identifier as the template
 * spelled it: a record holding `mycluster` holds the cluster a journal names
 * `MyCluster`, so the settle must not delete it. A case-sensitive type keeps
 * comparing exactly: `Orders` and `orders` are two DynamoDB tables.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

import {
  classifyFailedOp,
  demoteSupersededOrphans,
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  makeForeignHolderScan,
  settleJournaledOrphansOnSuccess,
} from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import {
  ASCII_CASE_INSENSITIVE_NAME_TYPES,
  CASE_INSENSITIVE_NAME_TYPES,
  physicalIdKey,
  samePhysicalId,
} from '../../../src/deployment/replacement-name-holder/name-keys.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const REGION = 'us-east-1';
const CLUSTER = 'AWS::RDS::DBCluster';
const TABLE = 'AWS::DynamoDB::Table';
const TOKEN = 'cluster-ABCDEFGHIJKLMNOP';

const orphan = (over: Partial<FailedOperation> = {}): FailedOperation => ({
  logicalId: 'OrphanCluster',
  changeType: 'CREATE',
  resourceType: CLUSTER,
  physicalId: 'MyCluster',
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  deletionPolicy: 'Delete',
  createdResourceIdentity: TOKEN,
  attemptedProperties: {},
  ...over,
});

const record = (physicalId: string, resourceType = CLUSTER): ResourceState => ({
  physicalId,
  resourceType,
  provisionedBy: 'sdk',
  properties: {},
  attributes: {},
  dependencies: [],
});

/** A state backend whose `listStacks` / `getState` answer `stacks` (stack name -> resources). */
function backendOf(stacks: Record<string, Record<string, ResourceState>>) {
  return {
    listStacks: vi.fn(async () => Object.keys(stacks).map((stackName) => ({ stackName, region: REGION }))),
    getState: vi.fn(async (stackName: string) => ({
      state: { version: 10, stackName, region: REGION, resources: stacks[stackName] ?? {}, outputs: {} },
    })),
  };
}

interface SettleOptions {
  op?: FailedOperation;
  /** This stack's records after the deploy. */
  own?: Record<string, ResourceState>;
  /** Other stacks' records under the same state prefix. */
  others?: Record<string, Record<string, ResourceState>>;
  rollbackOrphans?: unknown;
  newerOperations?: unknown[];
}

async function settle(opts: SettleOptions = {}) {
  const del = vi.fn().mockResolvedValue(undefined);
  const resourceIdentity = vi.fn(async () => TOKEN);
  const provider = { delete: del, resourceIdentity };
  const journal = {
    journalVersion: 1,
    stackName: 'S',
    region: REGION,
    segments: [
      {
        timestamp: 1,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        operations: [],
        failedOperations: [opts.op ?? orphan()],
      },
    ],
  };
  const own = opts.own ?? {};
  const backend = backendOf({ S: own, ...opts.others });
  const stateBackend = {
    ...backend,
    loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
    reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
    markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
    dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    providerRegistry: {
      getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
      getProvider: vi.fn(() => provider),
    },
    region: REGION,
    logger,
  } as unknown as RollbackExecutorContext;
  const out = await settleJournaledOrphansOnSuccess({
    stateBackend: stateBackend as never,
    stackName: 'S',
    region: REGION,
    stateResources: own,
    rollbackOrphans: opts.rollbackOrphans,
    newerOperations: (opts.newerOperations ?? []) as never,
    // The real scan, so its key is what decides.
    foreignHolder: makeForeignHolderScan(stateBackend as never)({ stackName: 'S', region: REGION }),
    ctx,
    logger: logger as never,
  });
  const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
  return { out, del, resourceIdentity, warned };
}

const HELD_ELSEWHERE = 'holds a resource of that type under the same physical id';

describe('physicalIdKey (go-to-k/cdkd#4692)', () => {
  it('folds the case-insensitive DB identifier types the settle can delete', () => {
    for (const type of [
      'AWS::RDS::DBCluster',
      'AWS::RDS::DBInstance',
      'AWS::DocDB::DBCluster',
      'AWS::DocDB::DBInstance',
      'AWS::Neptune::DBCluster',
      'AWS::Neptune::DBInstance',
      'AWS::ElastiCache::CacheCluster',
    ]) {
      expect(CASE_INSENSITIVE_NAME_TYPES.has(type)).toBe(true);
      expect(samePhysicalId(type, 'MyCluster', 'mycluster')).toBe(true);
    }
  });

  it('folds every type of either case-insensitive set, and nothing else', () => {
    for (const type of CASE_INSENSITIVE_NAME_TYPES) {
      expect(physicalIdKey(type, 'AbC')).toBe('abc');
    }
    for (const type of ASCII_CASE_INSENSITIVE_NAME_TYPES) {
      expect(physicalIdKey(type, 'Db|TÄble')).toBe('db|tÄble');
    }
    for (const type of [TABLE, 'AWS::S3::Bucket', 'AWS::Kinesis::Stream', 'AWS::SQS::Queue']) {
      expect(physicalIdKey(type, 'Orders')).toBe('Orders');
      expect(samePhysicalId(type, 'Orders', 'orders')).toBe(false);
    }
  });
});

describe('settleJournaledOrphansOnSuccess: a record holding the orphan in another case (go-to-k/cdkd#4692)', () => {
  it('control: an orphan no record holds is deleted', async () => {
    const r = await settle();
    expect(r.del).toHaveBeenCalledOnce();
    expect(r.out.unaddressed).toBe(0);
  });

  it('keeps it when a record of this stack under another logical id holds it in lower case', async () => {
    const r = await settle({ own: { Adopted: record('mycluster') } });
    expect(r.del).not.toHaveBeenCalled();
    // Tracked: settled silently, no identity read, nothing left unaddressed.
    expect(r.resourceIdentity).not.toHaveBeenCalled();
    expect(r.warned).toBe('');
    expect(r.out).toEqual({ unaddressed: 0, keepJournal: false, stripCleared: expect.any(Function) });
  });

  it('keeps and warns about it when another stack holds it in lower case', async () => {
    const r = await settle({ others: { Other: { Adopted: record('mycluster') } } });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain(HELD_ELSEWHERE);
    expect(r.warned).toContain('Other');
    expect(r.out.unaddressed).toBe(1);
  });

  it('keeps it when a rollback-orphan record holds it in lower case', async () => {
    const r = await settle({
      rollbackOrphans: [{ logicalId: 'Elsewhere', state: record('mycluster') }],
    });
    expect(r.del).not.toHaveBeenCalled();
  });

  it('keeps it when this deploy completed an op on it under another logical id in lower case', async () => {
    const r = await settle({
      newerOperations: [
        {
          logicalId: 'Adopted',
          changeType: 'UPDATE',
          resourceType: CLUSTER,
          physicalId: 'mycluster',
          provisionedBy: 'sdk',
        },
      ],
    });
    expect(r.del).not.toHaveBeenCalled();
  });

  describe('a case-sensitive type compares exactly', () => {
    const tableOrphan = orphan({
      logicalId: 'OrphanTable',
      resourceType: TABLE,
      physicalId: 'Orders',
    });

    it('deletes beside a record of this stack that differs in case only', async () => {
      const r = await settle({ op: tableOrphan, own: { Adopted: record('orders', TABLE) } });
      expect(r.del).toHaveBeenCalledOnce();
      expect(r.del.mock.calls[0]![1]).toBe('Orders');
    });

    it('deletes beside another stack’s record that differs in case only', async () => {
      const r = await settle({ op: tableOrphan, others: { Other: { T: record('orders', TABLE) } } });
      expect(r.del).toHaveBeenCalledOnce();
      expect(r.warned).not.toContain(HELD_ELSEWHERE);
    });

    it('control: still keeps it beside a record holding the exact id', async () => {
      const own = await settle({ op: tableOrphan, own: { Adopted: record('Orders', TABLE) } });
      expect(own.del).not.toHaveBeenCalled();
      const other = await settle({ op: tableOrphan, others: { Other: { T: record('Orders', TABLE) } } });
      expect(other.del).not.toHaveBeenCalled();
      expect(other.warned).toContain(HELD_ELSEWHERE);
    });
  });
});

describe('makeForeignHolderScan under the type’s case rule (go-to-k/cdkd#4692)', () => {
  const scanOf = (stacks: Record<string, Record<string, ResourceState>>) =>
    makeForeignHolderScan(backendOf(stacks) as never)({ stackName: 'Self', region: REGION });

  it('finds another stack’s record spelling a case-insensitive id in another case', async () => {
    const scan = scanOf({ Other: { C: record('mycluster') } });
    expect(await scan(CLUSTER, 'MyCluster')).toEqual({ kind: 'held', by: expect.stringContaining('Other') });
    expect(await scan(CLUSTER, 'MYCLUSTER')).toEqual(expect.objectContaining({ kind: 'held' }));
  });

  it('does not find a case-sensitive id spelled in another case, and does find it spelled alike', async () => {
    const scan = scanOf({ Other: { T: record('orders', TABLE) } });
    expect(await scan(TABLE, 'Orders')).toBeUndefined();
    expect(await scan(TABLE, 'orders')).toEqual(expect.objectContaining({ kind: 'held' }));
  });

  it('still never counts this stack’s own record, in any case', async () => {
    const scan = scanOf({ Self: { C: record('mycluster') } });
    expect(await scan(CLUSTER, 'MyCluster')).toBeUndefined();
  });
});

describe('classifyFailedOp and demoteSupersededOrphans under the type’s case rule (go-to-k/cdkd#4692)', () => {
  it('skips an orphan a record under another logical id holds in another case', () => {
    expect(classifyFailedOp(orphan(), { Adopted: record('mycluster') })).toBe('skip-failed-noop');
    expect(classifyFailedOp(orphan(), {})).toBe('delete-failed-create');
  });

  it('settles as a no-op when the record under its own logical id holds it in another case', () => {
    expect(classifyFailedOp(orphan(), { OrphanCluster: record('mycluster') })).toBe('skip-failed-noop');
  });

  // The exact comparison stays type-blind, as before the fold was added.
  it('still settles as a no-op beside a record of another type under its own logical id and exact id', () => {
    expect(
      classifyFailedOp(orphan(), { OrphanCluster: record('MyCluster', 'AWS::SQS::Queue') })
    ).toBe('skip-failed-noop');
  });

  it('deletes a case-sensitive orphan beside a record that differs in case only', () => {
    const op = orphan({ logicalId: 'T', resourceType: TABLE, physicalId: 'Orders' });
    expect(classifyFailedOp(op, { Adopted: record('orders', TABLE) })).toBe('delete-failed-create');
    expect(classifyFailedOp(op, { Adopted: record('Orders', TABLE) })).toBe('skip-failed-noop');
  });

  it('demotes an orphan a rollback-orphan record or a newer op holds in another case', () => {
    const segmentOf = (op: FailedOperation) => ({ failedOperations: [op] });
    const byRecord = orphan();
    expect(demoteSupersededOrphans([segmentOf(byRecord)], [{ logicalId: 'X', state: record('mycluster') }])).toBe(1);
    expect(byRecord.physicalIdRecoveredFromError).toBe(false);

    const byNewer = orphan();
    const newer = {
      failedOperations: [orphan({ logicalId: 'X', physicalId: 'mycluster', physicalIdRecoveredFromError: undefined })],
    };
    expect(demoteSupersededOrphans([segmentOf(byNewer), newer])).toBe(1);

    const byPrevious = orphan();
    const updated = {
      operations: [
        {
          logicalId: 'X',
          changeType: 'UPDATE',
          resourceType: CLUSTER,
          physicalId: 'other',
          previousState: { physicalId: 'mycluster' },
        },
      ],
    };
    expect(demoteSupersededOrphans([segmentOf(byPrevious), updated])).toBe(1);
  });

  it('does not demote a case-sensitive orphan over a case-only difference', () => {
    const op = orphan({ resourceType: TABLE, physicalId: 'Orders' });
    const rec = { logicalId: 'X', state: record('orders', TABLE) };
    expect(demoteSupersededOrphans([{ failedOperations: [op] }], [rec])).toBe(0);
    expect(op.physicalIdRecoveredFromError).toBe(true);
  });
});

describe('--remove-protection over an orphan another stack holds in another case (go-to-k/cdkd#4692)', () => {
  // A standalone RDS instance a `cdkd import` adopted into stack B as `mydb`:
  // destroying A must not strip B's deletion protection.
  const instanceOrphan = (): FailedOperation =>
    orphan({
      logicalId: 'OrphanDb',
      resourceType: 'AWS::RDS::DBInstance',
      physicalId: 'MyDb',
      createdResourceIdentity: 'db-TOKEN',
      attemptedProperties: { DeletionProtection: true },
    });

  async function replay(holders: Record<string, Record<string, ResourceState>>, op: FailedOperation) {
    const contexts: Array<Record<string, unknown>> = [];
    const del = vi.fn(async (...args: unknown[]) => {
      contexts.push(args[4] as Record<string, unknown>);
    });
    const warn = vi.fn();
    const ctx: RollbackExecutorContext = {
      region: REGION,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as unknown as RollbackExecutorContext['logger'],
      providerRegistry: {
        getProviderFor: () => ({
          provider: { delete: del, resourceIdentity: vi.fn(async () => op.createdResourceIdentity) },
          provisionedBy: 'sdk',
        }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      removeProtection: true,
      foreignHolder: makeForeignHolderScan(backendOf(holders) as never)({ stackName: 'A', region: REGION }),
    };
    await replayFailedOperations([op], {}, 'A', ctx, {});
    return { contexts, warned: warn.mock.calls.map((c) => String(c[0])).join('\n') };
  }

  it('withholds the flag when another stack holds it in lower case', async () => {
    const r = await replay({ B: { Db: record('mydb', 'AWS::RDS::DBInstance') } }, instanceOrphan());
    expect(r.contexts[0]).not.toHaveProperty('removeProtection');
    expect(r.warned).toContain('holds it now');
  });

  it('control: passes the flag when no other stack holds it', async () => {
    const r = await replay({ B: {} }, instanceOrphan());
    expect(r.contexts[0]?.['removeProtection']).toBe(true);
  });
});
