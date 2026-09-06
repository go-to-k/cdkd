/**
 * Issue #1919, `cdkd scrub` half: the outputs POSITION source this command
 * rebuilds from the template has the SAME two writers as the deploy engine's —
 * one per output NAME, one per `Export.Name` alias — and had no collision
 * guard.
 *
 * It is the worse half of the defect. Scrub's bag is LEGACY state holding
 * plaintext, its alias write runs AFTER the owning output's write in one loop
 * (the opposite winner from the deploy engine, where the post-loop pass wins),
 * and the command exists to remediate the advisory — so a colliding export name
 * rewrote a CORRECT public output into a reference naming a DIFFERENT output's
 * secret, which the exports index then republished.
 *
 * Two rules differ from the deploy engine's, and the cases below are what
 * settled them rather than argued them:
 *
 * - A colliding key gets NO position source and falls back to the VALUE scan,
 *   because scrub cannot know which output the stored value came from. The
 *   trade is two-sided and BOTH sides are pinned here: it fixes the corrupted
 *   legacy shape, and it gives up position precision when two references share
 *   one resolved value.
 * - Collisions are tested against DECLARED names with conditions IGNORED, and
 *   an intrinsic `Export.Name` is resolved best-effort for that test alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../../src/types/resource.js';

const commandLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
}));
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...commandLogger, child: () => commandLogger }),
}));

// The command-level mocks below exist for ONE test — the `--dry-run --fail`
// gate — and are inert for every `scrubStack` case, which is handed its
// backend, lock manager and logger directly.
const synthStacks = vi.hoisted(() => [] as unknown[]);
const commandStateBackend = vi.hoisted(() => ({
  getState: vi.fn(),
  saveState: vi.fn().mockResolvedValue('etag-2'),
}));
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockResolvedValue(undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {} })),
  setAwsClients: vi.fn(),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => commandStateBackend),
}));
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  })),
}));

const PUBLIC_VALUE = 'alpha-public-endpoint';
const SECRET_PLAINTEXT = 'beta-plaintext-secret';
const SECRET_EXPR = '{{resolve:secretsmanager:beta:SecretString:password:AWSCURRENT}}';
// A SECOND, different secret — the owning output's own value in the cases that
// need one. It is what makes them discriminate: with a literal owner value
// every candidate rule agrees, and only a rule that positions the ambiguous key
// by the OWNER's expression writes a reference naming the wrong secret.
const OWNER_PLAINTEXT = 'alpha-plaintext-secret';
const OWNER_EXPR = '{{resolve:secretsmanager:alpha:SecretString:password:AWSCURRENT}}';
// A THIRD expression resolving to the SAME plaintext as SECRET_EXPR — the two
// version stages of one secret, i.e. the #1910 collapse the value scan cannot
// separate.
const STAGED_EXPR = '{{resolve:secretsmanager:beta:SecretString:password:AWSPREVIOUS}}';
// A FOURTH expression that is a DISTINCT secret happening to resolve to the same
// plaintext as SECRET_EXPR — not another stage of the same one. This is the
// shape that makes the value-scan fallback's cost a wrong-SECRET reference
// rather than a lost precision bound.
const TWIN_EXPR = '{{resolve:secretsmanager:gamma:SecretString:password:AWSCURRENT}}';
// An `ssm` reference the resolver never PINS (issue #1901). The mock records it
// on its FIRST resolution only — a MODEL of "a plaintext a later resolution
// will not record again", which is what makes the name loop's own recording
// observable in the cases below. It is not how the real resolver behaves: an
// unclassifiable-`Type` reference is never cached (`cacheable = false`), so
// every real resolution re-asks AWS and records again.
const UNPINNED_PLAINTEXT = 'unpinned-securestring-value';
const UNPINNED_EXPR = '{{resolve:ssm:/p/unclassifiable}}';
const alreadyRecorded = vi.hoisted(() => new Set<string>());
// A degenerate SHORT secret, below the substring bound. Real secrets are longer;
// this one exists to prove an unbounded containment scan over state KEYS would
// flag unrelated keys and fail the CI gate repo-wide.
const TINY_PLAINTEXT = 'abc';
const TINY_EXPR = '{{resolve:secretsmanager:tiny:SecretString:pin:AWSCURRENT}}';
// A reference whose value MOVES between resolutions inside one run (issue
// #2531): the real resolver never caches an `ssm` reference whose `Type` came
// back unclassifiable, so the `Export.Name` loop (which runs FIRST) and the
// value loop each ask AWS, and a rotation in between shows the two a different
// plaintext. Modelled by returning `MOVING_FIRST` from the FIRST resolution and
// `MOVING_PLAINTEXT` afterwards, recording the entry AND the resolved pair the
// way the real seam does. `MOVING_EXPR_V1` is a second spelling of the same
// parameter resolving to the settled plaintext — the same-plaintext sibling
// that makes the value-keyed map collapse.
const MOVING_PLAINTEXT = 'moving-securestring-settled-value';
const MOVING_FIRST = 'moving-securestring-first-value';
const MOVING_EXPR = '{{resolve:ssm:/p/moving}}';
const MOVING_EXPR_V1 = '{{resolve:ssm:/p/moving:1}}';
const movingResolutions = vi.hoisted(() => new Map<string, number>());
/** A join part that makes the mock throw AFTER the parts before it recorded. */
const THROW_PART = '__THROW__';
/** ...and one that throws `undefined`, a legal thrown value the warn path must survive. */
const THROW_UNDEFINED_PART = '__THROW_UNDEFINED__';
/**
 * ...and one that resolves the unpinned reference LATE: it records only when
 * the resolver's NEXT call begins (the mock releases it there), so a sibling
 * part that rejects first ends the name's resolution — and the block around
 * it — before this part has recorded. That is the concurrent `Promise.all`
 * shape the real `Fn::Join` has, made deterministic: the late record lands
 * after the failed name's block and before the next resolution's own work.
 */
