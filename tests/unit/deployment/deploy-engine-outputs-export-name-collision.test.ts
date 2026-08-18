/**
 * Issue #1919: the stack-OUTPUTS bag has two key writers that must agree.
 *
 * `resolveOutputs` aliases each output's resolved value under its
 * `Export.Name` so a cross-stack consumer finds it, while a post-loop pass
 * writes the redaction POSITION source for every PUBLISHED output NAME. On a
 * collision the alias put the EXPORTING output's resolved value under the
 * colliding key and the post-loop pass put the OTHER output's unresolved value
 * under the same key — so the persisted leaf was positioned by a source
 * belonging to a different output. The fix skips the alias on such a collision
 * (and warns), which partitions the key space.
 *
 * ORDER MATTERS, per the issue's addendum. The corruption needs the EXPORTING
 * output to be iterated AFTER the colliding-name output; declared the other way
 * round the colliding-name output's own write reclaims the key and only the
 * alias is lost. Every corrupting case below declares the exporter LAST, and
 * the reversed order is pinned separately as a labelled control.
 *
 * Two further key-space hazards are pinned here because they are the same
 * defect seen from other sides: an `Export.Name` that is an INTRINSIC can
 * resolve to secret PLAINTEXT, and a key is never redacted (redaction walks
 * values); and a CONDITION-SUPPRESSED output must NOT reserve its name, or an
 * unrelated condition going false would drop a working export.
 *
 * The resolver is mocked but SECRET-AWARE, keyed on the expression STRING (the
 * same device as `deploy-engine-sibling-redaction-writers.test.ts`): the
 * position pass copies a real `{{resolve:...}}` source leaf, so the source has
 * to be a genuine expression string or the redaction arm under test never runs.
 * It also resolves `Fn::Sub` to a STRING, substituting dynamic references
 * inside it exactly as the real resolver does — without that the intrinsic
 * `Export.Name` branch is skipped entirely and its cases pass vacuously.
 *
 * Warning assertions go through the shared builders in
 * `src/deployment/outputs-export-alias.ts` rather than through substrings, so a
 * reword cannot silently make them vacuous.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  exportAliasCollisionWarning,
  secretBearingExportNameWarning,
} from '../../../src/deployment/outputs-export-alias.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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
// behaviors (pinned below as its own case). Generalised by review: the
// discriminating condition is that the COLLIDED-ON output's own `Value` is not
// a secret expression.
const PLAINTEXT_A = 'alpha-plaintext-secret';
const EXPR_A = '{{resolve:secretsmanager:alpha:SecretString:password:AWSCURRENT}}';
const PLAINTEXT_B = 'beta-plaintext-secret';
const EXPR_B = '{{resolve:secretsmanager:beta:SecretString:password:AWSCURRENT}}';
// The OTHER version stage of the same secret: a DIFFERENT expression resolving
// to the SAME plaintext, so the value-keyed map keeps only the last and cannot
// tell the two leaves apart. Only a POSITION source can.
const EXPR_B_ALT = '{{resolve:secretsmanager:beta:SecretString:password:AWSPREVIOUS}}';
const PUBLIC_A = 'alpha-public-endpoint';
const PUBLIC_B = 'beta-public-endpoint';
// A secret SHORTER than `secret-redaction`'s MIN_NEEDLE_LENGTH (4). Degenerate
// as a secret, load-bearing as a fixture: the masking helper skips needles this
// short, so a message built through it would print this plaintext under a
// "masked:" label. Real secrets are longer, which is exactly why the case has
// to be pinned rather than trusted.
const PLAINTEXT_SHORT = 'abc';
const EXPR_SHORT = '{{resolve:secretsmanager:tiny:SecretString:pin:AWSCURRENT}}';
// An `ssm` reference whose parameter Type came back unclassifiable: the resolver
// resolves it WITH decryption but deliberately never PINS it (issue #1901), so
// its cache-hit arm records nothing on a second resolution. Modelled below by
// recording it exactly once per deploy — which is what makes the recording side
// effect of the export-name resolution observable.
const PLAINTEXT_UNPINNED = 'unpinned-securestring-value';
const EXPR_UNPINNED = '{{resolve:ssm:/p/unclassifiable}}';
// A NESTED pair: the short secret is a PREFIX of the long one, so masking them
// shortest-first leaves the long one's tail in the message.
const PLAINTEXT_NESTED = 'abc-with-a-long-tail';
const EXPR_NESTED = '{{resolve:secretsmanager:nested:SecretString:pw:AWSCURRENT}}';

const SECRET_BY_EXPRESSION: Record<string, string> = {
  [EXPR_A]: PLAINTEXT_A,
  [EXPR_B]: PLAINTEXT_B,
  [EXPR_SHORT]: PLAINTEXT_SHORT,
  [EXPR_B_ALT]: PLAINTEXT_B,
  [EXPR_UNPINNED]: PLAINTEXT_UNPINNED,
  [EXPR_NESTED]: PLAINTEXT_NESTED,
};

/**
 * Expressions the mock records only on their FIRST resolution in a deploy —
 * the resolver's cache-hit behavior for a reference it cannot prove is secret.
 */
