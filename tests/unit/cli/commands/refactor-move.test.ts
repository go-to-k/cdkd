/**
 * go-to-k/cdkd#5202: `cdkd refactor` moving a record between stacks. The
 * planner keeps a move only when the destination's diff shows the moved
 * resource unchanged; the apply writes sources before destinations and puts a
 * source back when a later save fails, so a resource is never recorded in
 * two stacks and never silently in none.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import { applyMoveGroup, planMoves, renderMovePlan } from '../../../../src/cli/commands/refactor-move.js';
import type { RefactorDiffFn, StackRefactorPlan } from '../../../../src/cli/commands/refactor.js';
import type { ResourceChange, ResourceState, StackState } from '../../../../src/types/state.js';

const queue = 'AWS::SQS::Queue';

function rec(physicalId: string, extra: Partial<ResourceState> = {}): ResourceState {
  return { physicalId, resourceType: queue, properties: { T: 1 }, ...extra };
}

function stack(name: string, resources: Record<string, ResourceState>): StackState {
  return { version: 13, stackName: name, region: 'r', resources, outputs: {}, lastModified: 0 };
}

/** A destination diff: each `want` id is NO_CHANGE when its record holds an accepted physical id. */
function destDiff(want: Record<string, readonly string[]>): RefactorDiffFn {
  return async (state) => {
    const changes = new Map<string, ResourceChange>();
    for (const [id, accepted] of Object.entries(want)) {
      const r = state.resources[id];
      changes.set(id, {
        logicalId: id,
        resourceType: queue,
        changeType: r === undefined ? 'CREATE' : accepted.includes(r.physicalId) ? 'NO_CHANGE' : 'UPDATE',
        ...(r !== undefined && !accepted.includes(r.physicalId)
          ? { propertyChanges: [{ path: 'T', oldValue: 1, newValue: 2, requiresReplacement: false }] }
          : {}),
      });
    }
    return { changes, blocking: [] };
  };
}

function plan(
  stackName: string,
  state: StackState,
  unpaired: { creates?: string[]; deletes?: string[] },
  diff: RefactorDiffFn = destDiff({}),
  props: Record<string, unknown> = { T: 1 }
): StackRefactorPlan {
  return {
    stackName,
    region: 'r',
    etag: `"${stackName}"`,
    renames: [],
    differing: [],
    skipped: [],
    ambiguous: [],
    refusedOverrides: [],
    stillChanging: [],
    template: { Resources: {} },
    unpaired: {
      creates: (unpaired.creates ?? []).map((logicalId) => ({ logicalId, resourceType: queue, properties: props })),
      deletes: (unpaired.deletes ?? []).map((logicalId) => ({ logicalId, resourceType: queue, properties: props })),
    },
    movesOut: [],
    movesIn: [],
    state,
    diff,
  };
}

const sameEnv = (): string => 'same-env';

