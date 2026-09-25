/**
 * Issue go-to-k/cdkd#3379, deploy half — the `orphans` CONTAINER, not the
 * `resources` bag its sibling `deploy-engine-malformed-resources-refusal.test.ts`
 * covers and not the per-entry `properties` map covered one file over.
 *
 * The engine's adoption pass reads the container on a bare `?? []` and then
 * ASSIGNS `currentState.orphans` from what it read, so this is a WRITER: an
 * unreadable container is rewritten rather than reported. The guard sits beside
 * the `resources` refusal at the engine's state load, which is AFTER the lock —
 * so the guarantee the case drives is "before any resource operation", and a
 * refusal that stranded the lock would break the refusal's own sentence.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
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


describe('DeployEngine refuses an unreadable orphans container (go-to-k/cdkd#3379)', () => {
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

  function makeState(orphans: unknown): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: {},
      outputs: {},
      orphans: orphans as StackState['orphans'],
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
  };

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder as never,
      new DiffCalculator(),
      makeProviderRegistry() as never,
      {},
      REGION,
      exportIndexStore as never
    );
  }

  const MALFORMED: Array<[string, unknown]> = [
    ['a number container', 5],
    ['a plain object container', {}],
    ['an object carrying length', { length: 1 }],
    ['a string container', 'abc'],
    ['a null container', null],
  ];

  for (const [label, orphans] of MALFORMED) {
    it(`refuses ${label}, provisioning nothing and writing nothing`, async () => {
      stateBackend.getState.mockResolvedValue({ state: makeState(orphans), etag: 'etag-old' });
      const err = (await makeEngine()
        .deploy(STACK, template)
        .catch((e: unknown) => e)) as CdkdError;

      expect(err).toBeInstanceOf(CdkdError);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      // The CONTAINER by name: the `resources` bag here is a perfectly readable
      // `{}`, so a refusal naming it would be the wrong text.
      expect(err.message).toContain("'orphans'");
      expect(
        provisioned,
        'the deploy called a provider before refusing, so the guarantee is not "before any ' +
          'resource operation"'
      ).toEqual([]);
      expect(
        stateBackend.saveState,
        'the deploy wrote the record before refusing, so the adoption pass laundered the ' +
          'damaged container'
      ).not.toHaveBeenCalled();
      // The lock IS held by this point, so the refusal must not strand it.
      expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
    });
  }

  it('refuses an unusable row whose id is ALREADY in `resources`, which the pass skips silently', async () => {
    // The shape go-to-k/cdkd#3500's plan called "worth its own case" and no
    // fixture had (go-to-k/cdkd#3641, item o3). It needs the id to really be in
    // `resources`, which the shared `makeState` cannot express — hence its own
    // case rather than a table row, so the premise is set up rather than claimed.
    //
    // `planOrphanAdoption`'s FIRST branch drops a row whose id is already managed,
    // before anything dereferences its `state`. So this row reaches no abort and
    // produced no report at all: the run proceeded, and the damaged row stayed in
    // the record every later command reads. The guard refuses it on SHAPE, which
    // is what makes that silent path unreachable rather than merely unlikely.
    const state = makeState([{ logicalId: 'Managed', orphanedAt: 1 }]);
    state.resources = {
      Managed: { physicalId: 'p-managed', resourceType: 'AWS::SQS::Queue', properties: {} },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const err = (await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as CdkdError;
    expect(err, 'the already-managed row was skipped silently').toBeInstanceOf(CdkdError);
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain('rollback-orphan record(s)');
    expect(provisioned).toEqual([]);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('marks the refusal non-retryable — a nested child deploy runs inside a withRetry', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState('abc'), etag: 'etag-old' });
    const err = await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e);
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('CONTROL: a readable or absent container deploys, so the guard is not a blanket refusal', async () => {
    for (const orphans of [[], undefined]) {
      vi.clearAllMocks();
      provisioned = [];
      stateBackend.getState.mockResolvedValue({ state: makeState(orphans), etag: 'etag-old' });
      const err = await makeEngine()
        .deploy(STACK, template)
        .catch((e: unknown) => e);
      const message = err instanceof CdkdError ? err.message : '';
      expect(message).not.toContain("'orphans'");
      expect(provisioned, 'the control deployed nothing, so it proves nothing').toEqual(['create']);
    }
  });
  /**
   * Issue go-to-k/cdkd#3500, deploy half — a READABLE list holding a row the
   * adoption pass cannot use. `planOrphanAdoption` destructures every row and
   * reads its `state`, and what that does depends on which part is torn: it can
   * abort the deploy, drop the row, or keep it with a notice. The guard refuses
   * instead of leaving the outcome to the shape.
   */
  describe('DeployEngine refuses an unusable orphan ROW (go-to-k/cdkd#3500)', () => {
    const healthy = {
      logicalId: 'Keep',
      orphanedAt: 1,
      state: { physicalId: 'p-keep', resourceType: 'AWS::SQS::Queue', properties: {} },
    };

    const UNUSABLE: Array<[string, unknown]> = [
      ['a null row', null],
      ['a number row', 5],
      // The EMPTY-OBJECT row, named in go-to-k/cdkd#3500's verification plan and
      // missing from every per-command table until go-to-k/cdkd#3641's review
      // (item o3). It is a readable bag, and TWO clauses reject it — no string
      // `logicalId` AND no readable `state` — so it does not discriminate either
      // one (item o10: the first cut credited the `logicalId` clause alone, and
      // deleting that clause leaves this row refused).
      ['an empty-object row', {}],
      ['a row with no `state`', { logicalId: 'Gone', orphanedAt: 1 }],
      // A torn `properties` map: the deploy refuses it, while `cdkd diff` KEEPS it
      // and now predicts this refusal (go-to-k/cdkd#3641 M1). The per-command
      // tables were asymmetric — deploy had no `properties` row, destroy and scrub
      // no `attributes` row — so each table now carries both halves.
      [
        'a row whose `state.properties` is not an object',
        {
          logicalId: 'Gone',
          orphanedAt: 1,
          state: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' },
        },
      ],
      [
        'a row whose `state.physicalId` is not a string',
        {
          logicalId: 'Gone',
          orphanedAt: 1,
          state: { resourceType: 'AWS::SQS::Queue', properties: {} },
        },
      ],
      ['a row whose `logicalId` is not a string', { logicalId: 5, orphanedAt: 1, state: healthy.state }],
      [
        'a row whose `state.attributes` is not an object',
        {
          logicalId: 'Gone',
          orphanedAt: 1,
          state: {
            physicalId: 'p',
            resourceType: 'AWS::SQS::Queue',
            properties: {},
            attributes: 'abcdef',
          },
        },
      ],
    ];

    for (const [label, row] of UNUSABLE) {
      it(`refuses ${label}, provisioning nothing and writing nothing`, async () => {
        stateBackend.getState.mockResolvedValue({
          // A healthy row beside it: the guard must refuse a list it could
          // partly read, not merely a uniformly broken one.
          state: makeState([healthy, row] as unknown),
          etag: 'etag-old',
        });
        const err = (await makeEngine()
          .deploy(STACK, template)
          .catch((e: unknown) => e)) as CdkdError;

        expect(err).toBeInstanceOf(CdkdError);
        expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
        // The ROW text: the container here is a perfectly good list.
        expect(err.message).toContain('rollback-orphan record(s)');
        expect(err.message).not.toContain("has no readable 'orphans' list");
        expect(
          provisioned,
          'the deploy called a provider before refusing, so the guarantee is not "before any ' +
            'resource operation"'
        ).toEqual([]);
        expect(stateBackend.saveState).not.toHaveBeenCalled();
        expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
      });
    }

    it('marks the ROW refusal non-retryable too', async () => {
      stateBackend.getState.mockResolvedValue({
        state: makeState([5] as unknown),
        etag: 'etag-old',
      });
      const err = await makeEngine()
        .deploy(STACK, template)
        .catch((e: unknown) => e);
      // WHICH error, before the marker: a deploy can fail non-retryably for
      // reasons that have nothing to do with this guard, and a bare
      // `isMarkedNonRetryable` pass would credit the guard for one of those.
      expect(err).toBeInstanceOf(CdkdError);
      expect((err as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((err as CdkdError).message).toContain('rollback-orphan record(s)');
      expect(isMarkedNonRetryable(err)).toBe(true);
    });

    // go-to-k/cdkd#3643: two HEALTHY rows sharing a string `logicalId`. Each
    // passes the per-row predicate; the adoption pass writes `adopted[logicalId]`
    // per row and the failure-path save merges by id, so one of the two would be
    // dropped from tracking while its resource stays live.
    const twin = (logicalId: string, physicalId: string) => ({
      logicalId,
      orphanedAt: 1,
      state: { physicalId, resourceType: 'AWS::SQS::Queue', properties: {} },
    });

    for (const sharedId of ['Twin', '']) {
      it(`refuses two healthy rows sharing the id ${JSON.stringify(sharedId)}, provisioning and writing nothing`, async () => {
        stateBackend.getState.mockResolvedValue({
          state: makeState([healthy, twin(sharedId, 'p-1'), twin(sharedId, 'p-2')] as unknown),
          etag: 'etag-old',
        });
        const err = (await makeEngine()
          .deploy(STACK, template)
          .catch((e: unknown) => e)) as CdkdError;
        expect(err, 'rows sharing an id reached the adoption pass').toBeInstanceOf(CdkdError);
        expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
        expect(err.message).toContain('2 rollback-orphan record(s)');
        expect(err.message).toContain('shares it with another row');
        expect(err.message).not.toContain('Keep');
        expect(provisioned).toEqual([]);
        expect(stateBackend.saveState).not.toHaveBeenCalled();
        expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
        expect(isMarkedNonRetryable(err)).toBe(true);
      });
    }

    it('CONTROL: the same two rows under DISTINCT ids still deploy', async () => {
      stateBackend.getState.mockResolvedValue({
        state: makeState([twin('Twin', 'p-1'), twin('Other', 'p-2')] as unknown),
        etag: 'etag-old',
      });
      await makeEngine().deploy(STACK, template);
      expect(provisioned, 'the control never provisioned, so it proves nothing').not.toEqual([]);
      expect(stateBackend.saveState).toHaveBeenCalled();
    });

    it('CONTROL: a list whose every row is usable still deploys', async () => {
      vi.clearAllMocks();
      provisioned = [];
      stateBackend.getState.mockResolvedValue({
        state: makeState([healthy] as unknown),
        etag: 'etag-old',
      });
      stateBackend.saveState.mockResolvedValue('etag-new');
      await makeEngine().deploy(STACK, template);
      expect(provisioned, 'the control never provisioned, so it proves nothing').not.toEqual([]);
    });
  });
});
