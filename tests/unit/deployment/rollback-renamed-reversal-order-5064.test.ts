/**
 * go-to-k/cdkd#5064 phase 2: a replaced auto-named resource gets a NEW name,
 * so reversing its replacement brings the old resource back under a name the
 * new one does not hold. The ops that moved onto the new resource (a managed
 * policy's `Roles`, an inline policy's role) complete AFTER the replacement,
 * so reverse completion order reverts them first -- back to the old name,
 * which AWS no longer had: "The role with name ... cannot be found". The
 * replay now re-creates the old resource BEFORE those reverts and deletes the
 * new one only after them.
 *
 * The provider double models IAM: a policy write naming a role that does not
 * exist fails as IAM does.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  renamedReverseReplacement,
  revertReferences,
} from '../../../src/deployment/rollback-executor/plan.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const ROLE = 'AWS::IAM::Role';
const MANAGED = 'AWS::IAM::ManagedPolicy';
const INLINE = 'AWS::IAM::Policy';
const QUEUE = 'AWS::SQS::Queue';
const OLD_ROLE = 'App-Role-7b29ef5fc296';
const NEW_ROLE = 'App-Role-gen2-0a1b2c3d4e5f';
const MANAGED_ARN = 'arn:aws:iam::111122223333:policy/App-Managed';
const DOC = { Version: '2012-10-17', Statement: [] };

function record(
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  dependencies: string[] | null
): ResourceState {
  return {
    physicalId,
    resourceType,
    properties,
    attributes: {},
    ...(dependencies !== null && { dependencies }),
    provisionedBy: 'sdk',
  };
}

const roleRecord = (name: string) =>
  record(name, ROLE, { AssumeRolePolicyDocument: DOC }, []);
const managedRecord = (role: string, deps: string[] | null = ['Role']) =>
  record(MANAGED_ARN, MANAGED, { PolicyDocument: DOC, Roles: [role] }, deps);
const inlineRecord = (role: string, deps: string[] | null = ['Role']) =>
  record('App-Role-DefaultPolicy', INLINE, {
    PolicyName: 'RoleDefaultPolicy',
    PolicyDocument: DOC,
    Roles: [role],
  }, deps);

/** E1's segment, in COMPLETION order: Role, then its two dependents. */
function e1Ops(deps: string[] | null = ['Role']): CompletedOperation[] {
  return [
    {
      logicalId: 'Role',
      changeType: 'UPDATE',
      resourceType: ROLE,
      provisionedBy: 'sdk',
      physicalId: NEW_ROLE,
      previousState: roleRecord(OLD_ROLE),
      oldResourceRetained: false,
    },
    {
      logicalId: 'RoleDefaultPolicy',
      changeType: 'UPDATE',
      resourceType: INLINE,
      provisionedBy: 'sdk',
      physicalId: 'App-Role-DefaultPolicy',
      previousState: inlineRecord(OLD_ROLE, deps),
    },
    {
      logicalId: 'Managed',
      changeType: 'UPDATE',
      resourceType: MANAGED,
      provisionedBy: 'sdk',
      physicalId: MANAGED_ARN,
      previousState: managedRecord(OLD_ROLE, deps),
    },
  ];
}

/** State after the failed deploy: the new role, and both dependents on it. */
function e1State(deps: string[] | null = ['Role']): Record<string, ResourceState> {
  return {
    Role: roleRecord(NEW_ROLE),
    RoleDefaultPolicy: inlineRecord(NEW_ROLE, deps),
    Managed: managedRecord(NEW_ROLE, deps),
  };
}

/** IAM, as far as the replay can see it: which roles exist, and every call. */
function iamModel(live: string[] = [NEW_ROLE]) {
  const roles = new Set(live);
  const calls: string[] = [];
  const requireRoles = (props: Record<string, unknown>) => {
    for (const r of (props['Roles'] as string[] | undefined) ?? []) {
      if (!roles.has(r)) throw new Error(`The role with name ${r} cannot be found.`);
    }
  };
  const provider = {
    create: vi.fn(async (logicalId: string, type: string) => {
      calls.push(`create ${logicalId}`);
      if (type !== ROLE) throw new Error(`unexpected create of ${type}`);
      roles.add(OLD_ROLE);
      return { physicalId: OLD_ROLE, attributes: {} };
    }),
    update: vi.fn(
      async (logicalId: string, physicalId: string, _type: string, props: Record<string, unknown>) => {
        calls.push(`update ${logicalId} -> ${String((props['Roles'] as string[])[0])}`);
        requireRoles(props);
        return { physicalId, wasReplaced: false };
      }
    ),
    delete: vi.fn(async (logicalId: string, physicalId: string) => {
      calls.push(`delete ${logicalId} ${physicalId}`);
      roles.delete(physicalId);
    }),
  };
  const warns: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((m: string) => warns.push(m)),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  return { ctx, provider, calls, roles, warns };
}

