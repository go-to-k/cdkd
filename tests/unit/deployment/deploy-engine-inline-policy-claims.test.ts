/**
 * go-to-k/cdkd#4156: the deploy engine hands an `AWS::IAM::Policy` update and
 * its deploy-phase delete a LIVE predicate (`inlinePolicyClaimed`) that says
 * whether ANOTHER resource of the deploy has ALREADY written an inline policy
 * name onto a principal, read from what that resource recorded. These tests
 * evaluate the predicate INSIDE the provider call — when the provider would —
 * so a precomputed or a stale answer shows. The matching rules themselves are
 * pinned in `inline-policy-claims.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import type {
  CloudFormationTemplate,
  InlinePolicyClaimed,
  InlinePolicyPrincipalKind,
} from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/** `{Ref}` resolves to a parameter value or the recorded physical id. */
function resolveRefs(
  value: unknown,
  ctx: { resources?: Record<string, ResourceState>; parameters?: Record<string, unknown> }
): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ctx));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['Ref'] === 'string') {
      const ref = obj['Ref'];
      if (ctx.parameters && Object.hasOwn(ctx.parameters, ref)) return ctx.parameters[ref];
      const target = ctx.resources?.[ref];
      if (!target) throw new Error(`unresolvable Ref ${ref}`);
      return target.physicalId;
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, ctx)]));
  }
  return value;
}

