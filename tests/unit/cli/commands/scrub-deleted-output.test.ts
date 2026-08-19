/**
 * Issue #2005: `cdkd scrub` could not repair the ONE population it is
 * documented as the remedy for — an output DELETED from the template whose
 * stored value is pre-GHSA plaintext.
 *
 * `outputSecrets` is built from today's DECLARED outputs, and the outputs
 * redaction was gated on it being non-empty. A deleted output contributes
 * nothing to that set, so the needle sitting in `perResourceSecrets` never
 * reached `state.outputs` and the plaintext stayed in the record after a scrub
 * that REPORTED SUCCESS.
 *
 * The repair arm here is POSITIVE, so every case asserts the value CHANGED to
 * the expected expression rather than that scrub exited 0 — a scrub that does
 * nothing exits 0 too, which is exactly how this shipped.
 *
 * The other half of the scope decision is fenced just as hard, because
 * redaction may not buy itself a FABRICATED baseline: `cdkd drift --revert`
 * pushes the state baseline to AWS, so a value rewritten that was never a
 * secret would be APPLIED to the live resource. Three negatives pin it — a
 * stored value matching no recorded secret, a run that recorded no secret at
 * all, and a DECLARED output whose literal coincides with a resource's secret
 * plaintext.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState, ResourceState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../../src/types/resource.js';

const SECRET_PLAINTEXT = 'the-real-resolved-db-password';
const SECRET_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password:AWSCURRENT}}';
/** An ordinary literal an output can legitimately hold. */
const PUBLIC_VALUE = 'app-public-endpoint.example.com';

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

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * The stack whose template still carries the secret in a RESOURCE — which is
 * what makes the plaintext recoverable at all once the output that used to
 * carry it is gone.
 */
function makeStackInfo(
  outputs: Record<string, TemplateOutput>,
  opts: { resourceHoldsSecret?: boolean } = {}
): { stackName: string; template: CloudFormationTemplate } {
  const holdsSecret = opts.resourceHoldsSecret ?? true;
  return {
    stackName: 'MyStack',
    template: {
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: {
            DBInstanceIdentifier: 'app-db',
            MasterUserPassword: holdsSecret ? SECRET_EXPR : 'a-literal-password',
          },
        },
      },
      Outputs: outputs,
    } as CloudFormationTemplate,
  };
}

function dbRecord(masterPassword: unknown): ResourceState {
  return {
    physicalId: 'app-db',
    resourceType: 'AWS::RDS::DBInstance',
    properties: { DBInstanceIdentifier: 'app-db', MasterUserPassword: masterPassword },
  };
}

function makeState(outputs: Record<string, unknown>, masterPassword: unknown = SECRET_EXPR): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: { Db: dbRecord(masterPassword) },
    outputs,
    lastModified: 0,
  };
}

