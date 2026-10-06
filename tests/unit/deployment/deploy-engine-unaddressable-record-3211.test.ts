/**
 * Issue [go-to-k/cdkd#3211](https://github.com/go-to-k/cdkd/issues/3211), the
 * deploy half: a `resources` record whose `physicalId` is absent, empty,
 * whitespace-only or not a string must not reach a provider that would
 * address AWS by it.
 *
 * - DELETE (the resource left the template): skipped, record KEPT, no
 *   provider call — the `cdkd destroy` verdict, and the deploy's own #1762
 *   skip shape. The provider below answers `ResourceNotFoundException`, which
 *   the engine reads as ALREADY DELETED: without the guard the record of a
 *   live resource is dropped.
 * - UPDATE: refused for that resource before anything is sent.
 * - A nested-stack row is exempt from both: its provider finds the child by
 *   name and never reads the id.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

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

const TYPE = 'AWS::SSM::Parameter';
const NESTED = 'AWS::CloudFormation::Stack';

const UNADDRESSABLE: Array<[string, unknown]> = [
  ['an empty', ''],
  ['a whitespace-only', '   '],
  ['an absent', undefined],
  ['a non-string', 42],
];

type Counts = {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  deleteSkipped: number;
  updatePartial: number;
};

const freshCounts = (): Counts => ({
  created: 0,
  updated: 0,
  deleted: 0,
  skipped: 0,
  deleteSkipped: 0,
  updatePartial: 0,
});

/** The whole `.cause` chain: the engine wraps a resource failure. */
function causeChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** The innermost `CdkdError` on the `.cause` chain (the engine wraps it). */
function cdkdErrorIn(error: unknown): CdkdError | undefined {
  let found: CdkdError | undefined;
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof CdkdError) found = current;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return found;
}

