/**
 * Issue #2740: an Output that NEVER resolved at deploy — skipped under the
 * default (non-`--strict-getatt`) arm on every deploy — must leave a record
 * (`StackState.skippedOutputs`) that `cdkd diff` reads, or the diff previews a
 * phantom `ADD` on every run of the unchanged stack.
 *
 * The WRITER cases drive the DEPLOY ENGINE and read the record it SAVED; the
 * READER cases hand that saved record to the diff side
 * (`bindingSkippedOutputs` + `resolveTemplateOutputs` + `computeOutputsDiff`)
 * the way `computeStackDiff` does, so (b), (c), (c') and (f) go red if either
 * the writer or the reader forgets the field. The LIFECYCLE cases — a record
 * re-digested, cleared, carried — start from a hand-built prior record, since
 * what they pin is the engine's next write, not the reader. The resolver is
 * mocked pass-through except a `__boom__` sentinel that rejects, standing in
 * for a secret lookup that fails inside the resolver (a JSON key the secret
 * does not hold); the diff-side resolver ASSEMBLES that same value, which is
 * the whole asymmetry under test.
 *
 * Letters match the issue's test plan: (a) record saved on a first deploy,
 * (b) the unchanged re-deploy is silent and the diff reports no ADD, (c)/(c')
 * every digested input's repair makes it an ADD again, (d) resolving clears
 * it, (e) removal clears it, (f) the upgrade path writes it on a no-change
 * deploy of a record that never had the field.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import {
  skippedOutputDigest,
  bindingSkippedOutputs,
} from '../../../src/analyzer/skipped-outputs.js';
import { resolveTemplateOutputs, computeOutputsDiff } from '../../../src/analyzer/outputs-diff.js';

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    // Rejects on the string sentinel (an output VALUE) and on an `Fn::Sub` of
    // it (an intrinsic `Export.Name` — a LITERAL name is never resolved, so the
    // alias pass can only fail on an intrinsic one).
    //
    // The `Fn::Sub` arm MUTATES its input before rejecting. INJECTED, not
    // observed: `resolveSub` wrote back into the caller's variable map until
    // go-to-k/cdkd#2764 gave it a fresh object, and nothing in the flow does
    // so today. The injection is what pins the ORDERING — the digest must come
    // from a snapshot taken BEFORE resolution, or a diff over a fresh parse of
    // the same template could never reproduce it — independently of whatever
    // the real resolver happens to do.
    resolve: vi.fn().mockImplementation((value: unknown) => {
      if (value === '__boom__') {
        return Promise.reject(new Error("Dynamic reference: key 'missing' not found in secret"));
      }
      // A resolver that constructs NOTHING and returns `undefined` without
      // throwing (`constructAttribute`'s empty arm) — the second writer of an
      // `undefined` bag value.
      if (value === '__undefined__') {
        return Promise.resolve(undefined);
      }
      if (
        value !== null &&
        typeof value === 'object' &&
        (value as Record<string, unknown>)['Fn::Sub'] === '__boom__'
      ) {
        (value as Record<string, unknown>)['Fn::Sub'] = '<rewritten in place by the resolver>';
        return Promise.reject(new Error("Dynamic reference: key 'missing' not found in secret"));
      }
      return Promise.resolve(value);
    }),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi
      .fn()
      .mockImplementation((context: { template?: { Conditions?: Record<string, unknown> } }) => {
        if (conditionsEvaluationMutates.value && context.template?.Conditions) {
          for (const name of Object.keys(context.template.Conditions)) {
            context.template.Conditions[name] = '<rewritten in place by evaluateConditions>';
          }
        }
        return Promise.resolve({});
      }),
  })),
}));

/** Toggled by the one case that needs `evaluateConditions` to rewrite the template. */
const conditionsEvaluationMutates = vi.hoisted(() => ({ value: false }));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const stackName = 'never-resolves';

/** The failing output plus every section the digest reads, so (c') can move each one. */
function template(overrides: Partial<CloudFormationTemplate> = {}): CloudFormationTemplate {
  return {
    Parameters: { Env: { Type: 'String', Default: 'dev' } },
    Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
    Mappings: { Keys: { dev: { Field: 'missing' } } },
    Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
    Outputs: {
      Bad: { Value: '__boom__' },
      Fine: { Value: 'fine-value' },
    },
    ...overrides,
  };
}

function withBad(entry: TemplateOutput): CloudFormationTemplate {
  const t = template();
  t.Outputs!['Bad'] = entry;
  return t;
}