const resolveParameters = vi.hoisted(() => vi.fn());

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown, ctx: Parameters<typeof resolveRefs>[1]) =>
      Promise.resolve(resolveRefs(props, ctx ?? {}))
    ),
    resolveParameters,
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// No real AWS client: something on the engine's deploy path reads the
// process-global client factory, and with no credentials in CI its credential
// chain reaches IMDS while the liveness case below holds a provider call open.
// Any read of a client here throws instead of touching the network.
vi.mock('../../../src/utils/aws-clients.js', () => {
  const clients = new Proxy(
    {},
    {
      get: (_target, key) => {
        throw new Error(`test stub: no real AWS client (${String(key)})`);
      },
    }
  );
  return {
    getAwsClients: () => clients,
    setAwsClients: vi.fn(),
    resetAwsClients: vi.fn(),
    runWithStackAwsClients: <T,>(_clients: unknown, fn: () => T) => fn(),
    AwsClients: vi.fn(),
  };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const DOC = { Version: '2012-10-17', Statement: [] };
const POLICY = 'AWS::IAM::Policy';
const ROLE_STATE: ResourceState = {
  physicalId: 'role-phys',
  resourceType: 'AWS::IAM::Role',
  properties: {},
};

type Query = [InlinePolicyPrincipalKind, string, string];

describe('DeployEngine hands AWS::IAM::Policy a live inline-policy claim predicate (go-to-k/cdkd#4156)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let diffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let dagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  /** logicalId -> the predicate's answers to `queries[logicalId]`, taken INSIDE the provider call. */
  let answers: Record<string, boolean[]>;
  let queries: Record<string, Query[]>;

  const ask = (logicalId: string, ctx: { inlinePolicyClaimed?: InlinePolicyClaimed } | undefined) => {
    answers[logicalId] = (queries[logicalId] ?? []).map(
      (q) => ctx?.inlinePolicyClaimed?.(...q) ?? false
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveParameters.mockReturnValue({});
    answers = {};
    queries = {};
    provider = {
      create: vi
        .fn()
        .mockImplementation((_l: string, _t: string, props: Record<string, unknown>) =>
          Promise.resolve({ physicalId: props['PolicyName'] ?? 'created' })
        ),
      update: vi
        .fn()
        .mockImplementation(
          (l: string, _p: string, _t: string, props: Record<string, unknown>, _prev: unknown, ctx: never) => {
            ask(l, ctx);
            return Promise.resolve({ physicalId: props['PolicyName'] });
          }
        ),
      delete: vi.fn().mockImplementation((l: string, _p: string, _t: string, _props: unknown, ctx: never) => {
        ask(l, ctx);
        return Promise.resolve(undefined);
      }),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
    diffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    dagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn(),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
  });

  function engine(options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
      dagBuilder as never,
      diffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false, ...options },
      'us-east-1'
    );
  }

  /** `levels` also becomes the dependency graph: each level depends on the previous one. */
  function prime(resources: Record<string, ResourceState>, changes: ResourceChange[], levels: string[][]): void {
    stateBackend.getState!.mockResolvedValue({
      state: { version: 8, stackName: 'S', region: 'us-east-1', resources, outputs: {}, lastModified: 1 },
      etag: 'etag-old',
    });
    diffCalculator.calculateDiff!.mockResolvedValue(new Map(changes.map((c) => [c.logicalId, c])));
    dagBuilder.getExecutionLevels!.mockReturnValue(levels);
    dagBuilder.getDirectDependencies!.mockImplementation((_dag: unknown, id: string) => {
      const at = levels.findIndex((level) => level.includes(id));
      return at > 0 ? levels[at - 1]! : [];
    });
  }

  const rename = (logicalId: string, from: string, to: string): ResourceChange => ({
    logicalId,
    changeType: 'UPDATE',
    resourceType: POLICY,
    currentProperties: { PolicyName: from, PolicyDocument: DOC, Roles: ['role-phys'] },
    desiredProperties: { PolicyName: to, PolicyDocument: DOC, Roles: [{ Ref: 'Role' }] },
    propertyChanges: [{ path: 'PolicyName', oldValue: from, newValue: to, requiresReplacement: false }],
  });

  const recordedPolicy = (name: string): ResourceState => ({
    physicalId: name,
    resourceType: POLICY,
    properties: { PolicyName: name, PolicyDocument: DOC, Roles: ['role-phys'] },
  });

  const policyTemplate = (name: string, roles: unknown[] = [{ Ref: 'Role' }]) => ({
    Type: POLICY,
    Properties: { PolicyName: name, PolicyDocument: DOC, Roles: roles },
  });

  it('a swap in dependency order: the first sees no claim (removal proceeds), the second sees the first one written', async () => {
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('x'), B: recordedPolicy('y') },
      [rename('A', 'x', 'y'), rename('B', 'y', 'x')],
      [['A'], ['B']]
    );
    queries = { A: [['role', 'role-phys', 'x']], B: [['role', 'role-phys', 'y']] };

    await engine().deploy('S', {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        A: policyTemplate('y'),
        B: policyTemplate('x'),
      },
    });

    // A runs first: B has not written `x` yet, so A removes it (B's put
    // restores it). B runs second: A has recorded `y` on the role.
    expect(answers).toEqual({ A: [false], B: [true] });
  });

  it('a delete beside a create of the same name: the delete sees the completed create', async () => {
    prime(
      { Role: ROLE_STATE, Old: recordedPolicy('x') },
      [
        {
          logicalId: 'New',
          changeType: 'CREATE',
          resourceType: POLICY,
          desiredProperties: { PolicyName: 'x', PolicyDocument: DOC, Roles: [{ Ref: 'Role' }] },
        },
        { logicalId: 'Old', changeType: 'DELETE', resourceType: POLICY, currentProperties: {} },
      ],
      [['New']]
    );
    queries = { Old: [['role', 'role-phys', 'x'], ['role', 'other', 'x'], ['role', 'role-phys', 'z']] };

    await engine().deploy('S', {
      Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} }, New: policyTemplate('x') },
    });

    expect(answers['Old']).toEqual([true, false, false]);
  });

  it('the claim is what the writer RECORDED after resolution (a principal from a parameter)', async () => {
    resolveParameters.mockReturnValue({ RoleParam: 'param-role' });
    prime(
      {
        Old: {
          physicalId: 'x',
          resourceType: POLICY,
          properties: { PolicyName: 'x', PolicyDocument: DOC, Roles: ['param-role'] },
        },
      },
      [
        {
          logicalId: 'New',
          changeType: 'CREATE',
          resourceType: POLICY,
          desiredProperties: { PolicyName: 'x', PolicyDocument: DOC, Roles: [{ Ref: 'RoleParam' }] },
        },
        { logicalId: 'Old', changeType: 'DELETE', resourceType: POLICY, currentProperties: {} },
      ],
      [['New']]
    );
    queries = { Old: [['role', 'param-role', 'x']] };

    await engine().deploy('S', {
      Parameters: { RoleParam: { Type: 'String' } },
      Resources: { New: policyTemplate('x', [{ Ref: 'RoleParam' }]) },
    });

    expect(answers['Old']).toEqual([true]);
  });

  it("a principal's own Policies count once its update that changed them has completed", async () => {
    prime(
      {
        Role: {
          physicalId: 'role-phys',
          resourceType: 'AWS::IAM::Role',
          properties: { Policies: [] },
        },
        A: recordedPolicy('x'),
      },
      [
        {
          logicalId: 'Role',
          changeType: 'UPDATE',
          resourceType: 'AWS::IAM::Role',
          currentProperties: { Policies: [] },
          desiredProperties: { Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
          propertyChanges: [{ path: 'Policies', oldValue: [], newValue: [], requiresReplacement: false }],
        },
        rename('A', 'x', 'y'),
      ],
      [['Role'], ['A']]
    );
    provider.update!.mockImplementation(
      (l: string, _p: string, t: string, props: Record<string, unknown>, _prev: unknown, ctx: never) => {
        ask(l, ctx);
        return Promise.resolve({ physicalId: t === POLICY ? props['PolicyName'] : 'role-phys' });
      }
    );
    queries = { A: [['role', 'role-phys', 'x']] };

    await engine().deploy('S', {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: { Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] } },
        A: policyTemplate('y'),
      },
    });

    expect(answers['A']).toEqual([true]);
  });

  it('a sibling that writes nothing in this deploy (NO_CHANGE) claims nothing', async () => {
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('x'), B: recordedPolicy('x') },
      [rename('A', 'x', 'y'), { logicalId: 'B', changeType: 'NO_CHANGE', resourceType: POLICY }],
      [['A']]
    );
    queries = { A: [['role', 'role-phys', 'x']] };

    await engine().deploy('S', {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        A: policyTemplate('y'),
        B: policyTemplate('x'),
      },
    });

    expect(answers['A']).toEqual([false]);
  });

  it('a sibling whose write FAILED claims nothing', async () => {
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('x'), B: recordedPolicy('y') },
      [rename('B', 'y', 'x'), rename('A', 'x', 'y')],
      [['B'], ['A']]
    );
    const e = engine();
    provider.update!.mockImplementation((l: string) =>
      l === 'B' ? Promise.reject(new Error('throttled')) : Promise.resolve({ physicalId: 'y' })
    );

    await expect(
      e.deploy('S', {
        Resources: {
          Role: { Type: 'AWS::IAM::Role', Properties: {} },
          A: policyTemplate('y'),
          B: policyTemplate('x'),
        },
      })
    ).rejects.toThrow();

    const writers = (e as unknown as { inlinePolicyWriters: Map<string, unknown> }).inlinePolicyWriters;
    expect([...writers.keys()]).not.toContain('B');
  });

  it('a resource of another type is handed no predicate', async () => {
    prime(
      { Q: { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: { DelaySeconds: 1 } } },
      [
        {
          logicalId: 'Q',
          changeType: 'UPDATE',
          resourceType: 'AWS::SQS::Queue',
          currentProperties: { DelaySeconds: 1 },
          desiredProperties: { DelaySeconds: 2 },
          propertyChanges: [{ path: 'DelaySeconds', oldValue: 1, newValue: 2, requiresReplacement: false }],
        },
      ],
      [['Q']]
    );

    await engine().deploy('S', { Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { DelaySeconds: 2 } } } });

    expect(Object.keys(provider.update!.mock.calls[0]![5] as object)).not.toContain('inlinePolicyClaimed');
  });

  it("a replacement's delete of the old AWS::IAM::Policy copy is handed no predicate", async () => {
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('x') },
      [
        {
          logicalId: 'A',
          changeType: 'UPDATE',
          resourceType: POLICY,
          currentProperties: { PolicyName: 'x', PolicyDocument: DOC, Roles: ['role-phys'] },
          desiredProperties: { PolicyName: 'x2', PolicyDocument: DOC, Roles: [{ Ref: 'Role' }] },
          propertyChanges: [{ path: 'PolicyName', oldValue: 'x', newValue: 'x2', requiresReplacement: true }],
        },
      ],
      [['A']]
    );

    await engine().deploy('S', {
      Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} }, A: policyTemplate('x2') },
    });

    expect(provider.delete).toHaveBeenCalled();
    for (const call of provider.delete!.mock.calls) {
      expect(Object.keys((call[4] ?? {}) as object)).not.toContain('inlinePolicyClaimed');
    }
  });

  it("the --replace fallback's delete of the old AWS::IAM::Policy copy is handed no predicate", async () => {
    prime({ Role: ROLE_STATE, A: recordedPolicy('x') }, [rename('A', 'x', 'y')], [['A']]);
    provider.update!.mockRejectedValue(new ResourceUpdateNotSupportedError(POLICY, 'A'));

    await engine({ replace: true }).deploy('S', {
      Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} }, A: policyTemplate('y') },
    });

    expect(provider.create).toHaveBeenCalled();
    expect(provider.delete).toHaveBeenCalled();
    for (const call of provider.delete!.mock.calls) {
      expect(Object.keys((call[4] ?? {}) as object)).not.toContain('inlinePolicyClaimed');
    }
  });

  it('a sibling whose update came back PARTIAL is no completed writer', async () => {
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('x'), B: recordedPolicy('y') },
      [rename('A', 'x', 'y'), rename('B', 'y', 'x')],
      [['A'], ['B']]
    );
    provider.update!.mockImplementation(
      (l: string, _p: string, _t: string, props: Record<string, unknown>, _prev: unknown, ctx: never) => {
        ask(l, ctx);
        return Promise.resolve(
          l === 'A'
            ? { physicalId: props['PolicyName'], outcome: 'partial', reason: 'left something' }
            : { physicalId: props['PolicyName'] }
        );
      }
    );
    queries = { B: [['role', 'role-phys', 'y']] };

    await engine().deploy('S', {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        A: policyTemplate('y'),
        B: policyTemplate('x'),
      },
    });

    expect(answers['B']).toEqual([false]);
  });

  it('a reused engine forgets the previous deploy\'s writers', async () => {
    const e = engine();
    prime({ Role: ROLE_STATE, New: recordedPolicy('x') }, [
      {
        logicalId: 'New',
        changeType: 'UPDATE',
        resourceType: POLICY,
        currentProperties: { PolicyName: 'x', PolicyDocument: DOC, Roles: ['role-phys'] },
        desiredProperties: { PolicyName: 'x', PolicyDocument: { ...DOC, Id: '1' }, Roles: [{ Ref: 'Role' }] },
        propertyChanges: [{ path: 'PolicyDocument', oldValue: 1, newValue: 2, requiresReplacement: false }],
      },
    ], [['New']]);
    const template: CloudFormationTemplate = {
      Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} }, New: policyTemplate('x') },
    };
    await e.deploy('S', template);

    // Second deploy: `New` is unchanged, and `Old` (also on `x`) is deleted.
    prime(
      { Role: ROLE_STATE, New: recordedPolicy('x'), Old: recordedPolicy('x') },
      [
        { logicalId: 'New', changeType: 'NO_CHANGE', resourceType: POLICY },
        { logicalId: 'Old', changeType: 'DELETE', resourceType: POLICY, currentProperties: {} },
      ],
      [[]]
    );
    queries = { Old: [['role', 'role-phys', 'x']] };
    await e.deploy('S', template);

    expect(answers['Old']).toEqual([false]);
  });

  it("a principal REPLACED in this deploy claims its Policies on the new physical id (a create puts them all)", async () => {
    prime(
      {
        Role: {
          physicalId: 'role-old',
          resourceType: 'AWS::IAM::Role',
          properties: { RoleName: 'role-old', Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
        },
        A: recordedPolicy('x'),
      },
      [
        {
          logicalId: 'Role',
          changeType: 'UPDATE',
          resourceType: 'AWS::IAM::Role',
          currentProperties: { RoleName: 'role-old' },
          desiredProperties: { RoleName: 'role-new', Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
          // No `Policies` row: only the replacement's create puts `x`.
          propertyChanges: [{ path: 'RoleName', oldValue: 'role-old', newValue: 'role-new', requiresReplacement: true }],
        },
        rename('A', 'x', 'y'),
      ],
      [['Role'], ['A']]
    );
    provider.create!.mockImplementation((_l: string, t: string, props: Record<string, unknown>) =>
      Promise.resolve({ physicalId: t === POLICY ? props['PolicyName'] : props['RoleName'] })
    );
    queries = { A: [['role', 'role-new', 'x'], ['role', 'role-old', 'x']] };

    await engine().deploy('S', {
      Resources: {
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: { RoleName: 'role-new', Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
        },
        A: policyTemplate('y'),
      },
    });

    expect(answers['A']).toEqual([true, false]);
  });

  it("a principal re-created by the --replace fallback counts as an UPDATE: no own Policies row, no claim", async () => {
    prime(
      {
        Role: {
          physicalId: 'role-phys',
          resourceType: 'AWS::IAM::Role',
          properties: { Description: 'a', Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
        },
        A: recordedPolicy('x'),
      },
      [
        {
          logicalId: 'Role',
          changeType: 'UPDATE',
          resourceType: 'AWS::IAM::Role',
          currentProperties: { Description: 'a' },
          desiredProperties: { Description: 'b', Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
          propertyChanges: [{ path: 'Description', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
        },
        rename('A', 'x', 'y'),
      ],
      [['Role'], ['A']]
    );
    provider.update!.mockImplementation(
      (l: string, _p: string, t: string, props: Record<string, unknown>, _prev: unknown, ctx: never) => {
        if (t === 'AWS::IAM::Role') return Promise.reject(new ResourceUpdateNotSupportedError(t, l));
        ask(l, ctx);
        return Promise.resolve({ physicalId: props['PolicyName'] });
      }
    );
    provider.create!.mockResolvedValue({ physicalId: 'role-phys' });
    queries = { A: [['role', 'role-phys', 'x']] };

    await engine({ replace: true }).deploy('S', {
      Resources: {
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: { Description: 'b', Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
        },
        A: policyTemplate('y'),
      },
    });

    expect(provider.create).toHaveBeenCalled();
    expect(answers['A']).toEqual([false]);
  });

  it('the predicate is LIVE: a sibling that completes after it was handed over, before the query, counts', async () => {
    // A and B share no dependency, so both are dispatched. A's provider call
    // holds the predicate, first asks while B is still in flight (false),
    // then waits for B to complete and record, and asks again (true). A
    // snapshot of the writer map, or of the state bag (B's record still names
    // `y`), would keep answering false.
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('x'), B: recordedPolicy('y') },
      [rename('A', 'x', 'y'), rename('B', 'y', 'x')],
      [['A', 'B']]
    );
    let releaseB!: () => void;
    const bMayFinish = new Promise<void>((resolve) => (releaseB = resolve));
    const seen: boolean[] = [];
    provider.update!.mockImplementation(
      async (l: string, _p: string, _t: string, props: Record<string, unknown>, _prev: unknown, ctx: never) => {
        const claimed = (ctx as { inlinePolicyClaimed?: InlinePolicyClaimed }).inlinePolicyClaimed;
        if (l === 'B') {
          await bMayFinish;
          return { physicalId: props['PolicyName'] };
        }
        seen.push(claimed?.('role', 'role-phys', 'x') ?? false);
        releaseB();
        // Microtask turns only: B's completion path here is promise-only, and
        // a macrotask wait would let an unrelated engine read reach the
        // network while A holds its call open.
        for (let i = 0; i < 2000 && !(claimed?.('role', 'role-phys', 'x') ?? false); i++) {
          await Promise.resolve();
        }
        seen.push(claimed?.('role', 'role-phys', 'x') ?? false);
        return { physicalId: props['PolicyName'] };
      }
    );

    await engine().deploy('S', {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        A: policyTemplate('y'),
        B: policyTemplate('x'),
      },
    });

    expect(seen).toEqual([false, true]);
  });
});
