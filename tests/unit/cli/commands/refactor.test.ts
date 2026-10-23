/**
 * go-to-k/cdkd#5201: `cdkd refactor`'s planner and apply. The planner keeps a
 * rename only when the diff over the renamed record shows the new id
 * unchanged; the apply writes only under the lock, only over the record the
 * plan read, and always releases the lock.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyStackRefactor,
  envKey,
  moveOverridesOf,
  overridesForStack,
  referencedLogicalIds,
  planStackRefactor,
  renderRefactorPlan,
  sampleMappingFile,
  type RefactorDiffFn,
  type StackRefactorPlan,
} from '../../../../src/cli/commands/refactor.js';
import type { ResourceChange, ResourceState, StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import type { MappingEnvironment } from '../../../../src/analyzer/refactor-pairing.js';

const queue = 'AWS::SQS::Queue';

function rec(properties: Record<string, unknown>, extra: Partial<ResourceState> = {}): ResourceState {
  return { physicalId: 'p', resourceType: queue, properties, ...extra };
}

function stack(resources: Record<string, ResourceState>, extra: Partial<StackState> = {}): StackState {
  return { version: 13, stackName: 'S', region: 'us-east-1', resources, outputs: {}, lastModified: 0, ...extra };
}

/**
 * A diff double: a template id the state lacks is CREATE, a state id the
 * template lacks is DELETE, and a shared id is NO_CHANGE when the record's
 * properties equal `templateProps` (else UPDATE on each differing key).
 */
function fakeDiff(
  templateProps: Record<string, { type?: string; props: Record<string, unknown> }>,
  blocking: string[] = []
): RefactorDiffFn & { calls: StackState[] } {
  const calls: StackState[] = [];
  const fn = (async (state: StackState) => {
    calls.push(state);
    const changes = new Map<string, ResourceChange>();
    for (const [id, { type = queue, props }] of Object.entries(templateProps)) {
      const r = state.resources[id];
      if (r === undefined) {
        changes.set(id, { logicalId: id, changeType: 'CREATE', resourceType: type, desiredProperties: props });
        continue;
      }
      const diffs = Object.keys({ ...props, ...r.properties }).filter(
        (k) => JSON.stringify(props[k]) !== JSON.stringify(r.properties[k])
      );
      changes.set(id, {
        logicalId: id,
        resourceType: type,
        changeType: diffs.length === 0 ? 'NO_CHANGE' : 'UPDATE',
        propertyChanges: diffs.map((path) => ({
          path,
          oldValue: r.properties[path],
          newValue: props[path],
          requiresReplacement: false,
        })),
      });
    }
    for (const [id, r] of Object.entries(state.resources)) {
      if (!(id in templateProps)) {
        changes.set(id, { logicalId: id, changeType: 'DELETE', resourceType: r.resourceType });
      }
    }
    return { changes, blocking };
  }) as RefactorDiffFn & { calls: StackState[] };
  fn.calls = calls;
  return fn;
}

const template: CloudFormationTemplate = { Resources: {} };

function plan(state: StackState, diff: RefactorDiffFn, overrides: Array<{ from: string; to: string }> = []) {
  return planStackRefactor({ stackName: 'S', region: 'us-east-1', state, etag: '"e1"', template, overrides, diff });
}