const LATE_PART = '__LATE_UNPINNED__';
const pendingLate = vi.hoisted(() => ({ release: undefined as (() => void) | undefined }));
/**
 * The plaintext KEYS the mock resolver saw in its context map at each call —
 * what the pin and the cross-stack pre-pass mask against inside the name loop.
 */
const contextKeysAtResolve = vi.hoisted(
  () =>
    [] as Array<{
      input: string;
      keys: string[];
      // Every READ surface of the map, captured separately: the name loop's
      // map is a VIEW whose reads must all reach the pass map, and the pin,
      // the pre-pass and the resolver read it through different methods
      // (`size` first, then `has` / `get` / iteration).
      size: number;
      hasUnpinned: boolean;
      getUnpinned: string | undefined;
      spread: string[];
      entries: string[];
      values: string[];
      forEach: string[];
    }>
);

/** Conditions scrub's best-effort re-evaluation returns; per-test knob. */
const conditionValues: { value: Record<string, boolean> } = { value: {} };

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockImplementation(() => Promise.resolve(conditionValues.value)),
    resolve: vi
      .fn()
      .mockImplementation(async (value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        // A pending LATE part of an EARLIER call records now, before this
        // call looks at its own context — deterministic "after that block,
        // before this one".
        if (pendingLate.release) {
          const release = pendingLate.release;
          pendingLate.release = undefined;
          release();
          await Promise.resolve();
          await Promise.resolve();
        }
        const map = ctx.recordedSecretValues;
        const forEachKeys: string[] = [];
        map?.forEach((_v, k) => forEachKeys.push(k));
        contextKeysAtResolve.push({
          input: JSON.stringify(value),
          keys: [...(map?.keys() ?? [])],
          size: map?.size ?? -1,
          hasUnpinned: map?.has(UNPINNED_PLAINTEXT) ?? false,
          getUnpinned: map?.get(UNPINNED_PLAINTEXT),
          spread: map ? [...map].map(([k]) => k) : [],
          entries: [...(map?.entries() ?? [])].map(([k]) => k),
          values: [...(map?.values() ?? [])],
          forEach: forEachKeys,
        });
        const record = (plaintext: string, expr: string): void => {
          // An unpinned ssm reference is recorded only on its FIRST resolution.
          if (expr === UNPINNED_EXPR) {
            if (alreadyRecorded.has(expr)) return;
            alreadyRecorded.add(expr);
          }
          ctx.recordedSecretValues?.set(plaintext, expr);
        };
        // The moving reference: entry AND pair, like the real recording seam.
        const resolveMoving = (expr: string): string => {
          const n = (movingResolutions.get(expr) ?? 0) + 1;
          movingResolutions.set(expr, n);
          const plaintext = expr === MOVING_EXPR && n === 1 ? MOVING_FIRST : MOVING_PLAINTEXT;
          ctx.recordedSecretValues?.set(plaintext, expr);
          if (ctx.recordedSecretValues) recordResolvedPair(ctx.recordedSecretValues, expr, plaintext);
          return plaintext;
        };
        const walk = (v: unknown): unknown => {
          if (v === MOVING_EXPR || v === MOVING_EXPR_V1) return resolveMoving(v);
          if (v === SECRET_EXPR || v === STAGED_EXPR || v === TWIN_EXPR) {
            record(SECRET_PLAINTEXT, v as string);
            return SECRET_PLAINTEXT;
          }
          if (v === OWNER_EXPR) {
            record(OWNER_PLAINTEXT, OWNER_EXPR);
            return OWNER_PLAINTEXT;
          }
          if (v === TINY_EXPR) {
            record(TINY_PLAINTEXT, TINY_EXPR);
            return TINY_PLAINTEXT;
          }
          if (v === UNPINNED_EXPR) {
            record(UNPINNED_PLAINTEXT, UNPINNED_EXPR);
            return UNPINNED_PLAINTEXT;
          }
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const entries = Object.entries(v as Record<string, unknown>);
            // `Fn::Sub` collapses to a STRING — the shape a pre-fix binary
            // resolved and then used as a state KEY.
            if (
              entries.length === 1 &&
              entries[0]![0] === 'Fn::Sub' &&
              typeof entries[0]![1] === 'string'
            ) {
              const body = entries[0]![1] as string;
              // A parameter this run cannot resolve — the deploy could, from a
              // real parameter value.
              if (body.includes('${Unresolvable}')) {
                throw new Error('Parameter Unresolvable has no value during scrub');
              }
              return walk(
                body
                  .replace('${Owner}', 'PublicAlpha')
                  .replace('${Free}', 'FreeName')
                  .replace('${SecretName}', OWNER_PLAINTEXT)
              );
            }
            const out: Record<string, unknown> = {};
            for (const [k, val] of entries) out[k] = walk(val);
            return out;
          }
          if (typeof v === 'string' && v.includes(MOVING_EXPR)) {
            return v.split(MOVING_EXPR).join(resolveMoving(MOVING_EXPR));
          }
          if (typeof v === 'string' && v.includes(UNPINNED_EXPR)) {
            record(UNPINNED_PLAINTEXT, UNPINNED_EXPR);
            return v.split(UNPINNED_EXPR).join(UNPINNED_PLAINTEXT);
          }
          return v;
        };
        // A top-level `Fn::Join` resolves its parts CONCURRENTLY, as the real
        // resolver does (`Promise.all`): a part that rejects ends the whole
        // resolution while a slower sibling is still pending.
        const join = value as { 'Fn::Join'?: [string, unknown[]] } | null;
        if (join && typeof join === 'object' && Array.isArray(join['Fn::Join'])) {
          const [delimiter, parts] = join['Fn::Join'];
          const resolvedSoFar: string[] = [];
          return Promise.all(
            parts.map(async (part) => {
              // A resolver error ECHOES its input, resolved so far — the
              // shape that makes the warn path's masking load-bearing.
              if (part === THROW_PART) {
                throw new Error(`Fn::Join sibling rejected during scrub: ${resolvedSoFar.join('')}`);
              }
              if (part === THROW_UNDEFINED_PART) throw undefined;
              if (part === LATE_PART) {
                await new Promise<void>((resolve) => {
                  pendingLate.release = resolve;
                });
                record(UNPINNED_PLAINTEXT, UNPINNED_EXPR);
                return UNPINNED_PLAINTEXT;
              }
              const resolved = String(walk(part));
              resolvedSoFar.push(resolved);
              return resolved;
            })
          ).then((resolved) => resolved.join(delimiter));
        }
        return walk(value);
      }),
  })),
}));

