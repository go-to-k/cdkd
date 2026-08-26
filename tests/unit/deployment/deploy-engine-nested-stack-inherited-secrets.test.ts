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
 * The fix hands `DeployEngineOptions.inheritedSecrets` to the child's resolver
 * contexts, and the resolver records a pair into the CONSUMING resource's own
 * bag when that resource's `{Ref: <Param>}` resolves to a value carrying the
 * plaintext (issue [#2087](https://github.com/go-to-k/cdkd/issues/2087) — the
 * first cut pre-seeded every resource's bag instead, which over-redacted an
 * unrelated literal). Three halves are exercised here, because the fix is only
 * correct with all of them: the PERSIST side (state holds the expression), the
 * SCOPE (a resource that never referenced the parameter keeps its literal), and
 * the DIFF side (the comparison binds the expression too, or the child reports
 * a spurious UPDATE forever).
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
 * The resolver is mocked, so the mock has to FAIL THE WAY PRODUCTION FAILS.
 *
 * Since issue #2087 the `plaintext -> expression` pair is recorded by the
 * RESOLVER, at the moment a `{Ref: <Param>}` resolves to a value carrying that
 * plaintext (`IntrinsicFunctionResolver.recordInheritedParameterSecrets`) —
 * NOT pre-seeded into every context by the engine, which is what the first cut
 * did and what over-redacted an unrelated resource. A mock that "records
 * nothing" (this file's first shape, written against the pre-seed design) would
 * therefore let the pre-#2087 design pass every assertion below, so the two
 * arms of the real method are mirrored here instead:
 *
 *  - WHOLE VALUE at any length;
 *  - SUBSTRING at or above `MIN_NEEDLE_LENGTH`, imported from the same module
 *    the real one reads it from rather than re-spelled as a literal.
 *
 * What stays genuinely un-mocked is the thing under test: WHICH resource's bag
 * the pair lands in, and what the deploy engine's save choke point then does
 * with it. The resolver's own matching logic is fenced separately, against the
 * REAL resolver, in `intrinsic-resolver-inherited-parameter-secrets.test.ts`.
 */
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async () => {
  const { MIN_NEEDLE_LENGTH } = await import('../../../src/deployment/secret-redaction.js');

  const recordInherited = (value: unknown, ctx: ResolverContext): void => {
    const inherited = ctx.inheritedSecrets;
    const recorded = ctx.recordedSecretValues;
    if (!inherited || inherited.size === 0 || !recorded) return;
    const candidates: string[] = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : typeof value === 'string'
        ? [value]
        : [];
    for (const [plaintext, expression] of inherited) {
      const hit = candidates.some(
        (candidate) =>
          candidate === plaintext ||
          (plaintext.length >= MIN_NEEDLE_LENGTH && candidate.includes(plaintext))
      );
      if (hit) recorded.set(plaintext, expression);
    }
  };

  /**
   * Resolves `{Ref: <name>}` out of `ctx.parameters` and recurses through plain
   * containers, like the real resolver — recording an inherited pair on the way
   * out, exactly where the real `resolveRef` does.
   */
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
  };
});

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

  it('scopes the inherited pair to the resource that REFERENCED the parameter, leaving an unrelated literal that merely contains the plaintext verbatim (#2087)', async () => {
    // THE #2087 DISCRIMINATOR, and the probe input is chosen to discriminate:
    // the unrelated resource's literal CONTAINS the secret as a SUBSTRING. A
    // non-overlapping literal cannot see the defect at all, because
    // `redactSecretsForState` would leave it alone under either design.
    //
    // The first cut of #1903 pre-seeded the parent's bag into EVERY child
    // resource's `perResourceSecrets`, so this resource persisted
    // `my-{{resolve:...}}-bucket`. `redactParametersForDiff` rewrites only the
    // PARAMETERS, so the desired side kept `my-production-bucket` and every
    // later deploy saw a change — a perpetual UPDATE, or a perpetual
    // REPLACEMENT on a create-only property like `BucketName`.
    const SHORT_SECRET = 'production';
    const SHORT_EXPR = '{{resolve:secretsmanager:prod/app/env:SecretString:stage::}}';
    const OVERLAPPING_LITERAL = `my-${SHORT_SECRET}-bucket`;

    const twoResourceTemplate: CloudFormationTemplate = {
      Parameters: { [PARAM]: { Type: 'String' } },
      Resources: {
        ChildRes: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Type: 'String', Value: { Ref: PARAM } },
        },
        UnrelatedRes: {
          Type: 'AWS::SSM::Parameter',
          // No `Ref` anywhere: this resource never consumes the parameter. It
          // just happens to spell a name containing the secret's plaintext.
          Properties: { Type: 'String', Value: OVERLAPPING_LITERAL },
        },
      },
    };

    mockDagBuilder.getExecutionLevels!.mockReturnValue([['ChildRes', 'UnrelatedRes']]);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'ChildRes',
          {
            logicalId: 'ChildRes',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: twoResourceTemplate.Resources!['ChildRes']!.Properties!,
          },
        ],
        [
          'UnrelatedRes',
          {
            logicalId: 'UnrelatedRes',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: twoResourceTemplate.Resources!['UnrelatedRes']!.Properties!,
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
        parameters: { [PARAM]: SHORT_SECRET },
        inheritedSecrets: new Map([[SHORT_SECRET, SHORT_EXPR]]),
      },
      'us-east-1'
    );

    await engine.deploy(childStackName, twoResourceTemplate);

    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    // The genuine consumer is still redacted — the #1903 fix must survive the
    // narrowing, or this test would pass on a change that simply removed it.
    expect(saved.resources['ChildRes']!.properties['Value']).toBe(SHORT_EXPR);
    // ...and the bystander keeps its literal, byte for byte.
    expect(saved.resources['UnrelatedRes']!.properties['Value']).toBe(OVERLAPPING_LITERAL);
    // Stated as the user-visible consequence too: the desired side of the next
    // diff is this same literal, so an unchanged stack has nothing to update.
    expect(JSON.stringify(saved)).not.toContain(`my-${SHORT_EXPR}`);

    // AWS got the real values on both.
    const createdByLogicalId = new Map(
      mockProvider.create!.mock.calls.map((call) => [
        call[0] as string,
        call[2] as Record<string, unknown>,
      ])
    );
    expect(createdByLogicalId.get('ChildRes')!['Value']).toBe(SHORT_SECRET);
    expect(createdByLogicalId.get('UnrelatedRes')!['Value']).toBe(OVERLAPPING_LITERAL);
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
