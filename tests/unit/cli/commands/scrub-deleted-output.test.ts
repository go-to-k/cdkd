/**
 * Issue #2005: `cdkd scrub` could not repair the ONE population it is
 * documented as the remedy for — a stored output key today's template cannot
 * account for (the motivating case: an output DELETED in an ordinary refactor)
 * whose stored value is pre-GHSA plaintext.
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
 * redaction may not buy itself a FABRICATED value: `state.outputs` is
 * re-applied VERBATIM to consumer stacks by the exports index and by
 * `Fn::ImportValue` / `Fn::GetStackOutput`, so a value rewritten that was never
 * a secret ships a literal `{{resolve:...}}` token into a consumer's own AWS
 * call. (`cdkd drift` is NOT such a reader — it reads `state.resources` — and
 * an earlier revision of this header said it was.) The negatives pin it: a
 * stored value matching no recorded secret, a run that recorded no secret at
 * all, a DECLARED output whose literal coincides with a resource's secret
 * plaintext, and a plaintext too short to be a safe needle.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState, ResourceState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../../src/types/resource.js';

/**
 * The db secret. Its EXPRESSION deliberately contains the string `prod`, which
 * is also {@link ENV_PLAINTEXT} — that overlap is the whole point of the
 * double-scan regression case below, and is a realistic spelling (a secret
 * named after its environment).
 */
const SECRET_PLAINTEXT = 'the-real-resolved-db-password';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
/** A SecureString ssm parameter a RESOURCE still references. 4 chars = exactly the needle floor. */
const ENV_PLAINTEXT = 'prod';
const ENV_EXPR = '{{resolve:ssm:/app/env}}';
/** Two DISTINCT references resolving to ONE plaintext — the collision `allRecordedSecrets` orders. */
const SHARED_PLAINTEXT = 'shared-collision-plaintext';
const OUTPUT_SHARED_EXPR = '{{resolve:secretsmanager:app/shared:SecretString:token:AWSCURRENT}}';
const RESOURCE_SHARED_EXPR = '{{resolve:secretsmanager:app/shared-res:SecretString:token:AWSCURRENT}}';
/** Below `MIN_NEEDLE_LENGTH` (4) — never a union needle. */
const SHORT_PLAINTEXT = 'ab1';
const SHORT_EXPR = '{{resolve:secretsmanager:app/pin:SecretString:pin}}';
/** Exactly `MIN_NEEDLE_LENGTH` — the other side of the boundary. */
const FLOOR_PLAINTEXT = 'ab12';
const FLOOR_EXPR = '{{resolve:secretsmanager:app/floor:SecretString:pin}}';
/** An ordinary literal an output can legitimately hold. */
const PUBLIC_VALUE = 'app-public-endpoint.example.com';

/** Every expression this suite's fake resolver knows how to resolve. */
const RESOLVES: Record<string, string> = {
  [SECRET_EXPR]: SECRET_PLAINTEXT,
  [ENV_EXPR]: ENV_PLAINTEXT,
  [OUTPUT_SHARED_EXPR]: SHARED_PLAINTEXT,
  [RESOURCE_SHARED_EXPR]: SHARED_PLAINTEXT,
  [SHORT_EXPR]: SHORT_PLAINTEXT,
  [FLOOR_EXPR]: FLOOR_PLAINTEXT,
};

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (typeof v === 'string' && RESOLVES[v] !== undefined) {
            ctx.recordedSecretValues?.set(RESOLVES[v]!, v);
            return RESOLVES[v]!;
          }
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const keys = Object.keys(v as Record<string, unknown>);
            // `resolveSub` does NOT throw on an unresolvable placeholder: it
            // warns and keeps `${Foo}` in the string. That warn-and-keep result
            // is what the accounted-key narrowing turns on, so the fake has to
            // reproduce it rather than throwing.
            if (keys.length === 1 && keys[0] === 'Fn::Sub') {
              return (v as Record<string, unknown>)['Fn::Sub'];
            }
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

