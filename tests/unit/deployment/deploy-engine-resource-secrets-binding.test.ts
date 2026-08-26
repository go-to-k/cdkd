/**
 * EVERY provider CREATE / UPDATE site in `deploy-engine.ts` binds the
 * async-local secrets scope `NestedStackProvider` reads to seed a nested CHILD
 * engine (issue [#1903](https://github.com/go-to-k/cdkd/issues/1903), review
 * round 2).
 *
 * The sibling file `deploy-engine-nested-stack-inherited-secrets.test.ts` fences
 * what the child engine DOES with the seed. Nothing fenced the SIX bindings that
 * put it there: deleting `withCurrentResourceSecrets(...)` from any one of them
 * left the whole unit suite green, including the ordinary-UPDATE arm whose own
 * comment says "a nested stack that already exists silently keeps persisting the
 * parent's plaintext" — i.e. the #1903 arm itself. The integration test could
 * not see it either (its second deploy is a no-op, so
 * `NestedStackProvider.update` never fires).
 *
 * Six sites, one case each, because they are six code paths and a binding
 * applied to one says nothing about the others:
 *
 *  1. ordinary CREATE
 *  2. ordinary UPDATE                                  (the #1903 arm)
 *  3. property-driven replacement, create-then-destroy (CFn safe order)
 *  4. `--replace` delete-first fallback, after a create-first name collision
 *  5. `--recreate-via-cc-api` destroy-then-create
 *  6. UPDATE-not-supported fallback (DELETE -> CREATE)
 *
 * The observation seam is the one `NestedStackProvider.runChildDeploy` actually
 * uses — `getCurrentResourceSecrets()` read from INSIDE the provider call —
 * captured as a plain object rather than the live `Map`, because the engine
 * keeps mutating that map for the rest of the resource's turn.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { getCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// The REAL retry loop with its sleeps removed. The `--replace` delete-first
// fallback and the recreate path both wrap their create in `withRetry`, and the
// binding sits INSIDE the retried thunk — a pass-through stub would still call
// the thunk once, but the real loop is what proves nothing between the two
// loops re-enters unbound.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: (
      operation: () => Promise<unknown>,
      logicalId: string,
      opts: Record<string, unknown> = {}
    ) => actual.withRetry(operation, logicalId, { ...opts, sleep: async () => {} }),
  };
});

const SECRET_PLAINTEXT = 'nested-inherited-plaintext-1903';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/child/db:SecretString:password::}}';
const PARAM = 'referencetoParentDbPassword';

/**
 * The resolver is mocked, and the mock MUST FAIL THE WAY PRODUCTION FAILS: the
 * `plaintext -> expression` pair is recorded by the RESOLVER at the moment a
 * `{Ref: <Param>}` resolves, not pre-seeded by the engine. A mock that recorded
 * nothing would make every bag below empty, and every assertion here would then
 * pass on an engine that bound nothing at all.
 */
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async () => {
  const { MIN_NEEDLE_LENGTH } = await import('../../../src/deployment/secret-redaction.js');

  const recordInherited = (value: unknown, ctx: ResolverContext): void => {
    const inherited = ctx.inheritedSecrets;
    const recorded = ctx.recordedSecretValues;
    if (!inherited || inherited.size === 0 || !recorded) return;
    const candidates: string[] =
      typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    for (const [plaintext, expression] of inherited) {
      const hit = candidates.some(
        (candidate) =>
          candidate === plaintext ||
          (plaintext.length >= MIN_NEEDLE_LENGTH && candidate.includes(plaintext))
      );
      if (hit) recorded.set(plaintext, expression);
    }
  };

  const resolveAgainstParameters = (value: unknown, ctx: ResolverContext): unknown => {
    if (Array.isArray(value)) return value.map((v) => resolveAgainstParameters(v, ctx));
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj['Ref'] === 'string') {
        const name = obj['Ref'];
        const params = (ctx.parameters ?? {}) as Record<string, unknown>;
        if (!(name in params)) return obj;
        const resolved = params[name];
        recordInherited(resolved, ctx);
        return resolved;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = resolveAgainstParameters(v, ctx);
      return out;
    }
    return value;
  };

  return {
    IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
      getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
      resetPhysicalIdFallbackCount: vi.fn(),
      resolve: vi
        .fn()
        .mockImplementation((value: unknown, ctx: ResolverContext) =>
          Promise.resolve(resolveAgainstParameters(value, ctx ?? ({} as ResolverContext)))
        ),
      resolveParameters: vi
        .fn()
        .mockImplementation((_tpl: unknown, supplied?: Record<string, string>) => ({
          ...(supplied ?? {}),
        })),
      evaluateConditions: vi.fn().mockResolvedValue({}),
    })),
  };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK = 'Parent~Child';
const LOGICAL = 'ChildRes';
const TYPE = 'AWS::SSM::Parameter';

/** The child template: one resource that CONSUMES the down-passed parameter. */
const template: CloudFormationTemplate = {
  Parameters: { [PARAM]: { Type: 'String' } },
  Resources: {
    [LOGICAL]: { Type: TYPE, Properties: { Type: 'String', Value: { Ref: PARAM } } },
  },
};

const EXPECTED_BAG = { [SECRET_PLAINTEXT]: SECRET_EXPR };

