import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));
import {
  deployStackRecordsView,
  destroyStackRecordsView,
  getStackRecords,
  replayStackRecordsView,
  withStackRecords,
  type StackRecordsView,
} from '../../../src/deployment/stack-records-scope.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';

/** go-to-k/cdkd#4492: which records of a stack outlive the operation in flight. */
describe('stack-records-scope (#4492)', () => {
  const record = (deletionPolicy?: ResourceState['deletionPolicy']): ResourceState =>
    ({
      physicalId: 'p',
      resourceType: 'AWS::EC2::SecurityGroupIngress',
      properties: {},
      attributes: {},
      dependencies: [],
      ...(deletionPolicy && { deletionPolicy }),
    }) as ResourceState;
  const ids = (entries: Iterable<readonly [string, ResourceState]>) => [...entries].map(([id]) => id).sort();

  it('a deploy: survivors are the records its DELETE phase does not remove, plus the ones it retains', () => {
    const before = {
      Kept: record(),
      Deleted: record(),
      Retained: record('Retain'),
      RetainedOnCreate: record('RetainExceptOnCreate'),
    };
    const records: Record<string, ResourceState> = { ...before, Created: record() };
    // A retained DELETE drops its record from the bag; its resource stays.
    delete records['Retained'];
    const view = deployStackRecordsView(
      records,
      before,
      new Set(['Deleted', 'Retained', 'RetainedOnCreate'])
    );

    expect(ids(view.live())).toEqual(['Created', 'Deleted', 'Kept', 'RetainedOnCreate']);
    expect(ids(view.survivors())).toEqual(['Created', 'Kept', 'Retained', 'RetainedOnCreate']);
  });

  it('a deploy view reads the bag when called, as the deploy writes it', () => {
    const records: Record<string, ResourceState> = {};
    const view = deployStackRecordsView(records, {}, new Set());
    records['Later'] = record();

    expect(ids(view.live())).toEqual(['Later']);
    expect(ids(view.survivors())).toEqual(['Later']);
  });

  it('a deploy: a record whose UPDATE has not completed is in neither view', () => {
    const records: Record<string, ResourceState> = { Updating: record(), Kept: record() };
    const settled = new Set<string>();
    const view = deployStackRecordsView(records, {}, new Set(), (lid) => lid === 'Updating' && !settled.has(lid));

    expect(ids(view.live())).toEqual(['Kept']);
    expect(ids(view.survivors())).toEqual(['Kept']);
    settled.add('Updating');
    expect(ids(view.live())).toEqual(['Kept', 'Updating']);
    expect(ids(view.survivors())).toEqual(['Kept', 'Updating']);
  });

  it('a destroy: only a retained record survives', () => {
    const view = destroyStackRecordsView({
      A: record(),
      B: record('Retain'),
      C: record('Snapshot'),
      D: record('RetainExceptOnCreate'),
    });

    expect(ids(view.live())).toEqual(['A', 'B', 'C', 'D']);
    expect(ids(view.survivors())).toEqual(['B', 'D']);
  });

  it('a rollback replay: a record it drops but leaves in AWS (Retain, --orphan) still survives', () => {
    const records: Record<string, ResourceState> = {
      Retained: record('Retain'),
      OnCreate: record('RetainExceptOnCreate'),
      Orphaned: record(),
      Deleted: record(),
    };
    const view = replayStackRecordsView(records, new Set(['Orphaned']));
    for (const lid of Object.keys(records)) delete records[lid];

    expect(ids(view.live())).toEqual([]);
    // A rolled-back CREATE under RetainExceptOnCreate is deleted, so it does not survive.
    expect(ids(view.survivors())).toEqual(['Orphaned', 'Retained']);
  });

  it('a rollback replay: every live record survives the op in flight', () => {
    const records: Record<string, ResourceState> = { A: record(), B: record() };
    const view = replayStackRecordsView(records);
    delete records['A'];

    expect(ids(view.live())).toEqual(['B']);
    expect(ids(view.survivors())).toEqual(['B']);
  });

  it('an inner binding replaces the outer one, and an undefined binding hides it', async () => {
    const outer: StackRecordsView = { live: () => [], survivors: () => [] };
    const inner: StackRecordsView = { live: () => [], survivors: () => [] };

    expect(getStackRecords()).toBeUndefined();
    await withStackRecords(outer, async () => {
      await Promise.resolve();
      expect(getStackRecords()).toBe(outer);
      await withStackRecords(inner, async () => {
        await Promise.resolve();
        expect(getStackRecords()).toBe(inner);
      });
      withStackRecords(undefined, () => expect(getStackRecords()).toBeUndefined());
      expect(getStackRecords()).toBe(outer);
    });
  });
});

describe('the rollback replay binds its own records around each provider call (#4492)', () => {
  const silentLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    setLevel: () => undefined,
    child: () => silentLogger,
  } as unknown as RollbackExecutorContext['logger'];
  const res = (physicalId: string): ResourceState =>
    ({ physicalId, resourceType: 'AWS::S3::Bucket', properties: {}, attributes: {}, dependencies: [] }) as ResourceState;

  const observingCtx = (seen: string[][]): RollbackExecutorContext => ({
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({
        provider: {
          delete: async () => {
            const view = getStackRecords();
            seen.push(view ? [...view.survivors()].map(([id]) => id).sort() : ['<unbound>']);
          },
        },
      }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  });

  it('replayRollback: each delete sees the records still live, so the last holder sees no other', async () => {
    const seen: string[][] = [];
    const state: Record<string, ResourceState> = { A: res('a'), B: res('b') };
    const ops: CompletedOperation[] = [
      { logicalId: 'A', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'a' },
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'b' },
    ];

    await withStackRecords({ live: () => [['Outer', res('o')]], survivors: () => [['Outer', res('o')]] }, () =>
      replayRollback(ops, state, 'S', observingCtx(seen))
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(['A', 'B']);
    expect(seen[1]!).toHaveLength(1);
    expect(['A', 'B']).toContain(seen[1]![0]);
  });

  it('replayRollback: a record --orphan dropped still survives for the next delete', async () => {
    const seen: string[][] = [];
    const state: Record<string, ResourceState> = { A: res('a'), B: res('b') };
    const ops: CompletedOperation[] = [
      { logicalId: 'A', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'a' },
      { logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'b' },
    ];

    await replayRollback(ops, state, 'S', observingCtx(seen), { orphanLogicalIds: new Set(['A']) });

    expect(seen).toEqual([['A', 'B']]);
  });

  it('replayFailedOperations binds the same view', async () => {
    const seen: string[][] = [];
    const state: Record<string, ResourceState> = { A: res('a'), B: res('b') };
    const failed: FailedOperation[] = [
      { logicalId: 'A', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'a' },
    ];

    await replayFailedOperations(failed, state, 'S', observingCtx(seen));

    expect(seen).toEqual([['A', 'B']]);
  });
});
