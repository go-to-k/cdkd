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
  replay.warningsFor.clear();
  replay.orphanFor.clear();
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

  it('retries a conflicting save once with the fresh ETag', async () => {
    const h = harness({ segments: [seg('r', ['Q'])] });
    h.stateBackend.saveState.mockRejectedValueOnce(new Error('412')).mockResolvedValue('e9');

    await h.run('r');

    const calls = h.stateBackend.saveState.mock.calls;
    expect(calls[0]![3]).toEqual({ expectedEtag: 'e1' });
    expect(calls[1]![3]).toEqual({ expectedEtag: 'e1' }); // the re-read record's ETag
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('saves the child state BEFORE refusing a failed replay', async () => {
    replay.failuresFor.add('Q');
    const h = harness({ segments: [seg('r', ['Q', 'Ok'])] });

    await expect(h.run('r')).rejects.toThrow(/failed to revert/);

    const saved = h.stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources).toMatchObject({ Ok: { reverted: true } });
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

    await expect(h.run('r')).resolves.toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to release the lock'));
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
    return { stateBackend, logger, resources, order };
  }

  const sweep = (t: ReturnType<typeof tree>, resources: unknown = t.resources) =>
    dropNestedChildJournals({
      stateBackend: t.stateBackend as never,
      parentStackName: 'Root',
      region: REGION,
      resources: resources as never,
      logger: t.logger,
    });

  it('deletes every descendant journal depth-first, WITHOUT parsing it first', async () => {
    const t = tree();

    await sweep(t);

    // A journal that no longer parses is deleted too, with its version purge.
    expect(t.order).toEqual(['delete Root~Child~Grand', 'delete Root~Child']);
    expect(t.stateBackend.loadRollbackJournal).not.toHaveBeenCalled();
    expect(t.logger.warn).not.toHaveBeenCalled();
  });

  it('a backend failure warns and carries on to the next child', async () => {
    const t = tree();
    t.stateBackend.getState.mockRejectedValueOnce(new Error('throttled'));

    await expect(
      sweep(t, { ...t.resources, Second: { resourceType: 'AWS::CloudFormation::Stack' } })
    ).resolves.toBeUndefined();

    expect(t.logger.warn).toHaveBeenCalledOnce();
    expect(t.order).toContain('delete Root~Second');
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
    expect(t.order).toEqual(['delete Root~Child']);
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
  const stackOp = (logicalId: string) => ({
    logicalId,
    resourceType: 'AWS::CloudFormation::Stack',
    changeType: 'UPDATE',
  });

  function backend(journals: Record<string, RollbackJournalSegment[]>) {
    const kept: Record<string, RollbackJournalSegment[]> = {};
    const stateBackend = {
      loadRollbackJournal: vi.fn(async (name: string) =>
        journals[name] ? { segments: journals[name] } : null
      ),
      dropRollbackJournalSegments: vi.fn(
        async (name: string, _region: string, drop: (s: RollbackJournalSegment) => boolean) => {
          const all = journals[name] ?? [];
          kept[name] = all.filter((s) => !drop(s));
          return all.length - kept[name].length;
        }
      ),
    };
    return { stateBackend, kept, logger: { debug: vi.fn(), warn: vi.fn() } };
  }

  const settle = (b: ReturnType<typeof backend>, ids: string[], runId = 'r') =>
    dropSettledNestedJournals({
      stateBackend: b.stateBackend as never,
      parentStackName: 'Root',
      region: REGION,
      revertedLogicalIds: ids,
      runId,
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

    await settle(b, ['Child']);

    expect(b.kept['Root~Child']!.map((s) => [s.runId, s.reason])).toEqual([
      ['r', 'no-rollback-failure'],
      ['older', 'nested-pending-parent'],
    ]);
  });

  it('touches ONLY the children whose rows were reverted', async () => {
    const b = backend({ 'Root~Failed': [seg('r', [], { reason: 'auto-rollback-clean' })] });

    await settle(b, []);

    expect(b.stateBackend.loadRollbackJournal).not.toHaveBeenCalled();
    expect(b.stateBackend.dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('recurses into the grandchildren the child replay reverted, and only those', async () => {
    const b = backend({
      'Root~Child': [
        {
          ...seg('r', []),
          operations: [stackOp('Grand'), { logicalId: 'Q', resourceType: 'AWS::SQS::Queue', changeType: 'UPDATE' }],
        } as RollbackJournalSegment,
      ],
      'Root~Child~Grand': [seg('r', ['X'])],
      'Root~Child~Q': [seg('r', ['Y'])],
    });

    await settle(b, ['Child']);

    expect(b.kept['Root~Child~Grand']).toEqual([]);
    expect(b.stateBackend.loadRollbackJournal.mock.calls.map((c) => c[0])).not.toContain('Root~Child~Q');
  });

  it('a backend failure warns and carries on', async () => {
    const b = backend({ 'Root~B': [seg('r', ['Q'])] });
    b.stateBackend.loadRollbackJournal.mockRejectedValueOnce(new Error('throttled'));

    await settle(b, ['A', 'B']);

    expect(b.logger.warn).toHaveBeenCalledOnce();
    expect(b.kept['Root~B']).toEqual([]);
  });
});
