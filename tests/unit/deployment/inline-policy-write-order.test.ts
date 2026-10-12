/**
 * go-to-k/cdkd#4227: `orderInlinePolicyWriters` adds a dependency edge between
 * exactly the create / update rows that write the same inline policy name on
 * the same IAM principal, and never one that closes a cycle.
 */
import { describe, it, expect } from 'vite-plus/test';
import { orderInlinePolicyWriters } from '../../../src/deployment/inline-policy-claims.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

const POLICY = 'AWS::IAM::Policy';
const ROLE = 'AWS::IAM::Role';
const DOC = { Version: '2012-10-17', Statement: [] };

interface Row {
  change: ResourceChange;
  template?: TemplateResource;
  record?: ResourceState;
}

function policyRow(
  id: string,
  opts: {
    to: unknown;
    from?: string;
    roles?: unknown;
    recordedRoles?: unknown;
    changeType?: 'CREATE' | 'UPDATE';
    replace?: boolean;
  }
): [string, Row] {
  const changeType = opts.changeType ?? (opts.from === undefined ? 'CREATE' : 'UPDATE');
  return [
    id,
    {
      change: {
        logicalId: id,
        changeType,
        resourceType: POLICY,
        propertyChanges:
          changeType === 'UPDATE'
            ? [
                {
                  path: 'PolicyName',
                  oldValue: opts.from,
                  newValue: opts.to,
                  requiresReplacement: opts.replace ?? false,
                },
              ]
            : [],
      },
      template: {
        Type: POLICY,
        Properties: { PolicyName: opts.to, PolicyDocument: DOC, Roles: opts.roles ?? [{ Ref: 'Role' }] },
      },
      ...(opts.from !== undefined && {
        record: {
          physicalId: opts.from,
          resourceType: POLICY,
          properties: {
            PolicyName: opts.from,
            PolicyDocument: DOC,
            Roles: opts.recordedRoles ?? ['role-phys'],
          },
        },
      }),
    },
  ];
}

const roleRecord: ResourceState = { physicalId: 'role-phys', resourceType: ROLE, properties: {} };

function run(
  rows: Array<[string, Row]>,
  opts: {
    deps?: Record<string, string[]>;
    levels?: Record<string, number>;
    extraTemplate?: Record<string, TemplateResource>;
    extraState?: Record<string, ResourceState>;
  } = {}
) {
  const changes = new Map(rows.map(([id, r]) => [id, r.change]));
  const templateResources: Record<string, TemplateResource> = {
    Role: { Type: ROLE, Properties: {} },
    ...opts.extraTemplate,
  };
  const stateResources: Record<string, ResourceState> = { Role: roleRecord, ...opts.extraState };
  for (const [id, r] of rows) {
    if (r.template) templateResources[id] = r.template;
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

/** Throws when `deps` has a cycle; returns a topological order otherwise. */
function topo(deps: Map<string, Set<string>>): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new Error(`cycle through ${id}`);
    state.set(id, 'visiting');
    for (const d of deps.get(id) ?? []) visit(d);
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of deps.keys()) visit(id);
  return order;
}

