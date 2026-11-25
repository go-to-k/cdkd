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
import { InterruptedWaitError, isInterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';
import { ResourceTimeoutError } from '../../../src/utils/error-handler/base-errors.js';

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
/** Removed, and DEPENDENCY depends on it: kept transitively. */
const DEEP = 'Deep';
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

  function buildEngine(failure: Error, beforeFailing?: (engine: DeployEngine) => void) {
    let engineRef: DeployEngine | undefined;
    const provider = {
      create: vi.fn(),
      update: vi.fn().mockImplementation((logicalId: string, physicalId: string, _t: string, properties: Record<string, unknown>) => {
        updateCalls.push({ logicalId, properties });
        return Promise.resolve({ physicalId, wasReplaced: false });
      }),
      delete: vi.fn().mockImplementation((logicalId: string) => {
        deleteCalls.push(logicalId);
        if (logicalId !== FAILING) return Promise.resolve(undefined);
        beforeFailing?.(engineRef!);
        return Promise.reject(failure);
      }),
    };

    const currentState: StackState = {
      version: 8,
      stackName: STACK,
      region: 'us-east-1',
      resources: {
        [UPDATED]: record(UPDATED),
        [FAILING]: record(FAILING, [DEPENDENCY]),
        [DEPENDENCY]: record(DEPENDENCY, [DEEP]),
        [DEEP]: record(DEEP),
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
      [DEEP, deleteChange(DEEP)],
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
    engineRef = new DeployEngine(
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
    return engineRef;
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

    expect(result.deleteSkipped).toBe(3);
    // The control: an unrelated removal is still deleted.
    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(1);
    // No rollback: the update was sent once, never reverted to `v: 1`, and no
    // journal segment was written.
    expect(updateCalls).toEqual([{ logicalId: UPDATED, properties: { v: 2 } }]);
    expect(appendSegment).not.toHaveBeenCalled();
    expect(lastSavedResources()).toEqual([DEEP, DEPENDENCY, FAILING, UPDATED]);
    const warnings = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes(`${FAILING} (${TYPE}) was removed from the template, but its delete failed`))).toBe(true);
  });

  it('does not delete what the failed resource depends on, transitively', async () => {
    const engine = buildEngine(new Error('The bucket you tried to delete is not empty'));
    const recordEvent = vi.spyOn(engine, 'recordEvent');

    await engine.deploy(STACK, template);

    expect(deleteCalls.sort()).toEqual([FAILING, UNRELATED]);
    const lines = vi.mocked(getLogger().info).mock.calls.map((c) => String(c[0]));
    // Both name FAILING as the blocker: DEEP inherits it through DEPENDENCY.
    for (const kept of [DEPENDENCY, DEEP]) {
      expect(
        lines.some((l) => l.includes(kept) && l.includes(`not deleted (${FAILING} depends on it and its delete failed)`)),
        kept
      ).toBe(true);
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'RESOURCE_SKIPPED',
          operation: 'DELETE',
          logicalId: kept,
          physicalId: `phys-${kept}`,
          reason: `${FAILING} depends on it and its delete failed`,
        })
      );
    }
  });

  it('still fails the deploy when the delete was interrupted', async () => {
    const engine = buildEngine(new InterruptedWaitError('Delete of Failing'));

    const error = await engine.deploy(STACK, template).then(() => undefined, (e: unknown) => e);
    expect(isInterruptedWaitError(error)).toBe(true);

    // An interrupted deploy journals the failed DELETE for `cdkd rollback`.
    expect(appendSegment).toHaveBeenCalledOnce();
    const segment = appendSegment.mock.calls[0]![2] as { failedOperations?: Array<{ logicalId: string; changeType: string }> };
    expect(segment.failedOperations).toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalId: FAILING, changeType: 'DELETE' })])
    );
  });

  it('still fails the deploy when the user interrupted it before the delete failed', async () => {
    const engine = buildEngine(new Error('The bucket you tried to delete is not empty'), (e) => {
      e.interrupted = true;
    });

    await expect(engine.deploy(STACK, template)).rejects.toThrow(`Failed to delete resource ${FAILING}`);

    expect(appendSegment).toHaveBeenCalledOnce();
    const segment = appendSegment.mock.calls[0]![2] as { failedOperations?: Array<{ logicalId: string; changeType: string }> };
    expect(segment.failedOperations).toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalId: FAILING, changeType: 'DELETE' })])
    );
  });

  it("still fails the deploy when its --resource-timeout fired (the delete keeps running)", async () => {
    const engine = buildEngine(new ResourceTimeoutError(FAILING, TYPE, "us-east-1", 1_000, "DELETE", 1_000));

    await expect(engine.deploy(STACK, template)).rejects.toThrow(`Failed to delete resource ${FAILING}`);

    expect(deleteCalls).not.toContain(DEPENDENCY);
    const warnings = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("its cdkd state record was KEPT"))).toBe(false);
  });
});
