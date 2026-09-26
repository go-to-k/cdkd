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
    ctx: Record<string, unknown>;
  }>,
  failuresFor: new Set<string>(),
  warningsFor: new Set<string>(),
  orphanFor: new Set<string>(),
  /** Runs inside the replay, with the scope the replay was bound in. */
  duringReplay: undefined as ((inner: NestedRevertRun) => void) | undefined,
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
      ctx: Record<string, unknown>,
      options: { afterOp?: () => Promise<void>; onOrphan?: (record: unknown) => void }
    ) => {
      replay.duringReplay?.(replay.readRun() as NestedRevertRun);
      const nested = replay.readNested();
      replay.calls.push({
        ops: ops.map((o) => o.logicalId),
        stackName,
        nestedParent: nested?.parentStackName,
        nestedTemplates: nested?.nestedTemplates,
        run: replay.readRun(),
        stackScope: replay.readStackName(),
        ctx,
      });
      for (const op of ops) {
        if (replay.orphanFor.has(op.logicalId)) {
          // What the real executor does for a Retain'd rolled-back CREATE:
          // drop the resource from state and mint an orphan record.
          delete stateResources[op.logicalId];
          options.onOrphan?.({ logicalId: op.logicalId, state: { physicalId: 'kept' } });
        } else {
          stateResources[op.logicalId] = { reverted: true };
        }
        await options.afterOp?.();
      }
      const failures = ops.filter((o) => replay.failuresFor.has(o.logicalId)).length;
      const warnings = ops.filter((o) => replay.warningsFor.has(o.logicalId)).length;
      return { failures, warnings, interrupted: false, orphaned: [] };
    }
  ),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => l };
  return { getLogger: () => l };
});

