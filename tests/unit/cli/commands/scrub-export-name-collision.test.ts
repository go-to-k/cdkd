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
 * The remedy differs from the deploy engine's on purpose, and the second case
 * below is what pins the difference: scrub cannot know which output the stored
 * value under the colliding key came from, so it drops the position source for
 * that key and lets the VALUE scan decide from the plaintext actually stored.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

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
// A SECOND, different secret — the owning output's own value in the second
// case. It is what makes that case discriminate: with a literal owner value
// every candidate rule agrees, and only a rule that positions the ambiguous key
// by the OWNER's expression writes a reference naming the wrong secret.
const OWNER_PLAINTEXT = 'alpha-plaintext-secret';
const OWNER_EXPR = '{{resolve:secretsmanager:alpha:SecretString:password:AWSCURRENT}}';

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (v === SECRET_EXPR) {
            ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, SECRET_EXPR);
            return SECRET_PLAINTEXT;
          }
          if (v === OWNER_EXPR) {
            ctx.recordedSecretValues?.set(OWNER_PLAINTEXT, OWNER_EXPR);
            return OWNER_PLAINTEXT;
          }
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
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

/** `PublicAlpha` owns the name; `SecretBeta` exports under it — the collision. */
function makeStackInfo(ownerValue: unknown): { stackName: string; template: CloudFormationTemplate } {
  return {
    stackName: 'MyStack',
    template: {
      Resources: {},
      Outputs: {
        PublicAlpha: { Value: ownerValue },
        SecretBeta: { Value: SECRET_EXPR, Export: { Name: 'PublicAlpha' } },
      },
    },
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

describe('cdkd scrub - Export.Name colliding with an output NAME (issue #1919)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  async function scrub(
    ownerValue: unknown = PUBLIC_VALUE
  ): Promise<{ saved: StackState | undefined; changed: number }> {
    const res = await scrubStack(
      makeStackInfo(ownerValue) as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );
    const call = stateBackend.saveState.mock.calls.at(-1);
    return { saved: call ? (call[2] as StackState) : undefined, changed: res.recordsChanged };
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

    const { saved } = await scrub();

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
    // OWNER_EXPR, a reference naming the wrong secret. Dropping the source
    // instead lets the value scan map the stored plaintext back to the
    // expression that actually produced it.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ PublicAlpha: SECRET_PLAINTEXT, SecretBeta: SECRET_PLAINTEXT }),
      etag: 'etag-1',
    });

    const { saved } = await scrub(OWNER_EXPR);

    expect(saved!.outputs['PublicAlpha']).toBe(SECRET_EXPR);
    expect(saved!.outputs['SecretBeta']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
  });
});