import {
  scrubStack,
  scrubCommand,
  ScrubNeededError,
  type ScrubOptions,
} from '../../../../src/cli/commands/scrub.js';
import {
  exportAliasCollisionScrubWarning,
  secretBearingStateKeyWarning,
} from '../../../../src/deployment/outputs-export-alias.js';
import { recordResolvedPair } from '../../../../src/deployment/secret-redaction.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * The map the production call passes. Its content is irrelevant to these three
 * assertions — none of these names contains a secret — but the ARGUMENT is
 * required, so a caller cannot silently print an unmasked name.
 */
const SECRETS_FOR_MESSAGE = new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]);

/**
 * A COMPLETE `ScrubOptions`, built without a cast so a newly REQUIRED option
 * fails to compile here instead of being silently erased by an `as`.
 */
function commandOptions(overrides: Partial<ScrubOptions>): ScrubOptions {
  // `verbose` is REQUIRED and the previous cast erased it — which is the drift
  // this helper exists to surface.
  return { output: 'cdk.out', statePrefix: 'cdkd', verbose: false, ...overrides };
}

function makeStackInfo(outputs: Record<string, TemplateOutput>): {
  stackName: string;
  template: CloudFormationTemplate;
} {
  return {
    stackName: 'MyStack',
    template: { Resources: {}, Conditions: { IsProd: { 'Fn::Equals': [] } }, Outputs: outputs },
  };
}

function makeState(outputs: Record<string, unknown>): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: {},
    outputs,
    lastModified: 0,
  };
}

/** `PublicAlpha` owns the name; `SecretBeta` exports under it — the collision. */
function collidingOutputs(
  ownerValue: unknown,
  opts: { ownerCondition?: string; exportName?: unknown; exporterValue?: unknown } = {}
): Record<string, TemplateOutput> {
  return {
    PublicAlpha: {
      Value: ownerValue,
      ...(opts.ownerCondition && { Condition: opts.ownerCondition }),
    },
    SecretBeta: {
      Value: opts.exporterValue ?? SECRET_EXPR,
      Export: { Name: (opts.exportName ?? 'PublicAlpha') as string },
    },
  };
}