import {
  dropNestedChildJournals,
  dropSettledNestedJournals,
  getNestedRevertRun,
  nestedPendingSnapshot,
  revertNestedChildFromJournal,
  revertedNestedRowIds,
  type NestedRevertRun,
  type SettledNestedRows,
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

function harness(opts: {
  state?: StackState | null;
  segments?: RollbackJournalSegment[] | null;
  divergentBodyRegion?: string;
  ctxExtra?: Record<string, unknown>;
}) {
  const stateBackend = {
    getState: vi.fn().mockResolvedValue(
      opts.state === null
        ? null
        : {
            state: opts.state ?? childState(),
            etag: 'e1',
            ...(opts.divergentBodyRegion !== undefined && {
              divergentBodyRegion: opts.divergentBodyRegion,
            }),
          }
    ),
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
    ...opts.ctxExtra,
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // The scope the provider hands in: what the parent driver reads afterwards.
  const scope: NestedRevertRun = { runId: undefined, settled: new Map(), warnings: 0 };
  const run = (runId: string | undefined) => {
    (scope as { runId: string | undefined }).runId = runId;
    return revertNestedChildFromJournal({
      ctx: ctx as never,
      logicalId: 'Child',
      childStackName: CHILD,
      region: REGION,
      run: scope,
      logger: logger as never,
    });
  };
  return { stateBackend, lockManager, exportIndexStore, run, logger, scope };
}

beforeEach(() => {
  replay.calls.length = 0;
  replay.failuresFor.clear();
  replay.warningsFor.clear();
  replay.orphanFor.clear();
  replay.duringReplay = undefined;
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
      run: expect.objectContaining({ runId: 'run-1' }),
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

    await expect(h.run('run-1')).resolves.toEqual({ warnings: 0 });
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

    await expect(h.run('run-1')).rejects.toThrow(/holds no segment for this deploy run/);
    expect(replay.calls).toHaveLength(0);
    expect(h.lockManager.releaseLock).toHaveBeenCalledWith(CHILD, REGION);
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

  it('REFUSES a run with no id, before taking the lock (a runId-less segment matches every other one)', async () => {
    const h = harness({ segments: [seg(undefined, ['NoRun'])] });

    await expect(h.run(undefined)).rejects.toThrow(/carries no deploy run id/);
    expect(replay.calls).toHaveLength(0);
    expect(h.lockManager.acquireLockWithRetry).not.toHaveBeenCalled();
  });
});

describe('revertNestedChildFromJournal — review round (#3754)', () => {
  it('threads --skip-final-snapshot to the child replay from EITHER entry point', async () => {
    for (const extra of [
      { options: { skipFinalSnapshot: true } },
      { destroyOptions: { skipFinalSnapshot: true } },
    ]) {
      replay.calls.length = 0;
      await harness({ segments: [seg('r', ['Q'])], ctxExtra: extra }).run('r');
      expect(replay.calls[0]!.ctx['skipFinalSnapshot']).toBe(true);
    }
    replay.calls.length = 0;
    await harness({ segments: [seg('r', ['Q'])] }).run('r');
    expect(replay.calls[0]!.ctx['skipFinalSnapshot']).toBe(false);
  });

  it('refuses a secret region-lessly re-resolved across regions: the PRE-RUN reads feed the refusal', async () => {
    // The record was saved by the deploy being undone, which no longer reads
    // across regions; the replay restores values the pre-run read produced.
    const h = harness({
      segments: [
        seg('r', ['Q'], {
          previousCrossStackReads: {
            imports: [{ exportName: 'E', sourceStack: 'Producer', sourceRegion: 'us-west-2' }],
          } as never,
        }),
      ],
    });

    await h.run('r');

    expect(replay.calls[0]!.ctx['importedProducerRegions']).toEqual(['us-west-2']);
  });

  it('restores the pre-run cross-stack reads, and drops a read field the pre-run record lacked', async () => {
    const state = {
      ...childState(),
      imports: [{ exportName: 'NewE', sourceStack: 'P', sourceRegion: 'us-east-1' }],
      outputReads: [{ stackName: 'P', outputName: 'O', sourceRegion: 'us-east-1' }],
    } as unknown as StackState;
    const oldImports = [{ exportName: 'OldE', sourceStack: 'P', sourceRegion: 'us-east-1' }];
    const h = harness({
      state,
      segments: [seg('r', ['Q'], { previousCrossStackReads: { imports: oldImports } as never })],
    });

    await h.run('r');

    const saved = h.stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.imports).toEqual(oldImports);
    expect(saved).not.toHaveProperty('outputReads');
  });

  it('drops exportNames when the restored outputs came from a record without them', async () => {
    const h = harness({
      segments: [seg('r', ['Q'], { previousOutputs: { outputs: { QueueUrl: 'old' } } })],
    });

    await h.run('r');

    const saved = h.stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs).toEqual({ QueueUrl: 'old' });
    expect(saved).not.toHaveProperty('exportNames');
  });

  it('publishes the RESTORED exports to the index', async () => {
    const h = harness({
      segments: [
        seg('r', ['Q'], {
          previousOutputs: { outputs: { QueueUrl: 'old', OldExport: 'old' }, exportNames: ['OldExport'] },
        }),
      ],
    });

    await h.run('r');

    const [name, region, published] = h.exportIndexStore.updateForStack.mock.calls[0]!;
    expect([name, region]).toEqual([CHILD, REGION]);
    expect(published).toEqual({ OldExport: 'old' });
  });

  it('does NOT publish to the index when the child record could not be saved', async () => {
    const h = harness({
      segments: [seg('r', ['Q'], { previousOutputs: { outputs: { A: 'old' }, exportNames: [] } })],
    });
    h.stateBackend.saveState.mockRejectedValue(new Error('S3 down'));

    await h.run('r');

    expect(h.exportIndexStore.updateForStack).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to persist the state'));
  });

  it('persists the orphan a Retain rolled-back CREATE mints in the child', async () => {
    replay.orphanFor.add('Kept');
    const h = harness({ segments: [seg('r', ['Kept'])] });

    await h.run('r');

    const saved = h.stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.orphans?.map((o) => o.logicalId)).toEqual(['Kept']);
  });

  it('REFUSES a child record whose region field disagrees with its key, before any replay', async () => {
    const h = harness({ segments: [seg('r', ['Q'])], divergentBodyRegion: 'eu-west-1' });

    await expect(h.run('r')).rejects.toThrow(/region field disagrees/);
    expect(replay.calls).toHaveLength(0);
  });

  it('retries a conflicting save once with the RE-READ record ETag', async () => {
    const h = harness({ segments: [seg('r', ['Q'])] });
    h.stateBackend.getState
      .mockResolvedValueOnce({ state: childState(), etag: 'e1' })
      .mockResolvedValue({ state: childState(), etag: 'e5' });
    h.stateBackend.saveState.mockRejectedValueOnce(new Error('412')).mockResolvedValue('e9');

    await h.run('r');

    const calls = h.stateBackend.saveState.mock.calls;
    expect(calls[0]![3]).toEqual({ expectedEtag: 'e1' });
    expect(calls[1]![3]).toEqual({ expectedEtag: 'e5' });
    // ...and the saves after it chain on the ETag the retry returned.
    expect(calls[2]![3]).toEqual({ expectedEtag: 'e9' });
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('saves the child state once more after the replay, BEFORE refusing a failed one', async () => {
    replay.failuresFor.add('Q');
    const h = harness({ segments: [seg('r', ['Q', 'Ok'])] });

    await expect(h.run('r')).rejects.toThrow(/failed to revert/);

    // One save per replayed op (the mock's `afterOp`), plus the final save.
    expect(h.stateBackend.saveState).toHaveBeenCalledTimes(3);
  });

  it('restores the snapshots of the oldest segment that CARRIES one, past a snapshot-less failure segment', async () => {
    const h = harness({
      segments: [
        // The child failed and rolled itself back first in this run...
        seg('r', [], { reason: 'auto-rollback-clean' }),
        // ...then a later attempt succeeded.
        seg('r', ['Q'], {
          previousOutputs: { outputs: { QueueUrl: 'pre-run' }, exportNames: [] },
          previousCrossStackReads: { imports: [] } as never,
        }),
      ],
    });

    await h.run('r');

    const saved = h.stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs).toEqual({ QueueUrl: 'pre-run' });
    expect(saved.imports).toEqual([]);
  });

  it('the region refusal also reads the RECORD reads, not only the pre-run ones', async () => {
    const h = harness({
      state: {
        ...childState(),
        outputReads: [{ stackName: 'P', outputName: 'O', sourceRegion: 'eu-west-1' }],
      } as unknown as StackState,
      segments: [seg('r', ['Q'], { previousCrossStackReads: {} as never })],
    });

    await h.run('r');

    expect(replay.calls[0]!.ctx['importedProducerRegions']).toEqual(['eu-west-1']);
  });

  it('the region refusal also reads the RECORD imports', async () => {
    const h = harness({
      state: {
        ...childState(),
        imports: [{ exportName: 'E', sourceStack: 'P', sourceRegion: 'ap-northeast-1' }],
      } as unknown as StackState,
      segments: [seg('r', ['Q'], { previousCrossStackReads: {} as never })],
    });

    await h.run('r');

    expect(replay.calls[0]!.ctx['importedProducerRegions']).toEqual(['ap-northeast-1']);
  });

  it('drops an imports field the pre-run record lacked', async () => {
    const h = harness({
      state: {
        ...childState(),
        imports: [{ exportName: 'NewE', sourceStack: 'P', sourceRegion: 'us-east-1' }],
      } as unknown as StackState,
      segments: [seg('r', ['Q'], { previousCrossStackReads: {} as never })],
    });

    await h.run('r');

    expect(h.stateBackend.saveState.mock.calls.at(-1)![2]).not.toHaveProperty('imports');
  });

  it('drops skippedOutputs from the saved record', async () => {
    const h = harness({
      state: { ...childState(), skippedOutputs: { X: 'digest' } } as unknown as StackState,
      segments: [seg('r', ['Q'])],
    });

    await h.run('r');

    expect(h.stateBackend.saveState.mock.calls.at(-1)![2]).not.toHaveProperty('skippedOutputs');
  });

  it('a lock release failure only warns', async () => {
    const h = harness({ segments: [seg('r', ['Q'])] });
    h.lockManager.releaseLock.mockRejectedValue(new Error('gone'));

    await expect(h.run('r')).resolves.toEqual({ warnings: 0 });
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to release the lock'));
  });

  it('a COMPLETED replay registers the row as settled, with the grandchildren its replay completed', async () => {
    const h = harness({ segments: [seg('r', ['Q'])] });
    // What a grandchild revert inside the child's replay does.
    replay.duringReplay = (inner) => inner.settled.set('Grand', new Map());

    await expect(h.run('r')).resolves.toEqual({ warnings: 0 });

    expect([...h.scope.settled.keys()]).toEqual(['Child']);
    expect([...h.scope.settled.get('Child')!.keys()]).toEqual(['Grand']);
    expect(h.scope.warnings).toBe(0);
  });

  it('a replay that SKIPPED an op returns the count, adds it to the scope and does NOT settle the row', async () => {
    replay.warningsFor.add('Q');
    const h = harness({ segments: [seg('r', ['Q'])] });

    await expect(h.run('r')).resolves.toEqual({ warnings: 1 });

    expect(h.scope.settled.size).toBe(0);
    expect(h.scope.warnings).toBe(1);
  });

  it('a grandchild skip inside the child replay counts toward the child', async () => {
    const h = harness({ segments: [seg('r', ['Q'])] });
    replay.duringReplay = (inner) => {
      inner.warnings += 2;
    };

    await expect(h.run('r')).resolves.toEqual({ warnings: 2 });
    expect(h.scope.settled.size).toBe(0);
  });

  it('a replay that FAILED restores neither outputs nor reads, and publishes nothing', async () => {
    replay.failuresFor.add('Q');
    const h = harness({
      segments: [
        seg('r', ['Q'], {
          previousOutputs: { outputs: { QueueUrl: 'pre-run' }, exportNames: ['OldExport'] },
          previousCrossStackReads: { imports: [] } as never,
        }),
      ],
    });

    await expect(h.run('r')).rejects.toThrow(/failed to revert/);

    for (const call of h.stateBackend.saveState.mock.calls) {
      const saved = call[2] as StackState;
      expect(saved.outputs).toEqual({ QueueUrl: 'new-url' });
      expect(saved.exportNames).toEqual(['NewExport']);
    }
    expect(h.exportIndexStore.updateForStack).not.toHaveBeenCalled();
    expect(h.scope.settled.size).toBe(0);
  });

  it('the per-op saves during the replay carry the CURRENT outputs; only the final save restores', async () => {
    const h = harness({
      segments: [seg('r', ['Q'], { previousOutputs: { outputs: { QueueUrl: 'pre-run' } } })],
    });

    await h.run('r');

    const outputs = h.stateBackend.saveState.mock.calls.map(
      (c) => (c[2] as StackState).outputs
    );
    expect(outputs).toEqual([{ QueueUrl: 'new-url' }, { QueueUrl: 'pre-run' }]);
  });

  it('reports ops the replay skipped with a warning', async () => {
    replay.warningsFor.add('Q');
    const h = harness({ segments: [seg('r', ['Q'])] });

    await h.run('r');

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 operation(s) were skipped'));
  });
});

