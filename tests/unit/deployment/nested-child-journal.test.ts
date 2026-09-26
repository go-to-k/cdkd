/**
 * The nested-child revert and journal settlement (issue
 * [#3754](https://github.com/go-to-k/cdkd/issues/3754)).
 *
 * `revertNestedChildFromJournal` is what a rollback does to a nested child
 * INSTEAD of re-deploying the current template: replay the child's own
 * segments for the parent run being rolled back. The cases pin the four things
 * that make that correct — the SELECTION (only this run's segments,
 * newest-first), the SCOPE the replay runs in (the child as the "parent" of its
 * rows, the same run, the child's stack name), the REFUSALS (no record means a
 * failed revert, never a silent "restored"), and the LOCK (held for the replay,
 * released on every path).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { RollbackJournalSegment } from '../../../src/types/rollback-journal.js';

const replay = vi.hoisted(() => ({
  calls: [] as Array<{
    ops: string[];
    stackName: string;
    nestedParent: string | undefined;
    nestedTemplates: unknown;
    run: unknown;
    stackScope: string | undefined;
  }>,
  failuresFor: new Set<string>(),
  readNested: (() => undefined) as () =>
    | { parentStackName: string; nestedTemplates?: unknown }
    | undefined,
  readRun: (() => undefined) as () => unknown,
  readStackName: (() => undefined) as () => string | undefined,
}));

// The factory must not import the module under test: it imports this mocked
// module, so the factory would wait on itself. The scope readers are wired in
// below, after the real imports resolve.
vi.mock('../../../src/deployment/rollback-executor.js', () => ({
  replayRollback: vi.fn(
    async (
      ops: Array<{ logicalId: string }>,
      stateResources: Record<string, unknown>,
      stackName: string,
      _ctx: unknown,
      options: { afterOp?: () => Promise<void> }
    ) => {
      const nested = replay.readNested();
      replay.calls.push({
        ops: ops.map((o) => o.logicalId),
        stackName,
        nestedParent: nested?.parentStackName,
        nestedTemplates: nested?.nestedTemplates,
        run: replay.readRun(),
        stackScope: replay.readStackName(),
      });
      for (const op of ops) {
        stateResources[op.logicalId] = { reverted: true };
        await options.afterOp?.();
      }
      const failures = ops.filter((o) => replay.failuresFor.has(o.logicalId)).length;
      return { failures, warnings: 0, interrupted: false, orphaned: [] };
    }
  ),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => l };
  return { getLogger: () => l };
});

import {
  dropNestedChildJournals,
  getNestedRevertRun,
  revertNestedChildFromJournal,
} from '../../../src/deployment/nested-child-journal.js';
import { getCurrentNestedStackContext } from '../../../src/provisioning/nested-stack-context.js';
import { getCurrentStackName } from '../../../src/provisioning/resource-name.js';

replay.readNested = getCurrentNestedStackContext;
replay.readRun = getNestedRevertRun;
replay.readStackName = getCurrentStackName;

const REGION = 'us-east-1';
const CHILD = 'Parent~Child';

function childState(resources: Record<string, unknown> = { Q: { resourceType: 'AWS::SQS::Queue' } }): StackState {
  return {
    version: 10,
    stackName: CHILD,
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: { QueueUrl: 'new-url' },
    exportNames: ['NewExport'],
    lastModified: 0,
  } as StackState;
}

function seg(runId: string | undefined, ops: string[], extra: Partial<RollbackJournalSegment> = {}) {
  return {
    ...(runId !== undefined && { runId }),
    timestamp: 0,
    reason: 'nested-pending-parent',
    initialDeploy: false,
    operations: ops.map((logicalId) => ({ logicalId, resourceType: 'AWS::SQS::Queue', changeType: 'UPDATE' })),
    ...extra,
  } as RollbackJournalSegment;
}

function harness(opts: { state?: StackState | null; segments?: RollbackJournalSegment[] | null }) {
  const stateBackend = {
    getState: vi
      .fn()
      .mockResolvedValue(opts.state === null ? null : { state: opts.state ?? childState(), etag: 'e1' }),
    loadRollbackJournal: vi
      .fn()
      .mockResolvedValue(opts.segments === null ? null : { segments: opts.segments ?? [] }),
    saveState: vi.fn().mockResolvedValue('e2'),
  };
  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
  const exportIndexStore = { updateForStack: vi.fn().mockResolvedValue(undefined) };
  const ctx = {
    stateBackend,
    lockManager,
    providerRegistry: {},
    parentStackName: 'Parent',
    parentRegion: REGION,
    accountId: '1',
    awsClients: {},
    stateBucket: 'b',
    exportIndexStore,
    nestedTemplates: { Child: '/tmp/child.json' },
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = (runId: string | undefined) =>
    revertNestedChildFromJournal({
      ctx: ctx as never,
      logicalId: 'Child',
      childStackName: CHILD,
      region: REGION,
      runId,
      logger: logger as never,
    });
  return { stateBackend, lockManager, exportIndexStore, run, logger };
}

beforeEach(() => {
  replay.calls.length = 0;
  replay.failuresFor.clear();
});

describe('revertNestedChildFromJournal (#3754)', () => {
  it('replays ONLY the segments of the run being rolled back, newest-first', async () => {
    const h = harness({
      segments: [
        seg('run-1', ['Old1']),
        seg('run-2', ['Other']),
        seg('run-1', ['New1']),
      ],
    });

    await h.run('run-1');

    expect(replay.calls.map((c) => c.ops)).toEqual([['New1'], ['Old1']]);
  });

  it('runs each replay as the child: its name, no templates, the same run', async () => {
    const h = harness({ segments: [seg('run-1', ['Q'])] });

    await h.run('run-1');

    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]).toMatchObject({
      stackName: CHILD,
      // A grandchild row reverted by this replay must derive `<child>~<id>`.
      nestedParent: CHILD,
      // A revert never deploys a template.
      nestedTemplates: undefined,
      run: { runId: 'run-1' },
      // `generateResourceName` reads it: a replayed re-create must mint the
      // name the forward create did.
      stackScope: CHILD,
    });
  });

  it('restores the OLDEST matching segment previous outputs and republishes the exports', async () => {
    const h = harness({
      segments: [
        seg('run-1', ['A'], { previousOutputs: { outputs: { QueueUrl: 'oldest' }, exportNames: ['OldExport'] } }),
        seg('run-1', ['B'], { previousOutputs: { outputs: { QueueUrl: 'middle' } } }),
      ],
    });

    await h.run('run-1');

    const saved = h.stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs).toEqual({ QueueUrl: 'oldest' });
    expect(saved.exportNames).toEqual(['OldExport']);
    expect(saved.resources).toMatchObject({ A: { reverted: true }, B: { reverted: true } });
    expect(h.exportIndexStore.updateForStack).toHaveBeenCalledOnce();
  });

  it('CONTROL: without a previousOutputs snapshot the outputs are left as they were', async () => {
    const h = harness({ segments: [seg('run-1', ['Q'])] });

    await h.run('run-1');

    const saved = h.stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs).toEqual({ QueueUrl: 'new-url' });
    expect(h.exportIndexStore.updateForStack).not.toHaveBeenCalled();
  });

  it('an EMPTY segment for the run is a successful no-op, not a refusal', async () => {
    const h = harness({ segments: [seg('run-1', [])] });

    await expect(h.run('run-1')).resolves.toBeUndefined();
    expect(replay.calls.map((c) => c.ops)).toEqual([[]]);
  });

  it('REFUSES when the child journal holds no segment for the run', async () => {
    const h = harness({ segments: [seg('run-2', ['Q'])] });

    await expect(h.run('run-1')).rejects.toThrow(/no segment for this deploy run/);
    expect(replay.calls).toHaveLength(0);
    expect(h.lockManager.releaseLock).toHaveBeenCalledWith(CHILD, REGION);
  });

  it('REFUSES when there is no child journal at all', async () => {
    const h = harness({ segments: null });

    await expect(h.run('run-1')).rejects.toThrow(/NOT \(fully\) reverted/);
  });

  it('REFUSES when the child state is missing', async () => {
    const h = harness({ state: null, segments: [seg('run-1', ['Q'])] });

    await expect(h.run('run-1')).rejects.toThrow(/state\.json is missing/);
    expect(h.lockManager.releaseLock).toHaveBeenCalledWith(CHILD, REGION);
  });

  it('a replayed op that FAILED fails the revert (no false "restored")', async () => {
    replay.failuresFor.add('Q');
    const h = harness({ segments: [seg('run-1', ['Q'])] });

    await expect(h.run('run-1')).rejects.toThrow(/1 of its operation\(s\) failed to revert/);
    expect(h.lockManager.releaseLock).toHaveBeenCalledWith(CHILD, REGION);
  });

  it('holds the CHILD lock for the replay', async () => {
    const h = harness({ segments: [seg('run-1', ['Q'])] });
    const order: string[] = [];
    h.lockManager.acquireLockWithRetry.mockImplementation(async () => {
      order.push('acquire');
      return true;
    });
    h.lockManager.releaseLock.mockImplementation(async () => {
      order.push('release');
    });
    h.stateBackend.loadRollbackJournal.mockImplementation(async () => {
      order.push('load');
      return { segments: [seg('run-1', ['Q'])] };
    });

    await h.run('run-1');

    expect(h.lockManager.acquireLockWithRetry).toHaveBeenCalledWith(CHILD, REGION, undefined, 'rollback');
    expect(order).toEqual(['acquire', 'load', 'release']);
  });

  it('runId-less segments match a runId-less run and nothing else', async () => {
    const h = harness({ segments: [seg(undefined, ['NoRun']), seg('run-1', ['WithRun'])] });

    await h.run(undefined);

    expect(replay.calls.map((c) => c.ops)).toEqual([['NoRun']]);
  });
});

describe('dropNestedChildJournals (#3754)', () => {
  function tree() {
    const states: Record<string, unknown> = {
      'Root~Child': {
        state: {
          resources: {
            Grand: { resourceType: 'AWS::CloudFormation::Stack' },
            Leaf: { resourceType: 'AWS::SQS::Queue' },
          },
        },
      },
      'Root~Child~Grand': { state: { resources: {} } },
    };
    const order: string[] = [];
    const stateBackend = {
      getState: vi.fn(async (name: string) => states[name] ?? null),
      loadRollbackJournal: vi.fn(async () => ({ segments: [{}] })),
      deleteRollbackJournal: vi.fn(async (name: string) => {
        order.push(`delete ${name}`);
      }),
      dropRollbackJournalSegments: vi.fn(async (name: string, _region: string, _drop: unknown) => {
        order.push(`drop ${name}`);
        return 1;
      }),
    };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const resources = {
      Child: { resourceType: 'AWS::CloudFormation::Stack' },
      NotNested: { resourceType: 'AWS::SQS::Queue' },
    };
    return { stateBackend, logger, resources, order };
  }

  it('with no run, deletes every descendant journal depth-first', async () => {
    const t = tree();

    await dropNestedChildJournals({
      stateBackend: t.stateBackend as never,
      parentStackName: 'Root',
      region: REGION,
      resources: t.resources as never,
      logger: t.logger,
    });

    expect(t.order).toEqual(['delete Root~Child~Grand', 'delete Root~Child']);
    expect(t.stateBackend.dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('with a run, drops only that run segments', async () => {
    const t = tree();

    await dropNestedChildJournals({
      stateBackend: t.stateBackend as never,
      parentStackName: 'Root',
      region: REGION,
      resources: t.resources as never,
      logger: t.logger,
      run: { runId: 'run-1' },
    });

    expect(t.order).toEqual(['drop Root~Child~Grand', 'drop Root~Child']);
    const predicate = t.stateBackend.dropRollbackJournalSegments.mock.calls[0]![2] as (s: {
      runId?: string;
    }) => boolean;
    expect(predicate({ runId: 'run-1' })).toBe(true);
    expect(predicate({ runId: 'run-2' })).toBe(false);
    expect(t.stateBackend.deleteRollbackJournal).not.toHaveBeenCalled();
  });

  it('a backend failure warns and carries on to the next child', async () => {
    const t = tree();
    t.stateBackend.getState.mockRejectedValueOnce(new Error('throttled'));

    await expect(
      dropNestedChildJournals({
        stateBackend: t.stateBackend as never,
        parentStackName: 'Root',
        region: REGION,
        resources: { ...t.resources, Second: { resourceType: 'AWS::CloudFormation::Stack' } } as never,
        logger: t.logger,
      })
    ).resolves.toBeUndefined();

    expect(t.logger.warn).toHaveBeenCalledOnce();
    expect(t.order).toContain('delete Root~Second');
  });

  it('skips a child with no journal instead of issuing a delete', async () => {
    const t = tree();
    t.stateBackend.loadRollbackJournal.mockResolvedValue(null as never);

    await dropNestedChildJournals({
      stateBackend: t.stateBackend as never,
      parentStackName: 'Root',
      region: REGION,
      resources: t.resources as never,
      logger: t.logger,
    });

    expect(t.stateBackend.deleteRollbackJournal).not.toHaveBeenCalled();
  });
});
