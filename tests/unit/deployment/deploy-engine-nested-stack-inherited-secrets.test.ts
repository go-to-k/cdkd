/**
 * A nested-stack CHILD engine redacts the secrets its PARENT resolved on its
 * behalf (issue [#1903](https://github.com/go-to-k/cdkd/issues/1903)).
 *
 * The chain the GHSA fix rests on is `plaintext -> {{resolve:...}} expression`
 * recorded during resolution and read at the state-save choke point. A nested
 * stack breaks it: the parent resolves the child's `Parameters` block, so the
 * child receives PLAINTEXT and its own template spells the consumption as
 * `{Ref: <ParamName>}` — an intrinsic OBJECT, never a `{{resolve:` string. The
 * child's `recordedSecretValues` therefore came out empty and its `state.json`
 * persisted the decrypted secret.
 *
 * The fix seeds `DeployEngineOptions.inheritedSecrets` into every per-resource
 * map the child builds. Both halves are exercised here, because the fix is only
 * correct with both: the PERSIST side (state holds the expression) and the DIFF
 * side (the comparison binds the expression too, or the child reports a
 * spurious UPDATE forever).
 *
 * The resolver is mocked with a `{Ref: <name>}` implementation that resolves
 * against `ctx.parameters` and records NOTHING — which is precisely the real
 * behaviour for this shape, and is what makes the seed the only thing that can
 * produce a redaction here.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
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

const SECRET_PLAINTEXT = 'nested-inherited-plaintext-1903';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/child/db:SecretString:password::}}';
const PARAM = 'referencetoParentDbPassword';

/**
 * The contexts each resolver entry point was called with, so a test can assert
 * WHICH bag a given pass was bound to.
 */
const seen = vi.hoisted(() => ({
  resolve: [] as Array<{ value: unknown; ctx: ResolverContext }>,
  conditions: [] as ResolverContext[],
}));

/**
 * Resolves `{Ref: <name>}` out of `ctx.parameters` and recurses through plain
 * containers, like the real resolver. Records NOTHING into
 * `recordedSecretValues` — a `{Ref: ...}` is not a dynamic reference, which is
 * the whole reason the child could not redact on its own.
 */