describe('nestedPendingSnapshot / revertedNestedRowIds (#3754)', () => {
  it('copies outputs, exportNames, imports and outputReads — and only what the record holds', () => {
    const state = {
      outputs: { A: 1 },
      exportNames: ['E'],
      imports: [{ exportName: 'I' }],
    } as unknown as StackState;
    const snap = nestedPendingSnapshot(state);
    expect(snap).toEqual({
      previousOutputs: { outputs: { A: 1 }, exportNames: ['E'] },
      previousCrossStackReads: { imports: [{ exportName: 'I' }] },
    });
    (state.outputs as Record<string, unknown>)['A'] = 2;
    expect(snap.previousOutputs!.outputs['A']).toBe(1);
  });

  it('names only the nested-stack UPDATE rows', () => {
    expect(
      revertedNestedRowIds([
        { logicalId: 'Up', resourceType: 'AWS::CloudFormation::Stack', changeType: 'UPDATE' },
        { logicalId: 'New', resourceType: 'AWS::CloudFormation::Stack', changeType: 'CREATE' },
        { logicalId: 'Q', resourceType: 'AWS::SQS::Queue', changeType: 'UPDATE' },
      ])
    ).toEqual(['Up']);
  });
});

describe('dropNestedChildJournals — the root sweep (#3754)', () => {
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
      loadRollbackJournal: vi.fn(async () => {
        throw new Error('the sweep must not parse the journal');
      }),
      deleteRollbackJournal: vi.fn(async (name: string) => {
        order.push(`delete ${name}`);
      }),
    };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const resources = {
      Child: { resourceType: 'AWS::CloudFormation::Stack' },
      NotNested: { resourceType: 'AWS::SQS::Queue' },
    };
    const lockManager = {
      acquireLockWithRetry: vi.fn(async (name: string) => {
        order.push(`lock ${name}`);
        return true;
      }),
      releaseLock: vi.fn(async (name: string) => {
        order.push(`unlock ${name}`);
      }),
    };
    return { stateBackend, logger, resources, order, lockManager };
  }

  const sweep = (t: ReturnType<typeof tree>, resources: unknown = t.resources) =>
    dropNestedChildJournals({
      stateBackend: t.stateBackend as never,
      lockManager: t.lockManager as never,
      parentStackName: 'Root',
      region: REGION,
      resources: resources as never,
      logger: t.logger,
    });

  it('deletes every descendant journal depth-first, WITHOUT parsing it first', async () => {
    const t = tree();

    await sweep(t);

    // A journal that no longer parses is deleted too, with its version purge,
    // each under its OWN stack's lock (a direct child rollback holds only it).
    expect(t.order).toEqual([
      'lock Root~Child~Grand',
      'delete Root~Child~Grand',
      'unlock Root~Child~Grand',
      'lock Root~Child',
      'delete Root~Child',
      'unlock Root~Child',
    ]);
    expect(t.stateBackend.loadRollbackJournal).not.toHaveBeenCalled();
    expect(t.logger.warn).not.toHaveBeenCalled();
  });

  it('an unreadable child state still gets that child OWN journal deleted, and the walk carries on', async () => {
    const t = tree();
    t.stateBackend.getState.mockRejectedValueOnce(new Error('unparseable state.json'));

    await expect(
      sweep(t, { ...t.resources, Second: { resourceType: 'AWS::CloudFormation::Stack' } })
    ).resolves.toBeUndefined();

    expect(t.logger.warn).toHaveBeenCalledOnce();
    expect(t.order.filter((e) => e.startsWith('delete'))).toEqual([
      'delete Root~Child',
      'delete Root~Second',
    ]);
  });

  it('a failed delete warns and carries on', async () => {
    const t = tree();
    t.stateBackend.deleteRollbackJournal.mockRejectedValueOnce(new Error('AccessDenied'));

    await sweep(t);

    expect(t.logger.warn).toHaveBeenCalledOnce();
    expect(t.stateBackend.deleteRollbackJournal).toHaveBeenCalledTimes(2);
  });

  it('does not recurse into a record whose body names ANOTHER stack', async () => {
    // A backend answering every key with the parent's own record (a planted
    // state, or a test double) would otherwise walk `Root~Child~Child~...`
    // until the heap ran out.
    const t = tree();
    t.stateBackend.getState.mockResolvedValue({
      state: { stackName: 'Root', resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } } },
    } as never);

    await sweep(t);

    expect(t.stateBackend.getState).toHaveBeenCalledOnce();
    expect(t.order.filter((e) => e.startsWith('delete'))).toEqual(['delete Root~Child']);
  });

  it('a child lock that cannot be taken leaves that journal for the next sweep', async () => {
    const t = tree();
    t.lockManager.acquireLockWithRetry.mockImplementation(async (name: string) => {
      if (name === 'Root~Child') throw new Error('locked by a direct rollback');
      return true;
    });

    await sweep(t);

    expect(t.order).toContain('delete Root~Child~Grand');
    expect(t.order).not.toContain('delete Root~Child');
    expect(t.logger.warn).toHaveBeenCalledOnce();
  });

  it('stops at the depth bound when every level names itself as the child', async () => {
    const t = tree();
    t.stateBackend.getState.mockImplementation(async (name: string) => ({
      state: { stackName: name, resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } } },
    }));

    await sweep(t);

    expect(t.stateBackend.getState).toHaveBeenCalledTimes(32);
    expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('deeper than 32 levels'));
  });
});

