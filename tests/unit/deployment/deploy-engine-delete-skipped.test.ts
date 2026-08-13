/**
 * DeployEngine consumption of `{ outcome: 'skipped' }` (issue
 * https://github.com/go-to-k/cdkd/issues/1762) — the deploy-side twin of the
 * destroy-runner coverage in `tests/unit/cli/destroy-runner-skipped.test.ts`.
 *
 * Issue #1752 gave `ResourceProvider.delete` an optional return value whose
 * `'skipped'` arm means the resource was NOT deleted and may still be alive,
 * and taught `cdkd destroy` to report it. `cdkd deploy` discarded the value at
 * all five of its delete call sites, so the same skip printed `deleted`,
 * counted as deleted, and — in the template-DELETE branch — DROPPED the state
 * record, leaving the user with neither the AWS resource gone nor a cdkd
 * record pointing at it.
 *
 * Every case here fails against pre-#1762 code: the skip is a plain resolved
 * value, so the old sites walked straight into their success paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import type {
  CloudFormationTemplate,
  ResourceDeleteResult,
  ResourceProvider,
} from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

/** A provider skip carries a REQUIRED reason — the line always names a cause. */
const SKIP: ResourceDeleteResult = {
  outcome: 'skipped',
  reason: 'malformed physicalId in state — no delete issued',
};

// A COMPOSITE-physicalId type (the delete arms that report a skip today) that
// is NOT in `STATEFUL_TYPES` — a stateful one would be refused by the
// `--replace` data guard BEFORE any delete call, so the replacement cases
// below would pass without ever exercising the skip.
const TYPE = 'AWS::AppSync::Resolver';

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

type ProvisionCountsBag = {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  deleteSkipped: number;
};

function freshCounts(): ProvisionCountsBag {
  return { created: 0, updated: 0, deleted: 0, skipped: 0, deleteSkipped: 0 };
}

/**
 * The whole `.cause` chain as one string. The engine wraps every resource
 * failure in a `ProvisioningError('Failed to <op> resource <id>')`, so the
 * cause is where the reason a site refused actually lives — asserting on the
 * wrapper alone would pass for ANY failure, including the guards that refuse
 * BEFORE the delete is issued.
 */
function causeChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

async function failureOf(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => {
      throw new Error('expected the resource to fail, but it resolved');
    },
    (error: unknown) => causeChain(error)
  );
}