const RECORD_ONCE = new Set([EXPR_UNPINNED]);
const alreadyRecorded = vi.hoisted(() => new Set<string>());

/** `Fn::Sub` variables the mock substitutes, standing in for pseudo-parameters. */
const SUB_VARS: Record<string, string> = { Prefix: 'producer' };

function record(
  ctx: { recordedSecretValues?: Map<string, string> },
  plaintext: string,
  expr: string
): void {
  if (RECORD_ONCE.has(expr)) {
    if (alreadyRecorded.has(expr)) return;
    alreadyRecorded.add(expr);
  }
  ctx.recordedSecretValues?.set(plaintext, expr);
}

function substituteSecrets(text: string, ctx: { recordedSecretValues?: Map<string, string> }) {
  let out = text;
  for (const [expr, plaintext] of Object.entries(SECRET_BY_EXPRESSION)) {
    if (!out.includes(expr)) continue;
    record(ctx, plaintext, expr);
    out = out.split(expr).join(plaintext);
  }
  return out;
}

function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (typeof value === 'string') {
    // Whole-value first (an Output whose Value IS the reference), then embedded
    // (an `Fn::Sub` body), mirroring the real dynamic-reference substitution.
    const plaintext = SECRET_BY_EXPRESSION[value];
    if (plaintext !== undefined) {
      record(ctx, plaintext, value);
      return plaintext;
    }
    return substituteSecrets(value, ctx);
  }
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    // `Fn::Join` resolves its parts AS IT GOES — the real resolver runs them
    // through `Promise.all`, so an earlier part can record and cache before a
    // later one rejects. `__THROW__` is that later part.
    if (entries.length === 1 && entries[0]![0] === 'Fn::Join') {
      const [sep, parts] = entries[0]![1] as [string, unknown[]];
      const resolved: string[] = [];
      for (const part of parts) {
        if (part === '__THROW__') throw new Error('deliberate resolve failure (sibling element)');
        resolved.push(String(resolveWithSecrets(part, ctx)));
      }
      return resolved.join(sep);
    }
    // `Fn::Sub` collapses an OBJECT source leaf to a STRING — the shape that
    // makes an `Export.Name` intrinsic able to carry secret plaintext into a key.
    if (entries.length === 1 && entries[0]![0] === 'Fn::Sub' && typeof entries[0]![1] === 'string') {
      const body = (entries[0]![1] as string).replace(
        /\$\{([^}]+)\}/g,
        (whole, name: string) => SUB_VARS[name] ?? whole
      );
      return substituteSecrets(body, ctx);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = resolveWithSecrets(v, ctx);
    return out;
  }
  return value;
}

// Per-test knob for the condition-suppressed cases; empty otherwise.
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