/** `observedProperties` present, so the auto-refresh trigger stays dormant. */
function makeState(
  outputs: Record<string, unknown>,
  extra: Partial<Pick<StackState, 'exportNames' | 'skippedOutputs'>> = {}
): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: 'us-east-1',
    stackName,
    resources: {
      BucketA: {
        physicalId: 'phys-bucket-a',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: 'bucket-a' },
        observedProperties: { BucketName: 'bucket-a' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs,
    exportNames: [],
    ...extra,
    lastModified: 0,
  };
}

type Mocks = {
  provider: Record<string, ReturnType<typeof vi.fn>>;
  stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  exportIndexStore: { updateForStack: ReturnType<typeof vi.fn> };
};

function buildEngine(opts: {
  priorState?: StackState;
  /** CREATE changes → the change path; omitted → the no-change path. */
  creates?: string[];
  strictGetAtt?: boolean;
  dryRun?: boolean;
}): { engine: DeployEngine } & Mocks {
  const provider = {
    create: vi.fn().mockImplementation((logicalId: string) =>
      Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
    ),
    update: vi.fn(),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    // No `readCurrentState`: the engine treats its absence as "no observed
    // capture", which keeps the auto-refresh save trigger out of these cases.
  };
  const stateBackend = {
    getState: vi
      .fn()
      .mockResolvedValue(opts.priorState ? { state: opts.priorState, etag: 'etag-0' } : null),
    saveState: vi.fn().mockResolvedValue('etag-next'),
  };
  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
  const creates = opts.creates ?? [];
  const changes = new Map<string, ResourceChange>(
    creates.length > 0
      ? creates.map((id) => [
          id,
          {
            logicalId: id,
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: { BucketName: id.toLowerCase() },
            propertyChanges: [],
          } as unknown as ResourceChange,
        ])
      : [
          [
            'BucketA',
            { logicalId: 'BucketA', changeType: 'NO_CHANGE', resourceType: 'AWS::S3::Bucket' },
          ],
        ]
  );
  const dagBuilder = {
    buildGraph: vi.fn().mockReturnValue({}),
    getExecutionLevels: vi.fn().mockReturnValue(creates.length > 0 ? [creates] : []),
    getDirectDependencies: vi.fn().mockReturnValue([]),
  };
  const diffCalculator = {
    calculateDiff: vi.fn().mockResolvedValue(changes),
    hasChanges: vi.fn().mockReturnValue(creates.length > 0),
    filterByType: vi
      .fn()
      .mockImplementation((m: Map<string, ResourceChange>, type: string) =>
        Array.from(m.values()).filter((c) => c.changeType === type)
      ),
  };
  const providerRegistry = {
    getProvider: vi.fn().mockReturnValue(provider),
    getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
    getRegisteredTypes: vi.fn().mockReturnValue([]),
    getCloudControlProvider: vi.fn(),
    validateResourceTypes: vi.fn(),
    validateResourceProperties: vi.fn(),
  };
  const exportIndexStore = {
    updateForStack: vi.fn().mockResolvedValue(undefined),
    lookup: vi.fn().mockResolvedValue(null),
    patchEntry: vi.fn().mockResolvedValue(undefined),
  };
  const engine = new DeployEngine(
    stateBackend as never,
    lockManager as never,
    dagBuilder as never,
    diffCalculator as never,
    providerRegistry as never,
    {
      dryRun: opts.dryRun ?? false,
      concurrency: 2,
      ...(opts.strictGetAtt !== undefined && { strictGetAtt: opts.strictGetAtt }),
    },
    'us-east-1',
    exportIndexStore as never
  );
  return { engine, provider, stateBackend, exportIndexStore };
}

/**
 * The record as the S3 backend persists it: through JSON, which DROPS the
 * `undefined` the engine stores for a skipped key. The reader keys on the
 * key's ABSENCE, so the round-trip is part of what these cases pin — an
 * in-memory `{ Bad: undefined }` would satisfy `hasOwnProperty` and read as
 * "state holds the key".
 */
function jsonRoundTrip(state: StackState): StackState {
  return JSON.parse(JSON.stringify(state)) as StackState;
}

function savedAt(stateBackend: Mocks['stateBackend'], index: number): StackState {
  const calls = stateBackend.saveState.mock.calls;
  expect(calls.length).toBeGreaterThan(index);
  return jsonRoundTrip(calls[index]![2] as StackState);
}