describe('reversing a renamed replacement before its dependents revert (go-to-k/cdkd#5064)', () => {
  it("E1: re-creates the old role, reverts both dependents onto it, then deletes the new role", async () => {
    const m = iamModel();
    const state = e1State();
    const result = await replayRollback(e1Ops(), state, 'App', m.ctx);

    expect(m.calls).toEqual([
      'create Role',
      `update Managed -> ${OLD_ROLE}`,
      `update RoleDefaultPolicy -> ${OLD_ROLE}`,
      `delete Role ${NEW_ROLE}`,
    ]);
    expect(result.failures).toBe(0);
    expect(m.warns.filter((w) => w.includes('Rollback failed'))).toEqual([]);
    expect(state['Role']!.physicalId).toBe(OLD_ROLE);
    expect(state['Managed']!.properties['Roles']).toEqual([OLD_ROLE]);
    expect(state['RoleDefaultPolicy']!.properties['Roles']).toEqual([OLD_ROLE]);
    expect([...m.roles]).toEqual([OLD_ROLE]);
  });

  it('a dependent recording no dependencies keeps its slot, as before', async () => {
    // Nothing says it names Role, so no other order is overridden (#4821).
    const m = iamModel();
    const result = await replayRollback(e1Ops(null), e1State(null), 'App', m.ctx);
    expect(m.calls).toEqual([
      `update Managed -> ${OLD_ROLE}`,
      `update RoleDefaultPolicy -> ${OLD_ROLE}`,
      'create Role',
      `delete Role ${NEW_ROLE}`,
    ]);
    expect(result.failures).toBe(2);
  });

  it('an op naming nothing it replaced keeps reverse completion order', async () => {
    // A queue revert that depends on nothing runs before the role's reversal,
    // which stays at its own slot.
    const m = iamModel();
    const state: Record<string, ResourceState> = {
      Role: roleRecord(NEW_ROLE),
      Queue: record('https://sqs/q', QUEUE, { VisibilityTimeout: 60 }, []),
    };
    const ops: CompletedOperation[] = [
      e1Ops()[0]!,
      {
        logicalId: 'Queue',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        provisionedBy: 'sdk',
        physicalId: 'https://sqs/q',
        previousState: record('https://sqs/q', QUEUE, { VisibilityTimeout: 30 }, []),
      },
    ];
    m.provider.update.mockImplementation(async (logicalId: string, physicalId: string) => {
      m.calls.push(`update ${logicalId}`);
      return { physicalId, wasReplaced: false };
    });
    await replayRollback(ops, state, 'App', m.ctx);
    expect(m.calls).toEqual(['update Queue', 'create Role', `delete Role ${NEW_ROLE}`]);
  });

  it('a renamed reversal another renamed reversal names is re-created first, and deleted last', async () => {
    // Fn (old) names Role (old); both were replaced under new names.
    const FN = 'AWS::Lambda::Function';
    const m = iamModel();
    m.provider.create.mockImplementation(async (logicalId: string) => {
      m.calls.push(`create ${logicalId}`);
      if (logicalId === 'Role') m.roles.add(OLD_ROLE);
      if (logicalId === 'Fn' && !m.roles.has(OLD_ROLE)) throw new Error('role not found');
      return { physicalId: logicalId === 'Role' ? OLD_ROLE : 'fn-old', attributes: {} };
    });
    const state: Record<string, ResourceState> = {
      Role: roleRecord(NEW_ROLE),
      Fn: record('fn-new', FN, { Role: NEW_ROLE }, ['Role']),
    };
    const ops: CompletedOperation[] = [
      e1Ops()[0]!,
      {
        logicalId: 'Fn',
        changeType: 'UPDATE',
        resourceType: FN,
        provisionedBy: 'sdk',
        physicalId: 'fn-new',
        previousState: record('fn-old', FN, { Role: OLD_ROLE }, ['Role']),
        oldResourceRetained: false,
      },
    ];
    const result = await replayRollback(ops, state, 'App', m.ctx);
    expect(m.calls).toEqual([
      'create Role',
      'create Fn',
      'delete Fn fn-new',
      `delete Role ${NEW_ROLE}`,
    ]);
    expect(result.failures).toBe(0);
  });

  it("a reversal run ahead first re-creates the renamed reversal ITS old resource names", async () => {
    // Perm (old) names Fn (old), which names Role (old); Perm reverts first.
    const FN = 'AWS::Lambda::Function';
    const PERM = 'AWS::Lambda::Permission';
    const m = iamModel();
    const fns = new Set<string>(['fn-new']);
    m.provider.create.mockImplementation(async (logicalId: string) => {
      m.calls.push(`create ${logicalId}`);
      if (logicalId === 'Role') m.roles.add(OLD_ROLE);
      if (logicalId === 'Fn') {
        if (!m.roles.has(OLD_ROLE)) throw new Error('role not found');
        fns.add('fn-old');
      }
      return { physicalId: logicalId === 'Role' ? OLD_ROLE : 'fn-old', attributes: {} };
    });
    m.provider.update.mockImplementation(
      async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
        m.calls.push(`update ${logicalId}`);
        if (!fns.has(String(props['FunctionName']))) throw new Error('function not found');
        return { physicalId, wasReplaced: false };
      }
    );
    const state: Record<string, ResourceState> = {
      Role: roleRecord(NEW_ROLE),
      Fn: record('fn-new', FN, { Role: NEW_ROLE }, ['Role']),
      Perm: record('perm', PERM, { FunctionName: 'fn-new' }, ['Fn']),
    };
    const ops: CompletedOperation[] = [
      e1Ops()[0]!,
      {
        logicalId: 'Fn',
        changeType: 'UPDATE',
        resourceType: FN,
        provisionedBy: 'sdk',
        physicalId: 'fn-new',
        previousState: record('fn-old', FN, { Role: OLD_ROLE }, ['Role']),
        oldResourceRetained: false,
      },
      {
        logicalId: 'Perm',
        changeType: 'UPDATE',
        resourceType: PERM,
        provisionedBy: 'sdk',
        physicalId: 'perm',
        previousState: record('perm', PERM, { FunctionName: 'fn-old' }, ['Fn']),
      },
    ];
    const result = await replayRollback(ops, state, 'App', m.ctx);
    expect(m.calls).toEqual([
      'create Role',
      'create Fn',
      'update Perm',
      'delete Fn fn-new',
      `delete Role ${NEW_ROLE}`,
    ]);
    expect(result.failures).toBe(0);
  });

  it('a reversal that failed at its own slot is not run again ahead of a later op', async () => {
    // Role completed LAST, so it runs first and its re-create fails; the queue
    // after it names Role.
    const m = iamModel();
    m.provider.create.mockImplementation(async () => {
      m.calls.push('create Role');
      throw new Error('create rejected');
    });
    m.provider.update.mockImplementation(async (logicalId: string, physicalId: string) => {
      m.calls.push(`update ${logicalId}`);
      return { physicalId, wasReplaced: false };
    });
    const state: Record<string, ResourceState> = {
      Role: roleRecord(NEW_ROLE),
      Queue: record('https://sqs/q', QUEUE, { VisibilityTimeout: 60 }, ['Role']),
    };
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Queue',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        provisionedBy: 'sdk',
        physicalId: 'https://sqs/q',
        previousState: record('https://sqs/q', QUEUE, { VisibilityTimeout: 30 }, ['Role']),
      },
      e1Ops()[0]!,
    ];
    const result = await replayRollback(ops, state, 'App', m.ctx);
    expect(m.calls).toEqual(['create Role', 'update Queue']);
    expect(result.failures).toBe(1);
  });

  // A caller that records superseded resources (`cdkd rollback`, the automatic
  // rollback) keeps the new copy there instead of deleting it while the
  // dependents still on it have not reverted: the next deploy deletes it once
  // they moved off it. One that cannot record still deletes it, as before.
  const recording = () => ({ onSuperseded: vi.fn(), onSupersededSettled: vi.fn() });

  it('an interrupt after the early re-create deletes the new resource unless it is recorded', async () => {
    const m = iamModel();
    let interrupted = false;
    m.provider.create.mockImplementation(async () => {
      m.calls.push('create Role');
      m.roles.add(OLD_ROLE);
      interrupted = true;
      return { physicalId: OLD_ROLE, attributes: {} };
    });
    const result = await replayRollback(e1Ops(), e1State(), 'App', m.ctx, {
      isInterrupted: () => interrupted,
    });
    expect(result.interrupted).toBe(true);
    expect(m.calls).toEqual(['create Role', `delete Role ${NEW_ROLE}`]);

    m.calls.length = 0;
    m.roles.add(NEW_ROLE);
    m.roles.delete(OLD_ROLE);
    interrupted = false;
    const r = recording();
    const kept = await replayRollback(e1Ops(), e1State(), 'App', m.ctx, {
      isInterrupted: () => interrupted,
      ...r,
    });
    expect(kept.interrupted).toBe(true);
    expect(m.calls).toEqual(['create Role']);
    expect(m.roles.has(NEW_ROLE)).toBe(true);
    expect(r.onSuperseded).toHaveBeenCalledTimes(1);
    expect(r.onSupersededSettled).not.toHaveBeenCalled();
    expect(m.warns.some((w) => w.includes('the rollback was interrupted'))).toBe(true);
  });

  it.each([
    ['a caller that cannot record it: deleted at its slot', false],
    ['a caller that records it: kept for the next deploy', true],
  ])('a second replay after a partial failure completes cleanly (%s)', async (_label, records) => {
    // The first run's Managed revert fails once, so Managed still uses the new
    // role. The re-run reads Role as reverted and reverts Managed.
    const m = iamModel();
    const state = e1State();
    const r = recording();
    let failOnce = true;
    m.provider.update.mockImplementation(
      async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
        m.calls.push(`update ${logicalId}`);
        if (logicalId === 'Managed' && failOnce) {
          failOnce = false;
          throw new Error('Throttling: Rate exceeded');
        }
        for (const r of (props['Roles'] as string[]) ?? []) {
          if (!m.roles.has(r)) throw new Error(`The role with name ${r} cannot be found.`);
        }
        return { physicalId, wasReplaced: false };
      }
    );
    const first = await replayRollback(e1Ops(), state, 'App', m.ctx, records ? r : {});
    expect(first.failures).toBe(1);
    if (records) {
      expect(m.calls.some((c) => c.startsWith('delete'))).toBe(false);
      expect(m.roles.has(NEW_ROLE)).toBe(true);
      expect(r.onSuperseded).toHaveBeenCalledTimes(1);
      expect(r.onSupersededSettled).not.toHaveBeenCalled();
      expect(m.warns.some((w) => w.includes('a resource that references it did not revert'))).toBe(true);
    } else {
      expect(m.calls.at(-1)).toBe(`delete Role ${NEW_ROLE}`);
    }

    m.calls.length = 0;
    const second = await replayRollback(e1Ops(), state, 'App', m.ctx);
    expect(second.failures).toBe(0);
    expect(m.calls).toEqual(['update Managed']);
    expect(state['Managed']!.properties['Roles']).toEqual([OLD_ROLE]);
  });

  it('a dependent whose revert was SKIPPED still uses the new copy: kept, when recorded', async () => {
    const m = iamModel();
    const state = e1State();
    // An unaddressable record: its revert is skipped, never sent.
    state['Managed'] = { ...state['Managed']!, physicalId: '' };
    const r = recording();
    const result = await replayRollback(e1Ops(), state, 'App', m.ctx, r);
    expect(result.skipped).toBe(1);
    expect(m.calls.some((c) => c.startsWith('delete'))).toBe(false);
    expect(r.onSupersededSettled).not.toHaveBeenCalled();
  });

  it('a failed revert that does not use the new copy still lets it be deleted', async () => {
    const m = iamModel();
    const state = e1State();
    state['Queue'] = record('https://sqs/q', QUEUE, { V: 2 }, []);
    const ops = [
      ...e1Ops(),
      {
        logicalId: 'Queue',
        changeType: 'UPDATE' as const,
        resourceType: QUEUE,
        provisionedBy: 'sdk' as const,
        physicalId: 'https://sqs/q',
        previousState: record('https://sqs/q', QUEUE, { V: 1 }, []),
      },
    ];
    m.provider.update.mockImplementation(
      async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
        m.calls.push(`update ${logicalId}`);
        if (logicalId === 'Queue') throw new Error('queue update rejected');
        for (const role of (props['Roles'] as string[]) ?? []) {
          if (!m.roles.has(role)) throw new Error(`The role with name ${role} cannot be found.`);
        }
        return { physicalId, wasReplaced: false };
      }
    );
    const r = recording();
    const result = await replayRollback(ops, state, 'App', m.ctx, r);
    expect(result.failures).toBe(1);
    expect(m.calls.at(-1)).toBe(`delete Role ${NEW_ROLE}`);
    expect(r.onSupersededSettled).toHaveBeenCalledTimes(1);
  });

  it("re-runs over the pre-fix run's leftovers (role re-created, dependents still on the deleted new one)", async () => {
    const m = iamModel([OLD_ROLE]);
    const state = e1State();
    state['Role'] = roleRecord(OLD_ROLE);
    const result = await replayRollback(e1Ops(), state, 'App', m.ctx);
    expect(result.failures).toBe(0);
    expect(m.calls).toEqual([`update Managed -> ${OLD_ROLE}`, `update RoleDefaultPolicy -> ${OLD_ROLE}`]);
  });
});

