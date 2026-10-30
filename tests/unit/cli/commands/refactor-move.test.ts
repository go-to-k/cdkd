/**
 * go-to-k/cdkd#5202: `cdkd refactor` moving a record between stacks. The
 * planner keeps a move only when the destination's diff shows the moved
 * resource unchanged; the apply writes sources before destinations and puts a
 * source back when a later save fails, so a resource is never recorded in
 * two stacks and never silently in none.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyMoveGroup,
  finishInterruptedMoves,
  finishPendingMoves,
  planMoves,
  renderMovePlan,
} from '../../../../src/cli/commands/refactor-move.js';
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
    // `getState` of a stack with no record answers null, as S3 does.
    for (const [name, resources] of Object.entries(stacks)) {
      records.set(name, { state: stack(name, resources), etag: `"${name}"` });
    }
    const failures = new Map<string, { nth: number; landed: boolean }>();
    const saves = new Map<string, number>();
    let journal = false;
    const saveImpl = async (name: string, _r: string, state: StackState, o: { expectedEtag?: string }) => {
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
    };
    let marker: { body: unknown; etag: string } | null = null;
    let markerVersion = 0;
    const stateBackend = {
      getRefactorMarker: vi.fn(async () => (marker === null ? null : structuredClone(marker))),
      saveRefactorMarker: vi.fn(async (body: { moves: unknown[] }, etag: string | null) => {
        order.push('marker');
        if ((marker === null ? null : marker.etag) !== etag) return 'conflict' as const;
        markerVersion += 1;
        marker = body.moves.length === 0 ? null : { body: structuredClone(body), etag: `"m${markerVersion}"` };
        return 'saved' as const;
      }),
      getState: vi.fn(async (name: string) => {
        order.push(`get:${name}`);
        const r = records.get(name);
        if (r === undefined) return null;
        return { state: structuredClone(r.state), etag: r.etag, ...(r.migrationPending && { migrationPending: true }) };
      }),
      loadRollbackJournal: vi.fn(async () => (journal ? ({} as never) : null)),
      rotateCreateTokenNonce: vi.fn(async (name: string) => {
        order.push(`rotate:${name}`);
      }),
      saveState: vi.fn(saveImpl),
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
    const markerMoves = (): Array<{ fromStack: string; from: string; toStack: string; to: string }> =>
      marker === null ? [] : ((marker.body as { moves: never[] }).moves ?? []);
    return {
      order, records, plans, move, run, holders, stateBackend, lockManager, saveImpl, markerMoves,
      failSave: (name: string, nth: number, landed = false) => failures.set(name, { nth, landed }),
      setJournal: () => { journal = true; },
    };
  }

  /** Every resource is recorded; one recorded twice is marked as moving by its source. */
  function assertSafe(w: ReturnType<typeof world>, physicalIds: string[]): void {
    for (const pid of physicalIds) {
      const holders = w.holders(pid);
      expect(holders.length, `${pid} is recorded nowhere`).toBeGreaterThan(0);
      if (holders.length > 1) {
        const marked = holders.filter((name) =>
          (w.records.get(name)!.state.pendingMovesOut ?? []).some(
            (m) => w.records.get(name)!.state.resources[m.from]?.physicalId === pid
          )
        );
        expect(marked, `${pid} is in ${holders.join(', ')} with no source marking the move`).toHaveLength(1);
      }
    }
  }

  const finish = (w: ReturnType<typeof world>, name: string) =>
    finishPendingMoves({
      stackName: name,
      region: 'r',
      // As `cdkd refactor` feeds it: the moves the shared marker lists.
      markerMoves: w
        .markerMoves()
        .filter((m) => m.fromStack === name)
        .map((m) => ({ from: m.from, toStack: m.toStack, toRegion: 'r', to: m.to, startedAt: 1 })),
      declaresInDestination: () => true,
      stateBackend: w.stateBackend as never,
      lockManager: w.lockManager as never,
      recovery: { stateBucket: 'bkt', statePrefix: 'pfx' },
      contentionMessage: async (x) => `locked: ${x.stackName}`,
    });

  it('marks the source, adds to the destination, then unmarks the source', async () => {
    const w = world({ A: { Old: rec('p1'), Keep: rec('pk', { dependencies: ['Old'] }) }, B: { Other: rec('po') } });
    w.move(mv('A', 'Old', 'B', 'New'));
    const saved: Array<{ name: string; state: StackState }> = [];
    w.stateBackend.saveState.mockImplementationOnce(async (name, region, state, o) => {
      saved.push({ name, state: structuredClone(state) });
      return w.saveImpl(name, region, state, o);
    });
    await w.run();
    expect(w.order).toEqual([
      'lock:A', 'lock:B', 'get:A', 'get:B', 'marker', 'rotate:A', 'save:A', 'save:B', 'save:A', 'marker',
      'unlock:B', 'unlock:A',
    ]);
    // The marker is written before any record and cleared after the last.
    expect(w.markerMoves()).toEqual([]);
    // The first write keeps the record and names the move.
    expect(Object.keys(saved[0]!.state.resources).sort()).toEqual(['Keep', 'Old']);
    expect(saved[0]!.state.pendingMovesOut).toEqual([
      { from: 'Old', toStack: 'B', toRegion: 'r', to: 'New', startedAt: expect.any(Number) },
    ]);
    const finalA = w.records.get('A')!.state;
    expect(Object.keys(finalA.resources)).toEqual(['Keep']);
    expect(finalA.resources['Keep']!.dependencies).toEqual([]);
    expect(finalA.pendingMovesOut).toBeUndefined();
    expect(w.records.get('B')!.state.resources['New']!.physicalId).toBe('p1');
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
    expect(w.stateBackend.rotateCreateTokenNonce).toHaveBeenCalledWith('B', 'r', ['BRen']);
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

  // Every write of the run, failing before or after it lands: the records stay
  // safe, and the next refactor of the source finishes the move.
  it.each([
    ['the marked source', 'A', 1, false],
    ['the marked source (landed)', 'A', 1, true],
    ['the destination', 'B', 1, false],
    ['the destination (landed)', 'B', 1, true],
    ['the unmarked source', 'A', 2, false],
    ['the unmarked source (landed)', 'A', 2, true],
  ])('a failed save of %s leaves safe records the next refactor finishes', async (_label, name, nth, landed) => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.failSave(name, nth, landed);
    await expect(w.run()).rejects.toThrow(/could not save stack/);
    assertSafe(w, ['p1']);
    // The shared marker still lists the move, so a deploy of EITHER stack refuses.
    expect(w.markerMoves()).toEqual([expect.objectContaining({ fromStack: 'A', from: 'Old', toStack: 'B', to: 'New' })]);
    await finish(w, 'A');
    // Whichever write failed, the next refactor completes the move.
    expect(w.holders('p1')).toEqual(['B']);
    expect(w.records.get('A')!.state.pendingMovesOut).toBeUndefined();
  });

  it('keeps every resource safe when one of two destinations fails, and finishes both', async () => {
    const w = world({ S: { X: rec('px'), Y: rec('py') }, D1: {}, D2: {} });
    w.move(mv('S', 'X', 'D1', 'X2'));
    w.move(mv('S', 'Y', 'D2', 'Y2'));
    w.failSave('D2', 1);
    await expect(w.run()).rejects.toThrow(/Re-run 'cdkd refactor S'/);
    assertSafe(w, ['px', 'py']);
    expect(w.markerMoves()).toHaveLength(2);
    expect(w.records.get('S')!.state.pendingMovesOut).toHaveLength(2);
    const { finished } = await finish(w, 'S');
    expect(finished.map((f) => f.to).sort()).toEqual(['X2', 'Y2']);
    expect(w.holders('px')).toEqual(['D1']);
    expect(w.holders('py')).toEqual(['D2']);
    expect(w.records.get('S')!.state.pendingMovesOut).toBeUndefined();
  });

  it('writes nothing when the marker cannot be read as moves', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.stateBackend.getRefactorMarker.mockResolvedValue({ body: 'torn', etag: '"x"' });
    await expect(w.run()).rejects.toThrow(/marker .*cannot be/);
    expect(w.stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('retries a marker write that lost a race with another run', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.stateBackend.saveRefactorMarker.mockResolvedValueOnce('conflict');
    await w.run();
    expect(w.holders('p1')).toEqual(['B']);
    expect(w.markerMoves()).toEqual([]);
  });

  it('says the records are complete when only clearing the marker fails', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {} });
    w.move(mv('A', 'Old', 'B', 'New'));
    const real = w.stateBackend.saveRefactorMarker.getMockImplementation()!;
    let n = 0;
    w.stateBackend.saveRefactorMarker.mockImplementation(async (body, etag) => {
      n += 1;
      if (n > 1) throw new Error('throttled');
      return real(body, etag);
    });
    await expect(w.run()).rejects.toThrow(/Every record of the refactor was written/);
    expect(w.holders('p1')).toEqual(['B']);
    expect(w.markerMoves()).toHaveLength(1);
  });

  it('names what it wrote before a failure', async () => {
    const w = world({ A: { Old: rec('p1') }, B: {}, C: { Ren: rec('pc') } });
    w.move(mv('A', 'Old', 'B', 'New'));
    w.plans.get('C')!.renames.push({ from: 'Ren', to: 'Ren2', resourceType: queue, source: 'detected' });
    w.failSave('B', 1);
    await expect(w.run()).rejects.toThrow(/Written before the failure: A \(r\), C \(r\)/);
    expect(Object.keys(w.records.get('C')!.state.resources)).toEqual(['Ren2']);
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

describe('finishPendingMoves', () => {
  function backend(stacks: Record<string, StackState | undefined>) {
    const records = new Map<string, { state: StackState; etag: string }>();
    for (const [name, st] of Object.entries(stacks)) if (st) records.set(name, { state: st, etag: `"${name}"` });
    let n = 0;
    const out = {
      declared: undefined as Set<string> | undefined,
      records,
      stateBackend: {
        getState: vi.fn(async (name: string) => {
          const r = records.get(name);
          return r ? { state: structuredClone(r.state), etag: r.etag } : null;
        }),
        saveState: vi.fn(async (name: string, _r: string, state: StackState, o: { expectedEtag?: string }) => {
          if (records.get(name)?.etag !== o.expectedEtag) throw new Error('PreconditionFailed');
          n += 1;
          records.set(name, { state: structuredClone(state), etag: `"${name}-${n}"` });
          return `"${name}-${n}"`;
        }),
      },
      lockManager: { acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => undefined) },
    };
    return out;
  }
  const mark = { from: 'Old', toStack: 'B', toRegion: 'r', to: 'New', startedAt: 1 };
  const run = (b: ReturnType<typeof backend>, markerMoves?: typeof mark[]) =>
    finishPendingMoves({
      stackName: 'A',
      region: 'r',
      ...(markerMoves !== undefined && { markerMoves }),
      declaresInDestination: (_s: string, _r: string, id: string, type: string) =>
        b.declared === undefined || b.declared.has(`${id}:${type}`),
      stateBackend: b.stateBackend as never,
      lockManager: b.lockManager as never,
      recovery: { stateBucket: 'bkt', statePrefix: 'pfx' },
      contentionMessage: async () => 'locked',
    });
  const marked = (resources: Record<string, ResourceState>, pending = [mark]): StackState => ({
    ...stack('A', resources),
    pendingMovesOut: pending as never,
  });

  it('refuses to add a record the destination template does not declare with its type', async () => {
    const b = backend({ A: marked({ Old: rec('p1') }), B: stack('B', {}) });
    b.declared = new Set(['New:AWS::SNS::Topic']);
    await expect(run(b)).rejects.toThrow(/does not declare New as a AWS::SQS::Queue/);
    expect(b.stateBackend.saveState).not.toHaveBeenCalled();
    expect(b.records.get('A')!.state.pendingMovesOut).toHaveLength(1);
  });

  it('writes the moves that finish and keeps the mark of the one refused beside them', async () => {
    const mark2 = { from: 'Old2', toStack: 'B', toRegion: 'r', to: 'New2', startedAt: 1 };
    const b = backend({
      A: marked({ Old: rec('p1'), Old2: rec('p2') }, [mark, mark2]),
      B: stack('B', { New: rec('other') }),
    });
    const err = (await run(b).catch((e: unknown) => e)) as Error & { finishedMoves?: unknown[] };
    expect(err.message).toMatch(/already holds a different resource under New/);
    expect(err.finishedMoves).toEqual([expect.objectContaining({ from: 'Old2', to: 'New2' })]);
    expect(Object.keys(b.records.get('A')!.state.resources)).toEqual(['Old']);
    expect(b.records.get('A')!.state.pendingMovesOut).toEqual([mark]);
    expect(b.records.get('B')!.state.resources['New2']!.physicalId).toBe('p2');
  });

  it('only drops the source record when the destination already holds it', async () => {
    const b = backend({ A: marked({ Old: rec('p1') }), B: stack('B', { New: rec('p1') }) });
    expect((await run(b)).finished).toHaveLength(1);
    expect(b.records.get('A')!.state.resources).toEqual({});
    expect(b.records.get('A')!.state.pendingMovesOut).toBeUndefined();
    expect(b.stateBackend.saveState.mock.calls.map((c) => c[0])).toEqual(['A']);
  });

  it('adds the record to the destination first, then drops it from the source', async () => {
    const b = backend({ A: marked({ Old: rec('p1') }), B: stack('B', {}) });
    await run(b);
    expect(b.stateBackend.saveState.mock.calls.map((c) => c[0])).toEqual(['B', 'A']);
    expect(b.records.get('B')!.state.resources['New']!.physicalId).toBe('p1');
    expect(b.records.get('A')!.state.resources).toEqual({});
  });

  it('refuses, keeping the mark, when the destination holds a different resource under the id', async () => {
    const b = backend({ A: marked({ Old: rec('p1') }), B: stack('B', { New: rec('other') }) });
    await expect(run(b)).rejects.toThrow(/already holds a different resource under New/);
    expect(b.records.get('A')!.state.pendingMovesOut).toHaveLength(1);
    expect(b.records.get('A')!.state.resources['Old']).toBeDefined();
  });

  it('drops a mark whose record the source no longer holds when the destination does', async () => {
    const b = backend({ A: marked({}), B: stack('B', { New: rec('p1') }) });
    await run(b);
    expect(b.records.get('A')!.state.pendingMovesOut).toBeUndefined();
  });

  it.each([
    ['neither stack records the resource', { A: marked({}), B: stack('B', {}) }, /neither stack records the resource/],
    ['the destination has no state', { A: marked({ Old: rec('p1') }), B: undefined }, /has no cdkd state/],
  ])('refuses when %s', async (_label, stacks, reason) => {
    const b = backend(stacks as Record<string, StackState | undefined>);
    await expect(run(b)).rejects.toThrow(reason);
    expect(b.records.get('A')!.state.pendingMovesOut).toHaveLength(1);
  });

  it('refuses a malformed pending-moves field and writes nothing', async () => {
    const b = backend({ A: { ...stack('A', {}), pendingMovesOut: 'torn' as never }, B: stack('B', {}) });
    await expect(run(b)).rejects.toThrow(/cannot read/);
    expect(b.stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('finishes nothing on a record with no pending move', async () => {
    const b = backend({ A: stack('A', { Old: rec('p1') }) });
    expect((await run(b)).finished).toEqual([]);
    expect(b.lockManager.acquireLock).not.toHaveBeenCalled();
  });

  it('finishes a move found only in the shared refactor marker (source record unmarked)', async () => {
    // `A`'s own record holds `Old` but carries no `pendingMovesOut` -- the
    // move is known only through the shared marker a killed run left behind.
    const b = backend({ A: stack('A', { Old: rec('p1') }), B: stack('B', {}) });
    const result = await run(b, [mark]);
    expect(result.finished).toHaveLength(1);
    expect(b.stateBackend.saveState.mock.calls.map((c) => c[0])).toEqual(['B', 'A']);
    expect(b.records.get('B')!.state.resources['New']!.physicalId).toBe('p1');
    expect(b.records.get('A')!.state.resources).toEqual({});
  });

  it('finishes a marker move when the source record is absent and the destination already holds it', async () => {
    const b = backend({ B: stack('B', { New: rec('p1') }) });
    const result = await run(b, [mark]);
    expect(result.finished).toEqual([
      { fromStack: 'A', fromRegion: 'r', from: 'Old', toStack: 'B', toRegion: 'r', to: 'New' },
    ]);
    expect(b.stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('rejects a marker move when the source record is absent and the destination lacks it too', async () => {
    const b = backend({ B: stack('B', {}) });
    await expect(run(b, [mark])).rejects.toThrow(/has no cdkd state any more/);
    expect(b.stateBackend.saveState).not.toHaveBeenCalled();
  });
});

describe('finishInterruptedMoves', () => {
  function env(opts: { marker?: unknown; stacks: Record<string, StackState> }) {
    const records = new Map<string, { state: StackState; etag: string }>();
    for (const [name, st] of Object.entries(opts.stacks)) records.set(name, { state: st, etag: `"${name}"` });
    let marker: { body: unknown; etag: string } | null =
      opts.marker === undefined ? null : { body: opts.marker, etag: '"m0"' };
    let n = 0;
    const stateBackend = {
      refactorMarkerKey: () => 'pfx/_refactor/pending.json',
      getRefactorMarker: vi.fn(async () => (marker === null ? null : structuredClone(marker))),
      saveRefactorMarker: vi.fn(async (body: { moves: unknown[] }, etag: string | null) => {
        if ((marker?.etag ?? null) !== etag) return 'conflict' as const;
        marker = body.moves.length === 0 ? null : { body, etag: `"m${++n}"` };
        return 'saved' as const;
      }),
      getState: vi.fn(async (name: string) => {
        const r = records.get(name);
        return r ? { state: structuredClone(r.state), etag: r.etag } : null;
      }),
      saveState: vi.fn(async (name: string, _r: string, state: StackState, o: { expectedEtag?: string }) => {
        if (records.get(name)?.etag !== o.expectedEtag) throw new Error('PreconditionFailed');
        n += 1;
        records.set(name, { state: structuredClone(state), etag: `"${name}-${n}"` });
        return `"${name}-${n}"`;
      }),
    };
    const templates: Record<string, { Resources: Record<string, { Type: string }> }> = {
      B: { Resources: { New: { Type: queue } } },
    };
    const run = (selected: string[], dryRun = false) =>
      finishInterruptedMoves({
        selected: selected.map((stackName) => ({ stackName, region: 'r' })),
        templateOf: (name) => templates[name] as never,
        dryRun,
        stateBackend: stateBackend as never,
        lockManager: { acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => undefined) } as never,
        recovery: { stateBucket: 'bkt', statePrefix: 'pfx' },
        contentionMessage: async () => 'locked',
      });
    return { records, stateBackend, run, marker: () => marker };
  }
  const listed = {
    moves: [{ fromStack: 'A', fromRegion: 'r', from: 'Old', toStack: 'B', toRegion: 'r', to: 'New', startedAt: 1 }],
  };

  it('finishes a listed move when only the DESTINATION is selected, and unlists it', async () => {
    const e = env({ marker: listed, stacks: { A: stack('A', { Old: rec('p1') }), B: stack('B', {}) } });
    const { finished } = await e.run(['B']);
    expect(finished.map((f) => `${f.fromStack}.${f.from}->${f.toStack}.${f.to}`)).toEqual(['A.Old->B.New']);
    expect(e.records.get('B')!.state.resources['New']!.physicalId).toBe('p1');
    expect(e.records.get('A')!.state.resources).toEqual({});
    expect(e.marker()).toBeNull();
  });

  it('ignores a listed move that involves no selected stack', async () => {
    const e = env({ marker: listed, stacks: { A: stack('A', { Old: rec('p1') }), B: stack('B', {}), C: stack('C', {}) } });
    expect((await e.run(['C'])).finished).toEqual([]);
    expect(e.stateBackend.saveState).not.toHaveBeenCalled();
    expect(e.marker()).not.toBeNull();
  });

  it('writes nothing under --dry-run and lists what it would finish', async () => {
    const e = env({ marker: listed, stacks: { A: stack('A', { Old: rec('p1') }), B: stack('B', {}) } });
    const { finished, pending } = await e.run(['A'], true);
    expect(finished).toEqual([]);
    expect(pending).toEqual([expect.objectContaining({ from: 'Old', to: 'New' })]);
    expect(e.stateBackend.saveState).not.toHaveBeenCalled();
    expect(e.stateBackend.saveRefactorMarker).not.toHaveBeenCalled();
  });

  it('lists a MARKED source under --dry-run too, writing nothing', async () => {
    const mark1 = { from: 'Old', toStack: 'B', toRegion: 'r', to: 'New', startedAt: 1 };
    const e = env({
      stacks: { A: { ...stack('A', { Old: rec('p1') }), pendingMovesOut: [mark1] }, B: stack('B', {}) },
    });
    const { pending } = await e.run(['A'], true);
    expect(pending).toEqual([expect.objectContaining({ from: 'Old', to: 'New' })]);
    expect(e.stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('refuses a marker it cannot read, writing nothing', async () => {
    const e = env({ marker: 'torn', stacks: { A: stack('A', {}) } });
    await expect(e.run(['A'])).rejects.toThrow(/cannot be read/);
    expect(e.stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('unlists the moves that finished when a sibling move is refused', async () => {
    const both = {
      moves: [
        ...listed.moves,
        { fromStack: 'A', fromRegion: 'r', from: 'Old2', toStack: 'B', toRegion: 'r', to: 'Gone', startedAt: 1 },
      ],
    };
    const e = env({ marker: both, stacks: { A: stack('A', { Old: rec('p1'), Old2: rec('p2') }), B: stack('B', {}) } });
    // `Gone` is not in the destination template: that move is refused.
    await expect(e.run(['A'])).rejects.toThrow(/does not declare Gone/);
    expect((e.marker()!.body as { moves: Array<{ from: string }> }).moves.map((m) => m.from)).toEqual(['Old2']);
    expect(e.records.get('B')!.state.resources['New']!.physicalId).toBe('p1');
  });
});