describe('DeployEngine — a record with no usable physicalId (go-to-k/cdkd#3211)', () => {
  let provider: ResourceProvider;
  let events: DeploymentEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'p', attributes: {} }),
      // What a real provider answers for an id naming no resource, and what
      // the engine's catch reads as ALREADY DELETED.
      delete: vi.fn().mockRejectedValue(new Error('ResourceNotFoundException: not found')),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      {
        eventRecorder: {
          runId: 'run-1',
          record: (event: Omit<DeploymentEvent, 'timestamp'>) =>
            events.push(event as DeploymentEvent),
        },
      },
      'us-east-1'
    );
  }

  function provision(
    engine: InstanceType<typeof DeployEngine>,
    change: ResourceChange,
    stateResources: Record<string, unknown>,
    template: CloudFormationTemplate,
    counts: Counts
  ): Promise<unknown> {
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
          counts?: Counts
        ) => Promise<unknown>;
      }
    ).provisionResource.call(
      engine,
      'Res',
      change,
      stateResources,
      'MyStack',
      template,
      undefined,
      undefined,
      counts
    );
  }

  function record(
    physicalId: unknown,
    resourceType = TYPE,
    provisionedBy: 'sdk' | 'cc-api' = 'sdk'
  ) {
    return {
      Res: {
        physicalId,
        resourceType,
        properties: { Value: 'a' },
        attributes: {},
        dependencies: [],
        provisionedBy,
      },
    };
  }

  describe('DELETE (removed from the template)', () => {
    const deleteChange = (resourceType = TYPE): ResourceChange => ({
      logicalId: 'Res',
      changeType: 'DELETE',
      resourceType,
      currentProperties: { Value: 'a' },
    });

    for (const [label, physicalId] of UNADDRESSABLE) {
      it(`skips ${label} physicalId without a provider call and keeps the record`, async () => {
        const state = record(physicalId);
        const counts = freshCounts();
        const result = await provision(
          makeEngine(),
          deleteChange(),
          state,
          { Resources: {} },
          counts
        );

        expect(provider.delete).not.toHaveBeenCalled();
        expect(Object.keys(state)).toEqual(['Res']);
        expect(result).toEqual({ deleteSkipped: 'state record has no physical id' });
        expect(counts.deleteSkipped).toBe(1);
        expect(counts.deleted).toBe(0);
        const skip = events.find((e) => e.eventType === 'RESOURCE_SKIPPED');
        expect(skip?.reason).toBe('state record has no physical id');
        expect(events.map((e) => e.eventType)).not.toContain('RESOURCE_SUCCEEDED');
        const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain("has no non-empty string 'physicalId'");
        expect(warned).toContain('cdkd state orphan MyStack');
        expect(warned).toContain('--resource Res');
      });
    }

    it('control: a usable physicalId reaches the provider (and NotFound drops the record)', async () => {
      const state = record('phys-1');
      const counts = freshCounts();
      await provision(makeEngine(), deleteChange(), state, { Resources: {} }, counts);
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(Object.keys(state)).toEqual([]);
      expect(counts.deleted).toBe(1);
    });

    it('exempts a nested-stack row, whose delete never reads the id', async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const state = record('', NESTED);
      const counts = freshCounts();
      await provision(makeEngine(), deleteChange(NESTED), state, { Resources: {} }, counts);
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(counts.deleteSkipped).toBe(0);
    });

    it('does not exempt a nested-stack row recorded on Cloud Control, which deletes by id', async () => {
      const state = record('', NESTED, 'cc-api');
      const counts = freshCounts();
      await provision(makeEngine(), deleteChange(NESTED), state, { Resources: {} }, counts);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(Object.keys(state)).toEqual(['Res']);
      expect(counts.deleteSkipped).toBe(1);
    });

    it("keys the exemption on the RECORD's type, not the change's", async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      // A nested-stack record under a change naming another type: exempt.
      const nested = record('', NESTED);
      await provision(makeEngine(), deleteChange(TYPE), nested, { Resources: {} }, freshCounts());
      expect(provider.delete).toHaveBeenCalledTimes(1);
      // The reverse: a plain record under a change naming a nested stack is
      // skipped.
      const plain = record('');
      const counts = freshCounts();
      await provision(makeEngine(), deleteChange(NESTED), plain, { Resources: {} }, counts);
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(counts.deleteSkipped).toBe(1);
    });

    it('prepares no final snapshot for a Snapshot-policy record with no usable id', async () => {
      const state = record('', 'AWS::RDS::DBInstance');
      (state.Res as Record<string, unknown>)['deletionPolicy'] = 'Snapshot';
      const engine = makeEngine();
      const prepare = vi.spyOn(
        engine as unknown as { prepareFinalSnapshotForDelete: () => Promise<unknown> },
        'prepareFinalSnapshotForDelete'
      );
      const counts = freshCounts();
      await provision(
        engine,
        deleteChange('AWS::RDS::DBInstance'),
        state,
        { Resources: {} },
        counts
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(counts.deleteSkipped).toBe(1);
    });

    it('control: a Snapshot-policy record with a usable id does prepare one', async () => {
      (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const state = record('db-1', 'AWS::RDS::DBInstance');
      (state.Res as Record<string, unknown>)['deletionPolicy'] = 'Snapshot';
      const engine = makeEngine();
      const prepare = vi
        .spyOn(
          engine as unknown as { prepareFinalSnapshotForDelete: () => Promise<unknown> },
          'prepareFinalSnapshotForDelete'
        )
        .mockResolvedValue(undefined);
      await provision(
        engine,
        deleteChange('AWS::RDS::DBInstance'),
        state,
        { Resources: {} },
        freshCounts()
      );
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it('the RESOURCE_SKIPPED event carries no blank physicalId', async () => {
      await provision(makeEngine(), deleteChange(), record('   '), { Resources: {} }, freshCounts());
      const skip = events.find((e) => e.eventType === 'RESOURCE_SKIPPED');
      expect(skip).toBeDefined();
      expect(skip).not.toHaveProperty('physicalId');
    });

    it('a retained resource keeps the retention branch (no address needed)', async () => {
      const state = record('');
      (state.Res as Record<string, unknown>)['deletionPolicy'] = 'Retain';
      const counts = freshCounts();
      await provision(makeEngine(), deleteChange(), state, { Resources: {} }, counts);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(Object.keys(state)).toEqual([]);
      expect(counts.deleteSkipped).toBe(0);
    });
  });

  describe('UPDATE', () => {
    const updateChange = (desired: string, resourceType = TYPE): ResourceChange => ({
      logicalId: 'Res',
      changeType: 'UPDATE',
      resourceType,
      currentProperties: { Value: 'a' },
      desiredProperties: { Value: desired },
      propertyChanges:
        desired === 'a'
          ? []
          : [{ path: 'Value', oldValue: 'a', newValue: desired, requiresReplacement: false }],
    });
    const templateWith = (value: string, type = TYPE): CloudFormationTemplate => ({
      Resources: { Res: { Type: type, Properties: { Value: value } } },
    });

    for (const [label, physicalId] of UNADDRESSABLE) {
      it(`refuses ${label} physicalId before anything is sent`, async () => {
        const error = await provision(
          makeEngine(),
          updateChange('b'),
          record(physicalId),
          templateWith('b'),
          freshCounts()
        ).then(
          () => undefined,
          (e: unknown) => e
        );
        const failure = causeChain(error);

        // The verdict's three marks: the malformed-record code, no retry (the
        // record cannot change between attempts), and refused before applying
        // (so nothing is journaled as attempted).
        expect(cdkdErrorIn(error)?.code).toBe(STATE_RESOURCES_MALFORMED);
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(isRefusedBeforeApplying(error, 'Res')).toBe(true);
        expect(failure).toContain("with no non-empty string 'physicalId'");
        expect(failure).toContain('did not try to update it');
        expect(failure).toContain('cdkd state show MyStack');
        expect(provider.update).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        expect(provider.delete).not.toHaveBeenCalled();
      });
    }

    it('control: a usable physicalId is updated', async () => {
      await provision(
        makeEngine(),
        updateChange('b'),
        record('phys-1'),
        templateWith('b'),
        freshCounts()
      );
      expect(provider.update).toHaveBeenCalledTimes(1);
    });

    it('does not refuse an UPDATE that resolves to no change: nothing addresses the record', async () => {
      const counts = freshCounts();
      await provision(makeEngine(), updateChange('a'), record(''), templateWith('a'), counts);
      expect(counts.skipped).toBe(1);
      expect(provider.update).not.toHaveBeenCalled();
    });

    it("keys the exemption on the RECORD's type: a change TO a nested stack is refused", async () => {
      const failure = await provision(
        makeEngine(),
        updateChange('b', NESTED),
        record(''),
        templateWith('b', NESTED),
        freshCounts()
      ).then(
        () => 'resolved',
        (e: unknown) => causeChain(e)
      );
      expect(failure).toContain('did not try to update it');
      expect(provider.update).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('does not exempt a nested-stack row recorded on Cloud Control', async () => {
      const failure = await provision(
        makeEngine(),
        updateChange('b', NESTED),
        record('', NESTED, 'cc-api'),
        templateWith('b', NESTED),
        freshCounts()
      ).then(
        () => 'resolved',
        (e: unknown) => causeChain(e)
      );
      expect(failure).toContain('did not try to update it');
      expect(provider.update).not.toHaveBeenCalled();
    });

    it("exempts a nested-stack row (keyed on the RECORD's type)", async () => {
      await provision(
        makeEngine(),
        updateChange('b', NESTED),
        record('', NESTED),
        templateWith('b', NESTED),
        freshCounts()
      ).catch(() => undefined);
      expect(provider.update).toHaveBeenCalledTimes(1);
    });
  });
});