describe('planStackRefactor', () => {
  it('keeps a rename the confirming diff shows unchanged, without writing anything', async () => {
    const state = stack({ Old: rec({ T: 1 }) });
    const diff = fakeDiff({ New: { props: { T: 1 } } });
    const p = await plan(state, diff);
    expect(p.renames.map((r) => [r.from, r.to])).toEqual([['Old', 'New']]);
    expect(p.differing).toEqual([]);
    // The input record is never mutated; the second diff ran over a renamed copy.
    expect(Object.keys(state.resources)).toEqual(['Old']);
    expect(Object.keys(diff.calls[1]!.resources)).toEqual(['New']);
  });

  it('leaves a detected look-alike whose properties changed to the deploy, naming the paths', async () => {
    const p = await plan(stack({ Old: rec({ T: 1 }) }), fakeDiff({ New: { props: { T: 2 } } }));
    expect(p.renames).toEqual([]);
    expect(p.differing).toEqual([
      { rename: expect.objectContaining({ from: 'Old', to: 'New' }), paths: ['T'] },
    ]);
    expect(renderRefactorPlan(p).join('\n')).toMatch(/Not refactored: Old -> New .* also changes T/);
  });

  it('refuses a mapping-file pair whose properties changed (cdk refactor parity)', async () => {
    const p = await plan(
      stack({ OldA: rec({ T: 1 }), OldB: rec({ T: 1 }) }),
      fakeDiff({ NewA: { props: { T: 1 } }, NewB: { props: { T: 5 } } }),
      [{ from: 'OldA', to: 'NewB' }]
    );
    expect(p.refusedOverrides).toEqual([
      expect.objectContaining({ from: 'OldA', to: 'NewB', reason: expect.stringMatching(/properties also changed \(T\)/) }),
    ]);
    expect(p.renames.map((r) => [r.from, r.to])).toEqual([['OldB', 'NewA']]);
  });

  it('re-confirms the survivors after dropping a failed rename', async () => {
    const topic = 'AWS::SNS::Topic';
    const diff = fakeDiff({
      NewTopic: { type: topic, props: { T: 1 } },
      NewQueue: { props: { T: 9 } },
    });
    const p = await plan(
      stack({ OldTopic: rec({ T: 1 }, { resourceType: topic }), OldQueue: rec({ T: 2 }) }),
      diff
    );
    expect(p.renames.map((r) => r.to)).toEqual(['NewTopic']);
    expect(p.differing.map((x) => x.rename.to)).toEqual(['NewQueue']);
    // base + one pass that failed NewQueue + one confirming pass.
    expect(diff.calls).toHaveLength(3);
    expect(Object.keys(diff.calls[2]!.resources).sort()).toEqual(['NewTopic', 'OldQueue']);
  });

  it('reports identical look-alikes as ambiguous and renames nothing', async () => {
    const p = await plan(
      stack({ OldA: rec({ T: 1 }), OldB: rec({ T: 1 }) }),
      fakeDiff({ NewA: { props: { T: 1 } }, NewB: { props: { T: 1 } } })
    );
    expect(p.renames).toEqual([]);
    expect(p.ambiguous).toHaveLength(1);
  });

  it('refuses a stack whose diff carries a deploy-refusal condition', async () => {
    await expect(plan(stack({ Old: rec({}) }), fakeDiff({ New: { props: {} } }, ['torn']))).rejects.toThrow(
      /refuses to start/
    );
  });

  it('skips a detected rename whose old id a rollback-orphan record names, and refuses a named one', async () => {
    const orphans = [{ logicalId: 'Old', orphanedAt: 1, state: rec({ T: 1 }, { physicalId: 'x' }) }];
    const detected = await plan(stack({ Old: rec({ T: 1 }) }, { orphans }), fakeDiff({ New: { props: { T: 1 } } }));
    expect(detected.renames).toEqual([]);
    expect(detected.refusedOverrides).toEqual([]);
    expect(detected.skipped).toEqual([
      { rename: expect.objectContaining({ from: 'Old', to: 'New' }), reason: expect.stringMatching(/rollback-orphan/) },
    ]);
    expect(renderRefactorPlan(detected).join('\n')).toMatch(/Not refactored: Old -> New .*rollback-orphan/);
    const named = await plan(stack({ Old: rec({ T: 1 }) }, { orphans }), fakeDiff({ New: { props: { T: 1 } } }), [
      { from: 'Old', to: 'New' },
    ]);
    expect(named.refusedOverrides).toEqual([
      expect.objectContaining({ from: 'Old', to: 'New', reason: expect.stringMatching(/rollback-orphan/) }),
    ]);
  });

  it('drops a rename a later pass invalidates (the cascade)', async () => {
    // B is unchanged only while A is renamed too; A itself changed.
    const diff: RefactorDiffFn = async (state) => {
      const changes = new Map<string, ResourceChange>();
      const has = (id: string) => state.resources[id] !== undefined;
      changes.set('A2', {
        logicalId: 'A2',
        resourceType: 'AWS::SNS::Topic',
        changeType: has('A2') ? 'UPDATE' : 'CREATE',
        desiredProperties: {},
        propertyChanges: has('A2') ? [{ path: 'X', oldValue: 1, newValue: 2, requiresReplacement: false }] : [],
      });
      changes.set('B2', {
        logicalId: 'B2',
        resourceType: queue,
        changeType: !has('B2') ? 'CREATE' : has('A2') ? 'NO_CHANGE' : 'UPDATE',
        desiredProperties: {},
      });
      for (const id of Object.keys(state.resources)) {
        if (id !== 'A2' && id !== 'B2') {
          changes.set(id, { logicalId: id, changeType: 'DELETE', resourceType: state.resources[id]!.resourceType });
        }
      }
      return { changes, blocking: [] };
    };
    const p = await plan(stack({ A: rec({}, { resourceType: 'AWS::SNS::Topic' }), B: rec({}) }), diff);
    expect(p.renames).toEqual([]);
    expect(p.differing.map((d) => d.rename.to).sort()).toEqual(['A2', 'B2']);
  });

  it('splits look-alikes that differ only in what they reference with the diff itself', async () => {
    // Both CREATE rows carry an unresolved Ref, so the proposal sees them as
    // equal; only the pairing that keeps each physical id shows no change.
    const want: Record<string, string> = { NewA: 'pa', NewB: 'pb' };
    const diff = (async (state: StackState) => {
      const changes = new Map<string, ResourceChange>();
      for (const id of Object.keys(want)) {
        const r = state.resources[id];
        changes.set(id, {
          logicalId: id,
          resourceType: queue,
          changeType: r === undefined ? 'CREATE' : r.physicalId === want[id] ? 'NO_CHANGE' : 'UPDATE',
          desiredProperties: { Target: { Ref: 'X' } },
        });
      }
      for (const id of Object.keys(state.resources)) {
        if (!(id in want)) changes.set(id, { logicalId: id, changeType: 'DELETE', resourceType: queue });
      }
      return { changes, blocking: [] };
    }) as RefactorDiffFn;
    const p = await plan(
      stack({ OldA: rec({ Target: 'ta' }, { physicalId: 'pa' }), OldB: rec({ Target: 'tb' }, { physicalId: 'pb' }) }),
      diff
    );
    expect(p.ambiguous).toEqual([]);
    expect(p.renames.map((r) => [r.from, r.to]).sort()).toEqual([
      ['OldA', 'NewA'],
      ['OldB', 'NewB'],
    ]);
  });

  it.each([
    ['an unreadable orphans container', { orphans: 'torn' as never }],
    ['an unreadable orphan row', { orphans: [null] as never }],
  ])('refuses %s before diffing', async (_label, extra) => {
    const diff = fakeDiff({ New: { props: { T: 1 } } });
    await expect(plan(stack({ Old: rec({ T: 1 }) }, extra), diff)).rejects.toThrow();
    expect(diff.calls).toHaveLength(0);
  });

  /**
   * A diff double for look-alikes: every CREATE row carries an unresolved
   * Ref (so the proposal cannot split them), and a renamed id is NO_CHANGE
   * when its record's physical id is one `want` accepts for it.
   */
  function lookAlikeDiff(want: Record<string, readonly string[]>): RefactorDiffFn & { calls: number } {
    const fn = (async (state: StackState) => {
      fn.calls += 1;
      const changes = new Map<string, ResourceChange>();
      for (const id of Object.keys(want)) {
        const r = state.resources[id];
        changes.set(id, {
          logicalId: id,
          resourceType: queue,
          changeType: r === undefined ? 'CREATE' : want[id]!.includes(r.physicalId) ? 'NO_CHANGE' : 'UPDATE',
          desiredProperties: { Target: { Ref: 'X' } },
        });
      }
      for (const id of Object.keys(state.resources)) {
        if (!(id in want)) changes.set(id, { logicalId: id, changeType: 'DELETE', resourceType: queue });
      }
      return { changes, blocking: [] };
    }) as unknown as RefactorDiffFn & { calls: number };
    fn.calls = 0;
    return fn;
  }

  it('splits what it can and leaves the rest of a group ambiguous', async () => {
    // NewA matches only OldA; NewB and NewC each match both OldB and OldC.
    const diff = lookAlikeDiff({ NewA: ['pa'], NewB: ['pb', 'pc'], NewC: ['pb', 'pc'] });
    const p = await plan(
      stack({
        OldA: rec({ Target: 'a' }, { physicalId: 'pa' }),
        OldB: rec({ Target: 'b' }, { physicalId: 'pb' }),
        OldC: rec({ Target: 'c' }, { physicalId: 'pc' }),
      }),
      diff
    );
    expect(p.renames.map((r) => [r.from, r.to])).toEqual([['OldA', 'NewA']]);
    expect(p.ambiguous).toEqual([{ resourceType: queue, from: ['OldB', 'OldC'], to: ['NewB', 'NewC'] }]);
  });

  it('leaves a group past the trial budget ambiguous without trying it', async () => {
    const want: Record<string, string[]> = {};
    const records: Record<string, ResourceState> = {};
    for (let i = 0; i < 9; i++) {
      want[`New${i}`] = [`p${i}`];
      records[`Old${i}`] = rec({ Target: `t${i}` }, { physicalId: `p${i}` });
    }
    const diff = lookAlikeDiff(want);
    const p = await plan(stack(records), diff);
    expect(p.renames).toEqual([]);
    expect(p.ambiguous).toHaveLength(1);
    expect(p.ambiguous[0]!.to).toHaveLength(9);
    // The base diff only: 81 trials exceed the budget of 64, so none ran.
    expect(diff.calls).toBe(1);
  });

  it('never pairs a CREATE row a rollback-orphan record will be re-adopted under', async () => {
    const orphanState = rec({ T: 1 }, { physicalId: 'orphaned' });
    const p = await plan(
      stack({ Old: rec({ T: 1 }) }, { orphans: [{ logicalId: 'New', orphanedAt: 1, state: orphanState }] }),
      fakeDiff({ New: { props: { T: 1 } } })
    );
    expect(p.renames).toEqual([]);
  });
});

