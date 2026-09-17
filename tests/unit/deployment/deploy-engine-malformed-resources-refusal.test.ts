/**
 * Issue [go-to-k/cdkd#3161](https://github.com/go-to-k/cdkd/issues/3161), deploy
 * half — the ROOT `resources` bag, not the per-entry `properties` map its
 * sibling `deploy-engine-malformed-properties-refusal.test.ts` covers.
 *
 * That sibling's guard lives in `DiffCalculator.calculateDiff` and keys on
 * `unreadableResourcePropertyBags`, which deliberately returns `[]` when the
 * ROOT bag is itself unreadable. So before this lane, a record spelling
 * `"resources": "abcdef"` reached the deploy diff and enumerated two fabricated
 * logical ids, while `[]` / `5` / `true` enumerated none and made the change
 * calculation plan every resource the template declares as a CREATE —
 * re-provisioning a stack that already exists. `refuseMalformedState`'s callers
 * were `import.ts`, `orphan.ts` and `rollback.ts`, none of them on this path.
 *
 * The REAL `DiffCalculator` is used, as in the sibling, so the "nothing was
 * provisioned and no state was written" claim in the refusal's own text is
 * driven rather than restated: the guard sits at the engine's state LOAD, which
 * is AFTER the lock is taken, so a refusal that stranded the lock would make
 * the sentence false.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import {
  STATE_RESOURCES_MALFORMED,
  repairMalformedResourcesForReadOnly,
} from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

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

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'malformed-resources-stack';
const REGION = 'us-east-1';

describe('DeployEngine refuses an unreadable root resources bag (go-to-k/cdkd#3161)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let exportIndexStore: {
    updateForStack: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    patchEntry: ReturnType<typeof vi.fn>;
  };
  /** Every provider call the run made — the "nothing was provisioned" claim. */
  let provisioned: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    provisioned = [];
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    exportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  const dagBuilder = {
    buildGraph: vi.fn().mockReturnValue({}),
    getExecutionLevels: vi.fn().mockReturnValue([['ParamA']]),
    getDirectDependencies: vi.fn().mockReturnValue([]),
  };

  function makeProviderRegistry() {
    const provider = {
      create: vi.fn().mockImplementation(() => {
        provisioned.push('create');
        return Promise.resolve({ physicalId: 'p' });
      }),
      update: vi.fn().mockImplementation(() => {
        provisioned.push('update');
        return Promise.resolve({ physicalId: 'p' });
      }),
      delete: vi.fn().mockImplementation(() => {
        provisioned.push('delete');
        return Promise.resolve();
      }),
      getAttribute: vi.fn().mockResolvedValue(undefined),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
    return {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      reportSilentDropDecisions: vi.fn(),
      getEffectivePropertiesFn: vi.fn().mockReturnValue(undefined),
    };
  }

  function makeState(resources: unknown): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: resources as StackState['resources'],
      outputs: {},
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
  };

  function makeEngine(dryRun = false): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder as never,
      new DiffCalculator(),
      makeProviderRegistry() as never,
      { dryRun },
      REGION,
      exportIndexStore as never
    );
  }

  /**
   * One entry per OUTCOME the unguarded reads produce. `[]` / `5` / `true`
   * enumerate no keys and are therefore the repaired-to-`{}` case; a string
   * enumerates one fabricated logical id per character; `null` and an absent
   * key throw the bare `TypeError` go-to-k/cdkd#3018 exists to remove, out of
   * the `Object.keys(currentState.resources)` debug line that sits immediately
   * below the guard.
   */
  const MALFORMED: Array<[string, unknown]> = [
    ['a list bag', []],
    ['a number bag', 5],
    ['a boolean bag', true],
    ['a string bag', 'ab'],
    ['a null bag', null],
  ];

  for (const [label, resources] of MALFORMED) {
    it(`refuses ${label}, provisioning nothing and writing nothing`, async () => {
      stateBackend.getState.mockResolvedValue({ state: makeState(resources), etag: 'etag-old' });
      const err = (await makeEngine()
        .deploy(STACK, template)
        .catch((e: unknown) => e)) as CdkdError;

      expect(err).toBeInstanceOf(CdkdError);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      expect(
        provisioned,
        'the deploy called a provider before refusing, so it re-created a resource that already ' +
          'exists — the outcome the guard is for'
      ).toEqual([]);
      expect(
        stateBackend.saveState,
        'the deploy wrote the record before refusing, laundering the damaged bag into a ' +
          'well-formed one'
      ).not.toHaveBeenCalled();
      expect(exportIndexStore.updateForStack).not.toHaveBeenCalled();
      // The lock IS held by this point, so the refusal must not strand it.
      expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
    });
  }

  it('refuses an ABSENT resources key — absence is a defect for this container', async () => {
    const state = makeState({});
    delete (state as Partial<StackState>).resources;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const err = (await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(provisioned).toEqual([]);
  });

  /**
   * PRECEDENCE, and it is the OPPOSITE of the destroy's — deliberately. Both
   * refusals carry the same code and differ only in TEXT, so a reorder is
   * invisible without a case. `deploy` refuses `outputs` first because that
   * guard predates this one and dominates the same reads; `destroy` refuses
   * `resources` first because that is the container its fast path acts on.
   */
  it('names `outputs` when BOTH containers are malformed — the opposite order to destroy', async () => {
    const state = makeState([]);
    state.outputs = 'abcdef' as unknown as StackState['outputs'];
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const err = (await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain(`'outputs'`);
    expect(
      err.message,
      'the resources guard now runs first, so a record broken in both reports the wrong container'
    ).not.toContain('re-provisions a stack that already exists');
    expect(provisioned).toEqual([]);
  });

  it('still names `resources` when only that container is malformed', async () => {
    // The control: without it, a guard that always reported `outputs` would
    // satisfy the precedence assertion above.
    stateBackend.getState.mockResolvedValue({ state: makeState([]), etag: 'etag-old' });
    const err = (await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err.message).toContain('re-provisions a stack that already exists');
  });

  it('marks the refusal non-retryable — a nested child deploy runs inside the parent withRetry', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState([]), etag: 'etag-old' });
    const err = await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e);
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('names the DEPLOY consequence, not the destroy or the generic save one', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState([]), etag: 'etag-old' });
    const err = (await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err.message).toContain('re-provisions a stack that already exists');
    expect(err.message).toContain('Nothing was provisioned and no state was written');
    // Not the destroy text — that one describes a fast path this command never
    // reaches, and offers `cdkd state orphan`, which would be advice to delete
    // the record the deploy is refusing to act on.
    expect(err.message).not.toContain('empty-stack fast path');
    expect(err.message).not.toContain('cdkd state orphan');
  });

  it('refuses under --dry-run too, and says so in terms that are TRUE there', async () => {
    // Provisioning is gated below the diff and the guard is at the LOAD, well
    // above both, so a dry run reaches it. Decided rather than incidental: the
    // repaired preview is available from `cdkd diff`, so refusing here costs
    // nothing that is not offered one command over, while a plausible
    // `--dry-run` plan followed by a refusal when the flag comes off would be
    // the worst arm of all.
    stateBackend.getState.mockResolvedValue({ state: makeState('ab'), etag: 'etag-old' });
    const err = (await makeEngine(true)
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain("under '--dry-run' too");
    expect(err.message).toContain("'cdkd diff' previews the stack with this map read as EMPTY");
    expect(provisioned).toEqual([]);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });

  /**
   * THE MEASUREMENT the refuse-not-repair contract rests on, driven rather than
   * asserted in prose.
   *
   * A repair turns `[]` / `5` / `true` into `{}` — and `{}` is what this case
   * deploys. The plan it produces is a CREATE of every resource the template
   * declares, against a stack whose resources are standing in AWS. So repairing
   * reproduces the damaging outcome instead of avoiding it, exactly as
   * go-to-k/cdkd#3191 measured one container down, and only a refusal closes
   * the class.
   *
   * It doubles as the OTHER-DIRECTION control: a guard that refused every
   * record would satisfy every case above while making `cdkd deploy` refuse a
   * first-ever deploy.
   */
  it('a readable EMPTY bag — what a repair would produce — CREATES the whole stack', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });
    const result = await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e);
    expect(result).not.toBeInstanceOf(CdkdError);
    expect(
      provisioned,
      'the repaired-to-empty shape no longer plans a CREATE, so this measurement no longer ' +
        'shows what repairing would cost'
    ).toEqual(['create']);
  });

  /**
   * The two halves of the measurement, JOINED — the case above deploys a
   * literal `{}` and could be read as merely restating the control. This one
   * takes an actually-malformed `[]` record, applies the READ-ONLY REPAIR the
   * class offers elsewhere, and deploys the RESULT. That is what a "just
   * repair it" implementation would have done, and it CREATES the resource.
   */
  it('MEASUREMENT: a `[]` record put through the read-only repair still CREATEs', async () => {
    const repaired = makeState([]);
    expect(
      repairMalformedResourcesForReadOnly(repaired),
      'the repair declined this record, so the measurement below is about something else'
    ).toBe(true);
    expect(repaired.resources).toEqual({});
    stateBackend.getState.mockResolvedValue({ state: repaired, etag: 'etag-old' });
    const result = await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e);
    expect(result).not.toBeInstanceOf(CdkdError);
    expect(
      provisioned,
      'repairing a `[]` record no longer plans a CREATE, so the refuse-not-repair contract ' +
        'rests on nothing measured'
    ).toEqual(['create']);
  });

  it('deploys normally when the bag is populated', async () => {
    stateBackend.getState.mockResolvedValue({
      state: makeState({
        ParamA: {
          physicalId: 'phys-param-a',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: 'x' },
          attributes: {},
          dependencies: [],
        },
      }),
      etag: 'etag-old',
    });
    const result = await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e);
    expect(result).not.toBeInstanceOf(CdkdError);
    expect(provisioned, 'a NO_CHANGE record should not have been provisioned').toEqual([]);
    expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });
});