describe('DeployEngine — a provider-reported delete skip (#1762)', () => {
  let provider: ResourceProvider;
  let events: DeploymentEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'old-pid' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      // Keep the harness on the single-shot path: the outer retry loop is a
      // different code path and none of these cases are about it.
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(
    opts: {
      replace?: boolean;
      recreateViaCcApi?: boolean;
      recordEvents?: boolean;
    } = {}
  ): InstanceType<typeof DeployEngine> {
    const mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag'),
    };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      {
        ...(opts.replace === true && { replace: true }),
        ...(opts.recreateViaCcApi === true && {
          recreateViaCcApiTargets: new Set(['MyResource']),
        }),
        ...(opts.recordEvents === true && {
          eventRecorder: {
            runId: 'run-1',
            record: (event: Omit<DeploymentEvent, 'timestamp'>) =>
              events.push(event as DeploymentEvent),
          },
        }),
      },
      'us-east-1'
    );
  }

  function stateWith(): Record<string, StateRecord> {
    return {
      MyResource: {
        physicalId: 'api1|Query|field',
        resourceType: TYPE,
        properties: { Name: 'a|b' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
  }

  function provisionOf(engine: InstanceType<typeof DeployEngine>) {
    return (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate,
          parameterValues?: Record<string, unknown>,
          conditions?: Record<string, boolean>,
          counts?: ProvisionCountsBag
        ) => Promise<unknown>;
      }
    ).provisionResource.bind(engine);
  }

  /** The template-DELETE branch: the resource was removed from the template. */
  async function invokeTemplateDelete(
    engine: InstanceType<typeof DeployEngine>,
    counts: ProvisionCountsBag
  ): Promise<{ result: unknown; stateResources: Record<string, StateRecord> }> {
    const change: ResourceChange = {
      logicalId: 'MyResource',
      changeType: 'DELETE',
      resourceType: TYPE,
      currentProperties: { Name: 'a|b' },
    };
    const stateResources = stateWith();
    const result = await provisionOf(engine)(
      'MyResource',
      change,
      stateResources,
      'MyStack',
      { Resources: {} },
      undefined,
      undefined,
      counts
    );
    return { result, stateResources };
  }

  /** An UPDATE that resolves to a replacement (DELETE of the old, then CREATE). */
  async function invokeReplacingUpdate(
    engine: InstanceType<typeof DeployEngine>,
    opts: { requiresReplacement: boolean }
  ): Promise<Record<string, StateRecord>> {
    const change: ResourceChange = {
      logicalId: 'MyResource',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { Mode: 'a' },
      desiredProperties: { Mode: 'b' },
      propertyChanges: [
        {
          path: 'Mode',
          oldValue: 'a',
          newValue: 'b',
          requiresReplacement: opts.requiresReplacement,
        },
      ],
    };
    const stateResources = stateWith();
    await provisionOf(engine)('MyResource', change, stateResources, 'MyStack', {
      Resources: { MyResource: { Type: TYPE, Properties: { Mode: 'b' } } },
    });
    return stateResources;
  }

  describe('template-DELETE branch', () => {
    it('keeps the state record, counts it apart from `deleted`, and prints `skipped`', async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(SKIP);
      const counts = freshCounts();

      const { stateResources } = await invokeTemplateDelete(makeEngine(), counts);

      // The data-loss half: pre-#1762 the record was dropped, so the user had
      // neither the resource deleted nor a pointer to it.
      expect(Object.keys(stateResources)).toEqual(['MyResource']);
      expect(counts.deleted).toBe(0);
      expect(counts.deleteSkipped).toBe(1);
      // NOT folded into the UPDATE-no-change counter, which feeds `unchanged`.
      expect(counts.skipped).toBe(0);
      const lines = infoSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('skipped') && l.includes(SKIP.reason))).toBe(true);
      expect(lines.some((l) => l.includes('deleted'))).toBe(false);
      // The warn names the remediation; the status line alone is one scroll away.
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'may still exist'
      );
    });

    it('emits RESOURCE_SKIPPED (with the reason) instead of RESOURCE_SUCCEEDED', async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(SKIP);

      await invokeTemplateDelete(makeEngine({ recordEvents: true }), freshCounts());

      const types = events.map((e) => e.eventType);
      expect(types).toContain('RESOURCE_SKIPPED');
      expect(types).not.toContain('RESOURCE_SUCCEEDED');
      const skipEvent = events.find((e) => e.eventType === 'RESOURCE_SKIPPED');
      // The events store is the durable post-mortem — a bare event cannot say
      // why cdkd could not address the resource.
      expect(skipEvent?.reason).toBe(SKIP.reason);
      expect(skipEvent?.operation).toBe('DELETE');
    });

    it('reports the skip to its caller so the rollback journal records nothing', async () => {
      // The journal is written by the DELETE executor from this return value.
      // Journaling a delete that never happened would make `cdkd rollback`
      // re-CREATE a live resource.
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(SKIP);

      const { result } = await invokeTemplateDelete(makeEngine(), freshCounts());

      expect(result).toEqual({ deleteSkipped: SKIP.reason });
    });

    it('control: a `void` return still drops the record and counts a delete', async () => {
      // The inverted control that makes the assertions above meaningful —
      // ~80 providers return `void`, and that must keep meaning "deleted".
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const counts = freshCounts();

      const { result, stateResources } = await invokeTemplateDelete(makeEngine(), counts);

      expect(Object.keys(stateResources)).toEqual([]);
      expect(counts.deleted).toBe(1);
      expect(counts.deleteSkipped).toBe(0);
      expect(result).toBeUndefined();
    });

    it("control: an explicit `{ outcome: 'deleted' }` behaves like `void`", async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: 'deleted' });
      const counts = freshCounts();

      const { stateResources } = await invokeTemplateDelete(makeEngine(), counts);

      expect(Object.keys(stateResources)).toEqual([]);
      expect(counts.deleted).toBe(1);
    });
  });

  describe('replacement delete sites', () => {
    it('UPDATE-not-supported replacement: a skip FAILS the resource and no create runs', async () => {
      // Unlike the template DELETE, proceeding here would create the
      // replacement beside a live old resource (or collide on its name).
      (provider.update as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ResourceUpdateNotSupportedError(TYPE, 'MyResource', 'no update API')
      );
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(SKIP);

      const failure = await failureOf(
        invokeReplacingUpdate(makeEngine({ replace: true }), { requiresReplacement: false })
      );
      expect(failure).toContain(SKIP.reason);
      // Asserted explicitly: a guard that refused BEFORE the delete would
      // satisfy "create was not called" without exercising the skip at all.
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(provider.create).not.toHaveBeenCalled();
    });

    it('create-first cleanup: a skip WARNS, because the replacement itself succeeded', async () => {
      // The one replacement site whose delete is already best-effort: the new
      // resource is created and recorded, so the old one is untracked whether
      // the delete failed or was skipped. Failing the resource here would roll
      // back a replacement that worked.
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(SKIP);

      const stateResources = await invokeReplacingUpdate(makeEngine(), {
        requiresReplacement: true,
      });

      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(stateResources['MyResource']?.physicalId).toBe('new-pid');
      const warns = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warns).toContain(SKIP.reason);
      expect(warns).toContain('Delete it manually');
    });

    it('--recreate-via-cc-api: a skip FAILS the resource and no create runs', async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(SKIP);

      const failure = await failureOf(
        invokeReplacingUpdate(makeEngine({ recreateViaCcApi: true }), {
          requiresReplacement: false,
        })
      );
      expect(failure).toContain(SKIP.reason);
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(provider.create).not.toHaveBeenCalled();
    });

    it('control: the same replacement path completes when the delete is clean', async () => {
      (provider.update as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ResourceUpdateNotSupportedError(TYPE, 'MyResource', 'no update API')
      );
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const stateResources = await invokeReplacingUpdate(makeEngine({ replace: true }), {
        requiresReplacement: false,
      });

      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(stateResources['MyResource']?.physicalId).toBe('new-pid');
    });
  });
});
