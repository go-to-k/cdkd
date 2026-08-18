/**
 * Issue #1919: an `Export.Name` spelled exactly like another declared output's
 * NAME made the two writers of the outputs bag disagree about the key space.
 *
 * `resolveOutputs` aliases each output's resolved value under its
 * `Export.Name` so a cross-stack consumer finds it, while a post-loop pass
 * writes the redaction POSITION source for every declared output NAME. On a
 * collision the alias put the EXPORTING output's resolved value under the
 * colliding key and the post-loop pass put the OTHER output's unresolved value
 * under the same key — so the persisted leaf was positioned by a source that
 * belongs to a different output. The fix skips the alias on such a collision
 * (and warns), which partitions the key space: declared output names belong to
 * the post-loop pass, export aliases to the in-loop one.
 *
 * ORDER MATTERS, per the issue's addendum. The corruption needs the EXPORTING
 * output to be iterated AFTER the colliding-name output; declared the other way
 * round the colliding-name output's own write reclaims the key on its later
 * iteration and only the alias is lost. Every corrupting case below therefore
 * declares the exporter LAST, and `deploy-engine-outputs-export-name-collision`
 * pins the reversed order separately as a labelled control.
 *
 * The resolver is mocked but SECRET-AWARE, keyed on the expression STRING (the
 * same device as `deploy-engine-sibling-redaction-writers.test.ts`): the
 * position pass copies a real `{{resolve:...}}` source leaf, so the source has
 * to be a genuine expression string or the redaction arm under test never runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// Two DIFFERENT secrets (distinct plaintexts, so nothing collapses in the
// value-keyed map) plus two public literals. The public ones are what make the
// collision OBSERVABLE: when both sides are secrets the position pass happens
// to rewrite the corrupted leaf back onto the key owner's own expression, so
// the persisted bytes coincide and only the warning distinguishes the two
// behaviors (pinned below as its own case).
const PLAINTEXT_A = 'alpha-plaintext-secret';
const EXPR_A = '{{resolve:secretsmanager:alpha:SecretString:password:AWSCURRENT}}';
const PLAINTEXT_B = 'beta-plaintext-secret';
const EXPR_B = '{{resolve:secretsmanager:beta:SecretString:password:AWSCURRENT}}';
const PUBLIC_A = 'alpha-public-endpoint';
const PUBLIC_B = 'beta-public-endpoint';

const SECRET_BY_EXPRESSION: Record<string, string> = {
  [EXPR_A]: PLAINTEXT_A,
  [EXPR_B]: PLAINTEXT_B,
};

function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (typeof value === 'string') {
    const plaintext = SECRET_BY_EXPRESSION[value];
    if (plaintext === undefined) return value;
    ctx.recordedSecretValues?.set(plaintext, value);
    return plaintext;
  }
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveWithSecrets(v, ctx);
    }
    return out;
  }
  return value;
}

// Per-test knob for the condition-pruned case; every other case leaves it empty.
const conditionValues: { value: Record<string, boolean> } = { value: {} };

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation((props: unknown, ctx: { recordedSecretValues?: Map<string, string> }) =>
        Promise.resolve(resolveWithSecrets(props, ctx ?? {}))
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockImplementation(() => Promise.resolve(conditionValues.value)),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - Export.Name colliding with an output NAME (issue #1919)', () => {
  const stackName = 'export-name-collision-stack';

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;
  let mockExportIndexStore: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    conditionValues.value = {};
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'res-phys' }),
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
      getExecutionLevels: vi.fn().mockReturnValue([['Res']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Res',
            {
              logicalId: 'Res',
              changeType: 'CREATE',
              resourceType: 'AWS::SQS::Queue',
              desiredProperties: { QueueName: 'q' },
            },
          ],
        ])
      ),
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
      popRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
    mockExportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  type OutputDecl = { Value: unknown; Export?: { Name: string }; Condition?: string };

  /**
   * Deploy one throwaway resource plus `outputs`, declared in the ORDER GIVEN —
   * `Object.entries` preserves it, and it is the whole point of the fixture.
   */
  async function deployOutputs(
    outputs: Record<string, OutputDecl>,
    conditions?: Record<string, boolean>
  ): Promise<{
    saved: Record<string, unknown>;
    indexed: Record<string, unknown>;
    savedStateJson: string;
  }> {
    if (conditions) conditionValues.value = conditions;
    const template: CloudFormationTemplate = {
      ...(conditions && {
        Conditions: Object.fromEntries(Object.keys(conditions).map((c) => [c, { 'Fn::Equals': [] }])),
      }),
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: outputs,
    } as CloudFormationTemplate;

    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1',
      mockExportIndexStore as never
    );
    await engine.deploy(stackName, template);

    const savedState = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(mockExportIndexStore.updateForStack!).toHaveBeenCalled();
    return {
      saved: savedState.outputs as Record<string, unknown>,
      indexed: mockExportIndexStore.updateForStack!.mock.calls.at(-1)![2] as Record<
        string,
        unknown
      >,
      savedStateJson: JSON.stringify(savedState),
    };
  }

  function collisionWarnings(): string[] {
    return warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('which is also the name of another output'));
  }

  it('polarity B->A: the exporter iterated LAST must not overwrite the colliding output', async () => {
    // Declaration order is load-bearing (addendum): `PublicAlpha` first, so the
    // exporting `SecretBeta` is resolved AFTER it and its alias lands on a key
    // whose position source the post-loop pass then reclaims. Pre-fix the
    // persisted `PublicAlpha` was SecretBeta's value, value-scanned onto
    // EXPR_B — a reference to a DIFFERENT secret stored where a public endpoint
    // belongs, and published under that name into the exports index.
    const { saved, indexed, savedStateJson } = await deployOutputs({
      PublicAlpha: { Value: PUBLIC_A },
      SecretBeta: { Value: EXPR_B, Export: { Name: 'PublicAlpha' } },
    });

    expect(saved['PublicAlpha']).toBe(PUBLIC_A);
    expect(saved['SecretBeta']).toBe(EXPR_B);
    expect(indexed['PublicAlpha']).toBe(PUBLIC_A);
    expect(indexed['SecretBeta']).toBe(EXPR_B);
    expect(savedStateJson).not.toContain(PLAINTEXT_B);

    const warnings = collisionWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SecretBeta');
    expect(warnings[0]).toContain('PublicAlpha');
  });

  it('polarity A->B: the mirrored collision behaves identically', async () => {
    // Same shape with the roles swapped, so the guard cannot be a one-way
    // accident: here `SecretAlpha` is the exporter and is declared LAST.
    const { saved, indexed, savedStateJson } = await deployOutputs({
      PublicBeta: { Value: PUBLIC_B },
      SecretAlpha: { Value: EXPR_A, Export: { Name: 'PublicBeta' } },
    });

    expect(saved['PublicBeta']).toBe(PUBLIC_B);
    expect(saved['SecretAlpha']).toBe(EXPR_A);
    expect(indexed['PublicBeta']).toBe(PUBLIC_B);
    expect(indexed['SecretAlpha']).toBe(EXPR_A);
    expect(savedStateJson).not.toContain(PLAINTEXT_A);

    expect(collisionWarnings()).toHaveLength(1);
  });

  it('two SECRET outputs colliding: each keeps its OWN expression, and it warns', async () => {
    // The issue's headline shape. The value assertions here hold on the unfixed
    // code as well — the position pass rewrites the corrupted leaf back onto the
    // key owner's own expression, so the persisted bytes coincide. Kept because
    // it is the shape the issue describes and it pins that no leaf ends up
    // carrying its sibling's reference; the WARNING is what discriminates.
    const { saved, indexed, savedStateJson } = await deployOutputs({
      SecretAlpha: { Value: EXPR_A },
      SecretBeta: { Value: EXPR_B, Export: { Name: 'SecretAlpha' } },
    });

    expect(saved['SecretAlpha']).toBe(EXPR_A);
    expect(saved['SecretBeta']).toBe(EXPR_B);
    expect(indexed['SecretAlpha']).toBe(EXPR_A);
    expect(indexed['SecretBeta']).toBe(EXPR_B);
    expect(savedStateJson).not.toContain(PLAINTEXT_A);
    expect(savedStateJson).not.toContain(PLAINTEXT_B);
    expect(collisionWarnings()).toHaveLength(1);
  });

  it('CONTROL — the REVERSED order never corrupted, and is still skipped + warned', async () => {
    // The addendum's vacuous ordering: the exporter is declared FIRST, so
    // `PublicAlpha`'s own write reclaims the key on its later iteration and the
    // unfixed code loses only the alias. Pinned so a future reordering of the
    // fixture cannot silently turn the discriminating cases above into this one
    // — and to prove the guard does not depend on iteration order the way the
    // BUG did.
    const { saved, indexed } = await deployOutputs({
      SecretBeta: { Value: EXPR_B, Export: { Name: 'PublicAlpha' } },
      PublicAlpha: { Value: PUBLIC_A },
    });

    expect(saved['PublicAlpha']).toBe(PUBLIC_A);
    expect(saved['SecretBeta']).toBe(EXPR_B);
    expect(indexed['PublicAlpha']).toBe(PUBLIC_A);
    expect(collisionWarnings()).toHaveLength(1);
  });

  it('a CONDITION-PRUNED output still owns its name: the alias is skipped, not published', async () => {
    // The pruned output contributes no value, but the post-loop source pass
    // still writes its unresolved `Value` under its name — so an alias landing
    // there would be positioned by a source belonging to an output this deploy
    // did not even publish. The guard therefore tests the DECLARED set, not the
    // surviving one, and the export name is simply absent from the bag.
    const { saved, indexed } = await deployOutputs(
      {
        PrunedAlpha: { Value: PUBLIC_A, Condition: 'IsProd' },
        SecretBeta: { Value: EXPR_B, Export: { Name: 'PrunedAlpha' } },
      },
      { IsProd: false }
    );

    expect(Object.hasOwn(saved, 'PrunedAlpha')).toBe(false);
    expect(Object.hasOwn(indexed, 'PrunedAlpha')).toBe(false);
    expect(saved['SecretBeta']).toBe(EXPR_B);
    expect(collisionWarnings()).toHaveLength(1);
  });

  it('a NON-colliding export alias is still published, positioned by its own source', async () => {
    // Guard-the-guard: the collision check must not cost the ordinary alias its
    // position source (issue #1918), which is what keeps a cross-stack consumer
    // off a sibling's expression.
    const { saved, indexed } = await deployOutputs({
      SecretAlpha: { Value: EXPR_A },
      SecretBeta: { Value: EXPR_B, Export: { Name: 'BetaExport' } },
    });

    expect(indexed['BetaExport']).toBe(EXPR_B);
    expect(saved['BetaExport']).toBe(EXPR_B);
    expect(saved['SecretAlpha']).toBe(EXPR_A);
    expect(collisionWarnings()).toHaveLength(0);
  });

  it('an output exporting under its OWN name is not a collision', async () => {
    // The alias rewrites the identical key with the identical value and both
    // writers then carry the same source, so there is nothing to guard and
    // nothing to warn about.
    const { saved, indexed } = await deployOutputs({
      SecretAlpha: { Value: EXPR_A, Export: { Name: 'SecretAlpha' } },
      SecretBeta: { Value: EXPR_B },
    });

    expect(saved['SecretAlpha']).toBe(EXPR_A);
    expect(indexed['SecretAlpha']).toBe(EXPR_A);
    expect(collisionWarnings()).toHaveLength(0);
  });
});