function resolveAgainstParameters(value: unknown, ctx: ResolverContext): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveAgainstParameters(v, ctx));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['Ref'] === 'string') {
      const name = obj['Ref'];
      const params = (ctx.parameters ?? {}) as Record<string, unknown>;
      return name in params ? params[name] : obj;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveAgainstParameters(v, ctx);
    return out;
  }
  return value;
}

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown, ctx: ResolverContext) => {
      seen.resolve.push({ value, ctx });
      return Promise.resolve(resolveAgainstParameters(value, ctx ?? ({} as ResolverContext)));
    }),
    // The child engine's parameters come from `DeployEngineOptions.parameters`
    // (what `NestedStackProvider` forwards), so mirror that binding.
    resolveParameters: vi
      .fn()
      .mockImplementation((_tpl: unknown, supplied?: Record<string, string>) => ({
        ...(supplied ?? {}),
      })),
    evaluateConditions: vi.fn().mockImplementation((ctx: ResolverContext) => {
      seen.conditions.push(ctx);
      return Promise.resolve({});
    }),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine — nested-stack child inherits the parent secrets map (#1903)', () => {
  const childStackName = 'Parent~Child';

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    seen.resolve.length = 0;
    seen.conditions.length = 0;
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'child-res-phys' }),
      update: vi.fn(),
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
      getExecutionLevels: vi.fn().mockReturnValue([['ChildRes']]),
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

  /** The child template: consumes the down-passed parameter, no `{{resolve:` anywhere. */
  const childTemplate: CloudFormationTemplate = {
    Parameters: { [PARAM]: { Type: 'String' } },
    Resources: {
      ChildRes: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Type: 'String', Value: { Ref: PARAM } },
      },
    },
  };

  function makeChildEngine(inherited?: Map<string, string>): DeployEngine {
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
        ...(inherited && { inheritedSecrets: inherited }),
        parentStackInfo: {
          parentStack: 'Parent',
          parentLogicalId: 'Child',
          parentRegion: 'us-east-1',
        },
      },
      'us-east-1'
    );
  }

  function primeCreate(): void {
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'ChildRes',
          {
            logicalId: 'ChildRes',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: childTemplate.Resources!['ChildRes']!.Properties!,
          },
        ],
      ])
    );
  }

  it('persists the {{resolve:...}} expression in the CHILD state while the AWS call gets the plaintext', async () => {
    primeCreate();
    const engine = makeChildEngine(new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

    const result = await engine.deploy(childStackName, childTemplate);
    expect(result.created).toBe(1);

    // The provider — i.e. AWS — received the real value. A fix that redacted
    // the PROVISIONING side too would deploy a literal token into the resource.
    const createdProps = mockProvider.create!.mock.calls[0]![2] as Record<string, unknown>;
    expect(createdProps['Value']).toBe(SECRET_PLAINTEXT);

    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['ChildRes']!.properties['Value']).toBe(SECRET_EXPR);
    // Hard invariant: the plaintext appears NOWHERE in the child's serialized
    // state — the disclosure this issue is about.
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    // ...and the child record is still stamped as a nested child (the seed must
    // not have displaced the v6 parent identity).
    expect(saved.parentStack).toBe('Parent');
  });

  it('WITHOUT the inherited map the child still persists plaintext (the pre-fix state, kept as the discriminator)', async () => {
    // A top-level stack, or any caller that inherits nothing, is unchanged by
    // this issue — and this is also what makes the assertion above meaningful
    // rather than a property of the harness.
    primeCreate();
    const engine = makeChildEngine(undefined);

    await engine.deploy(childStackName, childTemplate);

    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['ChildRes']!.properties['Value']).toBe(SECRET_PLAINTEXT);
  });

  it('redacts a secret EMBEDDED in a longer parameter value, not only a whole-value match', async () => {
    // CDK routinely builds a connection string with `Fn::Sub`, so the parent
    // hands the child `postgres://u:<secret>@host` rather than the bare secret.
    const embedded = `postgres://app:${SECRET_PLAINTEXT}@db.internal:5432/app`;
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'ChildRes',
          {
            logicalId: 'ChildRes',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: { Type: 'String', Value: { Ref: PARAM } },
          },
        ],
      ])
    );
    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      {
        dryRun: false,
        parameters: { [PARAM]: embedded },
        inheritedSecrets: new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]),
      },
      'us-east-1'
    );

    await engine.deploy(childStackName, childTemplate);

    const createdProps = mockProvider.create!.mock.calls[0]![2] as Record<string, unknown>;
    expect(createdProps['Value']).toBe(embedded);

    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['ChildRes']!.properties['Value']).toBe(
      `postgres://app:${SECRET_EXPR}@db.internal:5432/app`
    );
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
  });

  it('binds the DIFF pass to the REDACTED parameters, so an unchanged child reports no spurious change', async () => {
    // The coupling this issue warns about, from the deploy side: once the
    // child's state holds the expression, a diff that still resolves
    // `{Ref: Param}` to plaintext reports an UPDATE on every single deploy.
    mockDiffCalculator.calculateDiff!.mockResolvedValue(new Map<string, ResourceChange>());
    mockDiffCalculator.hasChanges!.mockReturnValue(false);
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName: childStackName,
        region: 'us-east-1',
        resources: {
          ChildRes: {
            physicalId: 'child-res-phys',
            resourceType: 'AWS::SSM::Parameter',
            // What the PERSIST half above now writes.
            properties: { Type: 'String', Value: SECRET_EXPR },
          },
        },
        outputs: {},
        lastModified: 1,
      } as StackState,
      etag: 'e',
    });

    const engine = makeChildEngine(new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));
    await engine.deploy(childStackName, childTemplate);

    // Resolve the child's property through the very resolve function the diff
    // calculator was handed. Expression in, expression out — like-for-like
    // against the stored side.
    const diffResolveFn = mockDiffCalculator.calculateDiff!.mock.calls.at(-1)![2] as (
      v: unknown
    ) => Promise<unknown>;
    await expect(diffResolveFn({ Ref: PARAM })).resolves.toBe(SECRET_EXPR);

    // The CONDITION pass must NOT be redacted: an `Fn::Equals` over a parameter
    // has to compare the value the stack deployed with, and substituting the
    // expression there would flip the condition. This is the discriminator that
    // makes the assertion above about the DIFF context specifically.
    expect(seen.conditions).not.toHaveLength(0);
    expect((seen.conditions.at(-1)!.parameters as Record<string, unknown>)[PARAM]).toBe(
      SECRET_PLAINTEXT
    );
  });

  it('leaves a non-inherited parameter value alone on the diff side', async () => {
    // Scope control: only a value the parent recorded as a secret is rewritten.
    mockDiffCalculator.calculateDiff!.mockResolvedValue(new Map<string, ResourceChange>());
    mockDiffCalculator.hasChanges!.mockReturnValue(false);
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName: childStackName,
        region: 'us-east-1',
        resources: {},
        outputs: {},
        lastModified: 1,
      } as StackState,
      etag: 'e',
    });

    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      {
        dryRun: false,
        parameters: { [PARAM]: 'ordinary-public-config' },
        inheritedSecrets: new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]),
      },
      'us-east-1'
    );
    await engine.deploy(childStackName, childTemplate);

    const diffResolveFn = mockDiffCalculator.calculateDiff!.mock.calls.at(-1)![2] as (
      v: unknown
    ) => Promise<unknown>;
    await expect(diffResolveFn({ Ref: PARAM })).resolves.toBe('ordinary-public-config');
  });
});
