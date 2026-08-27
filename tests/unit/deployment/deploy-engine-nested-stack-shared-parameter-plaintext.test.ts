/**
 * TWO nested-stack `Parameters` resolving to ONE plaintext keep DISTINCT
 * expressions across the parent -> child handoff (issue
 * [#2291](https://github.com/go-to-k/cdkd/issues/2291)).
 *
 * The parent resolves the child's `Parameters` block, so the child receives
 * PLAINTEXT and spells its consumption as `{Ref: <ParamName>}`. Two independent
 * causes made a child leaf persist its SIBLING's expression:
 *
 * 1. `RecordedSecretValues` is keyed by PLAINTEXT, so the parent's own bag
 *    collapses two expressions onto one entry BEFORE the child engine is built.
 * 2. `{Ref: P}` gives the position pass nothing to certify against, so even an
 *    uncollapsed bag could not have been used.
 *
 * `resolveReplayProps` re-resolves whatever is persisted, so `cdkd drift
 * --revert` / rollback would push the WRONG secret VERSION to the live
 * resource.
 *
 * WHAT THIS FILE FENCES THAT `secret-redaction-nested-parameter-source.test.ts`
 * CANNOT: the ENGINE wiring. That file drives the store's functions directly;
 * this one drives `DeployEngine.deploy` end to end, so it fails if
 * `buildResolverContext` stops copying the associations onto a child resource's
 * bag, if `redactParametersForDiff` stops answering per parameter, or if EITHER
 * of the parent's two recording call sites stops recording — the CREATE arm and
 * the UPDATE arm, each driven by its own case.
 *
 * THE UPDATE CASE EXISTS BECAUSE THE FIRST DRAFT OF THIS HEADER LIED. It
 * claimed both call sites were covered while every case primed
 * `changeType: 'CREATE'`, so deleting the UPDATE arm's
 * `recordNestedStackParameterExpressions` left all 18 cases green (probe P8 in
 * review). An overstated invariant is worse than a missing one: it stops the
 * next reader looking.
 *
 * THE DISCRIMINATING SHAPE IS TWO LEAVES IN ONE RESOURCE. `perResourceSecrets`
 * is keyed by logical id, so two resources get two bags each holding a single
 * pair and would pass with the collapse fully intact.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  redactSecretsForState,
  inheritNestedStackParameterAssociations,
  recordNestedStackParameterExpressions,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { getCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
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

const SECRET_ID = 'prod/db/cred';
/**
 * Two spellings of ONE reference. An empty version-stage defaults to
 * `AWSCURRENT`, so these resolve identically. Neither is a substring of the
 * other, so an assertion naming one cannot be satisfied by the other.
 */
const EXPR_A = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:handoff::}}`;
const EXPR_B = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:handoff:AWSCURRENT:}}`;
const SHARED = 'sh4red-h4ndoff-pl4intext-2291';

const PARAM_A = 'SecretStageA';
const PARAM_B = 'SecretStageB';

/**
 * An `Fn::Sub` over the LOSING parameter — the one whose expression is NOT the
 * collapsed map's survivor. Pointing it at `PARAM_B` would pass either way.
 */
const SUB_TEMPLATE = `postgres://u:\${${PARAM_A}}@host`;

/**
 * The resolver is mocked, and the mock has to FAIL THE WAY PRODUCTION FAILS.
 * Two behaviours are mirrored from the real one, and each is load-bearing here:
 *
 *  - a whole `{{resolve:...}}` token resolves to its plaintext AND records
 *    `plaintext -> expression` into the pass's own bag. Because the bag is
 *    keyed by plaintext, recording both tokens of a coinciding pair leaves ONE
 *    entry — the collapse this issue is about, reproduced rather than assumed;
 *  - `{Ref: <Param>}` resolves out of `ctx.parameters` and copies any inherited
 *    pair the value carries into the consuming resource's bag
 *    (`recordInheritedParameterSecrets`, issue #2087), which is what puts the
 *    plaintext in the child bag at all.
 */
