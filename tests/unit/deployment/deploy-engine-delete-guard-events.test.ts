/**
 * The deploy engine persists a delete's indeterminate guards (issue
 * https://github.com/go-to-k/cdkd/issues/2422) — the deploy-side twin of
 * `tests/unit/cli/destroy-runner-guard-indeterminate.test.ts`.
 *
 * `ResourceDeleteResult.indeterminateGuards` says a pre-flight safety guard
 * could not reach a verdict and was not enforced. `cdkd destroy` persisted it;
 * every deploy delete site discarded it. Each case below drives one of the five
 * sites with a provider whose delete reports a guard, and asserts the single
 * `RESOURCE_GUARD_INDETERMINATE` row `provisionResource` emits for it — with
 * `operation: 'DELETE'` even where the row itself is an UPDATE.
 *
 * The harness mirrors `deploy-engine-delete-skipped.test.ts`, which reaches the
 * same five sites for the `'skipped'` outcome.
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
import { ccAlreadyExistsError } from '../_aws-sdk-error.js';

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

// Not in `STATEFUL_TYPES`, so the `--replace` data guard does not refuse the
// replacement cases before their delete runs (the skip harness's reasoning).
const TYPE = 'AWS::AppSync::Resolver';
const OLD_PID = 'api1|Query|field';
const GUARD_ID = 'cc-delete-region-identity';
const GUARD_REASON = `probe on ${OLD_PID} could not be answered: AccessDenied`;

/** A delete that ran, with one guard it could not enforce. */
const GUARDED: ResourceDeleteResult = {
  outcome: 'deleted',
  indeterminateGuards: [{ guard: GUARD_ID, reason: GUARD_REASON }],
};

/** The same guard on a delete that then reported a skip. */
const GUARDED_SKIP: ResourceDeleteResult = {
  outcome: 'skipped',
  reason: 'malformed physicalId in state — no delete issued',
  indeterminateGuards: [{ guard: GUARD_ID, reason: GUARD_REASON }],
};

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

