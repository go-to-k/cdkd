/**
 * go-to-k/cdkd#4821: a standalone `AWS::IAM::RolePolicy` / `GroupPolicy` /
 * `UserPolicy` (Cloud Control) joins the inline-policy claim model: it claims
 * its one name on its principal once its write COMPLETED, its delete leaves a
 * name another completed writer holds, and a same-deploy collision with an
 * `AWS::IAM::Policy` or a principal's `Policies` orders that writer first.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  inlinePolicyHolders,
  isInlinePolicyClaimedByCompletedWriter,
  orderInlinePolicyReversals,
  orderInlinePolicyWriters,
  RollbackInlinePolicyWriters,
  standaloneInlinePolicyHandedOff,
  type InlinePolicyWrite,
} from '../../../src/deployment/inline-policy-claims.js';
import type {
  InlinePolicyPrincipalKind,
  TemplateResource,
} from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';
import { collectInlinePolicyNamesManagedBySiblings } from '../../../src/provisioning/providers/iam-role-provider.js';

const DOC = { Version: '2012-10-17', Statement: [] };

const KINDS = [
  ['AWS::IAM::RolePolicy', 'role', 'RoleName'],
  ['AWS::IAM::GroupPolicy', 'group', 'GroupName'],
  ['AWS::IAM::UserPolicy', 'user', 'UserName'],
] as const;

const standaloneRecord = (
  type: string,
  principalField: string,
  principal: unknown,
  name: unknown
): ResourceState =>
  ({
    physicalId: `${String(name)}|${String(principal)}`,
    resourceType: type,
    properties: { PolicyName: name, [principalField]: principal, PolicyDocument: DOC },
    provisionedBy: 'cc-api',
  }) as ResourceState;

function claimed(
  state: Record<string, ResourceState>,
  writers: Array<[string, InlinePolicyWrite]>,
  query: [InlinePolicyPrincipalKind, string, string]
): boolean {
  return isInlinePolicyClaimedByCompletedWriter(
    { selfLogicalId: 'Self', writers: new Map(writers), changes: new Map(), stateResources: state },
    ...query
  );
}

describe('the claim predicate reads a standalone inline policy writer (go-to-k/cdkd#4821)', () => {
  it.each(KINDS)(
    'a completed %s writer claims its name on its principal, though routed through Cloud Control',
    (type, kind, field) => {
      const W = standaloneRecord(type, field, 'p', 'x');
      expect(claimed({ W }, [['W', 'create']], [kind, 'p', 'x'])).toBe(true);
      expect(claimed({ W }, [['W', 'update']], [kind, 'P', 'X'])).toBe(true);
    }
  );

  it.each(KINDS)('a %s record that is NOT a completed writer claims nothing', (type, kind, field) => {
    const W = standaloneRecord(type, field, 'p', 'x');
    expect(claimed({ W }, [], [kind, 'p', 'x'])).toBe(false);
  });

  it('claims nothing for another name, another principal, or another principal kind', () => {
    const W = standaloneRecord('AWS::IAM::RolePolicy', 'RoleName', 'p', 'x');
    expect(claimed({ W }, [['W', 'create']], ['role', 'p', 'y'])).toBe(false);
    expect(claimed({ W }, [['W', 'create']], ['role', 'q', 'x'])).toBe(false);
    expect(claimed({ W }, [['W', 'create']], ['user', 'p', 'x'])).toBe(false);
  });

  it('a redacted or non-string name or principal claims nothing (fail toward the removal)', () => {
    for (const [principal, name] of [
      ['***', 'x'],
      ['p', '{{resolve:secretsmanager:s}}'],
      [{ Ref: 'Role' }, 'x'],
      ['p', undefined],
    ] as const) {
      const W = standaloneRecord('AWS::IAM::RolePolicy', 'RoleName', principal, name);
      expect(claimed({ W }, [['W', 'create']], ['role', 'p', 'x'])).toBe(false);
    }
  });

  it('a standalone writer never claims against itself', () => {
    const Self = standaloneRecord('AWS::IAM::RolePolicy', 'RoleName', 'p', 'x');
    expect(claimed({ Self }, [['Self', 'create']], ['role', 'p', 'x'])).toBe(false);
  });
});

describe('standaloneInlinePolicyHandedOff (go-to-k/cdkd#4821)', () => {
  const props = { RoleName: 'p', PolicyName: 'y', PolicyDocument: DOC };

  it('answers true only when the predicate claims the exact (kind, principal, name)', () => {
    const seen: unknown[] = [];
    const yes = (...q: unknown[]) => {
      seen.push(q);
      return true;
    };
    expect(standaloneInlinePolicyHandedOff('AWS::IAM::RolePolicy', props, yes)).toBe(true);
    expect(seen).toEqual([['role', 'p', 'y']]);
    expect(
      standaloneInlinePolicyHandedOff(
        'AWS::IAM::UserPolicy',
        { UserName: 'u', PolicyName: 'y' },
        (...q) => JSON.stringify(q) === JSON.stringify(['user', 'u', 'y'])
      )
    ).toBe(true);
  });

  it('answers false (the delete proceeds) when not claimed, unreadable, unasked or another type', () => {
    expect(standaloneInlinePolicyHandedOff('AWS::IAM::RolePolicy', props, () => false)).toBe(false);
    expect(standaloneInlinePolicyHandedOff('AWS::IAM::RolePolicy', props, undefined)).toBe(false);
    expect(
      standaloneInlinePolicyHandedOff(
        'AWS::IAM::RolePolicy',
        { RoleName: '***', PolicyName: 'y' },
        () => true
      )
    ).toBe(false);
    expect(
      standaloneInlinePolicyHandedOff('AWS::IAM::RolePolicy', { PolicyName: 'y' }, () => true)
    ).toBe(false);
    expect(standaloneInlinePolicyHandedOff('AWS::IAM::RolePolicy', undefined, () => true)).toBe(
      false
    );
    expect(standaloneInlinePolicyHandedOff('AWS::IAM::Policy', props, () => true)).toBe(false);
    // A physical id naming another policy (Cloud Control's `<name>|<principal>`).
    expect(standaloneInlinePolicyHandedOff('AWS::IAM::RolePolicy', props, () => true, 'z|p')).toBe(
      false
    );
    expect(standaloneInlinePolicyHandedOff('AWS::IAM::RolePolicy', props, () => true, 'Y|P')).toBe(
      true
    );
  });
});

describe('inlinePolicyHolders reads a standalone record (go-to-k/cdkd#4821)', () => {
  it('holds its name on its principal, and an unreadable one is named', () => {
    const state = {
      A: standaloneRecord('AWS::IAM::RolePolicy', 'RoleName', 'p', 'x'),
      B: standaloneRecord('AWS::IAM::RolePolicy', 'RoleName', '***', 'x'),
      C: standaloneRecord('AWS::IAM::RolePolicy', 'RoleName', 'p', 'other'),
      D: standaloneRecord('AWS::IAM::UserPolicy', 'UserName', 'p', 'x'),
    };
    expect(inlinePolicyHolders(state, 'role', 'p', 'x')).toEqual({
      holders: [{ logicalId: 'A', principal: 'p', policyName: 'x', document: DOC }],
      unreadable: ['B'],
    });
  });
});

describe('RollbackInlinePolicyWriters counts a standalone write routed through Cloud Control (go-to-k/cdkd#4821)', () => {
  it('a completed standalone revert claims its name; a principal routed through Cloud Control still does not', () => {
    const writers = new RollbackInlinePolicyWriters();
    const W = standaloneRecord('AWS::IAM::RolePolicy', 'RoleName', 'p', 'x');
    const R = {
      physicalId: 'p',
      resourceType: 'AWS::IAM::Role',
      properties: { Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
    } as ResourceState;
    const state: Record<string, ResourceState> = { W, R };
    writers.record('W', 'create', W, false, 'cc-api');
    writers.record('R', 'create', R, true, 'cc-api');
    const ask = writers.claimedFor('AWS::IAM::RolePolicy', 'Self', state)!;
    expect(ask).toBeDefined();
    expect(ask('role', 'p', 'x')).toBe(true);
    // Only R would claim this one, and R's Cloud Control write is not counted.
    delete state['W'];
    expect(ask('role', 'p', 'x')).toBe(false);
  });

  it('hands every standalone type a predicate, and still none to an unrelated type', () => {
    const writers = new RollbackInlinePolicyWriters();
    for (const [type] of KINDS) expect(writers.claimedFor(type, 'Self', {})).toBeDefined();
    expect(writers.claimedFor('AWS::S3::Bucket', 'Self', {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

interface Row {
  change: ResourceChange;
  template: TemplateResource;
  record?: ResourceState;
}

function policyRow(id: string, from: string | undefined, to: string): [string, Row] {
  return [
    id,
    {
      change: {
        logicalId: id,
        changeType: from === undefined ? 'CREATE' : 'UPDATE',
        resourceType: 'AWS::IAM::Policy',
        propertyChanges:
          from === undefined
            ? []
            : [{ path: 'PolicyName', oldValue: from, newValue: to, requiresReplacement: false }],
      },
      template: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: to, PolicyDocument: DOC, Roles: [{ Ref: 'Role' }] },
      },
      ...(from !== undefined && {
        record: {
          physicalId: from,
          resourceType: 'AWS::IAM::Policy',
          properties: { PolicyName: from, PolicyDocument: DOC, Roles: ['role-phys'] },
        },
      }),
    },
  ];
}

function standaloneRow(
  id: string,
  from: string | undefined,
  to: string,
  opts: { type?: string; principalField?: string; principal?: unknown; kind?: string } = {}
): [string, Row] {
  const type = opts.type ?? 'AWS::IAM::RolePolicy';
  const field = opts.principalField ?? 'RoleName';
  return [
    id,
    {
      change: {
        logicalId: id,
        changeType: from === undefined ? 'CREATE' : 'UPDATE',
        resourceType: type,
        propertyChanges:
          from === undefined
            ? []
            : [{ path: 'PolicyName', oldValue: from, newValue: to, requiresReplacement: true }],
      },
      template: {
        Type: type,
        Properties: {
          PolicyName: to,
          PolicyDocument: DOC,
          [field]: opts.principal ?? { Ref: 'Role' },
        },
      },
      ...(from !== undefined && {
        record: standaloneRecord(type, field, 'role-phys', from),
      }),
    },
  ];
}

function run(
  rows: Array<[string, Row]>,
  opts: { levels?: Record<string, number>; deps?: Record<string, string[]> } = {}
) {
  const changes = new Map(rows.map(([id, r]) => [id, r.change]));
  const templateResources: Record<string, TemplateResource> = {
    Role: { Type: 'AWS::IAM::Role', Properties: {} },
  };
  const stateResources: Record<string, ResourceState> = {
    Role: { physicalId: 'role-phys', resourceType: 'AWS::IAM::Role', properties: {} },
  };
  for (const [id, r] of rows) {
    templateResources[id] = r.template;
    if (r.record) stateResources[id] = r.record;
  }
  const dependencies = new Map<string, Set<string>>(
    rows.map(([id]) => [id, new Set(opts.deps?.[id] ?? [])])
  );
  const edges = orderInlinePolicyWriters({
    writes: rows.map(([id]) => id),
    changes,
    templateResources,
    stateResources,
    dependencies,
    rank: (id) => opts.levels?.[id] ?? 0,
  });
  return { edges, dependencies };
}

describe('orderInlinePolicyWriters with a standalone inline policy (go-to-k/cdkd#4821)', () => {
  it('orders the AWS::IAM::Policy BEFORE the RolePolicy in a swap, whatever their ids and levels', () => {
    // `A` sorts first and sits on a lower level, so the #4227 rule alone
    // would have put the RolePolicy first.
    expect(run([standaloneRow('A', 'y', 'x'), policyRow('B', 'x', 'y')]).edges).toEqual([
      { before: 'B', after: 'A' },
    ]);
    expect(
      run([standaloneRow('A', 'y', 'x'), policyRow('B', 'x', 'y')], { levels: { A: 0, B: 3 } })
        .edges
    ).toEqual([{ before: 'B', after: 'A' }]);
  });

  it('orders a policy releasing a name before a RolePolicy CREATE taking it', () => {
    expect(run([policyRow('A', 'x', 'y'), standaloneRow('B', undefined, 'x')]).edges).toEqual([
      { before: 'A', after: 'B' },
    ]);
  });

  it('orders a principal dropping a name from its Policies before a RolePolicy taking it', () => {
    const role: [string, Row] = [
      'Role',
      {
        change: {
          logicalId: 'Role',
          changeType: 'UPDATE',
          resourceType: 'AWS::IAM::Role',
          propertyChanges: [
            { path: 'Policies', oldValue: [], newValue: [], requiresReplacement: false },
          ],
        },
        template: {
          Type: 'AWS::IAM::Role',
          Properties: { RoleName: 'role-phys', Policies: [{ PolicyName: 'y', PolicyDocument: DOC }] },
        },
        record: {
          physicalId: 'role-phys',
          resourceType: 'AWS::IAM::Role',
          properties: { Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
        },
      },
    ];
    const rp = standaloneRow('Attach', undefined, 'x', { principal: 'role-phys' });
    expect(run([rp, role]).edges).toEqual([{ before: 'Role', after: 'Attach' }]);
  });

  it.each([
    ['AWS::IAM::UserPolicy', 'UserName', 'Users'],
    ['AWS::IAM::GroupPolicy', 'GroupName', 'Groups'],
  ])('orders the same swap for an %s', (type, field, listField) => {
    const policy = policyRow('B', 'x', 'y');
    policy[1].template.Properties = {
      PolicyName: 'y',
      PolicyDocument: DOC,
      [listField]: ['p'],
    };
    policy[1].record!.properties = { PolicyName: 'x', PolicyDocument: DOC, [listField]: ['p'] };
    const standalone = standaloneRow('A', 'y', 'x', { type, principalField: field, principal: 'p' });
    standalone[1].record = standaloneRecord(type, field, 'p', 'y');
    expect(run([standalone, policy]).edges).toEqual([{ before: 'B', after: 'A' }]);
  });

  it('adds nothing when the RolePolicy and the policy share no name (the ordinary deploy)', () => {
    const { edges, dependencies } = run([
      standaloneRow('A', 'a', 'a2'),
      policyRow('B', 'b', 'b2'),
      standaloneRow('C', undefined, 'c'),
    ]);
    expect(edges).toEqual([]);
    expect([...dependencies.values()].every((d) => d.size === 0)).toBe(true);
  });

  it('adds nothing for one name on two DIFFERENT roles', () => {
    expect(
      run([standaloneRow('A', undefined, 'x', { principal: 'other-role' }), policyRow('B', 'x', 'y')])
        .edges
    ).toEqual([]);
  });

  it('adds no edge that would close a cycle: an existing dependency the other way stands', () => {
    const { edges, dependencies } = run(
      [standaloneRow('A', 'y', 'x'), policyRow('B', 'x', 'y')],
      { deps: { B: ['A'] } }
    );
    expect(edges).toEqual([]);
    expect([...dependencies.get('A')!]).toEqual([]);
  });

  it('two RolePolicies SWAPPING names keep the #4227 rank order (each releases what the other takes)', () => {
    expect(
      run([standaloneRow('B', 'y', 'x'), standaloneRow('A', 'x', 'y')], { levels: { A: 0, B: 0 } })
        .edges
    ).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('of two RolePolicies, the one replaced AWAY from a name the other creates goes first, whatever the ids', () => {
    // `A` replaced x -> y releases `x`, which the new `B` takes; `B` sorts
    // after `A` here and before it below.
    expect(run([standaloneRow('A', 'x', 'y'), standaloneRow('B', undefined, 'x')]).edges).toEqual([
      { before: 'A', after: 'B' },
    ]);
    expect(run([standaloneRow('Z', 'x', 'y'), standaloneRow('B', undefined, 'x')]).edges).toEqual([
      { before: 'Z', after: 'B' },
    ]);
  });

  it("a replacement changing BOTH its role and its name claims only (new role, new name) and (old role, old name)", () => {
    // `A` moves from role-phys/x to other-role/y. A policy taking `y` on
    // role-phys, or `x` on other-role, shares no pair with it.
    const moved = standaloneRow('A', 'x', 'y', { principal: 'other-role' });
    const onRoleY = policyRow('B', undefined, 'y');
    expect(run([moved, onRoleY]).edges).toEqual([]);
    // Its OLD pair still collides: a policy taking `x` on role-phys waits for it.
    const onRoleX = policyRow('C', undefined, 'x');
    expect(run([moved, onRoleX]).edges).toEqual([{ before: 'C', after: 'A' }]);
  });
});

describe('orderInlinePolicyReversals (go-to-k/cdkd#4821)', () => {
  const pol = (name: string, roles: unknown = ['p']): ResourceState => ({
    physicalId: name,
    resourceType: 'AWS::IAM::Policy',
    properties: { PolicyName: name, PolicyDocument: DOC, Roles: roles },
  });
  const rp = (name: string, deps?: string[]): ResourceState => ({
    ...standaloneRecord('AWS::IAM::RolePolicy', 'RoleName', 'p', name),
    ...(deps && { dependencies: deps }),
  });
  const op = (logicalId: string, previousState: ResourceState) => ({ logicalId, previousState });
  const ids = (ops: Array<{ logicalId: string }>) => ops.map((o) => o.logicalId);

  it('moves a standalone reversal after the colliding policy reversal it preceded', () => {
    const state = { S: rp('x'), P: pol('y'), Q: pol('q') };
    const replay = [op('S', rp('y')), op('Q', pol('q0')), op('P', pol('x'))];
    expect(ids(orderInlinePolicyReversals(replay, state))).toEqual(['Q', 'P', 'S']);
  });

  it('moves it after a colliding principal reversal too', () => {
    const role = (names: string[]): ResourceState => ({
      physicalId: 'p',
      resourceType: 'AWS::IAM::Role',
      properties: { Policies: names.map((PolicyName) => ({ PolicyName, PolicyDocument: DOC })) },
    });
    const state = { S: rp('x'), R: role(['y']) };
    expect(ids(orderInlinePolicyReversals([op('S', rp('y')), op('R', role(['x']))], state))).toEqual([
      'R',
      'S',
    ]);
  });

  it('keeps the order with no collision, no standalone op, or a dependency between the two', () => {
    expect(
      ids(orderInlinePolicyReversals([op('S', rp('a')), op('P', pol('b'))], { S: rp('c'), P: pol('d') }))
    ).toEqual(['S', 'P']);
    expect(
      ids(orderInlinePolicyReversals([op('A', pol('x')), op('B', pol('y'))], { A: pol('y'), B: pol('x') }))
    ).toEqual(['A', 'B']);
    expect(
      ids(
        orderInlinePolicyReversals([op('S', rp('y', ['P'])), op('P', pol('x'))], {
          S: rp('x', ['P']),
          P: pol('y'),
        })
      )
    ).toEqual(['S', 'P']);
    // Another principal: no collision.
    expect(
      ids(orderInlinePolicyReversals([op('S', rp('y')), op('P', pol('x', ['other']))], {
        S: rp('x'),
        P: pol('y', ['other']),
      }))
    ).toEqual(['S', 'P']);
  });

  it('an unreadable principal on the other writer collides (over-approximates toward ordering)', () => {
    const state = { S: rp('x'), P: pol('y', ['***']) };
    expect(ids(orderInlinePolicyReversals([op('S', rp('y')), op('P', pol('x', ['***']))], state))).toEqual(
      ['P', 'S']
    );
  });

  it('never moves a standalone reversal past an op it has a dependency with, colliding or not', () => {
    const fn: ResourceState = { physicalId: 'fn', resourceType: 'AWS::Lambda::Function', properties: {} };
    // S depends on F (a non-writer) between it and the colliding P: S stays.
    expect(
      ids(
        orderInlinePolicyReversals([op('S', rp('y', ['F'])), op('F', fn), op('P', pol('x'))], {
          S: rp('x', ['F']),
          F: fn,
          P: pol('y'),
        })
      )
    ).toEqual(['S', 'F', 'P']);
    // Without the dependency it moves past F to after P.
    expect(
      ids(
        orderInlinePolicyReversals([op('S', rp('y')), op('F', fn), op('P', pol('x'))], {
          S: rp('x'),
          F: fn,
          P: pol('y'),
        })
      )
    ).toEqual(['F', 'P', 'S']);
  });

  it('two standalone reversals colliding with one policy reversal both follow it, in their order', () => {
    // P renamed y -> x: its new name collides with S1's, its old one with S2's.
    const state = { S1: rp('x'), S2: rp('y'), P: pol('x') };
    expect(
      ids(
        orderInlinePolicyReversals(
          [op('S1', rp('z')), op('S2', rp('w')), op('P', pol('y'))],
          state
        )
      )
    ).toEqual(['P', 'S1', 'S2']);
  });

  it('never reorders two standalone reversals against each other', () => {
    const state = { A: rp('x'), B: rp('y') };
    expect(ids(orderInlinePolicyReversals([op('A', rp('y')), op('B', rp('x'))], state))).toEqual([
      'A',
      'B',
    ]);
  });
});

describe('collectInlinePolicyNamesManagedBySiblings counts standalone siblings (go-to-k/cdkd#4821)', () => {
  it.each([
    ['Roles', 'AWS::IAM::RolePolicy', 'RoleName'],
    ['Users', 'AWS::IAM::UserPolicy', 'UserName'],
    ['Groups', 'AWS::IAM::GroupPolicy', 'GroupName'],
  ] as const)('%s: the %s naming this principal is excluded; one naming another is not', (field, type, nameField) => {
    const siblings = {
      Mine: { resourceType: type, properties: { PolicyName: 'mine', [nameField]: 'me' } },
      Theirs: { resourceType: type, properties: { PolicyName: 'theirs', [nameField]: 'them' } },
    };
    expect([...collectInlinePolicyNamesManagedBySiblings('me', { siblings }, field)]).toEqual(['mine']);
  });
});
