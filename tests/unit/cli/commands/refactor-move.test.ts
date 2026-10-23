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
    const named = await planMoves([a, b], envOf, [{ region: 'r', env: 'A', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' }]);
    expect(named.refused).toEqual([expect.objectContaining({ reason: expect.stringMatching(/mapping environment's account and region/) })]);
  });

  it('leaves a detected move whose destination changes to the deploy, and refuses a named one', async () => {
    const mk = () => [
      plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] }),
      plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['other'] })),
    ];
    const detected = await planMoves(mk(), sameEnv, []);
    expect(detected.moves).toEqual([]);
    expect(detected.differing).toEqual([expect.objectContaining({ paths: ['T'] })]);
    const named = await planMoves(mk(), sameEnv, [{ region: 'r', env: 'same-env', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' }]);
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
      { region: 'r', env: 'same-env', fromStack: 'A', from: 'O2', toStack: 'B', to: 'N1' },
      { region: 'r', env: 'same-env', fromStack: 'A', from: 'O1', toStack: 'B', to: 'N2' },
    ]);
    expect(result.refused).toEqual([]);
    expect(result.moves.map((m) => `${m.from}->${m.to}`).sort()).toEqual(['O1->N2', 'O2->N1']);
  });

  it.each([
    ['a stack that is not selected', { region: 'r', env: 'same-env', fromStack: 'A', from: 'Old', toStack: 'Z', to: 'New' }, /both stacks must be selected/],
    ['a from that is not a removed row', { region: 'r', env: 'same-env', fromStack: 'A', from: 'Nope', toStack: 'B', to: 'New' }, /no longer declares/],
    ['a to that is not an added row', { region: 'r', env: 'same-env', fromStack: 'A', from: 'Old', toStack: 'B', to: 'Nope' }, /does not hold/],
  ])('refuses a mapping naming %s', async (_label, override, reason) => {
    const a = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] });
    const b = plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['p1'] }));
    const result = await planMoves([a, b], sameEnv, [override]);
    expect(result.refused).toEqual([expect.objectContaining({ reason: expect.stringMatching(reason) })]);
  });

  it('confirms against the destination with its own renames applied', async () => {
    // B's diff shows New unchanged only while B's own rename is applied too.
    const a = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] });
    const diffB: RefactorDiffFn = async (state) => {
      const changes = new Map<string, ResourceChange>();
      const ok = state.resources['New']?.physicalId === 'p1' && state.resources['Ren2'] !== undefined;
      changes.set('New', { logicalId: 'New', resourceType: queue, changeType: state.resources['New'] ? (ok ? 'NO_CHANGE' : 'UPDATE') : 'CREATE' });
      return { changes, blocking: [] };
    };
    const b = plan('B', stack('B', { Ren: rec('pr') }), { creates: ['New'] }, diffB);
    b.renames.push({ from: 'Ren', to: 'Ren2', resourceType: queue, source: 'detected' });
    const result = await planMoves([a, b], sameEnv, []);
    expect(result.moves.map((m) => m.to)).toEqual(['New']);
  });

  it('re-confirms the surviving moves after dropping one', async () => {
    // Two moves into B: N2 is unchanged only while N1 moves too, and N1 changed.
    const a = plan('A', stack('A', { O1: rec('p1'), O2: rec('p2', { resourceType: 'AWS::SNS::Topic' }) }), { deletes: ['O1'] });
    a.unpaired.deletes.push({ logicalId: 'O2', resourceType: 'AWS::SNS::Topic', properties: { T: 1 } });
    let calls = 0;
    const diffB: RefactorDiffFn = async (state) => {
      calls += 1;
      const changes = new Map<string, ResourceChange>();
      changes.set('N1', { logicalId: 'N1', resourceType: queue, changeType: state.resources['N1'] ? 'UPDATE' : 'CREATE' });
      changes.set('N2', {
        logicalId: 'N2',
        resourceType: 'AWS::SNS::Topic',
        changeType: !state.resources['N2'] ? 'CREATE' : state.resources['N1'] ? 'NO_CHANGE' : 'UPDATE',
      });
      return { changes, blocking: [] };
    };
    const b = plan('B', stack('B', {}), { creates: ['N1'] }, diffB);
    b.unpaired.creates.push({ logicalId: 'N2', resourceType: 'AWS::SNS::Topic', properties: { T: 1 } });
    const result = await planMoves([a, b], sameEnv, []);
    expect(result.moves).toEqual([]);
    expect(result.differing.map((d) => d.move.to).sort()).toEqual(['N1', 'N2']);
    expect(calls).toBe(2);
  });

  it('pairs nothing among several rows whose properties all differ', async () => {
    const a = plan('A', stack('A', { O1: rec('p1'), O2: rec('p2') }), {}, destDiff({}), { T: 1 });
    a.unpaired.deletes.push(
      { logicalId: 'O1', resourceType: queue, properties: { T: 1 } },
      { logicalId: 'O2', resourceType: queue, properties: { T: 2 } }
    );
    const b = plan('B', stack('B', {}), {}, destDiff({ N1: ['p1'], N2: ['p2'] }));
    b.unpaired.creates.push(
      { logicalId: 'N1', resourceType: queue, properties: { T: 9 } },
      { logicalId: 'N2', resourceType: queue, properties: { T: 8 } }
    );
    const result = await planMoves([a, b], sameEnv, []);
    expect(result.moves).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it('refuses a named move whose mapping environment is not the stacks\' own', async () => {
    // Both stacks are in one environment, but the mapping names another account.
    const a = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] });
    const b = plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['p1'] }));
    const result = await planMoves([a, b], sameEnv, [
      { region: 'r', env: 'other-account', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' },
    ]);
    expect(result.refused).toEqual([expect.objectContaining({ reason: expect.stringMatching(/mapping environment/) })]);
  });

  it('keeps one stack name in two regions apart', async () => {
    const east = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] });
    const west = { ...plan('A', stack('A', { Old: rec('p2') }), { deletes: ['Old'] }), region: 'w', movesOut: [], movesIn: [] };
    const destEast = plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['p1'] }));
    const destWest = { ...plan('B', stack('B', {}), { creates: ['New'] }, destDiff({ New: ['p2'] })), region: 'w', movesOut: [], movesIn: [] };
    const envOf = (p: StackRefactorPlan): string => p.region;
    const result = await planMoves([east, west, destEast, destWest], envOf, [
      { region: 'r', env: 'r', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' },
      { region: 'w', env: 'w', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' },
    ]);
    expect(result.refused).toEqual([]);
    expect(result.moves.map((m) => `${m.fromRegion}:${m.from}->${m.toRegion}:${m.to}`).sort()).toEqual([
      'r:Old->r:New',
      'w:Old->w:New',
    ]);
  });

  it.each([
    ['types differ', 'AWS::SNS::Topic', /types differ/],
    ['an unpairable type', 'AWS::CloudFormation::Stack', /cannot move/],
  ])('refuses a named move whose %s', async (_label, toType, reason) => {
    const a = plan('A', stack('A', { Old: rec('p1') }), {});
    a.unpaired.deletes.push({ logicalId: 'Old', resourceType: toType === 'AWS::SNS::Topic' ? queue : toType, properties: {} });
    const b = plan('B', stack('B', {}), {});
    b.unpaired.creates.push({ logicalId: 'New', resourceType: toType, properties: {} });
    const result = await planMoves([a, b], sameEnv, [
      { region: 'r', env: 'same-env', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' },
    ]);
    expect(result.refused).toEqual([expect.objectContaining({ reason: expect.stringMatching(reason) })]);
  });

  it('refuses a mapping naming one location twice', async () => {
    const a = plan('A', stack('A', { Old: rec('p1') }), { deletes: ['Old'] });
    const b = plan('B', stack('B', {}), { creates: ['New', 'New2'] }, destDiff({ New: ['p1'] }));
    const result = await planMoves([a, b], sameEnv, [
      { region: 'r', env: 'same-env', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' },
      { region: 'r', env: 'same-env', fromStack: 'A', from: 'Old', toStack: 'B', to: 'New2' },
    ]);
    expect(result.refused).toEqual([expect.objectContaining({ to: 'New2', reason: expect.stringMatching(/more than once/) })]);
  });

  it('renders every kind of move line', () => {
    const m = { fromStack: 'A', fromRegion: 'r', from: 'O', toStack: 'B', toRegion: 'r', to: 'N', resourceType: queue, source: 'detected' as const };
    const text = renderMovePlan({
      moves: [],
      differing: [{ move: m, paths: ['T'] }],
      refused: [{ fromStack: 'A', from: 'X', toStack: 'B', to: 'Y', reason: 'why' }],
      ambiguous: [{ resourceType: queue, from: ['A.P'], to: ['B.Q', 'B.R'], plan: plan('A', stack('A', {}), {}) }],
    }).join('\n');
    expect(text).toMatch(/Not moved: A\.O -> B\.N .* also changes T/);
    expect(text).toMatch(/Ambiguous \(AWS::SQS::Queue\): A\.P could each be B\.Q, B\.R/);
    expect(text).toMatch(/Refused: A\.X -> B\.Y: why\./);
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
  type Move = StackRefactorPlan['movesIn'][number];
  const mv = (fromStack: string, from: string, toStack: string, to: string): Move => ({
    fromStack, fromRegion: 'r', from, toStack, toRegion: 'r', to, resourceType: queue, source: 'detected',
  });

  /**
   * A stateful S3 double: a save replaces the record and its ETag, so a
   * re-read sees what landed. `failSave(name, n)` makes the n-th save of
   * `name` throw -- before landing, or AFTER landing (`landed`), the
   * response-lost case.
   */
  function world(stacks: Record<string, Record<string, ResourceState>>) {
    const order: string[] = [];
    const records = new Map<string, { state: StackState; etag: string; migrationPending?: boolean }>();
    for (const [name, resources] of Object.entries(stacks)) {
      records.set(name, { state: stack(name, resources), etag: `"${name}"` });
    }
    const failures = new Map<string, { nth: number; landed: boolean }>();
    const saves = new Map<string, number>();
    let journal = false;
    const stateBackend = {
      getState: vi.fn(async (name: string) => {
        order.push(`get:${name}`);
        const r = records.get(name)!;
        return { state: structuredClone(r.state), etag: r.etag, ...(r.migrationPending && { migrationPending: true }) };
      }),
      loadRollbackJournal: vi.fn(async () => (journal ? ({} as never) : null)),
      rotateCreateTokenNonce: vi.fn(async (name: string) => {
        order.push(`rotate:${name}`);
      }),
      saveState: vi.fn(async (name: string, _r: string, state: StackState, o: { expectedEtag?: string }) => {
        const n = (saves.get(name) ?? 0) + 1;
        saves.set(name, n);
        order.push(`save:${name}`);
        const fail = failures.get(name);
        const r = records.get(name)!;
        if (o.expectedEtag !== r.etag) throw new Error('PreconditionFailed');
        if (fail !== undefined && fail.nth === n && !fail.landed) throw new Error('AccessDenied');
        records.set(name, { state: structuredClone(state), etag: `"${name}-${n}"` });
        if (fail !== undefined && fail.nth === n && fail.landed) throw new Error('socket hang up');
        return `"${name}-${n}"`;
      }),
    };
    const lockManager = {
      acquireLock: vi.fn(async (name: string) => {
        order.push(`lock:${name}`);
        return true;
      }),
      releaseLock: vi.fn(async (name: string) => {
        order.push(`unlock:${name}`);
      }),
    };
    const plans = new Map<string, StackRefactorPlan>();
    for (const name of Object.keys(stacks)) {
      plans.set(name, plan(name, structuredClone(records.get(name)!.state), {}));
    }
    const move = (m: Move): void => {
      plans.get(m.fromStack)!.movesOut.push(m);
      plans.get(m.toStack)!.movesIn.push(m);
    };
    const run = () =>
      applyMoveGroup({
        plans: [...plans.values()].reverse(),
        stateBackend: stateBackend as never,
        lockManager: lockManager as never,
        recovery: { stateBucket: 'bkt', statePrefix: 'pfx' },
        contentionMessage: async (p) => `locked: ${p.stackName}`,
      });
    const holders = (physicalId: string): string[] =>
      [...records.entries()]
        .filter(([, r]) => Object.values(r.state.resources).some((x) => x.physicalId === physicalId))
        .map(([name]) => name)
        .sort();
    return {
      order, records, plans, move, run, holders, stateBackend, lockManager,
      failSave: (name: string, nth: number, landed = false) => failures.set(name, { nth, landed }),
      setJournal: () => { journal = true; },
    };
  }

  it('locks in a fixed order and saves the source before the destination', async () => {
    const w = world({ A: { Old: rec('p1'), Keep: rec('pk', { dependencies: ['Old'] }) }, B: { Other: rec('po') } });
    w.move(mv('A', 'Old', 'B', 'New'));
    await w.run();
    expect(w.order).toEqual(['lock:A', 'lock:B', 'get:A', 'get:B', 'rotate:A', 'save:A', 'save:B', 'unlock:B', 'unlock:A']);
    expect(Object.keys(w.records.get('A')!.state.resources)).toEqual(['Keep']);
    expect(w.records.get('A')!.state.resources['Keep']!.dependencies).toEqual([]);
    expect(w.records.get('B')!.state.resources['New']!.physicalId).toBe('p1');
    expect(w.stateBackend.rotateCreateTokenNonce).toHaveBeenCalledWith('A', 'r', ['Old']);
  });

  it('applies a stack\'s own rename together with a move', async () => {
    const w = world({ A: { Old: rec('p1'), Ren: rec('pr') }, B: { BRen: rec('pb') } });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.plans.get('A')!.renames.push({ from: 'Ren', to: 'Ren2', resourceType: queue, source: 'detected' });
    w.plans.get('B')!.renames.push({ from: 'BRen', to: 'BRen2', resourceType: queue, source: 'detected' });
    await w.run();
    expect(Object.keys(w.records.get('A')!.state.resources)).toEqual(['Ren2']);
    expect(Object.keys(w.records.get('B')!.state.resources).sort()).toEqual(['BRen2', 'New']);
    expect(w.stateBackend.rotateCreateTokenNonce).toHaveBeenCalledWith('A', 'r', ['Ren', 'Old']);
  });

  it('writes nothing when any record changed after planning, and unlocks every stack', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.records.get('B')!.etag = '"moved"';
    await expect(w.run()).rejects.toThrow(/changed after cdkd refactor planned it/);
    expect(w.stateBackend.saveState).not.toHaveBeenCalled();
    expect(w.order.filter((x) => x.startsWith('unlock'))).toEqual(['unlock:B', 'unlock:A']);
  });

  it('writes nothing when a rollback journal appeared after planning', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.setJournal();
    await expect(w.run()).rejects.toThrow(/rollback journal/);
    expect(w.stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('migrates a legacy-layout record on the save', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.records.get('A')!.migrationPending = true;
    await w.run();
    const saveA = w.stateBackend.saveState.mock.calls.find((c) => c[0] === 'A')!;
    expect(saveA[3]).toEqual({ expectedEtag: '"A"', migrateLegacy: true });
  });

  it('puts the source back when the destination save fails', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.failSave('B', 1);
    await expect(w.run()).rejects.toThrow(/No record moved/);
    expect(w.holders('p1')).toEqual(['A']);
  });

  it('puts a destination back whose save landed but reported failure, then the source', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.failSave('B', 1, true);
    await expect(w.run()).rejects.toThrow(/Put back as planned/);
    expect(w.holders('p1')).toEqual(['A']);
  });

  it('never records a resource in two stacks when one of two destinations fails', async () => {
    const w = world({ S: { X: rec('px'), Y: rec('py') }, D1: {}, D2: {} });
    w.move(mv('S', 'X', 'D1', 'X2'));
    w.move(mv('S', 'Y', 'D2', 'Y2'));
    w.failSave('D2', 1);
    await expect(w.run()).rejects.toThrow(/No record moved/);
    expect(w.holders('px')).toEqual(['S']);
    expect(w.holders('py')).toEqual(['S']);
  });

  it('keeps the source without the record when a destination cannot be put back', async () => {
    const w = world({ S: { X: rec('px'), Y: rec('py') }, D1: {}, D2: {} });
    w.move(mv('S', 'X', 'D1', 'X2'));
    w.move(mv('S', 'Y', 'D2', 'Y2'));
    w.failSave('D2', 1);
    w.failSave('D1', 2); // the put-back of D1
    await expect(w.run()).rejects.toThrow(/Kept without the records they moved out/);
    // Each resource is recorded exactly once or not at all -- never twice.
    expect(w.holders('px')).toEqual(['D1']);
    expect(w.holders('py')).toEqual([]);
  });

  it('names cdkd import when the source cannot be put back either', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.failSave('B', 1);
    w.failSave('A', 2);
    await expect(w.run()).rejects.toThrow(/cdkd import/);
    expect(w.holders('p1')).toEqual([]);
  });

  it('names a rename-only stack written before the failure as kept', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {}, C: { Ren: rec('pc') } });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.plans.get('C')!.renames.push({ from: 'Ren', to: 'Ren2', resourceType: queue, source: 'detected' });
    w.failSave('B', 1);
    await expect(w.run()).rejects.toThrow(/Renamed and kept \(no move involved\): C \(r\)/);
    expect(Object.keys(w.records.get('C')!.state.resources)).toEqual(['Ren2']);
    expect(w.holders('p1')).toEqual(['A']);
  });

  it('keeps the source out when a destination cannot be read back', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.failSave('B', 1, true);
    const real = w.stateBackend.getState.getMockImplementation()!;
    let reads = 0;
    w.stateBackend.getState.mockImplementation(async (name: string) => {
      if (name === 'B' && ++reads > 1) return null as never;
      return real(name);
    });
    await expect(w.run()).rejects.toThrow(/Could not be read back or put back: B \(r\)/);
    // B holds the record; A must not get it back, or it would be in two stacks.
    expect(w.holders('p1')).toEqual(['B']);
  });

  it('reports a failed first source save without moving anything', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.failSave('A', 1);
    await expect(w.run()).rejects.toThrow(/No record moved/);
    expect(w.holders('p1')).toEqual(['A']);
    expect(w.stateBackend.saveState.mock.calls.map((c) => c[0])).toEqual(['A']);
  });

  it('releases the locks it took and writes nothing under contention', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.lockManager.acquireLock.mockImplementation(async (name: string) => {
      w.order.push(`lock:${name}`);
      return name !== 'B';
    });
    await expect(w.run()).rejects.toThrow('locked: B');
    expect(w.stateBackend.getState).not.toHaveBeenCalled();
    expect(w.order.filter((x) => x.startsWith('unlock'))).toEqual(['unlock:A']);
  });
});
