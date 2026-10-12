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
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
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

  it('the predicate is LIVE: a writer recorded after it was handed over, before the query, counts', () => {
    // go-to-k/cdkd#4227 orders the writers a deploy can see colliding, so a
    // deploy no longer runs two of them at once; the predicate still reads the
    // writer map and the state bag at query time, not at hand-over.
    const e = engine();
    const bag: Record<string, ResourceState> = {
      Role: ROLE_STATE,
      A: recordedPolicy('x'),
      B: recordedPolicy('y'),
    };
    const claimed = e.inlinePolicyClaimedFor(POLICY, 'A', bag)!;
    expect(claimed('role', 'role-phys', 'x')).toBe(false);
    bag['B'] = recordedPolicy('x');
    expect(claimed('role', 'role-phys', 'x')).toBe(false);
    e.recordInlinePolicyWrite('B', 'update');
    expect(claimed('role', 'role-phys', 'x')).toBe(true);
  });

  /** Holds each provider update open until `release`, recording the order of starts and ends. */
  function gatedUpdates(): { events: string[]; inFlightMax: () => number } {
    const events: string[] = [];
    let inFlight = 0;
    let max = 0;
    provider.update!.mockImplementation(
      async (l: string, _p: string, t: string, props: Record<string, unknown>, _prev: unknown, ctx: never) => {
        ask(l, ctx);
        events.push(`start ${l}`);
        inFlight++;
        max = Math.max(max, inFlight);
        // Microtask turns only (see the network note on the aws-clients mock):
        // long enough for every row the executor has dispatched to start.
        for (let i = 0; i < 200; i++) await Promise.resolve();
        inFlight--;
        events.push(`end ${l}`);
        return { physicalId: t === POLICY ? props['PolicyName'] : 'role-phys' };
      }
    );
    return { events, inFlightMax: () => max };
  }

  it('an UNORDERED swap of two names on one role runs one writer after the other (go-to-k/cdkd#4227)', async () => {
    // No dependency between A and B: before #4227 both ran at once, each
    // removal missed the other's put, and the role kept neither policy.
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('x'), B: recordedPolicy('y') },
      [rename('A', 'x', 'y'), rename('B', 'y', 'x')],
      [['A', 'B']]
    );
    queries = { A: [['role', 'role-phys', 'x']], B: [['role', 'role-phys', 'y']] };
    const { events, inFlightMax } = gatedUpdates();

    await engine().deploy('S', {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        A: policyTemplate('y'),
        B: policyTemplate('x'),
      },
    });

    expect(events).toEqual(['start A', 'end A', 'start B', 'end B']);
    expect(inFlightMax()).toBe(1);
    expect(answers).toEqual({ A: [false], B: [true] });
  });

  it('an UNORDERED rename beside a create of the old name runs one after the other (go-to-k/cdkd#4227)', async () => {
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('x') },
      [
        rename('A', 'x', 'y'),
        {
          logicalId: 'B',
          changeType: 'CREATE',
          resourceType: POLICY,
          desiredProperties: { PolicyName: 'x', PolicyDocument: DOC, Roles: [{ Ref: 'Role' }] },
        },
      ],
      [['A', 'B']]
    );
    const order: string[] = [];
    provider.create!.mockImplementation(async (l: string, _t: string, props: Record<string, unknown>) => {
      order.push(`start ${l}`);
      for (let i = 0; i < 200; i++) await Promise.resolve();
      order.push(`end ${l}`);
      return { physicalId: props['PolicyName'] };
    });
    provider.update!.mockImplementation(
      async (l: string, _p: string, _t: string, props: Record<string, unknown>, _prev: unknown, ctx: never) => {
        ask(l, ctx);
        order.push(`start ${l}`);
        for (let i = 0; i < 200; i++) await Promise.resolve();
        order.push(`end ${l}`);
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

    expect(order).toEqual(['start A', 'end A', 'start B', 'end B']);
  });

  it('policies with DISTINCT names on one role still run at once (no slowdown, go-to-k/cdkd#4227)', async () => {
    prime(
      { Role: ROLE_STATE, A: recordedPolicy('a'), B: recordedPolicy('b') },
      [rename('A', 'a', 'a2'), rename('B', 'b', 'b2')],
      [['A', 'B']]
    );
    const { events, inFlightMax } = gatedUpdates();

    await engine().deploy('S', {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        A: policyTemplate('a2'),
        B: policyTemplate('b2'),
      },
    });

    expect(inFlightMax()).toBe(2);
    expect(events.slice(0, 2)).toEqual(['start A', 'start B']);
  });

  it("a role update is handed the predicate: a name its Policies drops that a completed policy put is kept (go-to-k/cdkd#4227)", async () => {
    prime(
      {
        Role: {
          physicalId: 'role-phys',
          resourceType: 'AWS::IAM::Role',
          properties: { Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
        },
      },
      [
        {
          logicalId: 'P',
          changeType: 'CREATE',
          resourceType: POLICY,
          desiredProperties: { PolicyName: 'x', PolicyDocument: DOC, Roles: ['role-phys'] },
        },
        {
          logicalId: 'Role',
          changeType: 'UPDATE',
          resourceType: 'AWS::IAM::Role',
          currentProperties: { Policies: [{ PolicyName: 'x', PolicyDocument: DOC }] },
          desiredProperties: { Policies: [] },
          propertyChanges: [{ path: 'Policies', oldValue: [], newValue: [], requiresReplacement: false }],
        },
      ],
      [['P'], ['Role']]
    );
    queries = { Role: [['role', 'role-phys', 'x']] };
    provider.update!.mockImplementation(
      (l: string, _p: string, _t: string, _props: unknown, _prev: unknown, ctx: never) => {
        ask(l, ctx);
        return Promise.resolve({ physicalId: 'role-phys' });
      }
    );

    await engine().deploy('S', {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: { Policies: [] } },
        P: policyTemplate('x', ['role-phys']),
      },
    });

    expect(answers).toEqual({ Role: [true] });
  });
  describe('a standalone AWS::IAM::RolePolicy (go-to-k/cdkd#4821)', () => {
    const ROLE_POLICY = 'AWS::IAM::RolePolicy';
    const recordedRolePolicy = (name: string): ResourceState => ({
      physicalId: `${name}|role-phys`,
      resourceType: ROLE_POLICY,
      properties: { PolicyName: name, RoleName: 'role-phys', PolicyDocument: DOC },
      provisionedBy: 'cc-api',
    });
    const rolePolicyRename = (logicalId: string, from: string, to: string): ResourceChange => ({
      logicalId,
      changeType: 'UPDATE',
      resourceType: ROLE_POLICY,
      currentProperties: { PolicyName: from, RoleName: 'role-phys', PolicyDocument: DOC },
      desiredProperties: { PolicyName: to, RoleName: { Ref: 'Role' }, PolicyDocument: DOC },
      propertyChanges: [{ path: 'PolicyName', oldValue: from, newValue: to, requiresReplacement: true }],
    });
    const rolePolicyTemplate = (name: string) => ({
      Type: ROLE_POLICY,
      Properties: { PolicyName: name, RoleName: { Ref: 'Role' }, PolicyDocument: DOC },
    });

    it('a swap with an AWS::IAM::Policy: the policy runs first, and the replaced RolePolicy leaves the name the policy took', async () => {
      // One level, and `A` sorts first: the #4227 rule alone runs the RolePolicy first.
      prime(
        { Role: ROLE_STATE, A: recordedRolePolicy('y'), B: recordedPolicy('x') },
        [rolePolicyRename('A', 'y', 'x'), rename('B', 'x', 'y')],
        [['A', 'B']]
      );
      queries = { A: [['role', 'role-phys', 'y']], B: [['role', 'role-phys', 'x']] };

      await engine().deploy('S', {
        Resources: {
          Role: { Type: 'AWS::IAM::Role', Properties: {} },
          A: rolePolicyTemplate('x'),
          B: policyTemplate('y'),
        },
      });

      // B releases `x` before A's create takes it (Cloud Control refuses a
      // create while the name is on the role) ...
      const bUpdate = provider.update!.mock.calls.findIndex((c) => c[0] === 'B');
      const aCreate = provider.create!.mock.calls.findIndex((c) => c[0] === 'A');
      expect(bUpdate).toBeGreaterThanOrEqual(0);
      expect(aCreate).toBeGreaterThanOrEqual(0);
      expect(provider.update!.mock.invocationCallOrder[bUpdate]!).toBeLessThan(
        provider.create!.mock.invocationCallOrder[aCreate]!
      );
      // ... B's removal of `x` proceeds (A has not written it yet), and A's
      // delete of its old `y` sees B's completed write of it.
      expect(answers).toEqual({ A: [true], B: [false] });
      const aDelete = provider.delete!.mock.calls.find((c) => c[0] === 'A')!;
      expect(aDelete[3]).toMatchObject({ PolicyName: 'y', RoleName: 'role-phys' });
    });

    it('a RolePolicy rename that collides with nothing: its old-name delete is asked and sees no claim', async () => {
      prime(
        { Role: ROLE_STATE, A: recordedRolePolicy('y'), B: recordedPolicy('x') },
        [rolePolicyRename('A', 'y', 'w'), rename('B', 'x', 'z')],
        [['A', 'B']]
      );
      queries = { A: [['role', 'role-phys', 'y']] };

      await engine().deploy('S', {
        Resources: {
          Role: { Type: 'AWS::IAM::Role', Properties: {} },
          A: rolePolicyTemplate('w'),
          B: policyTemplate('z'),
        },
      });

      expect(answers['A']).toEqual([false]);
    });

    it('a RolePolicy DELETE row sees the completed AWS::IAM::Policy that took its name', async () => {
      prime(
        { Role: ROLE_STATE, Old: recordedRolePolicy('x'), B: recordedPolicy('y') },
        [
          rename('B', 'y', 'x'),
          { logicalId: 'Old', changeType: 'DELETE', resourceType: ROLE_POLICY, currentProperties: {} },
        ],
        [['B']]
      );
      queries = { Old: [['role', 'role-phys', 'x'], ['role', 'role-phys', 'y']] };

      await engine().deploy('S', {
        Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} }, B: policyTemplate('x') },
      });

      expect(answers['Old']).toEqual([true, false]);
    });

    it('an AWS::IAM::Policy delete sees a completed RolePolicy create of its name', async () => {
      prime(
        { Role: ROLE_STATE, Old: recordedPolicy('x') },
        [
          {
            logicalId: 'New',
            changeType: 'CREATE',
            resourceType: ROLE_POLICY,
            desiredProperties: { PolicyName: 'x', RoleName: { Ref: 'Role' }, PolicyDocument: DOC },
          },
          { logicalId: 'Old', changeType: 'DELETE', resourceType: POLICY, currentProperties: {} },
        ],
        [['New']]
      );
      queries = { Old: [['role', 'role-phys', 'x']] };

      await engine().deploy('S', {
        Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} }, New: rolePolicyTemplate('x') },
      });

      expect(answers['Old']).toEqual([true]);
    });
  });
});