describe('DeployEngine — indeterminate guards on deploy-path deletes (#2422)', () => {
  let provider: ResourceProvider;
  let events: DeploymentEvent[];
  let createFailures: Error[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    createFailures = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        const failure = createFailures.shift();
        if (failure) throw failure;
        return { physicalId: 'new-pid', attributes: {} };
      }),
      update: vi.fn().mockResolvedValue({ physicalId: OLD_PID }),
      delete: vi.fn().mockResolvedValue(GUARDED),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(
    opts: { replace?: boolean; recreateViaCcApi?: boolean } = {}
  ): InstanceType<typeof DeployEngine> {
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      // Every delete is ROUTED to Cloud Control while the record says `sdk`
      // (a silent-drop auto-route, `--pin-cc-api`): the guard row must carry
      // the layer the delete actually ran on, not the record's.
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') } as unknown as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as unknown as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as unknown as never,
      mockProviderRegistry as unknown as never,
      {
        ...(opts.replace === true && { replace: true }),
        ...(opts.recreateViaCcApi === true && {
          recreateTargets: {
            stackName: 'MyStack',
            viaCcApi: new Set(['MyResource']),
            viaSdkProvider: new Set<string>(),
          },
        }),
        eventRecorder: {
          runId: 'run-1',
          record: (event: Omit<DeploymentEvent, 'timestamp'>) =>
            events.push(event as DeploymentEvent),
        },
      },
      'us-east-1'
    );
  }

  function stateWith(properties: Record<string, unknown>): Record<string, StateRecord> {
    return {
      MyResource: {
        physicalId: OLD_PID,
        resourceType: TYPE,
        properties,
        attributes: {},
        dependencies: [],
        // Disagrees with the routed layer on purpose (see `getProviderFor`).
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
          template: CloudFormationTemplate
        ) => Promise<unknown>;
      }
    ).provisionResource.bind(engine);
  }

  async function invokeTemplateDelete(engine: InstanceType<typeof DeployEngine>): Promise<void> {
    await provisionOf(engine)(
      'MyResource',
      {
        logicalId: 'MyResource',
        changeType: 'DELETE',
        resourceType: TYPE,
        currentProperties: { Name: 'a' },
      },
      stateWith({ Name: 'a' }),
      'MyStack',
      { Resources: {} }
    );
  }

  async function invokeReplacingUpdate(
    engine: InstanceType<typeof DeployEngine>,
    opts: { requiresReplacement: boolean }
  ): Promise<void> {
    const identity = { ApiId: 'api1', TypeName: 'Query', FieldName: 'field' };
    await provisionOf(engine)(
      'MyResource',
      {
        logicalId: 'MyResource',
        changeType: 'UPDATE',
        resourceType: TYPE,
        currentProperties: { ...identity, Mode: 'a' },
        desiredProperties: { ...identity, Mode: 'b' },
        propertyChanges: [
          {
            path: 'Mode',
            oldValue: 'a',
            newValue: 'b',
            requiresReplacement: opts.requiresReplacement,
          },
        ],
      },
      stateWith({ ...identity, Mode: 'a' }),
      'MyStack',
      { Resources: { MyResource: { Type: TYPE, Properties: { ...identity, Mode: 'b' } } } }
    );
  }

  function guardRows(): DeploymentEvent[] {
    return events.filter((e) => e.eventType === 'RESOURCE_GUARD_INDETERMINATE');
  }

  /** The destroy runner's payload, aimed at the OLD resource the delete ran on. */
  function expectOneGuardRow(): void {
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(guardRows()).toEqual([
      {
        eventType: 'RESOURCE_GUARD_INDETERMINATE',
        stackName: 'MyStack',
        operation: 'DELETE',
        logicalId: 'MyResource',
        resourceType: TYPE,
        provisionedBy: 'cc-api',
        physicalId: OLD_PID,
        guard: GUARD_ID,
        reason: GUARD_REASON,
      },
    ]);
  }

  /** The guard row precedes the row's own outcome event and leaves it intact. */
  function expectBeside(outcome: string, operation: 'DELETE' | 'UPDATE'): void {
    const types = events.map((e) => e.eventType);
    const guardAt = types.indexOf('RESOURCE_GUARD_INDETERMINATE');
    const outcomeAt = types.indexOf(outcome as DeploymentEvent['eventType']);
    expect(outcomeAt).toBeGreaterThan(guardAt);
    expect(events[outcomeAt]?.operation).toBe(operation);
  }

  it('template-DELETE branch: one row beside RESOURCE_SUCCEEDED', async () => {
    await invokeTemplateDelete(makeEngine());
    expectOneGuardRow();
    expectBeside('RESOURCE_SUCCEEDED', 'DELETE');
  });

  it('template-DELETE branch: a guard on a SKIPPED delete still persists, beside RESOURCE_SKIPPED', async () => {
    (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(GUARDED_SKIP);
    await invokeTemplateDelete(makeEngine());
    expectOneGuardRow();
    expectBeside('RESOURCE_SKIPPED', 'DELETE');
  });

  it('UPDATE-not-supported fallback: operation DELETE on the guard, UPDATE on the row', async () => {
    (provider.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ResourceUpdateNotSupportedError(TYPE, 'MyResource', 'no update API')
    );
    await invokeReplacingUpdate(makeEngine({ replace: true }), { requiresReplacement: false });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expectOneGuardRow();
    expectBeside('RESOURCE_SUCCEEDED', 'UPDATE');
  });

  it('UPDATE-not-supported fallback: a skip that FAILS the row keeps the guard row', async () => {
    // The skip throws right after the guarded delete returned, so a guard
    // carried on a return value alone would be lost here.
    (provider.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ResourceUpdateNotSupportedError(TYPE, 'MyResource', 'no update API')
    );
    (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(GUARDED_SKIP);
    await expect(
      invokeReplacingUpdate(makeEngine({ replace: true }), { requiresReplacement: false })
    ).rejects.toThrow();
    expectOneGuardRow();
    expectBeside('RESOURCE_FAILED', 'UPDATE');
  });

  it('create-first cleanup of the replaced resource', async () => {
    await invokeReplacingUpdate(makeEngine(), { requiresReplacement: true });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expectOneGuardRow();
    expectBeside('RESOURCE_SUCCEEDED', 'UPDATE');
  });

  it('--recreate-via-cc-api destroy-then-create', async () => {
    await invokeReplacingUpdate(makeEngine({ recreateViaCcApi: true }), {
      requiresReplacement: false,
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expectOneGuardRow();
    expectBeside('RESOURCE_SUCCEEDED', 'UPDATE');
  });

  it('--recreate-via-cc-api: a skip that FAILS the row keeps the guard row', async () => {
    (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(GUARDED_SKIP);
    await expect(
      invokeReplacingUpdate(makeEngine({ recreateViaCcApi: true }), { requiresReplacement: false })
    ).rejects.toThrow();
    expect(provider.create).not.toHaveBeenCalled();
    expectOneGuardRow();
    expectBeside('RESOURCE_FAILED', 'UPDATE');
  });

  it('--replace delete-first fallback (reached via a name collision)', async () => {
    createFailures = [
      ccAlreadyExistsError(
        `CREATE failed for MyResource: Resource of type '${TYPE}' with identifier ` +
          `'${OLD_PID}' already exists.`
      ),
    ];
    await invokeReplacingUpdate(makeEngine({ replace: true }), { requiresReplacement: true });
    expect(provider.create).toHaveBeenCalledTimes(2);
    expectOneGuardRow();
    expectBeside('RESOURCE_SUCCEEDED', 'UPDATE');
  });

  it('--replace delete-first fallback: a skip that FAILS the row keeps the guard row', async () => {
    (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(GUARDED_SKIP);
    createFailures = [
      ccAlreadyExistsError(
        `CREATE failed for MyResource: Resource of type '${TYPE}' with identifier ` +
          `'${OLD_PID}' already exists.`
      ),
    ];
    await expect(
      invokeReplacingUpdate(makeEngine({ replace: true }), { requiresReplacement: true })
    ).rejects.toThrow();
    expectOneGuardRow();
    expectBeside('RESOURCE_FAILED', 'UPDATE');
  });

  it('--replace delete-first fallback reached through a name-idempotent create', async () => {
    // The create-first hands the OLD resource back (an SQS-style idempotent
    // Create API), so `--replace` deletes the old one first and re-creates.
    (provider.create as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ physicalId: OLD_PID, attributes: {} })
      .mockResolvedValueOnce({ physicalId: 'new-pid', attributes: {} });
    await invokeReplacingUpdate(makeEngine({ replace: true }), { requiresReplacement: true });
    expect(provider.create).toHaveBeenCalledTimes(2);
    expectOneGuardRow();
    expectBeside('RESOURCE_SUCCEEDED', 'UPDATE');
  });

  it('concurrent siblings that BOTH report a guard: each row carries only its own', async () => {
    // The two deletes are held until BOTH have started, so the two
    // resources' provisioning genuinely overlaps (`p-limit` is mocked serial,
    // which a sequential test cannot see past). A sink shared across rows
    // hands one row's guard to the other.
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (provider.delete as ReturnType<typeof vi.fn>).mockImplementation(
      async (_logicalId: string, physicalId: string) => {
        started++;
        if (started === 2) release();
        await gate;
        return {
          outcome: 'deleted',
          indeterminateGuards: [{ guard: GUARD_ID, reason: `probe on ${physicalId}` }],
        };
      }
    );
    const engine = makeEngine();
    const run = (logicalId: string, physicalId: string): Promise<unknown> =>
      provisionOf(engine)(
        logicalId,
        { logicalId, changeType: 'DELETE', resourceType: TYPE, currentProperties: {} },
        {
          [logicalId]: {
            physicalId,
            resourceType: TYPE,
            properties: {},
            attributes: {},
            dependencies: [],
            provisionedBy: 'sdk',
          },
        },
        'MyStack',
        { Resources: {} }
      );

    await Promise.all([run('A', 'pid-a'), run('B', 'pid-b')]);

    expect(started).toBe(2);
    expect(guardRows().map((e) => `${e.logicalId}:${e.physicalId}`).sort()).toEqual([
      'A:pid-a',
      'B:pid-b',
    ]);
  });

  describe('controls', () => {
    it('a delete reporting no guard records no guard row (template DELETE)', async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      await invokeTemplateDelete(makeEngine());
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.eventType)).toContain('RESOURCE_SUCCEEDED');
      expect(guardRows()).toEqual([]);
    });

    it('a delete reporting no guard records no guard row (replacement)', async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: 'deleted' });
      await invokeReplacingUpdate(makeEngine(), { requiresReplacement: true });
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(guardRows()).toEqual([]);
    });

    it('a guard reported by one row does not leak onto the next row', async () => {
      const engine = makeEngine();
      await invokeTemplateDelete(engine);
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      await invokeTemplateDelete(engine);
      expect(guardRows()).toHaveLength(1);
    });
  });

  it("keeps the guard row's physical id FIELD exact for a resource named from a secret (go-to-k/cdkd#3869)", async () => {
    // The derived-name registry masks the printed reason, never this field:
    // after the delete no record holds the id, and a cleanup needs it.
    const engine = makeEngine();
    const secretNamed = { FieldName: '{{resolve:secretsmanager:s:SecretString:field::}}' };
    await provisionOf(engine)(
      'MyResource',
      {
        logicalId: 'MyResource',
        changeType: 'DELETE',
        resourceType: TYPE,
        currentProperties: secretNamed,
      },
      stateWith(secretNamed),
      'MyStack',
      { Resources: {} }
    );
    const [row] = guardRows();
    expect(row?.physicalId).toBe(OLD_PID);
    // Non-vacuity: the registry did judge the record named from a secret.
    expect(row?.reason).not.toContain(OLD_PID);
  });

  it("masks the guard row's physical id and reason with the resource's own secrets", async () => {
    // A resolved secret can name a resource; the event store outlives destroy.
    const engine = makeEngine();
    (
      engine as unknown as { perResourceSecrets: Map<string, Map<string, string>> }
    ).perResourceSecrets.set('MyResource', new Map([['Query', '***']]));
    await invokeTemplateDelete(engine);
    const [row] = guardRows();
    expect(row?.physicalId).toBe('api1|***|field');
    expect(row?.reason).toBe('probe on api1|***|field could not be answered: AccessDenied');
  });
});
