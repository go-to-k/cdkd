/**
 * Issues #2053 / #1952 — the engine's DELETE path must never read a USER ABORT
 * as "already deleted".
 *
 * `deploy-engine.ts` treats a failed delete as success when the error MESSAGE
 * contains `not found` / `NoSuchEntity` / `NotFoundException`. An interrupt's
 * message embeds a name the USER chose, so a logical id carrying one of those
 * needles made an interrupted delete drop a LIVE resource's state row and
 * report the deploy a success — the same defect as its `destroy-runner.ts`
 * twin, which `destroy-runner-interrupt-not-found.test.ts` covers.
 *
 * The typed `isInterruptedWaitError` check therefore runs AHEAD of the
 * substring match. The substring match cannot be made safe on its own: any
 * needle can appear in a user-chosen name.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const TYPE = 'AWS::AppSync::Resolver';

const STACK = 'delete-interrupt-not-found-test';

/**
 * A logical id carrying the classifier's own needle.
 *
 * `HandleNotFoundException` is an ordinary construct name, and the interrupt
 * message interpolates it verbatim — which is the whole defect: the engine's
 * already-deleted arm SUBSTRING-matches `NotFoundException` against the error
 * message, so a user's own naming decided whether a live resource was dropped
 * from state.
 */
const NEEDLE = 'HandleNotFoundException';

type JournalMocks = {
  appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  deleteRollbackJournal: ReturnType<typeof vi.fn>;
  loadRollbackJournal: ReturnType<typeof vi.fn>;
  popRollbackJournalSegment: ReturnType<typeof vi.fn>;
};


describe('DeployEngine DELETE — an interrupt is never "already deleted" (#2053 / #1952)', () => {
  let saveState: ReturnType<typeof vi.fn>;
  let deleteError: Error | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    deleteError = undefined;
  });

  function buildEngine() {
    const provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'phys-x', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-x', wasReplaced: false }),
      delete: vi.fn().mockImplementation(() =>
        deleteError ? Promise.reject(deleteError) : Promise.resolve(undefined)
      ),
    };

    const currentState: StackState = {
      version: 8,
      stackName: STACK,
      region: 'us-east-1',
      resources: {
        [NEEDLE]: {
          physicalId: `phys-${NEEDLE}`,
          resourceType: TYPE,
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: Date.now(),
    };

    saveState = vi.fn().mockResolvedValue('etag-1');

    const changes = new Map<string, ResourceChange>([
      [
        NEEDLE,
        {
          logicalId: NEEDLE,
          changeType: 'DELETE',
          resourceType: TYPE,
          propertyChanges: [],
        } as unknown as ResourceChange,
      ],
    ]);

    const mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'e0' }),
      saveState,
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([[]]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((all: Map<string, ResourceChange>, type: string) =>
          [...all.values()].filter((c) => c.changeType === type)
        ),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 4, noRollback: true, roleArn: 'arn:aws:iam::1:role/r' },
      'us-east-1'
    );
  }

  const template: CloudFormationTemplate = { Resources: {} };

  /** What survived into the persisted state after the deploy. */
  function persistedResources(): Record<string, unknown> {
    const lastSave = saveState.mock.calls.at(-1);
    return ((lastSave?.[2] as StackState | undefined)?.resources ?? {}) as Record<string, unknown>;
  }

  it('keeps the state row when the interrupt message carries the needle', async () => {
    const interrupt = new InterruptedWaitError(`DynamoDB Table ${NEEDLE} delete`);
    // Non-vacuity: the fixture really does contain the needle the arm matches.
    expect(interrupt.message).toContain('NotFoundException');
    deleteError = interrupt;

    await expect(buildEngine().deploy(STACK, template)).rejects.toThrow();

    // Pre-fix the substring arm swallowed this as "already deleted", removed
    // the record, and reported success — for a table that is still live.
    expect(persistedResources()[NEEDLE]).toMatchObject({ physicalId: `phys-${NEEDLE}` });
  });

  it('...and when the interrupt is WRAPPED, which is the normal shape', async () => {
    deleteError = new ProvisioningError(
      `Failed to delete ${NEEDLE}: interrupted`,
      TYPE,
      NEEDLE,
      `phys-${NEEDLE}`,
      new InterruptedWaitError(`DynamoDB Table ${NEEDLE} delete`)
    );

    await expect(buildEngine().deploy(STACK, template)).rejects.toThrow();

    expect(persistedResources()[NEEDLE]).toMatchObject({ physicalId: `phys-${NEEDLE}` });
  });

  it('INVERTED CONTROL — a genuine not-found on the SAME name is still already-deleted', async () => {
    // The guard is on the ERROR TYPE, not on the name. Without this the two
    // cases above pass with the whole substring arm deleted.
    deleteError = new Error('Resource NotFoundException: already gone');

    const result = await buildEngine().deploy(STACK, template);

    expect(result.deleted).toBe(1);
    expect(persistedResources()[NEEDLE]).toBeUndefined();
  });
});