describe('unpaired rows (the move candidates)', () => {
  it('keeps a look-alike whose properties differ as a candidate and drops every row a rename took', async () => {
    const topic = 'AWS::SNS::Topic';
    const p = await plan(
      stack({ OldT: rec({ T: 1 }, { resourceType: topic }), OldQ: rec({ T: 2 }), Gone: rec({ T: 3 }, { resourceType: 'AWS::SSM::Parameter' }) }),
      fakeDiff({
        NewT: { type: topic, props: { T: 1 } },
        NewQ: { props: { T: 9 } },
        Brand: { type: 'AWS::SNS::Subscription', props: {} },
      })
    );
    expect(p.renames.map((r) => r.to)).toEqual(['NewT']);
    expect(p.unpaired.creates.map((c) => c.logicalId).sort()).toEqual(['Brand', 'NewQ']);
    expect(p.unpaired.deletes.map((d) => d.logicalId).sort()).toEqual(['Gone', 'OldQ']);
  });
});

describe('stillChanging', () => {
  it('warns when a resource referencing a renamed one still changes', async () => {
    const t: CloudFormationTemplate = {
      Resources: {
        Wiring: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'New' } } },
        Unrelated: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
      },
    };
    const state = stack({
      Old: rec({ T: 1 }),
      Wiring: rec({ Value: 'p-other' }, { resourceType: 'AWS::SSM::Parameter' }),
      Unrelated: rec({ Value: 'y' }, { resourceType: 'AWS::SSM::Parameter' }),
    });
    const diff = fakeDiff({
      New: { props: { T: 1 } },
      Wiring: { type: 'AWS::SSM::Parameter', props: { Value: 'p-renamed' } },
      Unrelated: { type: 'AWS::SSM::Parameter', props: { Value: 'x' } },
    });
    const p = await planStackRefactor({
      stackName: 'S', region: 'us-east-1', state, etag: '"e"', template: t, overrides: [], diff,
    });
    expect(p.renames.map((r) => r.to)).toEqual(['New']);
    expect(p.stillChanging).toEqual(['Wiring']);
    expect(renderRefactorPlan(p).join('\n')).toMatch(/Warning: Wiring reference a renamed resource/);
  });
});