describe('orderInlinePolicyWriters (go-to-k/cdkd#4227)', () => {
  it('orders an unordered swap of two policy names on one role', () => {
    const { edges, dependencies } = run([
      policyRow('A', { from: 'x', to: 'y' }),
      policyRow('B', { from: 'y', to: 'x' }),
    ]);
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
    expect([...dependencies.get('B')!]).toEqual(['A']);
    expect([...dependencies.get('A')!]).toEqual([]);
  });

  it('orders a rename away from a name beside a create taking it', () => {
    const { edges } = run([
      policyRow('A', { from: 'x', to: 'y' }),
      policyRow('B', { to: 'x', changeType: 'CREATE' }),
    ]);
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('orders a replacement beside an update of the same name', () => {
    const { edges } = run([
      policyRow('A', { from: 'x', to: 'y', replace: true }),
      policyRow('B', { from: 'y', to: 'x' }),
    ]);
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('adds nothing for policies with distinct names on one role (the ordinary deploy)', () => {
    const { edges, dependencies } = run([
      policyRow('A', { from: 'a', to: 'a2' }),
      policyRow('B', { from: 'b', to: 'b2' }),
      policyRow('C', { to: 'c' }),
    ]);
    expect(edges).toEqual([]);
    expect([...dependencies.values()].every((d) => d.size === 0)).toBe(true);
  });

  it('adds nothing for one name on two DIFFERENT roles', () => {
    const { edges } = run(
      [
        policyRow('A', { from: 'x', to: 'y' }),
        policyRow('B', { from: 'y', to: 'x', roles: [{ Ref: 'Other' }], recordedRoles: ['other-phys'] }),
      ],
      {
        extraTemplate: { Other: { Type: ROLE, Properties: {} } },
        extraState: { Other: { physicalId: 'other-phys', resourceType: ROLE, properties: {} } },
      }
    );
    expect(edges).toEqual([]);
  });

  it('adds nothing for one name on a role and a USER of the same name', () => {
    const { edges } = run([
      policyRow('A', { from: 'x', to: 'y', roles: ['same'], recordedRoles: ['same'] }),
      [
        'B',
        {
          change: { logicalId: 'B', changeType: 'CREATE', resourceType: POLICY, propertyChanges: [] },
          template: { Type: POLICY, Properties: { PolicyName: 'x', PolicyDocument: DOC, Users: ['same'] } },
        },
      ],
    ]);
    expect(edges).toEqual([]);
  });

  it('adds nothing when the template already orders the pair, directly or transitively', () => {
    const direct = run(
      [policyRow('A', { from: 'x', to: 'y' }), policyRow('B', { from: 'y', to: 'x' })],
      { deps: { A: ['B'] } }
    );
    expect(direct.edges).toEqual([]);
    expect([...direct.dependencies.get('B')!]).toEqual([]);

    const transitive = run(
      [
        policyRow('A', { from: 'x', to: 'y' }),
        policyRow('B', { from: 'y', to: 'x' }),
        policyRow('M', { from: 'm', to: 'm2' }),
      ],
      { deps: { B: ['M'], M: ['A'] } }
    );
    expect(transitive.edges).toEqual([]);
  });

  it('matches a Ref to the role against its recorded physical name, case-insensitively', () => {
    const { edges } = run([
      policyRow('A', { from: 'X', to: 'y', roles: ['ROLE-PHYS'], recordedRoles: ['Role-Phys'] }),
      policyRow('B', { to: 'x', changeType: 'CREATE' }),
    ]);
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('matches a Ref to a role this deploy creates by its logical id', () => {
    const { edges } = run(
      [
        policyRow('A', { to: 'x', changeType: 'CREATE', roles: [{ Ref: 'NewRole' }] }),
        policyRow('B', { to: 'x', changeType: 'CREATE', roles: [{ Ref: 'NewRole' }] }),
      ],
      { extraTemplate: { NewRole: { Type: ROLE, Properties: {} } } }
    );
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('treats a name it cannot read before resolution as any name on that principal', () => {
    const { edges } = run([
      policyRow('A', { from: 'x', to: { 'Fn::Join': ['', ['p', 'q']] } }),
      policyRow('B', { from: 'q', to: 'r' }),
      policyRow('C', { to: 'z', roles: ['someone-else'] }),
    ]);
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('treats a principal it cannot read before resolution as any principal of that kind', () => {
    const { edges } = run(
      [
        policyRow('A', { to: 'x', changeType: 'CREATE', roles: [{ Ref: 'RoleNameParam' }] }),
        policyRow('B', { from: 'x', to: 'y', roles: ['anyone'], recordedRoles: ['anyone'] }),
        policyRow('C', { from: 'q', to: 'r', roles: ['anyone'], recordedRoles: ['anyone'] }),
      ]
    );
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it("orders a role's own Policies against a policy that takes a name it drops", () => {
    const { edges } = run(
      [
        [
          'R',
          {
            change: {
              logicalId: 'R',
              changeType: 'UPDATE',
              resourceType: ROLE,
              propertyChanges: [{ path: 'Policies', oldValue: [], newValue: [], requiresReplacement: false }],
            },
            template: { Type: ROLE, Properties: { RoleName: 'fixed', Policies: [] } },
            record: {
              physicalId: 'fixed',
              resourceType: ROLE,
              properties: { RoleName: 'fixed', Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
            },
          },
        ],
        policyRow('P', { to: 'x', changeType: 'CREATE', roles: ['fixed'] }),
      ],
      { levels: { R: 0, P: 0 } }
    );
    expect(edges).toEqual([{ before: 'P', after: 'R' }]);
  });

  it('a principal update that leaves Policies alone writes no inline policy', () => {
    const { edges } = run([
      [
        'R',
        {
          change: {
            logicalId: 'R',
            changeType: 'UPDATE',
            resourceType: ROLE,
            propertyChanges: [
              { path: 'Description', oldValue: 'a', newValue: 'b', requiresReplacement: false },
              { path: 'Policies', oldValue: [], newValue: [], requiresReplacement: false, inPlacePropagated: true },
            ],
          },
          template: { Type: ROLE, Properties: { RoleName: 'fixed', Policies: [{ PolicyName: 'x' }] } },
          record: {
            physicalId: 'fixed',
            resourceType: ROLE,
            properties: { Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
          },
        },
      ],
      policyRow('P', { to: 'x', changeType: 'CREATE', roles: ['fixed'] }),
    ]);
    expect(edges).toEqual([]);
  });

  it("a principal REPLACED writes every Policies name on the new principal", () => {
    const { edges } = run([
      [
        'R',
        {
          change: {
            logicalId: 'R',
            changeType: 'UPDATE',
            resourceType: ROLE,
            propertyChanges: [{ path: 'RoleName', oldValue: 'old', newValue: 'fixed', requiresReplacement: true }],
          },
          template: { Type: ROLE, Properties: { RoleName: 'fixed', Policies: [{ PolicyName: 'x' }] } },
          record: { physicalId: 'old', resourceType: ROLE, properties: { RoleName: 'old' } },
        },
      ],
      policyRow('P', { from: 'x', to: 'y', roles: ['fixed'], recordedRoles: ['fixed'] }),
    ]);
    expect(edges).toEqual([{ before: 'P', after: 'R' }]);
  });

  it('orders a policy that keeps its name but moves to another role beside a create of that name on the old role', () => {
    // A leaves role-phys (its RECORDED principal) for Other; B creates `x` on
    // role-phys. Only A's recorded list names the shared principal.
    const { edges } = run(
      [
        policyRow('A', { from: 'x', to: 'x', roles: [{ Ref: 'Other' }] }),
        policyRow('B', { to: 'x', changeType: 'CREATE' }),
      ],
      { extraTemplate: { Other: { Type: ROLE, Properties: {} } } }
    );
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  for (const field of ['Users', 'Groups'] as const) {
    it(`orders an unordered swap on one ${field === 'Users' ? 'user' : 'group'}`, () => {
      const row = (id: string, from: string, to: string): [string, Row] => [
        id,
        {
          change: {
            logicalId: id,
            changeType: 'UPDATE',
            resourceType: POLICY,
            propertyChanges: [{ path: 'PolicyName', oldValue: from, newValue: to, requiresReplacement: false }],
          },
          template: { Type: POLICY, Properties: { PolicyName: to, PolicyDocument: DOC, [field]: ['p1'] } },
          record: {
            physicalId: from,
            resourceType: POLICY,
            properties: { PolicyName: from, PolicyDocument: DOC, [field]: ['p1'] },
          },
        },
      ];
      expect(run([row('A', 'x', 'y'), row('B', 'y', 'x')]).edges).toEqual([{ before: 'A', after: 'B' }]);
    });
  }

  it("orders a role CREATED with a fixed name and its own Policies beside a policy naming it literally", () => {
    const { edges } = run([
      [
        'R',
        {
          change: { logicalId: 'R', changeType: 'CREATE', resourceType: ROLE, propertyChanges: [] },
          template: {
            Type: ROLE,
            Properties: { RoleName: 'fixed', Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
          },
        },
      ],
      policyRow('P', { from: 'x', to: 'y', roles: ['fixed'], recordedRoles: ['fixed'] }),
    ]);
    expect(edges).toEqual([{ before: 'P', after: 'R' }]);
  });

  it("treats a principal's Policies that is not a list as any name", () => {
    const { edges } = run([
      [
        'R',
        {
          change: { logicalId: 'R', changeType: 'CREATE', resourceType: ROLE, propertyChanges: [] },
          template: { Type: ROLE, Properties: { RoleName: 'fixed', Policies: { 'Fn::If': ['C', [], []] } } },
        },
      ],
      policyRow('P', { to: 'anything', changeType: 'CREATE', roles: ['fixed'] }),
    ]);
    expect(edges).toEqual([{ before: 'P', after: 'R' }]);
  });

  it('treats a principal list that is not a list as any principal of that kind', () => {
    const { edges } = run([
      policyRow('A', { to: 'x', changeType: 'CREATE', roles: { 'Fn::If': ['C', ['a'], ['b']] } }),
      policyRow('B', { from: 'x', to: 'y', roles: ['elsewhere'], recordedRoles: ['elsewhere'] }),
    ]);
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('treats a Ref to a resource of another kind as any principal', () => {
    const { edges } = run(
      [
        policyRow('A', { to: 'x', changeType: 'CREATE', roles: [{ Ref: 'SomeUser' }] }),
        policyRow('B', { from: 'x', to: 'y', roles: ['elsewhere'], recordedRoles: ['elsewhere'] }),
      ],
      { extraTemplate: { SomeUser: { Type: 'AWS::IAM::User', Properties: {} } } }
    );
    expect(edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('an unreadable principal matches only principals of its own kind', () => {
    const { edges } = run([
      policyRow('A', { to: 'x', changeType: 'CREATE', roles: [{ Ref: 'RoleNameParam' }] }),
      [
        'B',
        {
          change: { logicalId: 'B', changeType: 'CREATE', resourceType: POLICY, propertyChanges: [] },
          template: { Type: POLICY, Properties: { PolicyName: 'x', PolicyDocument: DOC, Users: ['u'] } },
        },
      ],
    ]);
    expect(edges).toEqual([]);
  });

  it("reads a policy's recorded physical id in the provider's old `<name>:<role>` format as its name", () => {
    const legacy = (id: string, name: string): [string, Row] => {
      const [, row] = policyRow(id, { from: name, to: name });
      return [id, { ...row, record: { ...row.record!, physicalId: `${name}:role-phys` } }];
    };
    expect(run([legacy('P1', 'one'), legacy('P2', 'two')]).edges).toEqual([]);
    const { edges } = run([legacy('P1', 'one'), policyRow('P2', { from: 'two', to: 'one' })]);
    expect(edges).toEqual([{ before: 'P1', after: 'P2' }]);
  });

  it('the recorded physical id counts as a name even where the recorded PolicyName is absent', () => {
    const [, a] = policyRow('A', { from: 'x', to: 'y' });
    const noName: [string, Row] = [
      'A',
      { ...a, record: { ...a.record!, properties: { PolicyDocument: DOC, Roles: ['role-phys'] } } },
    ];
    expect(run([noName, policyRow('B', { to: 'x', changeType: 'CREATE' })]).edges).toEqual([
      { before: 'A', after: 'B' },
    ]);
  });

  it('two principals whose names cannot be read before resolving are never ordered against each other', () => {
    const role = (id: string): [string, Row] => [
      id,
      {
        change: { logicalId: id, changeType: 'CREATE', resourceType: ROLE, propertyChanges: [] },
        template: {
          Type: ROLE,
          Properties: {
            RoleName: { 'Fn::Join': ['-', [{ Ref: 'AWS::StackName' }, id]] },
            Policies: [{ PolicyName: 'p', PolicyDocument: DOC }],
          },
        },
      },
    ];
    expect(run([role('A'), role('B')]).edges).toEqual([]);
  });

  /** N token-named roles, each with its own policy, all policies named `name`. */
  function tokenRoles(n: number, rows: (i: number) => Array<[string, Row]>) {
    const extraTemplate: Record<string, TemplateResource> = {};
    const all: Array<[string, Row]> = [];
    for (let i = 0; i < n; i++) {
      extraTemplate[`R${i}`] = {
        Type: ROLE,
        Properties: { RoleName: { 'Fn::Join': ['-', [{ Ref: 'AWS::StackName' }, `fn${i}`]] } },
      };
      all.push(...rows(i));
    }
    return { all, extraTemplate };
  }

  it('policies of one name on DIFFERENT token-named roles of the stack are not ordered (the ordinary shape)', () => {
    const { all, extraTemplate } = tokenRoles(5, (i) => [
      policyRow(`P${i}`, { to: 'access', changeType: 'CREATE', roles: [{ Ref: `R${i}` }] }),
    ]);
    expect(run(all, { extraTemplate }).edges).toEqual([]);
  });

  it('the same on later deploys, once each token-named role has a recorded name', () => {
    const { all, extraTemplate } = tokenRoles(5, (i) => [
      policyRow(`P${i}`, {
        from: 'access',
        to: 'access',
        roles: [{ Ref: `R${i}` }],
        recordedRoles: [`stack-fn${i}`],
      }),
    ]);
    const extraState = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `R${i}`,
        { physicalId: `stack-fn${i}`, resourceType: ROLE, properties: {} } as ResourceState,
      ])
    );
    expect(run(all, { extraTemplate, extraState }).edges).toEqual([]);
  });

  it('nor once their recorded names are masked (a secret-derived role name)', () => {
    const { all, extraTemplate } = tokenRoles(3, (i) => [
      policyRow(`P${i}`, { to: 'access', changeType: 'CREATE', roles: [{ Ref: `R${i}` }] }),
    ]);
    const extraState = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [
        `R${i}`,
        { physicalId: '***', resourceType: ROLE, properties: {} } as ResourceState,
      ])
    );
    expect(run(all, { extraTemplate, extraState }).edges).toEqual([]);
  });

  it('a swap on ONE token-named role is still ordered', () => {
    const { all, extraTemplate } = tokenRoles(1, () => [
      policyRow('A', { from: 'x', to: 'y', roles: [{ Ref: 'R0' }], recordedRoles: ['stack-fn0'] }),
      policyRow('B', { from: 'y', to: 'x', roles: [{ Ref: 'R0' }], recordedRoles: ['stack-fn0'] }),
    ]);
    const extraState = { R0: { physicalId: 'stack-fn0', resourceType: ROLE, properties: {} } };
    expect(run(all, { extraTemplate, extraState }).edges).toEqual([{ before: 'A', after: 'B' }]);
    // ...and on the first deploy, matched by the Ref alone.
    const { all: fresh, extraTemplate: freshTemplate } = tokenRoles(1, () => [
      policyRow('A', { to: 'x', changeType: 'CREATE', roles: [{ Ref: 'R0' }] }),
      policyRow('B', { to: 'x', changeType: 'CREATE', roles: [{ Ref: 'R0' }] }),
    ]);
    expect(run(fresh, { extraTemplate: freshTemplate }).edges).toEqual([{ before: 'A', after: 'B' }]);
  });

  it('200 token-named roles with one policy name each add no edge (no slowdown at scale)', () => {
    const { all, extraTemplate } = tokenRoles(200, (i) => [
      [
        `R${i}`,
        {
          change: { logicalId: `R${i}`, changeType: 'CREATE', resourceType: ROLE, propertyChanges: [] },
          template: {
            Type: ROLE,
            Properties: { RoleName: { 'Fn::Join': ['-', [{ Ref: 'AWS::StackName' }, `fn${i}`]] } },
          },
        },
      ],
      policyRow(`P${i}`, { to: 'access', changeType: 'CREATE', roles: [{ Ref: `R${i}` }] }),
    ]);
    const deps = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`P${i}`, [`R${i}`]]));
    expect(run(all, { extraTemplate, deps }).edges).toEqual([]);
  });

  it('orders by execution level first, then logical id', () => {
    const { edges } = run(
      [policyRow('A', { from: 'x', to: 'y' }), policyRow('B', { from: 'y', to: 'x' })],
      { levels: { A: 3, B: 1 } }
    );
    expect(edges).toEqual([{ before: 'B', after: 'A' }]);
  });

  it('chains three writers of one name into one order', () => {
    const { dependencies } = run([
      policyRow('A', { from: 'x', to: 'y' }),
      policyRow('B', { from: 'y', to: 'z' }),
      policyRow('C', { from: 'z', to: 'x' }),
    ]);
    const order = topo(dependencies);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('never closes a cycle against the template edges, whatever the ranks say', () => {
    // C depends on A in the template; B collides with both. Ranks would put
    // C before A, but the existing edge wins and every added one respects it.
    const { dependencies } = run(
      [
        policyRow('A', { from: 'x', to: 'y' }),
        policyRow('B', { from: 'y', to: 'x' }),
        policyRow('C', { from: 'q', to: 'x' }),
      ],
      { deps: { C: ['A'] }, levels: { C: 0, B: 1, A: 2 } }
    );
    expect(() => topo(dependencies)).not.toThrow();
  });

  it('randomized: always acyclic, and every colliding pair ends up ordered', () => {
    let seed = 4227;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const names = ['a', 'b', 'c'];
    for (let round = 0; round < 300; round++) {
      const count = 2 + rand(6);
      const ids = Array.from({ length: count }, (_, i) => `P${i}`);
      const rows = ids.map((id) =>
        rand(3) === 0
          ? policyRow(id, { to: names[rand(3)]!, changeType: 'CREATE' })
          : policyRow(id, { from: names[rand(3)]!, to: names[rand(3)]! })
      );
      // A random template DAG: edges only from a higher index to a lower one.
      const deps: Record<string, string[]> = {};
      for (let i = 1; i < count; i++) {
        deps[ids[i]!] = ids.slice(0, i).filter(() => rand(4) === 0);
      }
      const levels = Object.fromEntries(ids.map((id) => [id, rand(4)]));
      const { dependencies } = run(rows, { deps, levels });
      const order = topo(dependencies);
      const reaches = (from: string, to: string): boolean =>
        from === to || [...(dependencies.get(from) ?? [])].some((d) => reaches(d, to));
      const namesOf = (r: Row): Set<string> =>
        new Set(
          [r.template!.Properties!['PolicyName'], r.record?.physicalId].filter(
            (n): n is string => typeof n === 'string'
          )
        );
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const a = namesOf(rows[i]![1]);
          const b = namesOf(rows[j]![1]);
          if (![...a].some((n) => b.has(n))) continue;
          expect(reaches(ids[i]!, ids[j]!) || reaches(ids[j]!, ids[i]!)).toBe(true);
        }
      }
      expect(order).toHaveLength(count);
    }
  });

  it('returns at once for fewer than two inline-policy writers', () => {
    const changes = new Map<string, ResourceChange>([
      ['Q', { logicalId: 'Q', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue', propertyChanges: [] }],
      ['A', policyRow('A', { to: 'x' })[1].change],
    ]);
    const fail = (): never => {
      throw new Error('read');
    };
    const throwing = new Proxy(
      {},
      { get: fail, has: fail, getOwnPropertyDescriptor: fail, ownKeys: fail }
    ) as never;
    expect(
      orderInlinePolicyWriters({
        writes: ['Q', 'A'],
        changes,
        templateResources: throwing,
        stateResources: throwing,
        dependencies: new Map(),
        rank: () => {
          throw new Error('ranked');
        },
      })
    ).toEqual([]);
  });
});