describe('cdkd scrub - Export.Name colliding with an output NAME (issue #1919)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conditionValues.value = {};
    alreadyRecorded.clear();
    movingResolutions.clear();
    contextKeysAtResolve.length = 0;
    pendingLate.release = undefined;
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  async function scrub(
    outputs: Record<string, TemplateOutput>
  ): Promise<{ saved: StackState | undefined; secretsFound: number; changed: number }> {
    const res = await scrubStack(
      makeStackInfo(outputs) as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );
    const call = stateBackend.saveState.mock.calls.at(-1);
    return {
      saved: call ? (call[2] as StackState) : undefined,
      secretsFound: res.secretsFound,
      changed: res.recordsChanged,
    };
  }

  it('does NOT rewrite a correct public output into the exporting output secret reference', async () => {
    // The reproduction: state is CLEAN for `PublicAlpha` (it holds the public
    // value) and leaky only for `SecretBeta`. Unguarded, the alias write put
    // SecretBeta's expression under `PublicAlpha` in the source bag and the
    // position pass rewrote a public endpoint into a reference naming a
    // different output's secret.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: PUBLIC_VALUE, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub(collidingOutputs(PUBLIC_VALUE));

    expect(saved!.outputs['PublicAlpha']).toBe(PUBLIC_VALUE);
    // The genuinely leaky key is still remediated — that is the command's job.
    expect(saved!.outputs['SecretBeta']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    expect(logger.warn).toHaveBeenCalledWith(
      exportAliasCollisionScrubWarning('SecretBeta', 'PublicAlpha', SECRETS_FOR_MESSAGE)
    );
  });

  it('falls back to the VALUE scan on the colliding key, so corrupted legacy state is remediated', async () => {
    // The other legacy shape: an old binary let the ALIAS win the key, so
    // `PublicAlpha` holds SecretBeta's plaintext. Here the owning output's own
    // value is a DIFFERENT secret, which is what makes the rule choice visible:
    // positioning the key by the owner's expression — the deploy engine's rule,
    // sound there because it just resolved the value itself — writes
    // OWNER_EXPR, a reference naming the wrong secret.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub(collidingOutputs(OWNER_EXPR));

    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
    expect(saved!.outputs['SecretBeta']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
  });

  it('THE COST of that fallback: a #1910 collapse is no longer separable on the colliding key', async () => {
    // The other side of the same trade, pinned so it is visible rather than
    // argued. Both outputs resolve to ONE plaintext through DIFFERENT version
    // stages, which is exactly what position exists to separate — and on the
    // ambiguous key there is no position left, so the value map decides and the
    // key takes whichever expression it kept. The deploy engine's rule would
    // persist the OWNER's stage here; neither rule dominates, and this one is
    // chosen because its failure is a lost precision bound while the other's is
    // a reference naming a different secret (the two cases above).
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub(collidingOutputs(STAGED_EXPR));

    // Both keys land on ONE stage — the value map's survivor — where a
    // position-carrying key would have kept `STAGED_EXPR` on `PublicAlpha`.
    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
    expect(saved!.outputs['SecretBeta']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
  });

  it('EVIDENCE (declared vs published): a collision scrub judges suppressed is still a collision', async () => {
    // Scrub re-evaluates conditions BEST-EFFORT, from template defaults only,
    // and `evaluateConditions` assumes FALSE on any failure — so it can judge
    // an output suppressed that the DEPLOY published. State proves the deploy
    // published it: the key is there, holding its own public value.
    //
    // Testing collisions against PUBLISHED names (scrub's own conditions) makes
    // this a non-collision, so the alias write installs SecretBeta's secret
    // expression as the position source for `PublicAlpha` and the public value
    // is rewritten into a reference naming a different output's secret. Testing
    // against DECLARED names keeps it a collision, which is why scrub
    // over-approximates.
    conditionValues.value = { IsProd: false };
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: PUBLIC_VALUE, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub(collidingOutputs(PUBLIC_VALUE, { ownerCondition: 'IsProd' }));

    expect(saved!.outputs['PublicAlpha']).toBe(PUBLIC_VALUE);
    expect(saved!.outputs['SecretBeta']).toBe(SECRET_EXPR);
  });

  it('EVIDENCE (the cost of over-approximating): a genuinely suppressed name warns but stays correct', async () => {
    // The other direction, and the reason the choice is not free: when the
    // output really was suppressed, the deploy legitimately published the alias
    // under that key, and scrub still calls it ambiguous. The value is
    // remediated correctly either way — the whole cost is one spurious warning
    // plus the value-scan fallback pinned above.
    conditionValues.value = { IsProd: false };
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub(collidingOutputs(OWNER_EXPR, { ownerCondition: 'IsProd' }));

    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
    expect(logger.warn).toHaveBeenCalledWith(
      exportAliasCollisionScrubWarning('SecretBeta', 'PublicAlpha', SECRETS_FOR_MESSAGE)
    );
  });

  it('an INTRINSIC Export.Name is resolved for the collision test — legacy state was keyed by it', async () => {
    // The pre-fix binary RESOLVED an intrinsic `Export.Name` and used the result
    // as a state key, and that state is scrub's entire population. A
    // literal-only ambiguity test leaves the original corruption reachable
    // through exactly the shape the legacy binary produced.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: PUBLIC_VALUE, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub(
      collidingOutputs(PUBLIC_VALUE, { exportName: { 'Fn::Sub': '${Owner}' } })
    );

    expect(saved!.outputs['PublicAlpha']).toBe(PUBLIC_VALUE);
    expect(saved!.outputs['SecretBeta']).toBe(SECRET_EXPR);
    expect(logger.warn).toHaveBeenCalledWith(
      exportAliasCollisionScrubWarning('SecretBeta', 'PublicAlpha', SECRETS_FOR_MESSAGE)
    );
  });

  it('the export-name resolve RECORDS into the pass map, so a later value is not left in plaintext', async () => {
    // The export-name loop runs BEFORE the value loop. Whatever it records
    // must reach the pass map: a plaintext recorded ONLY there (modelled by
    // the record-once reference) would otherwise be invisible when the value
    // loop meets the same token, so its plaintext would survive `cdkd scrub`
    // and `--dry-run --fail` would report the state CLEAN.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ Leaky: UNPINNED_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved, secretsFound } = await scrub({
      Exporter: { Value: PUBLIC_VALUE, Export: { Name: { 'Fn::Sub': `x-${UNPINNED_EXPR}` } as never } },
      Leaky: { Value: UNPINNED_EXPR },
    });

    expect(secretsFound).toBeGreaterThan(0);
    expect(saved!.outputs['Leaky']).toBe(UNPINNED_EXPR);
    expect(JSON.stringify(saved)).not.toContain(UNPINNED_PLAINTEXT);
  });

  it('does NOT merge the export-name resolution PAIRS: a value that moved there cannot conflict the evidence the value loop earns (issue #2531)', async () => {
    // The name loop runs FIRST and re-asks AWS for a reference the resolver
    // never caches; if the value moved since, its resolved pair disagrees with
    // the one the value loop records for the same token. Through a shared map
    // that marks the pair conflicting, and the literal Output embedding the
    // token falls to the value scan — the sibling's `:1` spelling, the #2485
    // defect re-opened for this one shape. With the name's own map and an
    // ENTRIES-only copy, the value loop's pair stands and the leaf keeps its
    // own token.
    stateBackend.getState.mockResolvedValue({
      state: makeState({
        Exporter: PUBLIC_VALUE,
        Dsn: `pre-${MOVING_PLAINTEXT}-post`,
        Whole: MOVING_PLAINTEXT,
        // A key today's template cannot account for: the widened pass value-
        // scans it, so it shows which expression holds the collapsed slot.
        Orphan: MOVING_PLAINTEXT,
      }),
      etag: 'etag-1',
    });

    const { saved } = await scrub({
      Exporter: { Value: PUBLIC_VALUE, Export: { Name: { 'Fn::Sub': `x-${MOVING_EXPR}` } as never } },
      // The embedded leaf FIRST, so the whole-value sibling holds the
      // collapsed map slot — the order the value scan gets wrong.
      Dsn: { Value: `pre-${MOVING_EXPR}-post` },
      Whole: { Value: MOVING_EXPR_V1 },
    });

    // The premise: the name loop saw the moved value, the value loop the settled one.
    expect(movingResolutions.get(MOVING_EXPR)).toBe(2);
    // ...and the collapsed slot really is the sibling's spelling — the
    // value scan of a key no source positions writes the survivor. Without
    // this guard a reorder of `Dsn` / `Whole` would let the case pass with
    // the shared map, silently.
    expect(saved!.outputs['Orphan']).toBe(MOVING_EXPR_V1);
    expect(saved!.outputs['Dsn']).toBe(`pre-${MOVING_EXPR}-post`);
    expect(saved!.outputs['Whole']).toBe(MOVING_EXPR_V1);
    expect(JSON.stringify(saved)).not.toContain(MOVING_PLAINTEXT);
    expect(JSON.stringify(saved)).not.toContain(MOVING_FIRST);
  });

  it('...but the export-name resolution\'s ENTRIES still reach the pass map when that resolution THROWS part-way, so the error it warns with is MASKED (issue #2531)', async () => {
    // `Fn::Join` records its first part before its second throws — and the
    // resolver's error ECHOES what it resolved, so the warn that reports it
    // prints that plaintext unless the entry recorded before the throw has
    // reached the map the warn masks against. That is the invariant this
    // case pins: the entry is forwarded on the throwing exit too, BEFORE the
    // warn. (The `Leaky`
    // assertion rides on this file's record-once modelling of an unpinned
    // reference; the real resolver would re-record it in the value loop, so
    // the masked warn is the discriminating assertion, not `Leaky`.)
    stateBackend.getState.mockResolvedValue({
      state: makeState({ Leaky: UNPINNED_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved, secretsFound } = await scrub({
      Exporter: {
        Value: PUBLIC_VALUE,
        Export: { Name: { 'Fn::Join': ['', [UNPINNED_EXPR, THROW_PART]] } as never },
      },
      Leaky: { Value: UNPINNED_EXPR },
    });

    const warns = logger.warn.mock.calls.map((c) => String(c[0]));
    const nameWarn = warns.find((w) => w.includes('could not be resolved during scrub'));
    expect(nameWarn).toBeDefined();
    expect(nameWarn).toContain('***');
    expect(nameWarn).not.toContain(UNPINNED_PLAINTEXT);
    expect(secretsFound).toBeGreaterThan(0);
    expect(saved!.outputs['Leaky']).toBe(UNPINNED_EXPR);
    expect(JSON.stringify(saved)).not.toContain(UNPINNED_PLAINTEXT);
  });

  it('...and an entry recorded AFTER the name resolution already failed (a slower Fn::Join part) still reaches the pass map AND a later name, which a copy or a seeded snapshot would miss (issue #2531)', async () => {
    // `Fn::Join` resolves its parts concurrently. A part that rejects ends
    // the name's resolution — and the block around it — while a secret part
    // is still pending; that part records afterwards (here: when the NEXT
    // resolution begins). Two things must hold that neither a copy at the end
    // of the block nor a private map seeded from the pass map gives: the
    // late entry reaches the pass map (`Leaky` is scrubbed — an assertion
    // that rides on this file's record-once modelling, since the real
    // resolver would re-record the reference in the value loop), and the
    // LATER name's resolution already sees it (its context carries the
    // plaintext — the discriminating assertion), because the pin and the
    // pre-pass mask against exactly that context.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ Leaky: UNPINNED_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved, secretsFound } = await scrub({
      Exporter: {
        Value: PUBLIC_VALUE,
        Export: { Name: { 'Fn::Join': ['', [LATE_PART, THROW_PART]] } as never },
      },
      Later: { Value: PUBLIC_VALUE, Export: { Name: { 'Fn::Sub': `y-${MOVING_EXPR}` } as never } },
      Leaky: { Value: UNPINNED_EXPR },
    });

    const laterName = contextKeysAtResolve.find((c) => c.input.includes(`y-${MOVING_EXPR}`));
    expect(laterName).toBeDefined();
    expect(laterName!.keys).toContain(UNPINNED_PLAINTEXT);
    expect(secretsFound).toBeGreaterThan(0);
    expect(saved!.outputs['Leaky']).toBe(UNPINNED_EXPR);
    expect(JSON.stringify(saved)).not.toContain(UNPINNED_PLAINTEXT);
  });

  it('resolves each export name against every entry recorded SO FAR — the name map is a VIEW of the pass map, not a fresh one (issue #2531)', async () => {
    // The name loop runs before any value, so what an earlier NAME recorded
    // is the only thing a later name's resolution can be handed — and the
    // cross-region pin and the cross-stack pre-pass mask their own messages
    // against the map they are handed. This case pins that at the resolver
    // seam only: the context the second name is resolved with must carry the
    // first name's plaintext (a fresh private map fails it). It does not
    // drive those two callers' messages; their masking against the map they
    // receive is pinned by the cross-region and import-value scrub suites.
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-1' });

    await scrub({
      First: { Value: PUBLIC_VALUE, Export: { Name: { 'Fn::Sub': `x-${UNPINNED_EXPR}` } as never } },
      Second: { Value: PUBLIC_VALUE, Export: { Name: { 'Fn::Sub': `y-${MOVING_EXPR}` } as never } },
    });

    const secondName = contextKeysAtResolve.find((c) => c.input.includes(`y-${MOVING_EXPR}`));
    expect(secondName).toBeDefined();
    // Every read surface, because each has its own production reader: the
    // masking helpers check `size` before scanning (a view reporting 0 would
    // return their text UNMASKED), the resolver's cross-stack seam asks `has`,
    // and the scans iterate. A view delegating any one of these to its own
    // empty storage would pass the others.
    expect(secondName!.keys).toContain(UNPINNED_PLAINTEXT);
    expect(secondName!.size).toBeGreaterThan(0);
    expect(secondName!.hasUnpinned).toBe(true);
    expect(secondName!.getUnpinned).toBe(UNPINNED_EXPR);
    expect(secondName!.spread).toContain(UNPINNED_PLAINTEXT);
    expect(secondName!.entries).toContain(UNPINNED_PLAINTEXT);
    expect(secondName!.values).toContain(UNPINNED_EXPR);
    expect(secondName!.forEach).toContain(UNPINNED_PLAINTEXT);
  });

  it('still warns when the name resolution throws `undefined` (a legal thrown value)', async () => {
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub({
      PublicAlpha: { Value: OWNER_EXPR },
      SecretBeta: {
        Value: SECRET_EXPR,
        Export: { Name: { 'Fn::Join': ['', [THROW_UNDEFINED_PART]] } as never },
      },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be resolved during scrub')
    );
    // ...and the bag is value-scanned as on any other failed name.
    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
  });

  it('a resolved intrinsic name is COMPARED, never WRITTEN as a source key', async () => {
    // The resolution uses template defaults and can differ from what the deploy
    // resolved, so it may name a key this state never had — or a different one.
    // Writing a source under it would position a key by an output that has no
    // claim to it. Here the resolved name is FREE (no collision), and the state
    // key of that name holds a DIFFERENT output's secret: trusting the resolved
    // name as a source key persists the exporter's expression over it.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ FreeName: OWNER_PLAINTEXT, XOut: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub({
      Owner: { Value: OWNER_EXPR },
      XOut: { Value: SECRET_EXPR, Export: { Name: { 'Fn::Sub': '${Free}' } as never } },
    });

    expect(saved!.outputs['FreeName']).toBe(OWNER_EXPR);
    expect(saved!.outputs['XOut']).toBe(SECRET_EXPR);
  });

  it('an UNRESOLVABLE intrinsic name makes the whole outputs bag value-scanned, and warns', async () => {
    // Scrub cannot reproduce the name the deploy keyed state under, and that
    // name could be ANY output's — so there is no single key to distrust and no
    // honest way to keep positioning the rest. Here position would be actively
    // wrong: the deploy's resolved name was `PublicAlpha`, so that key holds the
    // EXPORTER's value while the template says the owner's expression belongs
    // there.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub({
      PublicAlpha: { Value: OWNER_EXPR },
      SecretBeta: {
        Value: SECRET_EXPR,
        Export: { Name: { 'Fn::Sub': 'pre-${Unresolvable}' } as never },
      },
    });

    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('redacting this stack\'s outputs by value match')
    );
  });

  it('an intrinsic name resolving to a NON-STRING also makes the bag untrusted', async () => {
    // The other arm of the same rule, and the one the throw case cannot pin: a
    // resolution that SUCCEEDS but does not yield a string is equally a name
    // scrub cannot reproduce. Without this arm the flag is only set by the
    // catch, so a template whose export name resolves to a list silently keeps
    // a source bag that positions the deploy-written key by the wrong output.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub({
      PublicAlpha: { Value: OWNER_EXPR },
      SecretBeta: {
        Value: SECRET_EXPR,
        // Resolves to an OBJECT (the mock walks it and returns a map), not a string.
        Export: { Name: { 'Fn::GetAtt': ['Res', 'Arn'] } as never },
      },
    });

    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
  });

  it('an unresolvable ${Placeholder} in an export name makes the bag untrusted too', async () => {
    // `resolveSub` does NOT throw on a placeholder it cannot substitute — it
    // warns and keeps `${EnvName}` in the string — and scrub takes no
    // `--parameters`, so this is the COMMON shape for a parameterized export
    // name, not an edge case. A returned string is not a resolved one.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub({
      PublicAlpha: { Value: OWNER_EXPR },
      SecretBeta: {
        Value: SECRET_EXPR,
        Export: { Name: { 'Fn::Sub': '${EnvName}-Shared' } as never },
      },
    });

    // Value-scanned, so the stored plaintext maps back to the expression that
    // produced it rather than to the owner's.
    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not fully resolve during scrub')
    );
  });

  it('CI GATE: a REAL run also exits non-zero on a leak it cannot rewrite', async () => {
    // `--fail` was inert without `--dry-run`, so a real run over the one finding
    // class a real run CANNOT fix exited 0 — exactly backwards.
    synthStacks.length = 0;
    synthStacks.push(
      makeStackInfo({
        Exporter: {
          Value: PUBLIC_VALUE,
          Export: { Name: { 'Fn::Sub': `pre-${UNPINNED_EXPR}` } as never },
        },
        Leaky: { Value: UNPINNED_EXPR },
      })
    );
    commandStateBackend.getState.mockResolvedValue({
      state: makeState({ [`pre-${UNPINNED_PLAINTEXT}`]: 'some-value' }),
      etag: 'etag-1',
    });

    await expect(
      scrubCommand([], commandOptions({ fail: true }))
    ).rejects.toBeInstanceOf(ScrubNeededError);

    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    // And it must not claim to have removed anything. The needle tracks the
    // summary's actual wording (issue #2624 replaced "The plaintext is no
    // longer stored there" with a versioning-bounded sentence) — a needle no
    // code path can emit makes this assertion pass for free.
    expect(summary).toContain('Nothing could be rewritten');
    expect(summary).not.toContain('The CURRENT state.json no longer holds the plaintext');
  });

  it('a state with NO outputs field is still scrubbed rather than throwing', async () => {
    // Every other consumer treats `outputs` as optional, and so does this
    // function's own redaction call — so indexing it directly made the
    // REMEDIATION command throw on a state file that simply has none, refusing
    // to scrub the resources it could have scrubbed.
    const stateWithoutOutputs = {
      version: 8,
      region: 'us-east-1',
      stackName: 'MyStack',
      resources: {
        Fn: {
          physicalId: 'my-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Secret: SECRET_PLAINTEXT },
        },
      },
      lastModified: 0,
    } as unknown as StackState;
    stateBackend.getState.mockResolvedValue({ state: stateWithoutOutputs, etag: 'etag-1' });

    const res = await scrubStack(
      {
        stackName: 'MyStack',
        template: {
          Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: { Secret: SECRET_EXPR } } },
          Outputs: {},
        },
      } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );

    expect(res.recordsChanged).toBeGreaterThan(0);
    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Fn']!.properties['Secret']).toBe(SECRET_EXPR);
  });

  it('the KEY scan is BOUNDED: a degenerate short secret does not flag unrelated keys', async () => {
    // An unbounded containment scan over keys turns a three-character recorded
    // secret into a repo-wide `--dry-run --fail` failure: every key containing
    // those characters is reported as leaking. That is the availability failure
    // the export-name check was redesigned to avoid, and the same discipline
    // applies here — below the substring bound only a WHOLE-key match counts.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ MyabcExport: 'unrelated-value', Tiny: TINY_PLAINTEXT }),
      etag: 'etag-1',
    });

    const res = await scrubStack(
      makeStackInfo({ Tiny: { Value: TINY_EXPR } }) as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: true, logger: logger as never }
    );

    expect(res.secretBearingKeys).toBe(0);
    // The VALUE still is remediated — the bound applies to key REPORTING only.
    expect(res.recordsChanged).toBeGreaterThan(0);
  });

  it('CI GATE: --dry-run --fail exits non-zero on a KEY-only finding', async () => {
    // The wiring this field exists for. `scrubStack`'s return value proves
    // nothing on its own: the verdict, the message and the throw all live in
    // `scrubCommand`, and pinning only the helper leaves "does a finding fail
    // the build?" unverified — which is the entire point of reporting a key
    // that cannot be scrubbed.
    synthStacks.length = 0;
    synthStacks.push(
      makeStackInfo({
        Exporter: {
          Value: PUBLIC_VALUE,
          Export: { Name: { 'Fn::Sub': `pre-${UNPINNED_EXPR}` } as never },
        },
        Leaky: { Value: UNPINNED_EXPR },
      })
    );
    // State whose RECORDS are clean — only the KEY holds plaintext, so nothing
    // is scrubbable and the pre-#1919 verdict would have been "clean".
    commandStateBackend.getState.mockResolvedValue({
      state: makeState({ [`pre-${UNPINNED_PLAINTEXT}`]: 'some-value' }),
      etag: 'etag-1',
    });

    await expect(
      scrubCommand([], commandOptions({ dryRun: true, fail: true }))
    ).rejects.toBeInstanceOf(ScrubNeededError);

    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    // The summary must not claim a remediation it did not perform.
    expect(summary).toContain('cannot rewrite');
    expect(summary).not.toContain('Would scrub 1');
  });

  it('THE OTHER COST: two DISTINCT secrets sharing one plaintext can name the wrong one', async () => {
    // Stated because an earlier revision of this rationale called the fallback's
    // residual a lost precision bound. It is not: the value map is keyed by
    // PLAINTEXT, so two DIFFERENT secrets colliding on one value leave only the
    // last, and the ambiguous key is persisted holding a reference to the OTHER
    // secret. Smaller blast radius than the alternative — one key, and only when
    // two secrets coincide — but the same KIND of error, and the docs and code
    // comments now say so.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    // `PublicAlpha` genuinely holds gamma's secret; beta's resolves to the same
    // plaintext and is recorded last, so the value scan names BETA on both keys.
    const { saved } = await scrub(collidingOutputs(TWIN_EXPR));

    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
    expect(saved!.outputs['SecretBeta']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
  });

  it('a state KEY holding plaintext is REPORTED and never rewritten', async () => {
    // The residue of a pre-fix binary publishing an export name that resolved to
    // a secret. No redaction pass can reach it — they all walk values — and
    // renaming the key would silently retire a live export, so scrub reports it
    // instead. Without the report, `--dry-run --fail` calls a state clean while
    // `state.json` holds plaintext.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ [`pre-${UNPINNED_PLAINTEXT}`]: 'some-value', Leaky: UNPINNED_PLAINTEXT }),
      etag: 'etag-1',
    });

    const res = await scrubStack(
      makeStackInfo({
        Exporter: {
          Value: PUBLIC_VALUE,
          Export: { Name: { 'Fn::Sub': `pre-${UNPINNED_EXPR}` } as never },
        },
        Leaky: { Value: UNPINNED_EXPR },
      }) as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: true, logger: logger as never }
    );

    expect(res.secretBearingKeys).toBe(1);
    const keyWarnings = logger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('holds an output KEY containing a secret'));
    expect(keyWarnings).toHaveLength(1);
    // The warning is about a plaintext leak; printing the key verbatim would BE
    // the leak, on a different reader.
    expect(keyWarnings[0]).not.toContain(UNPINNED_PLAINTEXT);
    expect(keyWarnings[0]).toContain('***');
    // Reported, not rewritten: dry-run writes nothing, and the key is untouched
    // in what would be written.
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('the collision warning MASKS a resolved name that carries plaintext', async () => {
    // The deploy twin prints its colliding name unmasked because
    // `secretBearingExportNameWarning` refused a secret-bearing `Export.Name`
    // upstream. Scrub runs no such refusal, so it masks its own — a BELT rather
    // than the guarantee an earlier revision of this comment claimed (issue
    // #1958 item 9): what actually bounds the printed string is the collision
    // test, which only ever passes a name matching a DECLARED output name.
    // Hence the shape below, which is the reachable one and not an arbitrary
    // contrivance: the template has to NAME an output with the plaintext. The
    // disclosure is still real — the template is not stderr, and not a CI log.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ [OWNER_PLAINTEXT]: 'v', Exporter: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    await scrub({
      [OWNER_PLAINTEXT]: { Value: OWNER_EXPR },
      Exporter: {
        Value: SECRET_EXPR,
        Export: { Name: { 'Fn::Sub': '${SecretName}' } as never },
      },
    });

    const collisionWarnings = logger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('is also the name of another output'));
    expect(collisionWarnings).toHaveLength(1);
    expect(collisionWarnings[0]).not.toContain(OWNER_PLAINTEXT);
    expect(collisionWarnings[0]).toContain('***');
  });

  it('a SUPPRESSED output is still RESOLVED, so its leaked plaintext is found and scrubbed', async () => {
    // Skipping the iteration for a suppressed output would skip the resolve that
    // RECORDS its secret — and with no other secret in the stack, scrub would
    // take the `totalSecrets === 0` early return and report the state CLEAN.
    // That is the remediation command declining to remediate, on a judgement
    // (`assuming false`) it cannot even trust.
    conditionValues.value = { IsProd: false };
    stateBackend.getState.mockResolvedValue({
      state: makeState({ GhostAlpha: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved, secretsFound, changed } = await scrub({
      GhostAlpha: { Value: SECRET_EXPR, Condition: 'IsProd' },
    });

    expect(secretsFound).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
    expect(saved!.outputs['GhostAlpha']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
  });
});

describe('outputs-export-alias message builders', () => {
  it('strips control characters from a printed state KEY', () => {
    // An export NAME — and so a state key derived from one — is a RESOLVED value
    // that never passed a CloudFormation validator, so it can carry ANSI escapes
    // or bidi overrides into a terminal or a CI log. `diff-recursive.ts`
    // documents that hazard for this same key space; these warnings print the
    // same strings and must not be the way in.
    const key = 'pre-\u001b[31mred\u202e-endpoint';
    const message = secretBearingStateKeyWarning('MyStack', key, new Map([['red', 'EXPR']]));

    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\u202e');
    // ...while still naming enough of the key to act on.
    expect(message).toContain('pre-');
    expect(message).toContain('-endpoint');
  });

  it('the scrub collision warning masks the OWNING output key too, not only the exported name', () => {
    // The neighbour of the masked argument (issue #1958 review). Both names
    // reach this builder from the same place — the collision fired because the
    // export name matched a DECLARED output name, so the owning key is a
    // declared output name as well — and the reachable shape is a template that
    // NAMES an output with the plaintext. Which of the two carries it depends
    // only on which output does the exporting, so masking one and printing the
    // other raw leaves the disclosure open on half the inputs.
    //
    // Note the arguments are the MIRROR of the case below: here the PLAINTEXT
    // is the owning key and the export name is ordinary.
    const message = exportAliasCollisionScrubWarning(
      SECRET_PLAINTEXT,
      'alpha-public-endpoint',
      SECRETS_FOR_MESSAGE
    );

    expect(message).not.toContain(SECRET_PLAINTEXT);
    expect(message).toContain('***');
    // ...and the ordinary name beside it is untouched, so this is a mask and
    // not a builder that redacts indiscriminately.
    expect(message).toContain('alpha-public-endpoint');
  });

  it('CONTROL: the scrub collision warning leaves an ORDINARY name untouched', () => {
    // The polarity the suite was missing (issue #1958 item 9). The end-to-end
    // `MASKS a resolved name that carries plaintext` case pins that the belt
    // FIRES; nothing pinned that it stays OFF a name carrying no secret, and
    // the three assertions that call this builder as their own expected value
    // cannot — they are tautological with respect to masking. Measured: a
    // builder that returned the bare mask for every name is green across the
    // whole file except this case. (It does NOT reach `secretsPresentIn`'s
    // `MIN_SECRET_NEEDLE` bound — that needs a degenerate SHORT needle in the
    // map, which `deploy-engine-outputs-export-name-collision.test.ts` fences
    // with its `PLAINTEXT_SHORT`.)
    const message = exportAliasCollisionScrubWarning(
      'SecretBeta',
      'alpha-public-endpoint',
      SECRETS_FOR_MESSAGE
    );

    expect(message).toContain('alpha-public-endpoint');
    expect(message).not.toContain('***');
  });
});