interface StackOpts {
  /** Expression the Db resource's `MasterUserPassword` holds; `null` = an ordinary literal. */
  resourceSecret?: string | null;
  /** Extra secret-bearing properties on the Db resource (property name -> expression). */
  extraResourceSecrets?: Record<string, string>;
}

/**
 * The stack whose template still carries the secret in a RESOURCE — which is
 * what makes the plaintext recoverable at all once the output that used to
 * carry it is gone.
 */
function makeStackInfo(
  outputs: Record<string, TemplateOutput>,
  opts: StackOpts = {}
): { stackName: string; template: CloudFormationTemplate } {
  const resourceSecret = opts.resourceSecret === undefined ? SECRET_EXPR : opts.resourceSecret;
  return {
    stackName: 'MyStack',
    template: {
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: {
            DBInstanceIdentifier: 'app-db',
            MasterUserPassword: resourceSecret ?? 'a-literal-password',
            ...(opts.extraResourceSecrets ?? {}),
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

function makeState(
  outputs: Record<string, unknown> | undefined,
  masterPassword: unknown = SECRET_EXPR
): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: { Db: dbRecord(masterPassword) },
    // `outputs` is TYPED as required and is optional at runtime (a state file
    // can simply have none) — the absent-bag case below depends on that.
    outputs: outputs as StackState['outputs'],
    lastModified: 0,
  };
}

describe('cdkd scrub - a stored output key the template cannot account for (issue #2005)', () => {
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
    opts: StackOpts & { dryRun?: boolean } = {}
  ): Promise<{ saved: StackState | undefined; changed: number }> {
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });
    const res = await scrubStack(
      makeStackInfo(outputs, opts) as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: opts.dryRun ?? false, logger: logger as never }
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

  it('REWRITES a deleted output nested inside an OBJECT-valued stored output', async () => {
    // An output value is not always a scalar — a list-valued `Fn::GetAtt`
    // persists a JSON array, and a legacy bag can hold a structure. The walk
    // must reach the leaf, not just the top-level string.
    const { saved } = await scrub(
      makeState({
        DeletedConn: { url: `postgres://admin:${SECRET_PLAINTEXT}@app-db`, port: 5432 },
      }),
      {}
    );

    expect(saved!.outputs['DeletedConn']).toEqual({
      url: `postgres://admin:${SECRET_EXPR}@app-db`,
      port: 5432,
    });
    expect(JSON.stringify(saved!.outputs)).not.toContain(SECRET_PLAINTEXT);
  });

  it('runs BOTH passes in one scrub: a DECLARED output is positioned, a deleted one value-matched', async () => {
    // The two-pass interaction, which nothing fenced before: the surviving
    // output's stored plaintext can ONLY be repaired by the positioning pass
    // (the widened pass skips every accounted key), and the deleted one ONLY by
    // the widened pass. Deleting either pass fails exactly one assertion.
    const state = makeState({ Endpoint: SECRET_PLAINTEXT, DbPassword: SECRET_PLAINTEXT });
    const { saved } = await scrub(state, { Endpoint: { Value: SECRET_EXPR } });

    expect(saved!.outputs['Endpoint']).toBe(SECRET_EXPR); // positioned pass
    expect(saved!.outputs['DbPassword']).toBe(SECRET_EXPR); // widened pass
  });

  it('does NOT splice a union needle INTO the expression the positioning pass inserted', async () => {
    // The blocker this fix round exists for. The widened pass used to re-scan
    // the POSITIONED bag, so for a MIXED leaf (which `redactSecretsForState`'s
    // whole-token guard does not cover) any union needle occurring inside the
    // just-inserted expression was substituted INTO it:
    //
    //   pass 1: postgres://admin:{{resolve:secretsmanager:prod/db:...}}@app-db
    //   pass 2: postgres://admin:{{resolve:secretsmanager:{{resolve:ssm:/app/env}}/db:...}}@app-db
    //
    // — a reference no service can resolve, persisted into `state.outputs` and
    // re-applied verbatim to every consumer stack. The fix scans the STORED
    // value ONCE with the union instead.
    const state = makeState({ DbUrl: `postgres://admin:${SECRET_PLAINTEXT}@app-db:5432/app` });
    const { saved } = await scrub(
      state,
      {
        // DECLARED, so the db secret lands in `outputSecrets` and the
        // positioning pass is what rewrites the mixed leaf.
        DbPassword: { Value: SECRET_EXPR },
      },
      // ...while `prod` is recorded ONLY by the resource, so it reaches the
      // union and nothing else. Without this the union carries no needle that
      // occurs inside the inserted expression and the case cannot discriminate
      // a double scan from a single one (measured: it did not).
      { extraResourceSecrets: { EnvName: ENV_EXPR } }
    );

    expect(saved!.outputs['DbUrl']).toBe(`postgres://admin:${SECRET_EXPR}@app-db:5432/app`);
    // The nested wreckage, named explicitly: `prod` is a recorded RESOURCE
    // secret occurring inside the db reference's own text.
    expect(saved!.outputs['DbUrl']).not.toContain(ENV_EXPR);
    expect(JSON.stringify(saved!.outputs)).not.toContain(SECRET_PLAINTEXT);
  });

  it('prefers the OUTPUT expression when an output and a resource resolve one plaintext', async () => {
    // `allRecordedSecrets` writes the outputs map LAST, so it wins a value
    // collision. Without the outputs half of the union the same key would be
    // rewritten onto the RESOURCE's reference — a different secret's spelling
    // for a value an output produced.
    const state = makeState({ DeletedShared: SHARED_PLAINTEXT });
    const { saved } = await scrub(
      state,
      { Shared: { Value: OUTPUT_SHARED_EXPR } },
      { extraResourceSecrets: { SharedToken: RESOURCE_SHARED_EXPR } }
    );

    expect(saved!.outputs['DeletedShared']).toBe(OUTPUT_SHARED_EXPR);
    expect(saved!.outputs['DeletedShared']).not.toBe(RESOURCE_SHARED_EXPR);
  });

  it('keeps the POSITIONED value for a non-scalar the union scan cannot match', async () => {
    // Why the change test is `JSON.stringify`, not `next === value`: the value
    // scan CLONES every array / object it walks, so an identity test reports a
    // change for a non-scalar it did not touch and overwrites the positioned
    // bag's leaf with this pass's un-repaired clone. Here the positioning pass
    // repairs a sub-floor secret by WHOLE-VALUE match (legal for a
    // position-scoped bag) that the union deliberately cannot see, so an
    // identity test would put the plaintext back.
    const state = makeState({ DeletedList: [SHORT_PLAINTEXT, PUBLIC_VALUE] });
    const { saved } = await scrub(state, { Pin: { Value: SHORT_EXPR } });

    expect(saved!.outputs['DeletedList']).toEqual([SHORT_EXPR, PUBLIC_VALUE]);
    expect(JSON.stringify(saved!.outputs)).not.toContain(SHORT_PLAINTEXT);
  });

  it('still repairs a SCALAR unaccounted key holding a sub-floor OUTPUT secret (the floor narrows nothing)', async () => {
    // The claim an earlier revision of `allRecordedSecrets`'s doc got backwards.
    // It said applying the floor to `outputSecrets` too gave up one pre-existing
    // behavior — a sub-floor OUTPUT secret whole-value-matching an UNACCOUNTED
    // key. It does not: the positioning pass runs FIRST over the same bag with
    // the UNFILTERED `outputSecrets` and whole-value-matches at any length, and
    // the widened pass scans the STORED value, so a leaf the union cannot see
    // compares equal, falls through, and the positioned result survives.
    //
    // The sibling case above pins the same thing for a non-scalar (where the
    // clone-vs-identity compare is what carries it); this is the SCALAR shape
    // the false note actually described, so the correction is pinned on its own
    // terms rather than by analogy.
    const state = makeState({ DeletedPin: SHORT_PLAINTEXT });
    const { saved } = await scrub(state, { Pin: { Value: SHORT_EXPR } });

    expect(saved!.outputs['DeletedPin']).toBe(SHORT_EXPR);
    expect(JSON.stringify(saved!.outputs)).not.toContain(SHORT_PLAINTEXT);
  });

  it('does NOT use a plaintext shorter than the needle floor as a cross-resource needle', async () => {
    // The security half. `redactSecretsForState`'s no-source arm whole-value-
    // matches at ANY length, which is sound only for a POSITION-SCOPED bag; the
    // union has no position source, so a 1-3 character plaintext recorded by
    // ANY resource would rewrite an unrelated stored output onto that
    // resource's reference — and `state.outputs` is re-applied verbatim to
    // consumers.
    const state = makeState({ DeletedPin: SHORT_PLAINTEXT });
    const { saved, changed } = await scrub(
      state,
      {},
      { extraResourceSecrets: { Pin: SHORT_EXPR } }
    );

    // Nothing at all to write: the only other recorded secret (the resource's
    // db reference) is already an expression in the record.
    expect(saved?.outputs['DeletedPin'] ?? state.outputs['DeletedPin']).toBe(SHORT_PLAINTEXT);
    expect(changed).toBe(0);
  });

  it('DOES use a plaintext exactly at the needle floor', async () => {
    // The other side of the same boundary — otherwise "short secrets are
    // refused" would be satisfied by refusing everything.
    const state = makeState({ DeletedPin: FLOOR_PLAINTEXT });
    const { saved } = await scrub(state, {}, { extraResourceSecrets: { Pin: FLOOR_EXPR } });

    expect(saved!.outputs['DeletedPin']).toBe(FLOOR_EXPR);
  });

  it('walks past the `totalSecrets === 0` early return with an EMPTY union when every secret is sub-floor', async () => {
    // The shape the needle floor CREATED, and the reason this suite carries a
    // case for it: `scrubStack` early-returns on `totalSecrets === 0`, but
    // `totalSecrets` counts the RAW maps while `allRecordedSecrets` filters to
    // `MIN_NEEDLE_LENGTH`. So a stack whose ONLY recorded plaintext is
    // sub-floor gives `totalSecrets === 1`, skips that return, and reaches
    // `redactUnaccountedOutputs` with an empty union — which an earlier
    // revision of the guard's comment called unreachable, i.e. it forbade
    // retesting a line that now runs.
    //
    // The RESOURCE assertion is what proves the run got past the early return
    // at all (a stack that returned there writes nothing), so the two
    // assertions together pin the path and not just the outcome.
    const state = makeState({ DeletedPin: SHORT_PLAINTEXT }, SHORT_PLAINTEXT);
    const { saved } = await scrub(state, {}, { resourceSecret: SHORT_EXPR });

    // Positioned against the template, so the sub-floor plaintext IS repaired
    // here — the floor bounds cross-resource needles, not positioned ones.
    expect(saved!.resources['Db']!.properties['MasterUserPassword']).toBe(SHORT_EXPR);
    // ...while the outputs bag, which only the union could have reached, is
    // left exactly as found.
    expect(saved!.outputs['DeletedPin']).toBe(SHORT_PLAINTEXT);
  });

  it('REPAIRS a stored key whose `Export.Name` did not fully resolve', async () => {
    // `scrub` takes no `--parameters`, so a parameterized export name comes
    // back as the literal `prefix-${Foo}`. Marking that literal ACCOUNTED is
    // not inert: `deploy-engine.ts` writes an alias key on `typeof exportName
    // === 'string'` with no unresolved-value test, so a deploy whose `Fn::Sub`
    // warn-and-kept the placeholder really does key state under it — and
    // accounting for it excluded the key from the widened pass while the
    // positioning pass had no secrets at all (the secret lives only on the
    // RESOURCE here, which is #2005's own population), leaving the plaintext in
    // place under a scrub reporting success.
    const state = makeState({ 'prefix-${Foo}': SECRET_PLAINTEXT });
    const { saved } = await scrub(state, {
      Endpoint: { Value: PUBLIC_VALUE, Export: { Name: { 'Fn::Sub': 'prefix-${Foo}' } as never } },
    });

    expect(saved!.outputs['prefix-${Foo}']).toBe(SECRET_EXPR);
  });

  it('leaves a stored output matching NO recorded secret byte-identical', async () => {
    // The negative twin of case 1: same shape, same undeclared key, a value
    // that is simply not a secret. Rewriting it would ship a fabricated
    // `{{resolve:...}}` token to every consumer stack importing it.
    const { saved } = await scrub(
      makeState({ DeletedEndpoint: PUBLIC_VALUE, DbPassword: SECRET_PLAINTEXT }),
      {}
    );

    expect(saved!.outputs['DeletedEndpoint']).toBe(PUBLIC_VALUE);
    // The sibling in the same bag IS repaired, so this is a per-key refusal
    // rather than the whole pass declining to run.
    expect(saved!.outputs['DbPassword']).toBe(SECRET_EXPR);
  });

  it('leaves the plaintext untouched when nothing recorded it this run (OUTCOME only - fences no guard)', async () => {
    // The other half of the scope decision: the secret reference is gone from
    // the template entirely (deleted output AND de-referenced resource), so the
    // needle is unrecoverable. A scrub that cannot identify the needle must not
    // guess — no rewrite, no invented key, no removed key.
    //
    // What this case pins is the OUTCOME, and it pins NO mechanism — measured,
    // not assumed. Deleting `redactUnaccountedOutputs`'s `secrets.size === 0`
    // guard leaves it green (that guard is unreachable from this caller:
    // `scrubStack` early-returns on the same predicate, `totalSecrets` being
    // exactly `outputSecrets.size + Σ perResourceSecrets sizes`), AND so does
    // deleting `scrubStack`'s early return itself — with no secrets recorded,
    // the union is empty, every scan is the identity, and the record comes out
    // byte-identical anyway. The redundancy is the point: nothing here is
    // load-bearing enough for one edit to start fabricating a value. Do not
    // relabel this case as a fence for either guard.
    const state = makeState({ DbPassword: SECRET_PLAINTEXT }, 'a-literal-password');
    const { saved, changed } = await scrub(state, {}, { resourceSecret: null });

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

  it('scrubs a state record that has NO outputs bag at all', async () => {
    // `state.outputs` is TYPED as required and optional in practice. The
    // remediation command must not throw on such a record — it would refuse to
    // scrub the RESOURCES it could have scrubbed — and it must not materialize
    // an empty bag on the way through either.
    const state = makeState(undefined, SECRET_PLAINTEXT);
    const { saved, changed } = await scrub(state, {});

    expect(changed).toBeGreaterThan(0);
    expect(saved!.resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
    expect(saved!.outputs).toBeUndefined();
  });

  it('scrubs a record with NO outputs bag while the template DOES declare outputs', async () => {
    // The variant that actually reaches both outputs passes with an absent bag:
    // a declared output puts a secret in `outputSecrets`, so the positioning
    // pass runs (and hands back `undefined`) and the widened pass is called
    // with a non-empty union. Without it the sibling case above short-circuits
    // at `outputSecrets.size > 0` and neither pass is exercised at all.
    const state = makeState(undefined, SECRET_PLAINTEXT);
    const { saved, changed } = await scrub(state, { DbPassword: { Value: SECRET_EXPR } });

    expect(changed).toBeGreaterThan(0);
    expect(saved!.resources['Db']!.properties['MasterUserPassword']).toBe(SECRET_EXPR);
    expect(saved!.outputs).toBeUndefined();
  });

  it('under --dry-run reports the repair without taking the lock or writing state', async () => {
    // The `--dry-run --fail` CI gate has to SEE this class of finding, and a
    // dry run must never touch the lock or the record.
    const state = makeState({ DbPassword: SECRET_PLAINTEXT });
    const { saved, changed } = await scrub(state, {}, { dryRun: true });

    expect(changed).toBeGreaterThan(0);
    expect(saved).toBeUndefined();
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(lockManager.acquireLockWithRetry).not.toHaveBeenCalled();
    expect(state.outputs['DbPassword']).toBe(SECRET_PLAINTEXT);
  });
});