const TOPIC = 'AWS::SNS::Topic';
const topicOp = (
  logicalId: string,
  oldId: string,
  newId: string,
  oldDeps: string[] = []
): CompletedOperation => ({
  logicalId,
  changeType: 'UPDATE',
  resourceType: TOPIC,
  provisionedBy: 'sdk',
  physicalId: newId,
  previousState: record(oldId, TOPIC, { TopicName: oldId }, oldDeps),
  oldResourceRetained: false,
});
const inPlaceOp = (logicalId: string, deps: string[]): CompletedOperation => ({
  logicalId,
  changeType: 'UPDATE',
  resourceType: QUEUE,
  provisionedBy: 'sdk',
  physicalId: `q-${logicalId}`,
  previousState: record(`q-${logicalId}`, QUEUE, { V: 1 }, deps),
});

describe('renamed reversals that stay at their slot (review of go-to-k/cdkd#5064)', () => {
  function plainModel() {
    const m = iamModel();
    (m.provider.create as ReturnType<typeof vi.fn>).mockImplementation(async (logicalId: string, _t: string, props: Record<string, unknown>) => {
      m.calls.push(`create ${logicalId}`);
      return { physicalId: String(props['TopicName'] ?? `${logicalId}-old`), attributes: {} };
    });
    m.provider.update.mockImplementation(async (logicalId: string, physicalId: string) => {
      m.calls.push(`update ${logicalId}`);
      return { physicalId, wasReplaced: false };
    });
    return m;
  }

  it('a name handed down a chain of renames: the old id another record holds is not re-created early', async () => {
    // B renamed y -> z, then A renamed x -> y, then C (naming B) updated.
    const m = plainModel();
    const state: Record<string, ResourceState> = {
      B: record('z', TOPIC, { TopicName: 'z' }, []),
      A: record('y', TOPIC, { TopicName: 'y' }, []),
      C: record('q-C', QUEUE, { V: 2 }, ['B']),
    };
    const ops = [topicOp('B', 'y', 'z'), topicOp('A', 'x', 'y'), inPlaceOp('C', ['B'])];
    const result = await replayRollback(ops, state, 'App', m.ctx);
    expect(m.calls).toEqual(['update C', 'create A', 'delete A y', 'create B', 'delete B z']);
    expect(result.failures).toBe(0);
  });

  it('an old id a pending new copy still holds is not re-created early either', async () => {
    // Same chain; C names A first, so A runs ahead and its new copy `y` waits
    // for its slot. B's old id is that `y`.
    const m = plainModel();
    const state: Record<string, ResourceState> = {
      B: record('z', TOPIC, { TopicName: 'z' }, []),
      A: record('y', TOPIC, { TopicName: 'y' }, []),
      C: record('q-C', QUEUE, { V: 2 }, ['A', 'B']),
    };
    const ops = [topicOp('B', 'y', 'z'), topicOp('A', 'x', 'y'), inPlaceOp('C', ['A', 'B'])];
    await replayRollback(ops, state, 'App', m.ctx);
    expect(m.calls).toEqual(['create A', 'update C', 'delete A y', 'create B', 'delete B z']);
  });

  it('the deferred delete skips a new id a record took meanwhile', async () => {
    // A runs ahead (C names it); B, at its slot before A's, re-creates `y`,
    // the id A's pending new copy has.
    const m = plainModel();
    const state: Record<string, ResourceState> = {
      A: record('y', TOPIC, { TopicName: 'y' }, []),
      B: record('z', TOPIC, { TopicName: 'z' }, []),
      C: record('q-C', QUEUE, { V: 2 }, ['A']),
    };
    const ops = [topicOp('A', 'x', 'y'), topicOp('B', 'y', 'z'), inPlaceOp('C', ['A'])];
    const events: Array<Record<string, unknown>> = [];
    const ctx = { ...m.ctx, recordEvent: (e: Record<string, unknown>) => events.push(e) } as RollbackExecutorContext;
    const result = await replayRollback(ops, state, 'App', ctx);
    expect(m.calls).toEqual(['create A', 'update C', 'create B', 'delete B z']);
    expect(
      events.some((e) => e['logicalId'] === 'A' && String(e['reason']).includes('now holds its physical id'))
    ).toBe(true);
    expect(state['B']!.physicalId).toBe('y');
    expect(m.warns.some((w) => w.includes('now holds its physical id'))).toBe(true);
    expect(result.warnings).toBe(1);
  });

  it('an op it names reverting AFTER its slot does not keep it at its slot', async () => {
    const m = plainModel();
    const state: Record<string, ResourceState> = {
      Y: record('q-Y', QUEUE, { V: 2 }, []),
      R: record('r-new', TOPIC, { TopicName: 'r-new' }, ['Y']),
      X: record('q-X', QUEUE, { V: 2 }, ['R']),
    };
    const ops = [inPlaceOp('Y', []), topicOp('R', 'r-old', 'r-new', ['Y']), inPlaceOp('X', ['R'])];
    await replayRollback(ops, state, 'App', m.ctx);
    expect(m.calls).toEqual(['create R', 'update X', 'delete R r-new', 'update Y']);
  });

  it("one whose old record names an op still to revert keeps its slot, after that op", async () => {
    // R's old record names Y (in place), which reverts between X and R.
    const m = plainModel();
    const state: Record<string, ResourceState> = {
      R: record('r-new', TOPIC, { TopicName: 'r-new' }, ['Y']),
      Y: record('q-Y', QUEUE, { V: 2 }, []),
      X: record('q-X', QUEUE, { V: 2 }, ['R']),
    };
    const ops = [topicOp('R', 'r-old', 'r-new', ['Y']), inPlaceOp('Y', []), inPlaceOp('X', ['R'])];
    await replayRollback(ops, state, 'App', m.ctx);
    expect(m.calls).toEqual(['update X', 'update Y', 'create R', 'delete R r-new']);
  });
});