describe('DeployEngine binds the nested-stack secrets scope at every provider call site (#1903)', () => {
  /** Bags observed from inside a provider call, keyed by the call that saw them. */
  let seenCreate: Array<Record<string, string> | undefined>;
  let seenUpdate: Array<Record<string, string> | undefined>;

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  function capture(into: Array<Record<string, string> | undefined>): void {
    const bag = getCurrentResourceSecrets();
    into.push(bag ? Object.fromEntries(bag) : undefined);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    seenCreate = [];
    seenUpdate = [];
    mockProvider = {
      create: vi.fn(async () => {
        capture(seenCreate);
        return { physicalId: 'new-phys' };
      }),
      update: vi.fn(async () => {
        capture(seenUpdate);
        return { physicalId: 'old-phys' };
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([[LOGICAL]]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  function engine(extraOptions: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      {
        dryRun: false,
        // What `NestedStackProvider.runChildDeploy` forwards: the parent's
        // ALREADY-RESOLVED parameter values, i.e. plaintext.
        parameters: { [PARAM]: SECRET_PLAINTEXT },
        inheritedSecrets: new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]),
        ...extraOptions,
      } as never,
      'us-east-1'
    );
  }

  const desiredProperties = template.Resources![LOGICAL]!.Properties!;

  function primeCreate(): void {
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [LOGICAL, { logicalId: LOGICAL, changeType: 'CREATE', resourceType: TYPE, desiredProperties }],
      ])
    );
  }

  /**
   * An UPDATE against an existing record. `requiresReplacement` drives the
   * three replacement arms; without it the engine takes the in-place UPDATE.
   */
  function primeUpdate(requiresReplacement = false): void {
    const current: ResourceState = {
      physicalId: 'old-phys',
      resourceType: TYPE,
      properties: { Type: 'String', Value: 'stale-previous-value' },
      attributes: {},
      dependencies: [],
    };
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 9,
        stackName: STACK,
        region: 'us-east-1',
        resources: { [LOGICAL]: current },
        outputs: {},
        lastModified: 1,
      },
      etag: 'e',
    });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          LOGICAL,
          {
            logicalId: LOGICAL,
            changeType: 'UPDATE',
            resourceType: TYPE,
            desiredProperties,
            currentProperties: current.properties,
            ...(requiresReplacement && {
              propertyChanges: [
                {
                  path: 'Value',
                  oldValue: 'stale-previous-value',
                  newValue: SECRET_PLAINTEXT,
                  requiresReplacement: true,
                },
              ],
            }),
          } as ResourceChange,
        ],
      ])
    );
  }

  it('site 1 — ordinary CREATE', async () => {
    primeCreate();
    await engine().deploy(STACK, template);
    expect(mockProvider.create).toHaveBeenCalledOnce();
    expect(seenCreate).toEqual([EXPECTED_BAG]);
  });

  it('site 2 — ordinary UPDATE (the #1903 arm: a nested stack that ALREADY exists)', async () => {
    primeUpdate();
    await engine().deploy(STACK, template);
    expect(mockProvider.update).toHaveBeenCalledOnce();
    expect(seenUpdate).toEqual([EXPECTED_BAG]);
  });

  it('site 3 — property-driven replacement, create-then-destroy', async () => {
    primeUpdate(true);
    // `AWS::SSM::Parameter` is a stateful recreate target, so a property-driven
    // replacement needs the user's explicit data-loss consent to get past the
    // guard and reach the call site under test.
    await engine({ forceStatefulRecreation: true }).deploy(STACK, template);
    expect(mockProvider.create).toHaveBeenCalledOnce();
    expect(mockProvider.delete).toHaveBeenCalled();
    expect(seenCreate).toEqual([EXPECTED_BAG]);
  });

  it('site 4 — the --replace delete-first fallback after a create-first name collision', async () => {
    primeUpdate(true);
    let creates = 0;
    mockProvider.create!.mockImplementation(async () => {
      capture(seenCreate);
      creates += 1;
      // The create-first attempt collides with the live resource holding the
      // name; `--replace` then deletes the old one and re-creates.
      if (creates === 1) throw new Error('Parameter already exists: old-phys');
      return { physicalId: 'new-phys' };
    });

    await engine({ replace: true, forceStatefulRecreation: true }).deploy(STACK, template);

    expect(creates).toBe(2);
    // BOTH attempts, not just the second: the binding lives inside the thunk,
    // so a fix that wrapped the retry loop instead of the call would leave one
    // of them unbound and only a per-attempt assertion could see it.
    expect(seenCreate).toEqual([EXPECTED_BAG, EXPECTED_BAG]);
  });

  it('site 5 — --recreate-via-cc-api destroy-then-create', async () => {
    primeUpdate();
    await engine({ recreateViaCcApiTargets: new Set([LOGICAL]) }).deploy(STACK, template);
    expect(mockProvider.delete).toHaveBeenCalled();
    expect(mockProvider.create).toHaveBeenCalledOnce();
    expect(seenCreate).toEqual([EXPECTED_BAG]);
  });

  it('site 6 — the UPDATE-not-supported fallback (DELETE -> CREATE)', async () => {
    primeUpdate();
    mockProvider.update!.mockImplementation(async () => {
      capture(seenUpdate);
      throw new Error('UnsupportedActionException: this type does not support UPDATE');
    });

    await engine().deploy(STACK, template);

    expect(mockProvider.delete).toHaveBeenCalled();
    expect(mockProvider.create).toHaveBeenCalledOnce();
    expect(seenCreate).toEqual([EXPECTED_BAG]);
  });

  it('scope control — a top-level engine binds an EMPTY bag, never undefined', async () => {
    // What makes every assertion above about the SEED rather than about the
    // harness: with nothing inherited the resolver records nothing, so the bag
    // is empty — but it is still BOUND, which is what the child engine reads as
    // "nothing to inherit" (the pre-#1903 behaviour). `undefined` here would
    // mean the site stopped binding altogether.
    primeCreate();
    const topLevel = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, parameters: { [PARAM]: SECRET_PLAINTEXT } } as never,
      'us-east-1'
    );
    await topLevel.deploy(STACK, template);
    expect(seenCreate).toEqual([{}]);
  });
});