describe('planMoves', () => {
  it('moves a record the destination then shows unchanged', async () => {
    const a = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] });
    const b = plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['p1'] }));
    const result = await planMoves([a, b], sameEnv, []);
    expect(result.moves).toEqual([
      expect.objectContaining({ fromStack: 'A', from: 'Old', toStack: 'B', to: 'New', source: 'detected' }),
    ]);
    expect(a.movesOut).toHaveLength(1);
    expect(b.movesIn).toHaveLength(1);
    expect(renderMovePlan(result).join('\n')).toMatch(/A\.Old -> B\.New/);
  });

  it('never pairs rows of one stack as a move', async () => {
    const a = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'], creates: ['New'] }, destDiff({ New: ['p1'] }));
    const result = await planMoves([a], sameEnv, []);
    expect(result.moves).toEqual([]);
  });

  it('ignores a same-stack look-alike when matching a move by properties', async () => {
    // A.N1 looks like A.O1 too, but a row's own stack was searched already.
    const a = plan('A', stack('A', { O1: rec('p1') }), { deletes: ['O1'], creates: ['N1'] });
    const b = plan('B', stack('B', {}), { creates: ['N2'] }, destDiff({ N2: ['p1'] }));
    const result = await planMoves([a, b], sameEnv, []);
    expect(result.ambiguous).toEqual([]);
    expect(result.moves).toEqual([expect.objectContaining({ fromStack: 'A', from: 'O1', toStack: 'B', to: 'N2' })]);
  });

  it('never moves across environments, and refuses a named one', async () => {
    const a = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] });
    const b = plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['p1'] }));
    const envOf = (p: StackRefactorPlan): string => p.stackName;
    expect((await planMoves([a, b], envOf, [])).moves).toEqual([]);
    const named = await planMoves([a, b], envOf, [{ region: 'r', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' }]);
    expect(named.refused).toEqual([expect.objectContaining({ reason: expect.stringMatching(/different accounts or regions/) })]);
  });

  it('leaves a detected move whose destination changes to the deploy, and refuses a named one', async () => {
    const mk = () => [
      plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] }),
      plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['other'] })),
    ];
    const detected = await planMoves(mk(), sameEnv, []);
    expect(detected.moves).toEqual([]);
    expect(detected.differing).toEqual([expect.objectContaining({ paths: ['T'] })]);
    const named = await planMoves(mk(), sameEnv, [{ region: 'r', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' }]);
    expect(named.refused).toEqual([expect.objectContaining({ reason: expect.stringMatching(/properties also changed \(T\)/) })]);
  });

  it('reports look-alikes across stacks as ambiguous, with stack-qualified locations', async () => {
    const a = plan('A', stack('A', { O1: rec('p1'), O2: rec('p2') }), { deletes: ['O1', 'O2'] });
    const b = plan('B', stack('B', {}), { creates: ['N1', 'N2'] }, destDiff({ N1: ['p1', 'p2'], N2: ['p1', 'p2'] }));
    const result = await planMoves([a, b], sameEnv, []);
    expect(result.moves).toEqual([]);
    expect(result.ambiguous).toEqual([
      expect.objectContaining({ resourceType: queue, from: ['A.O1', 'A.O2'], to: ['B.N1', 'B.N2'], plan: a }),
    ]);
  });

  it('lets a mapping name the look-alike moves', async () => {
    const a = plan('A', stack('A', { O1: rec('p1'), O2: rec('p2') }), { deletes: ['O1', 'O2'] });
    const b = plan('B', stack('B', {}), { creates: ['N1', 'N2'] }, destDiff({ N1: ['p2'], N2: ['p1'] }));
    const result = await planMoves([a, b], sameEnv, [
      { region: 'r', fromStack: 'A', from: 'O2', toStack: 'B', to: 'N1' },
      { region: 'r', fromStack: 'A', from: 'O1', toStack: 'B', to: 'N2' },
    ]);
    expect(result.refused).toEqual([]);
    expect(result.moves.map((m) => `${m.from}->${m.to}`).sort()).toEqual(['O1->N2', 'O2->N1']);
  });

  it.each([
    ['a stack that is not selected', { region: 'r', fromStack: 'A', from: 'Old', toStack: 'Z', to: 'New' }, /both stacks must be selected/],
    ['a from that is not a removed row', { region: 'r', fromStack: 'A', from: 'Nope', toStack: 'B', to: 'New' }, /no longer declares/],
    ['a to that is not an added row', { region: 'r', fromStack: 'A', from: 'Old', toStack: 'B', to: 'Nope' }, /does not hold/],
  ])('refuses a mapping naming %s', async (_label, override, reason) => {
    const a = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] });
    const b = plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['p1'] }));
    const result = await planMoves([a, b], sameEnv, [override]);
    expect(result.refused).toEqual([expect.objectContaining({ reason: expect.stringMatching(reason) })]);
  });

  it('refuses a stack that would both lose and gain a resource', async () => {
    const a = plan('A', stack('A', { X: rec('px') }), { deletes: ['X'], creates: ['Y2'] }, destDiff({ Y2: ['py'] }));
    const b = plan(
      'B',
      stack('B', { Y: rec('py', { resourceType: 'AWS::SNS::Topic' }) }),
      { creates: ['X2'] },
      destDiff({ X2: ['px'] })
    );
    b.unpaired.deletes.push({ logicalId: 'Y', resourceType: 'AWS::SNS::Topic', properties: {} });
    a.unpaired.creates[0]!.resourceType = 'AWS::SNS::Topic';
    await expect(planMoves([a, b], sameEnv, [])).rejects.toThrow(/both lose and gain/);
  });
});