const seen = vi.hoisted(() => ({ conditions: [] as ResolverContext[] }));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async () => {
  const { MIN_NEEDLE_LENGTH } = await import('../../../src/deployment/secret-redaction.js');
  const SECRET_VALUES: Record<string, string> = {
    [`{{resolve:secretsmanager:${'prod/db/cred'}:SecretString:handoff::}}`]:
      'sh4red-h4ndoff-pl4intext-2291',
    [`{{resolve:secretsmanager:${'prod/db/cred'}:SecretString:handoff:AWSCURRENT:}}`]:
      'sh4red-h4ndoff-pl4intext-2291',
  };

  const { inheritedParameterExpression } = await import(
    '../../../src/deployment/secret-redaction.js'
  );

  const recordInherited = (name: string, value: unknown, ctx: ResolverContext): void => {
    const inherited = ctx.inheritedSecrets;
    const recorded = ctx.recordedSecretValues;
    if (!inherited || inherited.size === 0 || !recorded) return;
    const candidates: string[] =
      typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    // Issue #2291 round 2, mirrored from the real
    // `recordInheritedParameterSecrets`: THIS parameter's own expression wins
    // over the collapsed map's survivor.
    //
    // MIRRORED, NOT FENCED. Because this is a re-implementation, deleting the
    // REAL override leaves this whole file green (measured: `rc=0, 8 passed`) —
    // so nothing here is evidence that production does it. What fences the
    // override is `intrinsic-resolver-inherited-parameter-secrets.test.ts`,
    // which drives the REAL resolver. The mirror exists for the opposite
    // reason: a mock that kept copying the SURVIVOR would fail the way
    // production no longer does, and the engine-level assertions below would
    // then be about the mock rather than about the wiring.
    for (const [plaintext, expression] of inherited) {
      const hit = candidates.some(
        (candidate) =>
          candidate === plaintext ||
          (plaintext.length >= MIN_NEEDLE_LENGTH && candidate.includes(plaintext))
      );
      if (hit) {
        // Asked PER PLAINTEXT since issue #2327, mirroring production: the
        // earlier spelling asked about the whole `value` and gated on
        // `plaintext === value`, which cannot hold once `coerceParameterValue`
        // has turned a `CommaDelimitedList` parameter into an ARRAY.
        const own = inheritedParameterExpression(inherited, name, plaintext);
        recorded.set(plaintext, typeof own === 'string' ? own : expression);
      }
    }
  };

  const resolveOne = (value: unknown, ctx: ResolverContext): unknown => {
    if (typeof value === 'string') {
      const plaintext = SECRET_VALUES[value];
      if (plaintext === undefined) return value;
      // The GHSA recording: keyed by PLAINTEXT, so the second token of a
      // coinciding pair OVERWRITES the first.
      ctx.recordedSecretValues?.set(plaintext, value);
      return plaintext;
    }
    if (Array.isArray(value)) return value.map((v) => resolveOne(v, ctx));
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj['Ref'] === 'string') {
        const name = obj['Ref'];
        const params = (ctx.parameters ?? {}) as Record<string, unknown>;
        if (!(name in params)) return obj;
        const resolved = params[name];
        recordInherited(name, resolved, ctx);
        return resolved;
      }
      // `Fn::Sub` over parameter placeholders, mirroring the real
      // `resolveSub` -> `resolveRef` route: it is the shape whose ONLY
      // redaction is the plaintext-keyed value scan, because
      // `crossStackSourceKey`'s `Fn::Sub` arm refuses a non-dotted placeholder.
      if (typeof obj['Fn::Sub'] === 'string') {
        const params = (ctx.parameters ?? {}) as Record<string, unknown>;
        return obj['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
          if (!(name in params)) return whole;
          const resolved = params[name];
          recordInherited(name, resolved, ctx);
          return String(resolved);
        });
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = resolveOne(v, ctx);
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
          Promise.resolve(resolveOne(value, ctx ?? ({} as ResolverContext)))
        ),
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