describe('referencedLogicalIds', () => {
  it('collects Ref, both GetAtt forms, Sub placeholders and DependsOn', () => {
    const t: CloudFormationTemplate = {
      Resources: {
        R: {
          Type: 'X',
          DependsOn: ['D1'],
          Properties: {
            a: { Ref: 'A' },
            b: { 'Fn::GetAtt': ['B', 'Arn'] },
            c: { 'Fn::GetAtt': 'C.Arn' },
            d: { 'Fn::Sub': '${E}-${F.Arn}-${!G}' },
            e: [{ 'Fn::Sub': ['${H}', { H: 'v' }] }],
          },
        },
      },
    };
    expect([...referencedLogicalIds(t, 'R')].sort()).toEqual(['A', 'B', 'C', 'D1', 'E', 'F', 'H']);
    expect(referencedLogicalIds(t, 'missing').size).toBe(0);
  });
});

describe('applyStackRefactor', () => {
  const thePlan = (): StackRefactorPlan => ({
    stackName: 'S',
    region: 'us-east-1',
    etag: '"e1"',
    renames: [{ from: 'Old', to: 'New', resourceType: queue, source: 'detected' }],
    differing: [],
    skipped: [],
    ambiguous: [],
    refusedOverrides: [],
    stillChanging: [],
    template,
    unpaired: { creates: [], deletes: [] },
    movesOut: [],
    movesIn: [],
    state: stack({}),
    diff: fakeDiff({}),
  });

  function doubles(etag = '"e1"', acquired = true, opts: { journal?: boolean; absent?: boolean; migrationPending?: boolean } = {}) {
    const order: string[] = [];
    const stateBackend = {
      getState: vi.fn(async () => {
        order.push('get');
        if (opts.absent) return null;
        return { state: stack({ Old: rec({ T: 1 }) }), etag, migrationPending: opts.migrationPending ?? false };
      }),
      loadRollbackJournal: vi.fn(async () => {
        order.push('journal');
        return opts.journal ? ({ journalVersion: 1, segments: [] } as never) : null;
      }),
      saveState: vi.fn(async () => {
        order.push('save');
      }),
      rotateCreateTokenNonce: vi.fn(async () => {
        order.push('rotate');
      }),
    };
    const lockManager = {
      acquireLock: vi.fn(async () => {
        order.push('lock');
        return acquired;
      }),
      releaseLock: vi.fn(async () => {
        order.push('unlock');
      }),
    };
    return { stateBackend, lockManager, order };
  }

  const run = (d: ReturnType<typeof doubles>) =>
    applyStackRefactor({
      plan: thePlan(),
      stateBackend: d.stateBackend as never,
      lockManager: d.lockManager as never,
      recovery: { stateBucket: 'b', statePrefix: 'p' },
      contentionMessage: async () => 'locked by someone',
    });

  it('locks, re-reads, rotates create tokens, saves conditionally, unlocks', async () => {
    const d = doubles();
    await run(d);
    expect(d.order).toEqual(['lock', 'get', 'journal', 'rotate', 'save', 'unlock']);
    const [, , saved, opts] = d.stateBackend.saveState.mock.calls[0] as unknown as [
      string,
      string,
      StackState,
      { expectedEtag: string },
    ];
    expect(Object.keys(saved.resources)).toEqual(['New']);
    expect(opts.expectedEtag).toBe('"e1"');
    expect(d.stateBackend.rotateCreateTokenNonce).toHaveBeenCalledWith('S', 'us-east-1', ['Old']);
  });

  it('writes nothing and unlocks when the record changed after planning', async () => {
    const d = doubles('"e2"');
    await expect(run(d)).rejects.toThrow(/changed after cdkd refactor planned it/);
    expect(d.stateBackend.saveState).not.toHaveBeenCalled();
    expect(d.stateBackend.rotateCreateTokenNonce).not.toHaveBeenCalled();
    expect(d.order.at(-1)).toBe('unlock');
  });

  it('writes nothing when a rollback journal appeared after planning', async () => {
    const d = doubles('"e1"', true, { journal: true });
    await expect(run(d)).rejects.toThrow(/rollback journal/);
    expect(d.stateBackend.saveState).not.toHaveBeenCalled();
    expect(d.stateBackend.rotateCreateTokenNonce).not.toHaveBeenCalled();
    expect(d.order.at(-1)).toBe('unlock');
  });

  it('writes nothing when the record was deleted after planning', async () => {
    const d = doubles('"e1"', true, { absent: true });
    await expect(run(d)).rejects.toThrow(/changed after cdkd refactor planned it/);
    expect(d.stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('migrates a legacy-layout record on the save, as every writer does', async () => {
    const d = doubles('"e1"', true, { migrationPending: true });
    await run(d);
    const opts = (d.stateBackend.saveState.mock.calls[0] as unknown as [string, string, StackState, Record<string, unknown>])[3];
    expect(opts).toEqual({ expectedEtag: '"e1"', migrateLegacy: true });
  });

  it('writes nothing and releases no foreign lock under contention', async () => {
    const d = doubles('"e1"', false);
    await expect(run(d)).rejects.toThrow('locked by someone');
    expect(d.stateBackend.getState).not.toHaveBeenCalled();
    expect(d.lockManager.releaseLock).not.toHaveBeenCalled();
  });

  it('unlocks when the save fails', async () => {
    const d = doubles();
    d.stateBackend.saveState.mockRejectedValueOnce(new Error('PreconditionFailed'));
    await expect(run(d)).rejects.toThrow('PreconditionFailed');
    expect(d.order.at(-1)).toBe('unlock');
  });
});

describe('sampleMappingFile', () => {
  it('writes one environment per ambiguous stack with its own account and region', () => {
    const base = {
      etag: '"e"', renames: [], differing: [], skipped: [], refusedOverrides: [], stillChanging: [], template,
      unpaired: { creates: [], deletes: [] }, movesOut: [], movesIn: [], state: stack({}), diff: fakeDiff({}),
    };
    const text = sampleMappingFile([
      { plan: { ...base, stackName: 'S', region: 'us-east-1', ambiguous: [{ resourceType: queue, from: ['A', 'B'], to: ['C', 'D'] }] }, account: '111' },
      { plan: { ...base, stackName: 'T', region: 'eu-west-1', ambiguous: [] }, account: '222' },
      { plan: { ...base, stackName: 'U', region: 'eu-west-1', ambiguous: [{ resourceType: queue, from: ['E'], to: ['F', 'G'] }] }, account: '333' },
    ]);
    expect(JSON.parse(text)).toEqual({
      environments: [
        { account: '111', region: 'us-east-1', resources: { 'S.A': 'S.C', 'S.B': 'S.D' } },
        { account: '333', region: 'eu-west-1', resources: { 'U.E': 'U.F' } },
      ],
    });
  });
});

describe('sampleMappingFile with moves', () => {
  it('adds one environment per ambiguous move group, keyed by locations', () => {
    const p0 = { ...thePlanFor('A'), ambiguous: [] };
    const text = sampleMappingFile([], [
      { group: { resourceType: queue, from: ['A.X', 'A.Y'], to: ['B.N'], plan: p0 }, account: '111' },
    ]);
    const env = JSON.parse(text).environments[0];
    expect(env).toEqual({ account: '111', region: 'us-east-1', resources: { 'A.X': 'B.N', 'A.Y': 'B.N' } });
  });
});

function thePlanFor(stackName: string): StackRefactorPlan {
  return {
    stackName, region: 'us-east-1', etag: '"e"', renames: [], differing: [], skipped: [], ambiguous: [],
    refusedOverrides: [], stillChanging: [], template, unpaired: { creates: [], deletes: [] },
    movesOut: [], movesIn: [], state: stack({}), diff: fakeDiff({}),
  };
}

describe('overridesForStack', () => {
  const envs: MappingEnvironment[] = [
    { account: '111111111111', region: 'us-east-1', resources: { 'S.Old': 'S.New', 'T.A': 'T.B' } },
    { account: '222222222222', region: 'us-east-1', resources: { 'S.X': 'S.Y' } },
  ];

  it('takes only the matching environment and this stack, swapping on --revert', () => {
    expect(overridesForStack(envs, 'S', '111111111111', 'us-east-1', false)).toEqual([{ from: 'Old', to: 'New' }]);
    expect(overridesForStack(envs, 'S', '111111111111', 'us-east-1', true)).toEqual([{ from: 'New', to: 'Old' }]);
    expect(overridesForStack(envs, 'S', '111111111111', 'eu-west-1', false)).toEqual([]);
  });

  it('leaves a move between stacks to moveOverridesOf', () => {
    const envs2: MappingEnvironment[] = [
      { account: '1', region: 'r', resources: { 'S.Old': 'T.New', 'S.A': 'S.B' } },
      { account: '9', region: 'r', resources: { 'S.X': 'T.Y' } },
    ];
    expect(overridesForStack(envs2, 'S', '1', 'r', false)).toEqual([{ from: 'A', to: 'B' }]);
    expect(moveOverridesOf(envs2, new Set(['1']), false)).toEqual([
      { region: 'r', env: envKey('1', 'r'), fromStack: 'S', from: 'Old', toStack: 'T', to: 'New' },
    ]);
    expect(moveOverridesOf(envs2, new Set(['1']), true)).toEqual([
      { region: 'r', env: envKey('1', 'r'), fromStack: 'T', from: 'New', toStack: 'S', to: 'Old' },
    ]);
  });
});