describe('applyMoveGroup', () => {
  function setup(opts: { etagB?: string; failDestSave?: boolean; failRestore?: boolean; lockB?: boolean } = {}) {
    const order: string[] = [];
    const a = plan('A', stack('A', { Old: rec('p1'), Keep: rec('pk', { dependencies: ['Old'] }) }), {});
    const b = plan('B', stack('B', { Other: rec('po') }), {});
    const m = { fromStack: 'A', fromRegion: 'r', from: 'Old', toStack: 'B', toRegion: 'r', to: 'New', resourceType: queue, source: 'detected' as const };
    a.movesOut.push(m);
    b.movesIn.push(m);
    const records: Record<string, { state: StackState; etag: string }> = {
      A: { state: a.state, etag: '"A"' },
      B: { state: b.state, etag: opts.etagB ?? '"B"' },
    };
    let saves = 0;
    const stateBackend = {
      getState: vi.fn(async (name: string) => {
        order.push(`get:${name}`);
        return { state: records[name]!.state, etag: records[name]!.etag };
      }),
      loadRollbackJournal: vi.fn(async () => null),
      rotateCreateTokenNonce: vi.fn(async (name: string) => {
        order.push(`rotate:${name}`);
      }),
      saveState: vi.fn(async (name: string, _region: string, _state: StackState, o: { expectedEtag?: string }) => {
        saves += 1;
        order.push(`save:${name}:${o.expectedEtag}`);
        if (name === 'B' && opts.failDestSave) throw new Error('AccessDenied');
        if (name === 'A' && saves > 1 && opts.failRestore) throw new Error('restore failed');
        return `"${name}-new"`;
      }),
    };
    const lockManager = {
      acquireLock: vi.fn(async (name: string) => {
        order.push(`lock:${name}`);
        return name === 'B' ? opts.lockB !== false : true;
      }),
      releaseLock: vi.fn(async (name: string) => {
        order.push(`unlock:${name}`);
      }),
    };
    const run = () =>
      applyMoveGroup({
        plans: [b, a],
        stateBackend: stateBackend as never,
        lockManager: lockManager as never,
        recovery: { stateBucket: 'bkt', statePrefix: 'pfx' },
        contentionMessage: async (p) => `locked: ${p.stackName}`,
      });
    return { order, stateBackend, lockManager, run };
  }

  it('locks in a fixed order and saves the source before the destination', async () => {
    const t = setup();
    await t.run();
    expect(t.order).toEqual([
      'lock:A', 'lock:B', 'get:A', 'get:B', 'rotate:A', 'save:A:"A"', 'save:B:"B"', 'unlock:B', 'unlock:A',
    ]);
    const saved = new Map(t.stateBackend.saveState.mock.calls.map((c) => [c[0], c[2] as StackState]));
    expect(Object.keys(saved.get('A')!.resources)).toEqual(['Keep']);
    expect(saved.get('A')!.resources['Keep']!.dependencies).toEqual([]);
    expect(saved.get('B')!.resources['New']!.physicalId).toBe('p1');
    expect(t.stateBackend.rotateCreateTokenNonce).toHaveBeenCalledWith('A', 'r', ['Old']);
  });

  it('writes nothing when any record changed after planning, and unlocks every stack', async () => {
    const t = setup({ etagB: '"moved"' });
    await expect(t.run()).rejects.toThrow(/changed after cdkd refactor planned it/);
    expect(t.stateBackend.saveState).not.toHaveBeenCalled();
    expect(t.order.filter((x) => x.startsWith('unlock'))).toEqual(['unlock:B', 'unlock:A']);
  });

  it('restores the source when the destination save fails', async () => {
    const t = setup({ failDestSave: true });
    await expect(t.run()).rejects.toThrow(/source stacks were restored/);
    const restore = t.stateBackend.saveState.mock.calls.at(-1)!;
    expect(restore[0]).toBe('A');
    expect((restore[3] as { expectedEtag: string }).expectedEtag).toBe('"A-new"');
    expect(Object.keys((restore[2] as StackState).resources).sort()).toEqual(['Keep', 'Old']);
  });

  it('names cdkd import when the source cannot be restored either', async () => {
    const t = setup({ failDestSave: true, failRestore: true });
    await expect(t.run()).rejects.toThrow(/cdkd import/);
  });

  it('releases the locks it took and writes nothing under contention', async () => {
    const t = setup({ lockB: false });
    await expect(t.run()).rejects.toThrow('locked: B');
    expect(t.stateBackend.getState).not.toHaveBeenCalled();
    expect(t.order.filter((x) => x.startsWith('unlock'))).toEqual(['unlock:A']);
  });
});