describe('DeployEngine — two child Parameters resolving to ONE plaintext (#2291)', () => {
  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;
  /** What `withCurrentResourceSecrets` bound around the provider call. */
  let boundSecrets: RecordedSecretValues | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    seen.conditions.length = 0;
    boundSecrets = undefined;
    mockProvider = {
      create: vi.fn().mockImplementation(() => {
        // `NestedStackProvider` reads exactly this to seed the child engine.
        boundSecrets = getCurrentResourceSecrets();
        return Promise.resolve({ physicalId: 'phys-1' });
      }),
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
      getExecutionLevels: vi.fn().mockReturnValue([['Child']]),
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

  function makeEngine(options: Record<string, unknown>): DeployEngine {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...options } as never,
      'us-east-1'
    );
  }

  // ----- the PARENT half: the row that hands the pair down -----

  const NESTED_PROPS = {
    TemplateURL: 'https://s3.amazonaws.com/bucket/child.json',
    Parameters: { [PARAM_A]: EXPR_A, [PARAM_B]: EXPR_B },
  };
  const parentTemplate: CloudFormationTemplate = {
    Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Properties: NESTED_PROPS } },
  };

  function primeParentCreate(): void {
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Child',
          {
            logicalId: 'Child',
            changeType: 'CREATE',
            resourceType: 'AWS::CloudFormation::Stack',
            desiredProperties: NESTED_PROPS,
          },
        ],
      ])
    );
  }

  it('records a per-PARAMETER association on the bag the nested-stack provider is handed', async () => {
    primeParentCreate();
    await makeEngine({}).deploy('Parent', parentTemplate);

    // THE MEASURED PRE-CONDITION, asserted rather than assumed: the bag the
    // child inherits genuinely cannot tell the two apart on its own.
    expect(boundSecrets).toBeDefined();
    expect(boundSecrets!.size).toBe(1);
    expect(boundSecrets!.get(SHARED)).toBe(EXPR_B);

    // The parent's OWN state is already correct (its source leaves are whole
    // tokens, which the position pass certifies per leaf) — the premise the
    // handoff has to preserve.
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    const savedParams = (saved.resources['Child']!.properties['Parameters'] ?? {}) as Record<
      string,
      unknown
    >;
    expect(savedParams[PARAM_A]).toBe(EXPR_A);
    expect(savedParams[PARAM_B]).toBe(EXPR_B);

    // And a child resource's bag built off that same object now separates the
    // two — which is the whole point of the handoff.
    const childBag: RecordedSecretValues = new Map(boundSecrets!);
    inheritNestedStackParameterAssociations(childBag, boundSecrets!);
    const persisted = redactSecretsForState(
      { Value: SHARED, Description: SHARED },
      childBag,
      { Value: { Ref: PARAM_A }, Description: { Ref: PARAM_B } }
    ) as Record<string, unknown>;
    expect(persisted['Value']).toBe(EXPR_A);
    expect(persisted['Description']).toBe(EXPR_B);
  });

  it('records the same per-PARAMETER association from the UPDATE call site (#2291)', async () => {
    // THE SECOND CALL SITE. Every other case here primes `CREATE`, so deleting
    // the UPDATE arm's `recordNestedStackParameterExpressions` left them all
    // green (probe P8 in review). A nested stack that ALREADY exists takes this
    // arm on every redeploy, which is the common case in production.
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 9,
        stackName: 'Parent',
        region: 'us-east-1',
        resources: {
          Child: {
            physicalId: 'phys-1',
            resourceType: 'AWS::CloudFormation::Stack',
            properties: {
              TemplateURL: 'https://s3.amazonaws.com/bucket/old.json',
              Parameters: { [PARAM_A]: EXPR_A, [PARAM_B]: EXPR_B },
            },
          },
        },
        outputs: {},
        lastModified: 1,
      } as unknown as StackState,
      etag: 'e',
    });
    mockProvider.update!.mockResolvedValue({ physicalId: 'phys-1' });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Child',
          {
            logicalId: 'Child',
            changeType: 'UPDATE',
            resourceType: 'AWS::CloudFormation::Stack',
            desiredProperties: NESTED_PROPS,
            currentProperties: {
              TemplateURL: 'https://s3.amazonaws.com/bucket/old.json',
              Parameters: { [PARAM_A]: EXPR_A, [PARAM_B]: EXPR_B },
            },
          },
        ],
      ])
    );
    // `withCurrentResourceSecrets` binds the bag around the UPDATE call too.
    mockProvider.update!.mockImplementation(() => {
      boundSecrets = getCurrentResourceSecrets();
      return Promise.resolve({ physicalId: 'phys-1' });
    });

    await makeEngine({}).deploy('Parent', parentTemplate);

    // The arm actually ran — otherwise everything below is vacuous.
    expect(mockProvider.update!.mock.calls.length).toBe(1);
    expect(boundSecrets).toBeDefined();
    expect(boundSecrets!.size).toBe(1);

    const childBag: RecordedSecretValues = new Map(boundSecrets!);
    inheritNestedStackParameterAssociations(childBag, boundSecrets!);
    const persisted = redactSecretsForState(
      { Value: SHARED, Description: SHARED },
      childBag,
      { Value: { Ref: PARAM_A }, Description: { Ref: PARAM_B } }
    ) as Record<string, unknown>;
    expect(persisted['Value']).toBe(EXPR_A);
    expect(persisted['Description']).toBe(EXPR_B);
  });

  it('records nothing for a row that is not a nested stack', async () => {
    // Scope control: the recorder is gated on the resource TYPE, so an ordinary
    // resource carrying a `Parameters` map contributes no associations.
    const props = { Parameters: { [PARAM_A]: EXPR_A, [PARAM_B]: EXPR_B } };
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Child',
          {
            logicalId: 'Child',
            changeType: 'CREATE',
            resourceType: 'AWS::SageMaker::Pipeline',
            desiredProperties: props,
          },
        ],
      ])
    );
    await makeEngine({}).deploy('Parent', {
      Resources: { Child: { Type: 'AWS::SageMaker::Pipeline', Properties: props } },
    });

    const childBag: RecordedSecretValues = new Map(boundSecrets!);
    inheritNestedStackParameterAssociations(childBag, boundSecrets!);
    const persisted = redactSecretsForState(
      { Value: SHARED, Description: SHARED },
      childBag,
      { Value: { Ref: PARAM_A }, Description: { Ref: PARAM_B } }
    ) as Record<string, unknown>;
    expect(persisted['Value']).toBe(EXPR_B);
    expect(persisted['Description']).toBe(EXPR_B);
  });

  // ----- the CHILD half: the engine that consumes the pair -----

  /** The parent bag exactly as the parent half above produces it. */
  function inheritedFromParent(): RecordedSecretValues {
    const parent: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SHARED, [PARAM_B]: SHARED } },
      NESTED_PROPS
    );
    return parent;
  }

  const childTemplate: CloudFormationTemplate = {
    Parameters: { [PARAM_A]: { Type: 'String' }, [PARAM_B]: { Type: 'String' } },
    Resources: {
      // ONE resource, TWO leaves. Two resources would get two bags and pass
      // with the collapse intact.
      ChildRes: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Type: 'String', Value: { Ref: PARAM_A }, Description: { Ref: PARAM_B } },
      },
      // THE EMBEDDING SHAPE, in its OWN resource so its bag is deterministic:
      // one parameter in, one pair recorded. `crossStackSourceKey`'s `Fn::Sub`
      // arm refuses a non-dotted placeholder, so this leaf can only ever be
      // redacted by the plaintext-keyed VALUE SCAN — which is why it is the one
      // that diverged from the per-parameter diff side.
      ChildSubRes: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Type: 'String', Value: { 'Fn::Sub': SUB_TEMPLATE } },
      },
    },
  };

  function makeChildEngine(inherited?: RecordedSecretValues): DeployEngine {
    return makeEngine({
      parameters: { [PARAM_A]: SHARED, [PARAM_B]: SHARED },
      ...(inherited && { inheritedSecrets: inherited }),
      parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
    });
  }

  function primeChildCreate(): void {
    mockDagBuilder.getExecutionLevels!.mockReturnValue([['ChildRes', 'ChildSubRes']]);
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
        [
          'ChildSubRes',
          {
            logicalId: 'ChildSubRes',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: childTemplate.Resources!['ChildSubRes']!.Properties!,
          },
        ],
      ])
    );
  }

  it('persists each child leaf on ITS OWN expression while AWS gets the plaintext', async () => {
    primeChildCreate();
    await makeChildEngine(inheritedFromParent()).deploy('Parent~Child', childTemplate);

    // AWS got the real value on both leaves — a fix that redacted the
    // PROVISIONING side would ship a literal token into the resource.
    const createdProps = mockProvider.create!.mock.calls[0]![2] as Record<string, unknown>;
    expect(createdProps['Value']).toBe(SHARED);
    expect(createdProps['Description']).toBe(SHARED);

    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    const props = saved.resources['ChildRes']!.properties;
    expect(props['Value']).toBe(EXPR_A);
    expect(props['Description']).toBe(EXPR_B);
    // The GHSA invariant still holds: no plaintext anywhere in the child state.
    expect(JSON.stringify(saved)).not.toContain(SHARED);
  });

  it('keeps an EMBEDDED leaf and the DIFF side on the SAME expression (#2291 round 2)', async () => {
    // THE REGRESSION ROUND 1 INTRODUCED. Making `redactParametersForDiff`
    // answer per parameter while the persist side still took the collapsed
    // survivor for every EMBEDDING shape left the two halves disagreeing: the
    // child reported an UPDATE on this resource on every single deploy, and on
    // a create-only property that is a perpetual REPLACEMENT of a live
    // resource. Both halves are asserted HERE, in one case, because the defect
    // is the DISAGREEMENT — either half alone reads as correct.
    primeChildCreate();
    await makeChildEngine(inheritedFromParent()).deploy('Parent~Child', childTemplate);

    const expectedEmbedded = `postgres://u:${EXPR_A}@host`;

    // AWS got the real value.
    const createdByLogicalId = new Map(
      mockProvider.create!.mock.calls.map((call) => [
        call[0] as string,
        call[2] as Record<string, unknown>,
      ])
    );
    expect(createdByLogicalId.get('ChildSubRes')!['Value']).toBe(
      `postgres://u:${SHARED}@host`
    );

    // PERSIST half: the value scan substitutes the LOSING parameter's own
    // expression. Under the collapse this was `EXPR_B`.
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['ChildSubRes']!.properties['Value']).toBe(expectedEmbedded);
    expect(JSON.stringify(saved)).not.toContain(SHARED);

    // DIFF half: the desired side computes the same string, so the comparison
    // converges instead of reporting a change forever.
    const diffResolveFn = mockDiffCalculator.calculateDiff!.mock.calls.at(-1)![2] as (
      v: unknown
    ) => Promise<unknown>;
    await expect(diffResolveFn({ 'Fn::Sub': SUB_TEMPLATE })).resolves.toBe(expectedEmbedded);
  });

  it('collapses onto the survivor when the parent recorded no association (the pre-fix answer)', async () => {
    // The discriminator: the SAME engine, the SAME template, an inherited bag
    // with no per-parameter table behind it. Without this the case above could
    // be passing for a reason belonging to the harness.
    primeChildCreate();
    await makeChildEngine(new Map([[SHARED, EXPR_B]])).deploy('Parent~Child', childTemplate);

    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    const props = saved.resources['ChildRes']!.properties;
    expect(props['Value']).toBe(EXPR_B);
    expect(props['Description']).toBe(EXPR_B);
  });

  it('binds the DIFF pass to the SAME per-parameter expressions, so the child reports no spurious UPDATE', async () => {
    // The coupling the persist fix creates: once state holds each leaf's own
    // expression, a desired side that still hands both parameters the SURVIVOR
    // reports an UPDATE on the losing one forever.
    mockDagBuilder.getExecutionLevels!.mockReturnValue([['ChildRes']]);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(new Map<string, ResourceChange>());
    mockDiffCalculator.hasChanges!.mockReturnValue(false);
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 9,
        stackName: 'Parent~Child',
        region: 'us-east-1',
        resources: {
          ChildRes: {
            physicalId: 'phys-1',
            resourceType: 'AWS::SSM::Parameter',
            // What the persist half above writes.
            properties: { Type: 'String', Value: EXPR_A, Description: EXPR_B },
          },
        },
        outputs: {},
        lastModified: 1,
      } as unknown as StackState,
      etag: 'e',
    });

    await makeChildEngine(inheritedFromParent()).deploy('Parent~Child', childTemplate);

    const diffResolveFn = mockDiffCalculator.calculateDiff!.mock.calls.at(-1)![2] as (
      v: unknown
    ) => Promise<unknown>;
    await expect(diffResolveFn({ Ref: PARAM_A })).resolves.toBe(EXPR_A);
    await expect(diffResolveFn({ Ref: PARAM_B })).resolves.toBe(EXPR_B);

    // The CONDITION pass must NOT be redacted: an `Fn::Equals` over a parameter
    // has to compare the value the stack deployed with. This is what makes the
    // assertion above about the DIFF context specifically.
    expect(seen.conditions).not.toHaveLength(0);
    const conditionParams = seen.conditions.at(-1)!.parameters as Record<string, unknown>;
    expect(conditionParams[PARAM_A]).toBe(SHARED);
    expect(conditionParams[PARAM_B]).toBe(SHARED);
  });

  it('leaves a non-secret parameter alone on the diff side', async () => {
    mockDagBuilder.getExecutionLevels!.mockReturnValue([['ChildRes']]);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(new Map<string, ResourceChange>());
    mockDiffCalculator.hasChanges!.mockReturnValue(false);
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 9,
        stackName: 'Parent~Child',
        region: 'us-east-1',
        resources: {},
        outputs: {},
        lastModified: 1,
      } as unknown as StackState,
      etag: 'e',
    });

    const engine = makeEngine({
      parameters: { [PARAM_A]: SHARED, [PARAM_B]: 'ordinary-public-config' },
      inheritedSecrets: inheritedFromParent(),
    });
    await engine.deploy('Parent~Child', childTemplate);

    const diffResolveFn = mockDiffCalculator.calculateDiff!.mock.calls.at(-1)![2] as (
      v: unknown
    ) => Promise<unknown>;
    await expect(diffResolveFn({ Ref: PARAM_A })).resolves.toBe(EXPR_A);
    await expect(diffResolveFn({ Ref: PARAM_B })).resolves.toBe('ordinary-public-config');
  });
});