describe('the deferred delete of the new resource (review of go-to-k/cdkd#5064)', () => {
  it('a failed deferred delete warns once and names the survivor in the closing event, after the dependents', async () => {
    const m = iamModel();
    m.provider.delete.mockImplementation(async (logicalId: string, physicalId: string) => {
      m.calls.push(`delete ${logicalId} ${physicalId}`);
      throw new Error('DeleteConflict');
    });
    const events: Array<Record<string, unknown>> = [];
    const ctx = { ...m.ctx, recordEvent: (e: Record<string, unknown>) => events.push(e) } as RollbackExecutorContext;
    const result = await replayRollback(e1Ops(), e1State(), 'App', ctx);
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(1);
    const succeeded = events.filter((e) => e['eventType'] === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded.map((e) => e['logicalId'])).toEqual(['Managed', 'RoleDefaultPolicy', 'Role']);
    const role = succeeded.at(-1)!;
    expect(role['physicalId']).toBe(NEW_ROLE);
    expect(String(role['reason'])).toContain('could not be deleted');
  });

  it('a new copy UpdateReplacePolicy: Retain keeps is not deferred: re-created early, nothing deleted', async () => {
    const m = iamModel();
    const state = e1State();
    state['Role'] = { ...state['Role']!, updateReplacePolicy: 'Retain' };
    const infos: string[] = [];
    (m.ctx.logger.info as unknown as ReturnType<typeof vi.fn>).mockImplementation((l: string) => infos.push(l));
    await replayRollback(e1Ops(), state, 'App', m.ctx);
    expect(m.calls).toEqual(['create Role', `update Managed -> ${OLD_ROLE}`, `update RoleDefaultPolicy -> ${OLD_ROLE}`]);
    expect(infos.some((l) => l.includes('re-created first'))).toBe(false);
  });

  it('records the new copy as superseded before the save that drops its record, and settles it after the delete', async () => {
    const m = iamModel();
    const state = e1State();
    const log: string[] = [];
    let pending: string[] = [];
    await replayRollback(e1Ops(), state, 'App', m.ctx, {
      onSuperseded: (entry) => {
        log.push(`superseded ${entry.state.physicalId}`);
        pending = [...pending, entry.state.physicalId];
      },
      onSupersededSettled: (entry) => {
        log.push(`settled ${entry.state.physicalId}`);
        pending = pending.filter((id) => id !== entry.state.physicalId);
      },
      afterOp: (id) => {
        log.push(`save ${id}:${state['Role']!.physicalId} pending=${pending.join(',')}`);
      },
    });
    expect(log).toEqual([
      `superseded ${NEW_ROLE}`,
      `save Role:${OLD_ROLE} pending=${NEW_ROLE}`,
      `save Managed:${OLD_ROLE} pending=${NEW_ROLE}`,
      `save RoleDefaultPolicy:${OLD_ROLE} pending=${NEW_ROLE}`,
      `settled ${NEW_ROLE}`,
      `save Role:${OLD_ROLE} pending=`,
    ]);
    expect(m.calls.at(-1)).toBe(`delete Role ${NEW_ROLE}`);
  });

  it('a failed deferred delete keeps the superseded entry for the next deploy', async () => {
    const m = iamModel();
    m.provider.delete.mockRejectedValue(new Error('DeleteConflict'));
    const onSuperseded = vi.fn();
    const onSupersededSettled = vi.fn();
    await replayRollback(e1Ops(), e1State(), 'App', m.ctx, { onSuperseded, onSupersededSettled });
    expect(onSuperseded).toHaveBeenCalledTimes(1);
    expect(onSupersededSettled).not.toHaveBeenCalled();
    expect(m.warns.some((w) => w.includes('next `cdkd deploy`'))).toBe(true);
  });

  it('a new copy a later run could not delete the same way is not recorded', async () => {
    const m = iamModel();
    const state = e1State();
    state['Role'] = { ...state['Role']!, noEchoLeaves: [['X']] } as ResourceState;
    const onSuperseded = vi.fn();
    await replayRollback(e1Ops(), state, 'App', m.ctx, { onSuperseded });
    expect(onSuperseded).not.toHaveBeenCalled();
    expect(m.calls.at(-1)).toBe(`delete Role ${NEW_ROLE}`);
  });
});