describe('DeployEngine - Export.Name key-space guards (issue #1919)', () => {
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
    alreadyRecorded.clear();
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

  /** State for the NO-CHANGE path: one resource, already observed, no outputs. */
  function noChangeState(): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        Res: {
          physicalId: 'res-phys',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'q' },
          observedProperties: { QueueName: 'q' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    };
  }

  /**
   * Deploy one throwaway resource plus `outputs`, declared in the ORDER GIVEN —
   * `Object.entries` preserves it, and it is the whole point of the fixture.
   *
   * `path: 'no-change'` routes through the SECOND `resolveOutputs` call site
   * (the outputs-only re-check on a stack with no resource diff), which owns the
   * same two bags and had no coverage for any of this.
   */
  async function deployOutputs(
    outputs: Record<string, TemplateOutput>,
    opts: { conditions?: Record<string, boolean>; path?: 'changes' | 'no-change' } = {}
  ): Promise<{
    saved: Record<string, unknown>;
    indexed: Record<string, unknown>;
    savedStateJson: string;
  }> {
    if (opts.conditions) conditionValues.value = opts.conditions;
    if (opts.path === 'no-change') {
      mockDiffCalculator.hasChanges!.mockReturnValue(false);
      mockDiffCalculator.calculateDiff!.mockResolvedValue(
        new Map<string, ResourceChange>([
          ['Res', { logicalId: 'Res', changeType: 'NO_CHANGE', resourceType: 'AWS::SQS::Queue' }],
        ])
      );
      mockStateBackend.getState!.mockResolvedValue({ state: noChangeState(), etag: 'etag-old' });
    }
    const template: CloudFormationTemplate = {
      ...(opts.conditions && {
        Conditions: Object.fromEntries(
          Object.keys(opts.conditions).map((c) => [c, { 'Fn::Equals': [] }])
        ),
      }),
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: outputs,
    };

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
      indexed: mockExportIndexStore.updateForStack!.mock.calls.at(-1)![2] as Record<string, unknown>,
      savedStateJson: JSON.stringify(savedState),
    };
  }

  const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

  // --- collision: the exporter iterated AFTER the colliding-name output -----

  it('polarity B->A (owner name sorts BEFORE the exporter) keeps the owner value', async () => {
    // Declaration order is load-bearing (addendum): `AlphaPublic` first, so the
    // exporting `ZuluSecret` is resolved AFTER it and its alias lands on a key
    // whose position source the post-loop pass then reclaims. Pre-fix the
    // persisted `AlphaPublic` was ZuluSecret's value, value-scanned onto
    // EXPR_B — a reference to a DIFFERENT secret stored where a public endpoint
    // belongs, and published under that name into the exports index.
    const { saved, indexed, savedStateJson } = await deployOutputs({
      AlphaPublic: { Value: PUBLIC_A },
      ZuluSecret: { Value: EXPR_B, Export: { Name: 'AlphaPublic' } },
    });

    expect(saved['AlphaPublic']).toBe(PUBLIC_A);
    expect(saved['ZuluSecret']).toBe(EXPR_B);
    expect(indexed['AlphaPublic']).toBe(PUBLIC_A);
    expect(indexed['ZuluSecret']).toBe(EXPR_B);
    expect(savedStateJson).not.toContain(PLAINTEXT_B);
    expect(warnings()).toContain(exportAliasCollisionWarning('ZuluSecret', 'AlphaPublic'));
  });

  it('polarity A->B (owner name sorts AFTER the exporter) behaves identically', async () => {
    // STRUCTURAL mirror, not a constants copy: the owner/exporter NAME ORDER is
    // reversed relative to the case above (`ZuluPublic` owns, `AlphaSecret`
    // exports), so a guard that keyed on any ordering of the two identifiers —
    // rather than on which name is OWNED — passes one case and fails this one.
    const { saved, indexed, savedStateJson } = await deployOutputs({
      ZuluPublic: { Value: PUBLIC_B },
      AlphaSecret: { Value: EXPR_A, Export: { Name: 'ZuluPublic' } },
    });

    expect(saved['ZuluPublic']).toBe(PUBLIC_B);
    expect(saved['AlphaSecret']).toBe(EXPR_A);
    expect(indexed['ZuluPublic']).toBe(PUBLIC_B);
    expect(indexed['AlphaSecret']).toBe(EXPR_A);
    expect(savedStateJson).not.toContain(PLAINTEXT_A);
    expect(warnings()).toContain(exportAliasCollisionWarning('AlphaSecret', 'ZuluPublic'));
  });

  it('ALL-PUBLIC collision: no secret machinery involved, the owner value survives', async () => {
    // The cleanest discriminator of the two — with no recorded secrets the
    // redaction short-circuits entirely, so the corruption is the raw alias
    // overwrite: pre-fix `PublicOne` held PublicTwo's value verbatim.
    const { saved, indexed } = await deployOutputs({
      PublicOne: { Value: PUBLIC_A },
      PublicTwo: { Value: PUBLIC_B, Export: { Name: 'PublicOne' } },
    });

    expect(saved['PublicOne']).toBe(PUBLIC_A);
    expect(saved['PublicTwo']).toBe(PUBLIC_B);
    expect(indexed['PublicOne']).toBe(PUBLIC_A);
    expect(warnings()).toContain(exportAliasCollisionWarning('PublicTwo', 'PublicOne'));
  });

  it('two SECRET outputs colliding: each keeps its OWN expression, and it warns', async () => {
    // The issue's headline shape. The value assertions here hold on the unfixed
    // code as well — when the collided-on output's own `Value` IS a secret
    // expression, the position pass rewrites the corrupted leaf back onto that
    // expression and the persisted bytes coincide. Kept because it is the shape
    // the issue describes; the WARNING is what discriminates.
    const { saved, indexed, savedStateJson } = await deployOutputs({
      SecretAlpha: { Value: EXPR_A },
      SecretBeta: { Value: EXPR_B, Export: { Name: 'SecretAlpha' } },
    });

    expect(saved['SecretAlpha']).toBe(EXPR_A);
    expect(saved['SecretBeta']).toBe(EXPR_B);
    expect(indexed['SecretAlpha']).toBe(EXPR_A);
    expect(savedStateJson).not.toContain(PLAINTEXT_A);
    expect(savedStateJson).not.toContain(PLAINTEXT_B);
    expect(warnings()).toContain(exportAliasCollisionWarning('SecretBeta', 'SecretAlpha'));
  });

  it('CONTROL — the REVERSED order never corrupted, and is still skipped + warned', async () => {
    // The addendum's vacuous ordering: the exporter is declared FIRST, so
    // `AlphaPublic`'s own write reclaims the key on its later iteration and the
    // unfixed code loses only the alias. Pinned so a future reordering of the
    // fixture cannot silently turn the discriminating cases above into this one.
    const { saved, indexed } = await deployOutputs({
      ZuluSecret: { Value: EXPR_B, Export: { Name: 'AlphaPublic' } },
      AlphaPublic: { Value: PUBLIC_A },
    });

    expect(saved['AlphaPublic']).toBe(PUBLIC_A);
    expect(saved['ZuluSecret']).toBe(EXPR_B);
    expect(indexed['AlphaPublic']).toBe(PUBLIC_A);
    expect(warnings()).toContain(exportAliasCollisionWarning('ZuluSecret', 'AlphaPublic'));
  });

  it('the collision guard also covers the NO-CHANGE re-check call site', async () => {
    // `resolveOutputs` has a second caller: the outputs-only re-check on a stack
    // with no resource diff, which owns the same two bags and persists through a
    // different save. A guard living on only one path would leave a stack that
    // deploys clean and then re-deploys unchanged corrupting itself on the
    // second run.
    const { saved, indexed } = await deployOutputs(
      {
        AlphaPublic: { Value: PUBLIC_A },
        ZuluSecret: { Value: EXPR_B, Export: { Name: 'AlphaPublic' } },
      },
      { path: 'no-change' }
    );

    expect(saved['AlphaPublic']).toBe(PUBLIC_A);
    expect(indexed['AlphaPublic']).toBe(PUBLIC_A);
    expect(warnings()).toContain(exportAliasCollisionWarning('ZuluSecret', 'AlphaPublic'));
  });

  // --- key space: what does NOT collide -------------------------------------

  it('a CONDITION-SUPPRESSED output does NOT reserve its name — the export is published', async () => {
    // A suppressed output publishes no value, so the name is free and the export
    // must keep working: reserving it would DROP a live export (and, on the next
    // producer deploy, delete its exports-index entry) because an unrelated
    // condition went false. The alias is positioned by the EXPORTER's own Value:
    // pre-fix the post-loop pass wrote the suppressed output's `Value` under that
    // key, so the leaf was positioned by an output this deploy never published.
    const { saved, indexed } = await deployOutputs(
      {
        SuppressedAlpha: { Value: EXPR_A, Condition: 'IsProd' },
        SecretBeta: { Value: EXPR_B, Export: { Name: 'SuppressedAlpha' } },
      },
      { conditions: { IsProd: false } }
    );

    expect(saved['SuppressedAlpha']).toBe(EXPR_B);
    expect(indexed['SuppressedAlpha']).toBe(EXPR_B);
    expect(saved['SecretBeta']).toBe(EXPR_B);
    expect(warnings()).toEqual([]);
  });

  it('a NON-colliding export alias is still published, positioned by its own source', async () => {
    // Guard-the-guard: the collision check must not cost the ordinary alias its
    // position source (issue #1918), which is what keeps a cross-stack consumer
    // off a sibling's expression.
    //
    // `BetaTwin` is what makes the SOURCE actually load-bearing here — an
    // earlier version of this test asserted only the published value, which the
    // value scan alone reproduces, so the name claimed more than the assertions
    // checked. Twin resolves to the same plaintext through the OTHER stage and
    // is declared LAST, so the value map keeps `EXPR_B_ALT`: without the alias's
    // own position source the key collapses onto that sibling expression.
    const { saved, indexed } = await deployOutputs({
      SecretAlpha: { Value: EXPR_A },
      SecretBeta: { Value: EXPR_B, Export: { Name: 'BetaExport' } },
      BetaTwin: { Value: EXPR_B_ALT },
    });

    expect(indexed['BetaExport']).toBe(EXPR_B);
    expect(saved['BetaExport']).toBe(EXPR_B);
    expect(saved['SecretAlpha']).toBe(EXPR_A);
    expect(warnings()).toEqual([]);
  });

  it('an output exporting under its OWN name is not a collision', async () => {
    // The alias rewrites the identical key with the identical value and both
    // writers then carry the same source, so there is nothing to guard.
    const { saved, indexed } = await deployOutputs({
      SecretAlpha: { Value: EXPR_A, Export: { Name: 'SecretAlpha' } },
      SecretBeta: { Value: EXPR_B },
    });

    expect(saved['SecretAlpha']).toBe(EXPR_A);
    expect(indexed['SecretAlpha']).toBe(EXPR_A);
    expect(warnings()).toEqual([]);
  });

  // --- key space: an INTRINSIC Export.Name -----------------------------------

  it('an INTRINSIC Export.Name is published under its RESOLVED name', async () => {
    const { saved, indexed } = await deployOutputs({
      SecretBeta: { Value: EXPR_B, Export: { Name: { 'Fn::Sub': '${Prefix}-BetaExport' } as never } },
    });

    expect(saved['producer-BetaExport']).toBe(EXPR_B);
    expect(indexed['producer-BetaExport']).toBe(EXPR_B);
    expect(warnings()).toEqual([]);
  });

  it('an INTRINSIC Export.Name resolving to secret plaintext is REFUSED, not keyed', async () => {
    // `Fn::Sub` substitutes dynamic references, so the resolved name can BE (or
    // contain) secret plaintext — and it would become a KEY in state.json and in
    // the exports index, which no redaction pass ever walks. The refusal is the
    // GHSA class, not a nicety.
    const exportName = { 'Fn::Sub': `export-${EXPR_A}` } as never;
    const { saved, indexed, savedStateJson } = await deployOutputs({
      SecretBeta: { Value: EXPR_B, Export: { Name: exportName } },
    });

    expect(savedStateJson).not.toContain(PLAINTEXT_A);
    expect(JSON.stringify(indexed)).not.toContain(PLAINTEXT_A);
    expect(Object.keys(saved)).toEqual(['SecretBeta']);
    expect(saved['SecretBeta']).toBe(EXPR_B);
    // The warning itself must not leak what the key would have leaked.
    const secretWarnings = warnings().filter((w) => w.includes('Export.Name that resolves'));
    expect(secretWarnings).toEqual([
      secretBearingExportNameWarning(
        'SecretBeta',
        `export-${PLAINTEXT_A}`,
        new Map([[PLAINTEXT_A, EXPR_A]])
      ),
    ]);
    expect(secretWarnings[0]).not.toContain(PLAINTEXT_A);
  });

  // --- the property the pruned-name decision rests on ------------------------

  it('resolveOutputs runs EXACTLY ONCE per deploy, on either path', async () => {
    // The post-loop source pass skips suppressed outputs, which is sound only
    // because the bag is not accumulated across several resolutions in one
    // deploy. The two call sites are mutually exclusive — the no-change branch
    // returns before `executeDeployment` — and `deploy()` resets the bag.
    //
    // Spying on the METHOD, not on how many times a particular Output value was
    // handed to the resolver: a second `resolveOutputs` call over a DIFFERENT
    // output set (say a condition-pruned one) is precisely the shape this
    // decision fears — two calls disagreeing about which names are published —
    // and a value-counting assertion cannot see it.
    const spy = vi.spyOn(
      DeployEngine.prototype as unknown as { resolveOutputs: () => Promise<unknown> },
      'resolveOutputs'
    );
    try {
      await deployOutputs({ SecretBeta: { Value: EXPR_B } });
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockClear();
      vi.clearAllMocks();
      mockStateBackend.saveState!.mockResolvedValue('etag-new');
      mockExportIndexStore.updateForStack!.mockResolvedValue(undefined);
      mockLockManager.acquireLockWithRetry!.mockResolvedValue(true);
      mockDiffCalculator.filterByType!.mockImplementation(
        (changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
      );
      await deployOutputs({ SecretBeta: { Value: EXPR_B } }, { path: 'no-change' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a SHORT secret in an export name is refused, and the message shows NO name rather than a false mask', async () => {
    // The bug this pins was introduced by the fix for the previous one: the
    // refusal used an exact containment scan (so a short secret IS caught) while
    // the message formatted the name through the masking helper (which skips
    // needles below its minimum length). The result printed the secret verbatim
    // under a "masked:" label — a message asserting a protection it had not
    // performed. Masking is now exhaustive, so the name is genuinely masked; the
    // assertion that matters either way is that the plaintext never appears.
    const { saved } = await deployOutputs({
      SecretBeta: { Value: EXPR_B, Export: { Name: { 'Fn::Sub': `export-${EXPR_SHORT}-v2` } as never } },
    });

    const refusals = warnings().filter((w) => w.includes('Export.Name that resolves'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).not.toContain(PLAINTEXT_SHORT);
    expect(Object.keys(saved)).toEqual(['SecretBeta']);
  });

  it('an export name carrying TWO secrets masks both', async () => {
    const { saved } = await deployOutputs({
      SecretBeta: {
        Value: EXPR_B,
        Export: { Name: { 'Fn::Sub': `${EXPR_A}-and-${EXPR_SHORT}` } as never },
      },
    });

    const refusals = warnings().filter((w) => w.includes('Export.Name that resolves'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).not.toContain(PLAINTEXT_A);
    expect(refusals[0]).not.toContain(PLAINTEXT_SHORT);
    // Positively assert the name was RENDERED masked. Without this a mask that
    // matches nothing passes every negative assertion — the builder suppresses
    // the name when masking changed nothing, so "no plaintext" is satisfied by
    // printing no name at all, and the useful half of the message is lost
    // silently.
    expect(refusals[0]).toContain('***-and-***');
    expect(Object.keys(saved)).toEqual(['SecretBeta']);
  });

  it('a REFUSED export name still RECORDS its secret for the rest of the pass', async () => {
    // The regression this pins was introduced by the fix for the previous
    // round: resolving `Export.Name` with a private secrets map made the
    // DECISION exact, but resolving is not side-effect-free. It warms the
    // resolver's cache, whose hit arm re-records only what it can still PROVE is
    // secret. An unpinned ssm reference (#1901) first touched by an export-name
    // resolve therefore became invisible to every later consumer.
    //
    // WHAT MAKES THIS FIXTURE REACH THE MERGE, stated because it stopped doing
    // so once and no test noticed: `EXPR_UNPINNED` appears ONLY in an
    // `Export.Name`, never in a `Value`. Since the pass split resolves every
    // value before any name, a fixture that also put it in a Value would record
    // it in pass 1 and leave `nameSecrets` empty here — which is exactly how the
    // earlier version of this test drifted off the branch it names. The consumer
    // is a LATER output's literal-name refusal, which is the live production
    // path: pass 2 walks names in declaration order.
    const { saved, savedStateJson } = await deployOutputs({
      Exporter: {
        Value: PUBLIC_A,
        Export: { Name: { 'Fn::Sub': `pre-${EXPR_UNPINNED}` } as never },
      },
      LaterExporter: {
        Value: PUBLIC_B,
        Export: { Name: `prod-${PLAINTEXT_UNPINNED}-endpoint` },
      },
    });

    // Both aliases refused: the first for substituting a secret into its name,
    // the second because that secret is now in the pass map and its literal name
    // contains it. Without the merge the second is PUBLISHED as a plaintext key.
    expect(Object.keys(saved).sort()).toEqual(['Exporter', 'LaterExporter']);
    expect(savedStateJson).not.toContain(PLAINTEXT_UNPINNED);
    expect(warnings().filter((w) => w.includes('Export.Name that resolves'))).toHaveLength(2);
  });

  it('...and still records it when that name resolution THROWS partway', async () => {
    // The `finally` half. `Fn::Join` resolves its parts as it goes, so the first
    // element records and caches before the second rejects; merging only on the
    // success path loses that recording while the cache stays warm. Same
    // consumer as above, so the assertion discriminates for the same reason.
    const { saved, savedStateJson } = await deployOutputs({
      Exporter: {
        Value: PUBLIC_A,
        Export: { Name: { 'Fn::Join': ['', [EXPR_UNPINNED, '__THROW__']] } as never },
      },
      LaterExporter: {
        Value: PUBLIC_B,
        Export: { Name: `prod-${PLAINTEXT_UNPINNED}-endpoint` },
      },
    });

    expect(savedStateJson).not.toContain(PLAINTEXT_UNPINNED);
    expect(Object.hasOwn(saved, `prod-${PLAINTEXT_UNPINNED}-endpoint`)).toBe(false);
    // The throwing output is dropped by the shared failure handler (warn-and-
    // continue), which is pre-existing behavior and not what this pins.
    expect(saved['Exporter']).toBeUndefined();
  });

  it('a THROWN outputs pass does not position the PREVIOUS bag by this template', async () => {
    // Measured, not argued (issue #1919 round-5 review). Under `--strict-getatt`
    // an unresolvable Output RETHROWS, and the failure path still saves state:
    // `persistStateAfterOutputFailure` -> `withParentInfo` ->
    // `redactStateForPersist` -> `redactOutputs(currentState.outputs)`. So the
    // PREVIOUS deploy's bag is redacted with THIS pass's secrets — right for the
    // value scan — while the position source holds only the alias keys written
    // before the throw, built from THIS template. Positioning by it makes
    // `redactByPath` return a known-secret source leaf verbatim, replacing a
    // public stored value with a reference to a secret that never produced it.
    //
    // The throw is placed in the ALIAS pass on purpose: since the pass split,
    // pass 1 writes no source at all, so a value-side throw leaves the bag empty
    // and cannot discriminate. `First` publishes its alias source, then
    // `Second`'s name resolution throws — which is the only shape that leaves a
    // PARTIAL source behind.
    mockDiffCalculator.hasChanges!.mockReturnValue(true);
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        ...noChangeState(),
        // `Leaked` is what makes the second assertion discriminate: the previous
        // bag must actually HOLD this pass's plaintext, or "the value scan still
        // runs" is a claim no assertion checks.
        outputs: { Legacy: 'previously-public-value', Leaked: PLAINTEXT_A },
      },
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: {
        First: { Value: EXPR_A, Export: { Name: 'Legacy' } },
        Second: {
          Value: PUBLIC_B,
          Export: { Name: { 'Fn::Join': ['', ['__THROW__']] } as never },
        },
      },
    };

    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, strictGetAtt: true },
      'us-east-1',
      mockExportIndexStore as never
    );
    await expect(engine.deploy(stackName, template)).rejects.toBeInstanceOf(Error);

    const savedState = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    // The stored public value survives as itself. Positioned by the partial
    // source it became EXPR_A — a secretsmanager reference standing in for a
    // value that never came from that secret, persisted by the FAILURE path.
    expect((savedState.outputs as Record<string, unknown>)['Legacy']).toBe(
      'previously-public-value'
    );
    // The value scan still runs, which is the half that must NOT be lost: a
    // previous bag holding this pass's plaintext is still redacted.
    expect(JSON.stringify(savedState)).not.toContain(PLAINTEXT_A);
  });

  it('PARITY row 2 — a LITERAL name spelled as an expression is PUBLISHED', async () => {
    // The deploy side of the row the previous round got wrong on the diff side.
    // A STRING `Export.Name` short-circuits the resolver entirely, so nothing is
    // substituted and the key is the expression itself — which is what state
    // stores post-redaction anyway, so there is nothing to refuse. Pinned HERE
    // as well as in the diff twin, because a parity claim tested on one side
    // only is exactly how the divergence shipped.
    const literalName = '{{resolve:secretsmanager:db:SecretString:pw}}';
    const { saved, indexed } = await deployOutputs({
      Exporter: { Value: PUBLIC_A, Export: { Name: literalName } },
    });

    expect(saved[literalName]).toBe(PUBLIC_A);
    expect(indexed[literalName]).toBe(PUBLIC_A);
    expect(warnings()).toEqual([]);
  });

  it('PARITY row 3 — the literal-name refusal does not depend on DECLARATION ORDER', async () => {
    // The order-dependence class this issue's own addendum flagged for the
    // original defect, reappearing in its fix: the refusal consults the secrets
    // recorded SO FAR, so with the exporting output declared FIRST the map was
    // still empty and the same template published a plaintext state KEY —
    // unredactable, republished into the exports index, and then reported by
    // `cdkd scrub` as unrepairable. Both orders must refuse; the value/alias
    // pass split is what makes that true.
    for (const order of ['exporter-first', 'secret-first'] as const) {
      vi.clearAllMocks();
      alreadyRecorded.clear();
      mockStateBackend.getState!.mockResolvedValue({ state: null, etag: undefined });
      mockStateBackend.saveState!.mockResolvedValue('etag-new');
      mockExportIndexStore.updateForStack!.mockResolvedValue(undefined);
      mockLockManager.acquireLockWithRetry!.mockResolvedValue(true);
      mockProvider.create!.mockResolvedValue({ physicalId: 'res-phys' });
      mockDiffCalculator.filterByType!.mockImplementation(
        (changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
      );

      const exporter: [string, TemplateOutput] = [
        'Exporter',
        { Value: PUBLIC_B, Export: { Name: `prod-${PLAINTEXT_A}-endpoint` } },
      ];
      const secretOutput: [string, TemplateOutput] = ['SecretAlpha', { Value: EXPR_A }];
      const declared =
        order === 'exporter-first' ? [exporter, secretOutput] : [secretOutput, exporter];

      const { saved, savedStateJson } = await deployOutputs(Object.fromEntries(declared));

      expect(Object.keys(saved).sort()).toEqual(['Exporter', 'SecretAlpha']);
      expect(savedStateJson).not.toContain(PLAINTEXT_A);
      expect(warnings().filter((w) => w.includes('Export.Name that resolves'))).toHaveLength(1);
    }
  });

  it('a LITERAL export name equal to a recorded secret is refused too', async () => {
    // The whole-value backstop, which the name-scoped map cannot supply: nothing
    // was SUBSTITUTED into a literal name, so only a comparison against the
    // pass's recorded values can catch a template that spells a secret out.
    const { saved, savedStateJson } = await deployOutputs({
      SecretAlpha: { Value: EXPR_A },
      Exporter: { Value: PUBLIC_B, Export: { Name: PLAINTEXT_A } },
    });

    const refusals = warnings().filter((w) => w.includes('Export.Name that resolves'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).not.toContain(PLAINTEXT_A);
    expect(Object.hasOwn(saved, PLAINTEXT_A)).toBe(false);
    expect(savedStateJson).not.toContain(PLAINTEXT_A);
  });

  it('masking is LONGEST-FIRST, so a nested secret cannot leave the longer one in fragments', async () => {
    // `PLAINTEXT_SHORT` is a prefix of `PLAINTEXT_NESTED`. Masking shortest-first
    // consumes the prefix and leaves the remainder of the longer secret in the
    // message — a partial disclosure a "masked:" label would still claim as safe.
    const { saved } = await deployOutputs({
      SecretBeta: {
        Value: EXPR_B,
        Export: { Name: { 'Fn::Sub': `${EXPR_SHORT}-${EXPR_NESTED}` } as never },
      },
    });

    const refusals = warnings().filter((w) => w.includes('Export.Name that resolves'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).not.toContain('with-a-long-tail');
    expect(refusals[0]).toContain('***-***');
    expect(Object.keys(saved)).toEqual(['SecretBeta']);
  });

  it('TWO outputs sharing ONE Export.Name is deliberately NOT guarded', async () => {
    // Documented behavior (docs/cross-stack-references.md): both bags stay
    // consistent — one iteration writes the value and its source together — so
    // it is not this issue's class. The later output simply wins the key, where
    // CloudFormation would reject the template outright. Pinned because a
    // deliberate non-behavior with no test is one a future round silently
    // reverses.
    const { saved, indexed } = await deployOutputs({
      First: { Value: EXPR_A, Export: { Name: 'SharedExport' } },
      Second: { Value: EXPR_B, Export: { Name: 'SharedExport' } },
    });

    expect(saved['SharedExport']).toBe(EXPR_B);
    expect(indexed['SharedExport']).toBe(EXPR_B);
    expect(saved['First']).toBe(EXPR_A);
    expect(warnings()).toEqual([]);
  });

  it('TWO suppressed outputs free BOTH names', async () => {
    const { saved, indexed } = await deployOutputs(
      {
        GhostOne: { Value: PUBLIC_A, Condition: 'IsProd' },
        GhostTwo: { Value: PUBLIC_B, Condition: 'IsProd' },
        SecretBeta: { Value: EXPR_B, Export: { Name: 'GhostTwo' } },
      },
      { conditions: { IsProd: false } }
    );

    expect(saved['GhostTwo']).toBe(EXPR_B);
    expect(indexed['GhostTwo']).toBe(EXPR_B);
    expect(Object.hasOwn(saved, 'GhostOne')).toBe(false);
    expect(warnings()).toEqual([]);
  });
});
