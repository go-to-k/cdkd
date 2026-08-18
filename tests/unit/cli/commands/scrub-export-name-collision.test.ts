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

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
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

/** Conditions scrub's best-effort re-evaluation returns; per-test knob. */
const conditionValues: { value: Record<string, boolean> } = { value: {} };

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockImplementation(() => Promise.resolve(conditionValues.value)),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (v === SECRET_EXPR || v === STAGED_EXPR) {
            ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, v);
            return SECRET_PLAINTEXT;
          }
          if (v === OWNER_EXPR) {
            ctx.recordedSecretValues?.set(OWNER_PLAINTEXT, OWNER_EXPR);
            return OWNER_PLAINTEXT;
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
              return (entries[0]![1] as string).replace('${Owner}', 'PublicAlpha');
            }
            const out: Record<string, unknown> = {};
            for (const [k, val] of entries) out[k] = walk(val);
            return out;
          }
          return v;
        };
        return Promise.resolve(walk(value));
      }),
  })),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';
import { exportAliasCollisionScrubWarning } from '../../../../src/deployment/outputs-export-alias.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

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
