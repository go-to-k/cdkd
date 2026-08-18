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
// An `ssm` reference the resolver never PINS (issue #1901): recorded on its
// FIRST resolution only, exactly as the cache-hit arm behaves.
const UNPINNED_PLAINTEXT = 'unpinned-securestring-value';
const UNPINNED_EXPR = '{{resolve:ssm:/p/unclassifiable}}';
const alreadyRecorded = vi.hoisted(() => new Set<string>());
// A degenerate SHORT secret, below the substring bound. Real secrets are longer;
// this one exists to prove an unbounded containment scan over state KEYS would
// flag unrelated keys and fail the CI gate repo-wide.
const TINY_PLAINTEXT = 'abc';
const TINY_EXPR = '{{resolve:secretsmanager:tiny:SecretString:pin:AWSCURRENT}}';

/** Conditions scrub's best-effort re-evaluation returns; per-test knob. */
const conditionValues: { value: Record<string, boolean> } = { value: {} };

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockImplementation(() => Promise.resolve(conditionValues.value)),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const record = (plaintext: string, expr: string): void => {
          // An unpinned ssm reference is recorded only on its FIRST resolution.
          if (expr === UNPINNED_EXPR) {
            if (alreadyRecorded.has(expr)) return;
            alreadyRecorded.add(expr);
          }
          ctx.recordedSecretValues?.set(plaintext, expr);
        };
        const walk = (v: unknown): unknown => {
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
          if (typeof v === 'string' && v.includes(UNPINNED_EXPR)) {
            record(UNPINNED_PLAINTEXT, UNPINNED_EXPR);
            return v.split(UNPINNED_EXPR).join(UNPINNED_PLAINTEXT);
          }
          return v;
        };
        return Promise.resolve(walk(value));
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

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

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
      exportAliasCollisionScrubWarning('SecretBeta', 'PublicAlpha')
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
      exportAliasCollisionScrubWarning('SecretBeta', 'PublicAlpha')
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
      exportAliasCollisionScrubWarning('SecretBeta', 'PublicAlpha')
    );
  });

  it('the export-name resolve RECORDS into the pass map, so a later value is not left in plaintext', async () => {
    // The export-name loop runs BEFORE the value loop, so a dynamic reference
    // first resolved there warms the resolver's cache — and the cache-hit arm
    // re-records only what it can still prove is secret. An unpinned ssm
    // reference (#1901) resolved first for a collision test and NOT recorded
    // would be invisible when the value loop meets it, so its plaintext would
    // survive `cdkd scrub` and `--dry-run --fail` would report the state CLEAN.
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
    // And it must not claim to have removed anything.
    expect(summary).toContain('Nothing could be rewritten');
    expect(summary).not.toContain('The plaintext is no longer stored');
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
    // The deploy twin prints its colliding name unmasked, and its rationale is
    // that the secret refusal already cleared it. Scrub runs no such refusal and
    // its name is a BEST-EFFORT resolved intrinsic, so it must mask its own —
    // otherwise the shared helper asserts an invariant only one caller upholds.
    // Contrived by construction (the resolved name has to equal a declared
    // output name) but the disclosure is real: the warning goes to stderr.
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
});