describe('cdkd scrub - an output DELETED from the template (issue #2005)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  async function scrub(
    state: StackState,
    outputs: Record<string, TemplateOutput>,
    opts: { resourceHoldsSecret?: boolean } = {}
  ): Promise<{ saved: StackState | undefined; changed: number }> {
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });
    const res = await scrubStack(
      makeStackInfo(outputs, opts) as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );
    const call = stateBackend.saveState.mock.calls.at(-1);
    return { saved: call ? (call[2] as StackState) : undefined, changed: res.recordsChanged };
  }

  it('REWRITES a stored output the template no longer declares onto its own expression', async () => {
    // The reproduction. `DbPassword` was deleted from the template in an
    // ordinary refactor; the resource still references the same secret, so the
    // plaintext IS recoverable — it just never reached `state.outputs`.
    const { saved, changed } = await scrub(makeState({ DbPassword: SECRET_PLAINTEXT }), {});

    // The POSITIVE assertion: the value changed, and to the exact expression.
    expect(saved!.outputs['DbPassword']).toBe(SECRET_EXPR);
    expect(saved!.outputs['DbPassword']).not.toBe(SECRET_PLAINTEXT);
    expect(JSON.stringify(saved!.outputs)).not.toContain(SECRET_PLAINTEXT);
    // ...and the write is ACCOUNTED for, so the summary cannot report a clean
    // stack over a record it just rewrote.
    expect(changed).toBeGreaterThan(0);
  });

  it('REWRITES a deleted output whose stored value merely EMBEDS the plaintext', async () => {
    // The `Fn::Join` shape: a deleted output that built a connection string
    // around the secret. Nothing positions it, so the value scan's embedded arm
    // is the only thing that can reach it.
    const { saved } = await scrub(
      makeState({ DbUrl: `postgres://admin:${SECRET_PLAINTEXT}@app-db:5432/app` }),
      {}
    );

    expect(saved!.outputs['DbUrl']).toBe(`postgres://admin:${SECRET_EXPR}@app-db:5432/app`);
    expect(JSON.stringify(saved!.outputs)).not.toContain(SECRET_PLAINTEXT);
  });

  it('REWRITES a deleted output while leaving a surviving declared output positioned', async () => {
    // Both passes run in one scrub: the declared output keeps its POSITION
    // source (its own expression), the deleted one is repaired by value match.
    const state = makeState({ DbPassword: SECRET_PLAINTEXT, Endpoint: PUBLIC_VALUE });
    const { saved } = await scrub(state, { Endpoint: { Value: PUBLIC_VALUE } });

    expect(saved!.outputs['DbPassword']).toBe(SECRET_EXPR);
    expect(saved!.outputs['Endpoint']).toBe(PUBLIC_VALUE);
  });

  it('leaves a stored output matching NO recorded secret byte-identical', async () => {
    // The negative twin of case 1: same shape, same undeclared key, a value
    // that is simply not a secret. Rewriting it would fabricate a baseline
    // `cdkd drift --revert` then pushes to the live resource.
    const { saved } = await scrub(
      makeState({ DeletedEndpoint: PUBLIC_VALUE, DbPassword: SECRET_PLAINTEXT }),
      {}
    );

    expect(saved!.outputs['DeletedEndpoint']).toBe(PUBLIC_VALUE);
    // The sibling in the same bag IS repaired, so this is a per-key refusal
    // rather than the whole pass declining to run.
    expect(saved!.outputs['DbPassword']).toBe(SECRET_EXPR);
  });

  it('leaves the plaintext untouched when nothing recorded it this run', async () => {
    // The other half of the scope decision: the secret reference is gone from
    // the template entirely (deleted output AND de-referenced resource), so the
    // needle is unrecoverable. A scrub that cannot identify the needle must not
    // guess — no rewrite, no invented key, no removed key.
    const state = makeState({ DbPassword: SECRET_PLAINTEXT }, 'a-literal-password');
    const { saved, changed } = await scrub(state, {}, { resourceHoldsSecret: false });

    expect(saved).toBeUndefined();
    expect(changed).toBe(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    // The record is left exactly as it was found.
    expect(state.outputs['DbPassword']).toBe(SECRET_PLAINTEXT);
  });

  it('does NOT rewrite a DECLARED output whose literal coincides with a resource secret', async () => {
    // The fabrication fence. A declared output is positioned against the
    // template by the pass that already existed; the widened pass must never
    // reach it, or one resource's secret plaintext would rewrite an unrelated
    // output's coinciding literal onto that resource's expression.
    const state = makeState({ Coincidence: SECRET_PLAINTEXT });
    const { saved, changed } = await scrub(state, { Coincidence: { Value: SECRET_PLAINTEXT } });

    // Nothing to write for the outputs bag at all: the only recorded secret is
    // the resource's, and the resource record is already an expression.
    expect(saved?.outputs['Coincidence'] ?? state.outputs['Coincidence']).toBe(SECRET_PLAINTEXT);
    expect(changed).toBe(0);
  });

  it('does NOT rewrite an EXPORT alias key of a surviving output', async () => {
    // An `Export.Name` is a key today's template CAN account for even though it
    // is not an output name, so it stays with the positioning pass. Pinned
    // separately because the accounted set is what keeps the widened pass off
    // the collision-prone population.
    const state = makeState({ Endpoint: SECRET_PLAINTEXT, 'MyStack-Endpoint': SECRET_PLAINTEXT });
    const { saved, changed } = await scrub(state, {
      Endpoint: { Value: PUBLIC_VALUE, Export: { Name: 'MyStack-Endpoint' } },
    });

    expect(saved?.outputs['MyStack-Endpoint'] ?? state.outputs['MyStack-Endpoint']).toBe(
      SECRET_PLAINTEXT
    );
    expect(changed).toBe(0);
  });
});