describe('renamedReverseReplacement / revertReferences', () => {
  const [role, inline] = e1Ops();
  it('selects only a renamed create-first reversal', () => {
    const state = e1State();
    expect(renamedReverseReplacement(role!, state, new Set())).toBe(true);
    expect(renamedReverseReplacement(inline!, state, new Set())).toBe(false);
    expect(renamedReverseReplacement({ ...role!, oldDeletedBeforeCreate: true }, state, new Set())).toBe(false);
    expect(renamedReverseReplacement({ ...role!, oldResourceMaySurvive: 'unconfirmed' } as CompletedOperation, state, new Set())).toBe(false);
    expect(renamedReverseReplacement(role!, state, new Set(['Role']))).toBe(false);
    expect(renamedReverseReplacement(role!, { ...state, Role: roleRecord(OLD_ROLE) }, new Set())).toBe(false);
    expect(renamedReverseReplacement(role!, { ...state, Other: roleRecord(OLD_ROLE) }, new Set())).toBe(false);
  });
  it('reads both records; a record listing none adds none', () => {
    expect([...revertReferences(inline!, e1State())]).toEqual(['Role']);
    expect([...revertReferences(e1Ops(null)[1]!, e1State(null))]).toEqual([]);
    const state = e1State();
    state['RoleDefaultPolicy']!.dependencies = ['Other'];
    expect([...revertReferences(e1Ops(null)[1]!, state)]).toEqual(['Other']);
    expect([...revertReferences(inline!, state)]).toEqual(['Role', 'Other']);
  });
});