describe('dropSettledNestedJournals — after a settled rollback (#3754)', () => {
  function backend(journals: Record<string, RollbackJournalSegment[]>) {
    const kept: Record<string, RollbackJournalSegment[]> = {};
    const locks: string[] = [];
    const stateBackend = {
      dropRollbackJournalSegments: vi.fn(
        async (name: string, _region: string, drop: (s: RollbackJournalSegment) => boolean) => {
          const all = journals[name] ?? [];
          kept[name] = all.filter((s) => !drop(s));
          return all.length - kept[name].length;
        }
      ),
    };
    const lockManager = {
      acquireLockWithRetry: vi.fn(async (name: string) => {
        locks.push(name);
        return true;
      }),
      releaseLock: vi.fn(async () => undefined),
    };
    return { stateBackend, lockManager, kept, locks, logger: { debug: vi.fn(), warn: vi.fn() } };
  }

  const tree = (entries: Array<[string, SettledNestedRows?]>): SettledNestedRows =>
    new Map(entries.map(([id, below]) => [id, below ?? new Map()]));

  const settle = (
    b: ReturnType<typeof backend>,
    settled: SettledNestedRows,
    opts: { runId: string | undefined } = { runId: 'r' }
  ) =>
    dropSettledNestedJournals({
      stateBackend: b.stateBackend as never,
      lockManager: b.lockManager as never,
      parentStackName: 'Root',
      region: REGION,
      settled,
      runId: opts.runId,
      logger: b.logger,
    });

  it('drops the PENDING segments of the run, and keeps the child own failure segment of the same run', async () => {
    const b = backend({
      'Root~Child': [
        seg('r', ['Q']),
        seg('r', ['Q'], { reason: 'no-rollback-failure' }),
        seg('older', ['Q']),
      ],
    });

    await settle(b, tree([['Child']]));

    expect(b.kept['Root~Child']!.map((s) => [s.runId, s.reason])).toEqual([
      ['r', 'no-rollback-failure'],
      ['older', 'nested-pending-parent'],
    ]);
    // Under the child's own lock.
    expect(b.locks).toEqual(['Root~Child']);
  });

  it('touches nothing when no child replay completed', async () => {
    const b = backend({ 'Root~Failed': [seg('r', [], { reason: 'auto-rollback-clean' })] });

    await settle(b, tree([]));

    expect(b.stateBackend.dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('recurses ONLY into the grandchildren the child replay completed, deepest first', async () => {
    const b = backend({
      'Root~Child': [seg('r', [])],
      'Root~Child~Grand': [seg('r', ['X'])],
      'Root~Child~Skipped': [seg('r', ['Y'])],
    });

    await settle(b, tree([['Child', tree([['Grand']])]]));

    expect(b.kept['Root~Child~Grand']).toEqual([]);
    expect(b.kept['Root~Child']).toEqual([]);
    // `Skipped` is a nested row the child replay did NOT complete.
    expect(b.stateBackend.dropRollbackJournalSegments.mock.calls.map((c) => c[0])).toEqual([
      'Root~Child~Grand',
      'Root~Child',
    ]);
  });

  it('a runId-less run drops nothing', async () => {
    const b = backend({ 'Root~Child': [seg(undefined, ['Q'])] });

    await settle(b, tree([['Child']]), { runId: undefined });

    expect(b.stateBackend.dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('a backend failure warns and carries on', async () => {
    const b = backend({ 'Root~B': [seg('r', ['Q'])] });
    b.stateBackend.dropRollbackJournalSegments.mockRejectedValueOnce(new Error('throttled'));

    await settle(b, tree([['A'], ['B']]));

    expect(b.logger.warn).toHaveBeenCalledOnce();
    expect(b.kept['Root~B']).toEqual([]);
  });
});