function lastSaved(stateBackend: Mocks['stateBackend']): StackState {
  return savedAt(stateBackend, stateBackend.saveState.mock.calls.length - 1);
}

/**
 * The diff side, as `computeStackDiff` wires it: the record's digests are
 * compared against a pristine copy of the template, the resolver ASSEMBLES the
 * value the deploy could not resolve (the `skipDynamicReferences` shape) and
 * receives the binding keys, and the rows are what `cdkd diff` would render.
 */
async function diffAgainst(saved: StackState, tpl: CloudFormationTemplate) {
  const binding = bindingSkippedOutputs(structuredClone(tpl), saved.skippedOutputs);
  const resolved = await resolveTemplateOutputs(
    structuredClone(tpl),
    async (v) => v,
    undefined,
    saved.outputs,
    binding
  );
  const rows = computeOutputsDiff(saved.outputs, resolved.outputs, resolved.exportNames);
  return { resolved, rows, reported: rows };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeployEngine records the outputs it skipped (issue #2740)', () => {
  it('(a) a first deploy whose output fails inside the resolver saves the record with its digest, and the key stays out of outputs', async () => {
    const tpl = template();
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, tpl);

    const saved = lastSaved(stateBackend);
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value' });
    expect(saved.skippedOutputs).toEqual({ Bad: skippedOutputDigest(template(), 'Bad') });
    // The digest was taken from the template AS PARSED — a fresh parse of the
    // same template reproduces it, which is what `cdkd diff` does.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Failed to resolve output Bad/));
  });

  it('(b) the unchanged re-deploy saves nothing, and the diff previews the key as absent rather than ADD', async () => {
    const tpl = template();
    const first = buildEngine({ creates: ['BucketA'] });
    await first.engine.deploy(stackName, tpl);
    const afterFirst = lastSaved(first.stateBackend);

    const second = buildEngine({ priorState: makeState(afterFirst.outputs, { skippedOutputs: afterFirst.skippedOutputs }) });
    await second.engine.deploy(stackName, template());
    // Record equal, bag equal, export set equal: nothing to persist.
    expect(second.stateBackend.saveState).not.toHaveBeenCalled();

    const { resolved, rows } = await diffAgainst(afterFirst, template());
    // Previewed as absent — not as a failed section.
    expect(resolved.resolutionFailed).toBe(false);
    expect(resolved.outputs).not.toHaveProperty('Bad');
    // What `cdkd diff --fail` would act on: nothing.
    expect(rows).toEqual([]);
  });

  it('a sibling output that genuinely changed still renders beside the suppressed key', async () => {
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, template());
    const saved = lastSaved(stateBackend);
    const siblingChanged = template();
    siblingChanged.Outputs!['Fine'] = { Value: 'fine-value-2' };
    const { resolved, rows } = await diffAgainst(saved, siblingChanged);
    expect(resolved.resolutionFailed).toBe(false);
    expect(rows.map((r) => [r.name, r.changeType])).toEqual([['Fine', 'MODIFY']]);
  });

  it('CONTROL: the same saved state with the record stripped previews the phantom ADD', async () => {
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, template());
    const saved = lastSaved(stateBackend);
    const { skippedOutputs: _dropped, ...stripped } = saved;
    const { reported } = await diffAgainst(stripped as StackState, template());
    expect(reported.map((r) => [r.name, r.changeType])).toEqual([['Bad', 'ADD']]);
  });

  // The mocked resolver cannot follow a `Ref` / `Fn::If` / `Fn::FindInMap`, so
  // these cases pin that the digest covers each SECTION (the rule the digest
  // is spelled as), not that `Bad.Value` reads it; the analyzer suite pins the
  // section list directly, and the real-resolver wiring suite drives a
  // condition that IS read.
  it.each<[string, CloudFormationTemplate]>([
    ['(c) the Value', withBad({ Value: '{{resolve:secretsmanager:s:SecretString:password}}' })],
    ["(c') an Export.Name added with the Value unchanged", withBad({ Value: '__boom__', Export: { Name: 'S:Bad' } })],
    ["(c') the Parameters section (a default)", template({ Parameters: { Env: { Type: 'String', Default: 'prod' } } })],
    ["(c') the Conditions section (a condition body)", template({ Conditions: { IsProd: { 'Fn::Equals': ['a', 'a'] } } })],
    ["(c') the Mappings section (an entry)", template({ Mappings: { Keys: { dev: { Field: 'password' } } } })],
  ])('%s changed after the deploy: the record no longer binds and the output is an ADD again', async (_label, repaired) => {
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, template());
    const saved = lastSaved(stateBackend);

    // PREMISE: against the UNCHANGED template the saved record binds — so the
    // ADD below is the repair unbinding it, not the record never existing.
    const unchanged = await diffAgainst(saved, template());
    expect(unchanged.reported).toEqual([]);

    const { resolved, reported } = await diffAgainst(saved, repaired);
    expect(resolved.resolutionFailed).toBe(false);
    expect(reported.some((r) => r.name === 'Bad' && r.changeType === 'ADD')).toBe(true);
  });

  it('an output the resolver returned `undefined` for (no throw, no warn) is recorded too', async () => {
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    const quiet = withBad({ Value: '__undefined__' });
    warnSpy.mockClear();
    await engine.deploy(stackName, quiet);
    // No failure handler ran — the resolver simply produced nothing...
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/Failed to resolve output Bad/));
    // ...and the key is as absent, and as recorded, as a thrown failure's.
    const saved = lastSaved(stateBackend);
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value' });
    expect(saved.skippedOutputs).toEqual({ Bad: skippedOutputDigest(withBad({ Value: '__undefined__' }), 'Bad') });
  });

  it('the per-run reset clears the record: an engine reused on a template with no Outputs writes its removal', async () => {
    // Two deploys on ONE engine: the first records `Bad`; the second, a
    // no-change deploy of a template with no `Outputs` section, must write the
    // record's removal. `resolveOutputs` early-returns for such a template
    // without recomputing the field, so the ONLY thing that clears it is
    // `deploy()`'s per-run reset — delete that and the previous pass's record
    // survives and reads as "unchanged" (mutation-probed).
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, template());
    const afterFirst = lastSaved(stateBackend);
    expect(afterFirst.skippedOutputs).toEqual({ Bad: skippedOutputDigest(template(), 'Bad') });

    stateBackend.getState.mockResolvedValue({
      state: makeState({ Fine: 'fine-value' }, { skippedOutputs: afterFirst.skippedOutputs }),
      etag: 'etag-1',
    });
    // The engine was built for the change path; switch it to the no-change
    // path for the second deploy.
    const noOutputs = template();
    delete noOutputs.Outputs;
    (
      engine as unknown as { diffCalculator: { hasChanges: ReturnType<typeof vi.fn> } }
    ).diffCalculator.hasChanges.mockReturnValue(false);
    const before = stateBackend.saveState.mock.calls.length;
    await engine.deploy(stackName, noOutputs);
    expect(stateBackend.saveState.mock.calls.length).toBe(before + 1);
    const saved = lastSaved(stateBackend);
    expect(saved).not.toHaveProperty('skippedOutputs');
    expect(saved.outputs).toStrictEqual({});
  });

  it("(c') an Export.Name removed with the Value unchanged: the record written WITH the alias no longer binds", async () => {
    const exported = withBad({ Value: '__boom__', Export: { Name: 'S:Bad' } });
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, exported);
    const saved = lastSaved(stateBackend);
    expect(saved.skippedOutputs).toEqual({ Bad: skippedOutputDigest(exported, 'Bad') });

    const { resolved, reported } = await diffAgainst(saved, template());
    expect(resolved.resolutionFailed).toBe(false);
    expect(reported.map((r) => [r.name, r.changeType])).toEqual([['Bad', 'ADD']]);
  });

  it('the record is re-saved with the new digest when the still-failing output\x27s inputs change on a no-change deploy', async () => {
    const before = template();
    const after = template({ Parameters: { Env: { Type: 'String', Default: 'prod' } } });
    const { engine, stateBackend } = buildEngine({
      priorState: makeState({ Fine: 'fine-value' }, { skippedOutputs: { Bad: skippedOutputDigest(before, 'Bad') } }),
    });
    await engine.deploy(stackName, after);
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = lastSaved(stateBackend);
    expect(saved.skippedOutputs).toEqual({ Bad: skippedOutputDigest(after, 'Bad') });
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value' });
  });

  it('(d) the output resolving on the next deploy clears the record and lands the key in outputs', async () => {
    const { engine, stateBackend } = buildEngine({
      priorState: makeState({ Fine: 'fine-value' }, { skippedOutputs: { Bad: skippedOutputDigest(template(), 'Bad') } }),
    });
    await engine.deploy(stackName, withBad({ Value: 'now-fine' }));
    const saved = lastSaved(stateBackend);
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value', Bad: 'now-fine' });
    expect(saved).not.toHaveProperty('skippedOutputs');
  });

  it('(e) the output leaving the template clears the record on a no-change deploy that has nothing else to persist', async () => {
    const { engine, stateBackend } = buildEngine({
      priorState: makeState({ Fine: 'fine-value' }, { skippedOutputs: { Bad: skippedOutputDigest(template(), 'Bad') } }),
    });
    const removed = template();
    delete removed.Outputs!['Bad'];
    await engine.deploy(stackName, removed);
    // Bag unchanged (Bad was never in it), export set unchanged — the record
    // is the ONLY reason this save happens.
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = lastSaved(stateBackend);
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value' });
    expect(saved).not.toHaveProperty('skippedOutputs');
  });

  it('(f) UPGRADE: a record with no field whose broken output is skipped again on a no-change deploy gains the record, bag and export set carried', async () => {
    const prior = makeState({ Fine: 'fine-value' }, { exportNames: ['S:Fine'] });
    expect(prior).not.toHaveProperty('skippedOutputs');
    const { engine, stateBackend, exportIndexStore } = buildEngine({ priorState: prior });
    await engine.deploy(stackName, template());
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = lastSaved(stateBackend);
    expect(saved.skippedOutputs).toEqual({ Bad: skippedOutputDigest(template(), 'Bad') });
    // `resolutionFailed` keeps the persisted bag and its export set; the index
    // is not republished for a record-only save.
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value' });
    expect(saved.exportNames).toEqual(['S:Fine']);
    expect(exportIndexStore.updateForStack).not.toHaveBeenCalled();

    const { reported } = await diffAgainst(saved, template());
    expect(reported).toEqual([]);
  });

  it('an Export.Name that fails on the alias pass blanks the output\x27s own key, so it is recorded too', async () => {
    const aliasFails = () =>
      // `TemplateOutput.Export.Name` is typed `string`; the engine resolves an
      // intrinsic one all the same (`typeof Name === 'string' ? ... : resolve`).
      withBad({
        Value: 'fine-after-all',
        Export: { Name: { 'Fn::Sub': '__boom__' } as unknown as string },
      });
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, aliasFails());
    const saved = lastSaved(stateBackend);
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value' });
    // Expected from a FRESH copy: the mock rewrites the name in place.
    expect(saved.skippedOutputs).toEqual({ Bad: skippedOutputDigest(aliasFails(), 'Bad') });
  });

  it('the digest is taken BEFORE resolution, so a resolver that rewrites the entry in place still records what a fresh parse digests', async () => {
    const handedIn = withBad({ Value: { 'Fn::Sub': '__boom__' } });
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, handedIn);
    // PREMISE: the resolver did rewrite the caller's template in place.
    expect((handedIn.Outputs!['Bad']!.Value as Record<string, unknown>)['Fn::Sub']).not.toBe('__boom__');
    const fresh = withBad({ Value: { 'Fn::Sub': '__boom__' } });
    expect(lastSaved(stateBackend).skippedOutputs).toEqual({ Bad: skippedOutputDigest(fresh, 'Bad') });
  });

  it('the digest is taken BEFORE condition evaluation, which rewrites Conditions in place', async () => {
    // An INJECTED in-place rewrite of `Conditions` — the shape `resolveSub`
    // produced before go-to-k/cdkd#2764, and one any future in-place
    // optimisation could reintroduce. It is the mechanism that pins the
    // ORDERING: a digest taken after this step would neither match a fresh
    // parse nor stay free of resolved values, so the record would stop
    // binding.
    const handedIn = template();
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    conditionsEvaluationMutates.value = true;
    try {
      await engine.deploy(stackName, handedIn);
    } finally {
      conditionsEvaluationMutates.value = false;
    }
    // PREMISE: the caller's template was rewritten.
    expect(handedIn.Conditions).toEqual({ IsProd: '<rewritten in place by evaluateConditions>' });
    expect(lastSaved(stateBackend).skippedOutputs).toEqual({
      Bad: skippedOutputDigest(template(), 'Bad'),
    });
  });

  it('...and on the NO-CHANGE path too, which resolves against the condition-pruned effectiveTemplate', async () => {
    // The issue's own scenario. `effectiveTemplate` shares `Conditions` by
    // reference with the template `evaluateConditions` rewrote, so passing it
    // (instead of the snapshot) into `resolveOutputs` would digest the
    // rewritten section — on exactly the path that writes the record.
    const handedIn = template();
    const { engine, stateBackend } = buildEngine({
      priorState: makeState({ Fine: 'fine-value' }),
    });
    conditionsEvaluationMutates.value = true;
    try {
      await engine.deploy(stackName, handedIn);
    } finally {
      conditionsEvaluationMutates.value = false;
    }
    expect(handedIn.Conditions).toEqual({ IsProd: '<rewritten in place by evaluateConditions>' });
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    expect(lastSaved(stateBackend).skippedOutputs).toEqual({
      Bad: skippedOutputDigest(template(), 'Bad'),
    });
  });

  it('records an output literally named `__proto__` (the bag is null-prototype)', async () => {
    // The failure handler writes `outputs[key] = undefined`; on a plain `{}`
    // that key would hit the prototype SETTER and be swallowed, so
    // `collectSkippedOutputs` could never see it — while the digest's own
    // canonicaliser goes to real trouble for exactly that name.
    // Built through JSON — one of the few spellings that give a plain object
    // an OWN `__proto__` data key (a computed property or
    // `Object.defineProperty` also would), and the one a real template takes,
    // since a template is parsed. Plain assignment hits the prototype setter,
    // which is the very hazard under test.
    const protoTemplate = (): CloudFormationTemplate => {
      const t = template();
      delete t.Outputs!['Bad'];
      const json = JSON.parse(JSON.stringify(t)) as CloudFormationTemplate;
      json.Outputs = JSON.parse(
        `{"__proto__": {"Value": "__boom__"}, "Fine": {"Value": "fine-value"}}`
      ) as CloudFormationTemplate['Outputs'];
      return json;
    };
    expect(Object.keys(protoTemplate().Outputs ?? {})).toContain('__proto__');
    const { engine, stateBackend } = buildEngine({ creates: ['BucketA'] });
    await engine.deploy(stackName, protoTemplate());
    const saved = lastSaved(stateBackend);
    expect(Object.keys(saved.skippedOutputs ?? {})).toEqual(['__proto__']);
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value' });

    // ...and the SIBLING bag keyed by the same template-controlled names two
    // lines away — the positioning source `resolveOutputs` hands to
    // `redactSecretsForState` — is null-prototype for the same reason. Its
    // prototype is the whole content of that hardening, so it is asserted
    // directly rather than through a behavioural consequence: with a plain
    // `{}` an output named `__proto__` REPLACES that prototype, and a later
    // lookup of a name the bag never stored inherits from it. Reverting the
    // `Object.create(null)` reds this line and nothing else.
    const sourceBag = (engine as unknown as { outputsTemplateSource: object })
      .outputsTemplateSource;
    expect(Object.getPrototypeOf(sourceBag)).toBeNull();
  });

  it('dry-run persists nothing, record included', async () => {
    const { engine, stateBackend } = buildEngine({ priorState: makeState({ Fine: 'fine-value' }), dryRun: true });
    await engine.deploy(stackName, template());
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('--strict-getatt: the deploy rejects and the failure save CARRIES the previous record rather than writing a new one', async () => {
    const stale = { Old: 'digest-of-a-previous-template' };
    const { engine, stateBackend } = buildEngine({
      priorState: makeState({ Fine: 'fine-value' }, { skippedOutputs: stale }),
      creates: ['BucketB'],
      strictGetAtt: true,
    });
    await expect(engine.deploy(stackName, template())).rejects.toThrow(/Failed to resolve output Bad/);
    const saved = lastSaved(stateBackend);
    // Provisioning landed, so resources are this run's; the bag and its record
    // are the previous deploy's, verbatim.
    expect(saved.resources).toHaveProperty('BucketB');
    expect(saved.outputs).toStrictEqual({ Fine: 'fine-value' });
    expect(saved.skippedOutputs).toEqual(stale);
  });

  it('the per-resource partial save during a change-path deploy carries the previous record', async () => {
    const stale = { Old: 'digest-of-a-previous-template' };
    const { engine, stateBackend } = buildEngine({
      priorState: makeState({ Fine: 'fine-value' }, { skippedOutputs: stale }),
      creates: ['BucketB'],
    });
    await engine.deploy(stackName, template());
    // First save = after BucketB (partial); last save = the success path.
    const first = savedAt(stateBackend, 0);
    expect(first.skippedOutputs).toEqual(stale);
    const last = lastSaved(stateBackend);
    expect(last.skippedOutputs).toEqual({ Bad: skippedOutputDigest(template(), 'Bad') });
  });
});
