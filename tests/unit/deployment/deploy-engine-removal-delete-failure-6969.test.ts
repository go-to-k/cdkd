/**
 * go-to-k/cdkd#6969: a resource removed from the template whose delete AWS
 * refuses (a bucket that still holds objects) no longer fails the deploy and
 * rolls back every other change. CloudFormation deletes it in its cleanup
 * phase, reports `DELETE_FAILED` and ends `UPDATE_COMPLETE`; cdkd keeps the
 * record (the next deploy retries the delete), counts it under
 * `deleteSkipped` (exit 2), and keeps whatever the failed resource depends on
 * instead of deleting it from under it. An interrupt still fails the deploy.
 *
 * Driven through `DeployEngine.deploy()`: the change is in the DELETE
 * executor's catch, which `provisionResource` alone does not reach.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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
  IntrinsicFunctionResolver: vi.fn(() => ({
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

const TYPE = 'AWS::SQS::QueuePolicy';
const STACK = 'removal-delete-failure-test';

/** Updated by the deploy; a rollback would send its previous properties back. */
const UPDATED = 'Updated';
/** Removed from the template; AWS refuses its delete. */
const FAILING = 'Failing';
/** Removed too, and FAILING depends on it, so it must not be deleted. */
const DEPENDENCY = 'Dependency';
/** Removed and unrelated to FAILING: still deleted. */
const UNRELATED = 'Unrelated';

describe('DeployEngine.deploy() — a removed resource whose delete fails (#6969)', () => {
  let saveState: ReturnType<typeof vi.fn>;
  let appendSegment: ReturnType<typeof vi.fn>;
  let deleteCalls: string[];
  let updateCalls: Array<{ logicalId: string; properties: Record<string, unknown> }>;

  beforeEach(() => {
    deleteCalls = [];
    updateCalls = [];
  });

  function record(logicalId: string, dependencies: string[] = []): ResourceState {
    return {
      physicalId: `phys-${logicalId}`,
      resourceType: TYPE,
      properties: { v: 1 },
      attributes: {},
      dependencies,
    };
  }

  function buildEngine(failure: Error) {
    const provider = {
      create: vi.fn(),
      update: vi.fn().mockImplementation((logicalId: string, physicalId: string, _t: string, properties: Record<string, unknown>) => {
        updateCalls.push({ logicalId, properties });
        return Promise.resolve({ physicalId, wasReplaced: false });
      }),
      delete: vi.fn().mockImplementation((logicalId: string) => {
        deleteCalls.push(logicalId);
        return logicalId === FAILING ? Promise.reject(failure) : Promise.resolve(undefined);
      }),
    };

    const currentState: StackState = {
      version: 8,
      stackName: STACK,
      region: 'us-east-1',
      resources: {
        [UPDATED]: record(UPDATED),
        [FAILING]: record(FAILING, [DEPENDENCY]),
        [DEPENDENCY]: record(DEPENDENCY),
        [UNRELATED]: record(UNRELATED),
      },
      outputs: {},
      lastModified: Date.now(),
    };

    const deleteChange = (logicalId: string): ResourceChange =>
      ({ logicalId, changeType: 'DELETE', resourceType: TYPE, propertyChanges: [] }) as unknown as ResourceChange;
    const changes = new Map<string, ResourceChange>([
      [
        UPDATED,
        {
          logicalId: UPDATED,
          changeType: 'UPDATE',
          resourceType: TYPE,
          currentProperties: { v: 1 },
          desiredProperties: { v: 2 },
          propertyChanges: [{ path: 'v', oldValue: 1, newValue: 2, requiresReplacement: false }],
        } as unknown as ResourceChange,
      ],
      [FAILING, deleteChange(FAILING)],
      [DEPENDENCY, deleteChange(DEPENDENCY)],
      [UNRELATED, deleteChange(UNRELATED)],
    ]);

    saveState = vi.fn().mockResolvedValue('etag-1');
    appendSegment = vi.fn().mockResolvedValue(undefined);
    const mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'e0' }),
      saveState,
      appendRollbackJournalSegment: appendSegment,
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
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
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([[UPDATED]]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 4, noRollback: false },
      'us-east-1'
    );
  }

  const template: CloudFormationTemplate = {
    Resources: { [UPDATED]: { Type: TYPE, Properties: { v: 2 } } },
  };

  /** The resources of the last state the deploy saved. */
  function lastSavedResources(): string[] {
    const calls = saveState.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return Object.keys((calls.at(-1)![2] as StackState).resources).sort();
  }

  it('completes the deploy, keeps the failed record and counts it as not deleted', async () => {
    const engine = buildEngine(new Error('The bucket you tried to delete is not empty'));

    const result = await engine.deploy(STACK, template);

    expect(result.deleteSkipped).toBe(2);
    // The control: an unrelated removal is still deleted.
    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(1);
    // No rollback: the update was sent once, never reverted to `v: 1`, and no
    // journal segment was written.
    expect(updateCalls).toEqual([{ logicalId: UPDATED, properties: { v: 2 } }]);
    expect(appendSegment).not.toHaveBeenCalled();
    expect(lastSavedResources()).toEqual([DEPENDENCY, FAILING, UPDATED]);
    const warnings = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes(`${FAILING} (${TYPE}) was removed from the template, but its delete failed`))).toBe(true);
  });

  it('does not delete what the failed resource depends on', async () => {
    const engine = buildEngine(new Error('The bucket you tried to delete is not empty'));

    await engine.deploy(STACK, template);

    expect(deleteCalls.sort()).toEqual([FAILING, UNRELATED]);
    const lines = vi.mocked(getLogger().info).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(DEPENDENCY) && l.includes(`${FAILING} depends on it and its delete failed`))).toBe(true);
  });

  it('still fails the deploy when the delete was interrupted', async () => {
    const engine = buildEngine(new InterruptedWaitError('Delete of Failing'));

    await expect(engine.deploy(STACK, template)).rejects.toThrow();

    // An interrupted deploy journals its operations for `cdkd rollback`.
    expect(appendSegment).toHaveBeenCalledOnce();
    expect(deleteCalls).not.toContain(DEPENDENCY);
  });
});
