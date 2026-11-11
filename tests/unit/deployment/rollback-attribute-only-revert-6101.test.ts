/**
 * go-to-k/cdkd#6101: a rollback reverts a metadata-only update, one where only
 * `DeletionPolicy` / `UpdateReplacePolicy` changed. The forward
 * (`applyAttributeOnlyUpdate`) rewrites the record's policies and calls no
 * provider, so its completed op carries properties equal to `previousState`'s.
 * The classifier used to read that as already reverted, so the failed deploy's
 * NEW policies stayed in state while the CLI said the pre-deploy state was
 * restored. Pinned on every consumer of the classifier: the deploy engine's
 * automatic rollback, the journal replay `cdkd rollback` runs, and its plan
 * (label and preview state).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  classifyRollbackOp,
  planRollback,
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { actionLabel } from '../../../src/cli/commands/rollback/render.js';
import { applyPlanToPreview } from '../../../src/cli/commands/rollback/preview.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

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
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', async (importOriginal) => ({
  CloudControlOperationFailedError: (
    await importOriginal<typeof import('../../../src/provisioning/cloud-control-provider.js')>()
  ).CloudControlOperationFailedError,
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const STACK = 'policy-flip';
const PARAM_PROPS = { Type: 'String', Value: 'v1' };
const BUCKET_PROPS = { BucketName: 'policy-flip-bucket' };

function record(over: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::SSM::Parameter',
    properties: {},
    attributes: {},
    dependencies: [],
    ...over,
  };
}

/** The v1 records: the parameter `Retain`, the bucket `Delete`. */
function v1Resources(): Record<string, ResourceState> {
  return {
    Param: record({
      physicalId: 'param-1',
      properties: { ...PARAM_PROPS },
      deletionPolicy: 'Retain',
      updateReplacePolicy: 'Retain',
    }),
    Bucket: record({
      physicalId: 'policy-flip-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: { ...BUCKET_PROPS },
      deletionPolicy: 'Delete',
    }),
  };
}

describe('the automatic rollback reverts a metadata-only update (go-to-k/cdkd#6101)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let saveState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildEngine(): DeployEngine {
    provider = {
      create: vi.fn().mockRejectedValue(new Error('create failed: Queue')),
      update: vi.fn().mockResolvedValue({ physicalId: 'x', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      resourceIdentity: vi.fn().mockResolvedValue('token'),
    };
    const currentState: StackState = {
      version: 8,
      stackName: STACK,
      region: 'us-east-1',
      resources: v1Resources(),
      outputs: {},
      lastModified: Date.now(),
    };
    saveState = vi.fn().mockResolvedValue('etag-1');
    const changes = new Map<string, ResourceChange>([
      [
        'Param',
        {
          logicalId: 'Param',
          changeType: 'UPDATE',
          resourceType: 'AWS::SSM::Parameter',
          currentProperties: { ...PARAM_PROPS },
          desiredProperties: { ...PARAM_PROPS },
          propertyChanges: [],
          attributeChanges: [
            { attribute: 'DeletionPolicy', oldValue: 'Retain', newValue: 'Delete' },
            { attribute: 'UpdateReplacePolicy', oldValue: 'Retain', newValue: 'Delete' },
          ],
        } as unknown as ResourceChange,
      ],
      [
        'Bucket',
        {
          logicalId: 'Bucket',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          currentProperties: { ...BUCKET_PROPS },
          desiredProperties: { ...BUCKET_PROPS },
          propertyChanges: [],
          attributeChanges: [{ attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' }],
        } as unknown as ResourceChange,
      ],
      [
        'Queue',
        {
          logicalId: 'Queue',
          changeType: 'CREATE',
          resourceType: 'AWS::SQS::Queue',
          desiredProperties: {},
          propertyChanges: [],
        } as unknown as ResourceChange,
      ],
    ]);
    const deps: Record<string, string[]> = { Param: [], Bucket: [], Queue: ['Param', 'Bucket'] };
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'e0' }),
        saveState,
        stackInstanceIdForFirstWrite: vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000000'),
        listStacks: vi.fn().mockResolvedValue([]),
        appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
        rewriteRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([Object.keys(deps)]),
        getDirectDependencies: vi.fn((_dag: unknown, id: string) => deps[id] ?? []),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(changes),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi
          .fn()
          .mockImplementation((all: Map<string, ResourceChange>, type: string) =>
            [...all.values()].filter((c) => c.changeType === type)
          ),
      } as never,
      registry as never,
      { concurrency: 4, noRollback: false },
      'us-east-1'
    );
  }

  /** v2: both policies flipped, plus a queue whose create fails. */
  const v2: CloudFormationTemplate = {
    Resources: {
      Param: {
        Type: 'AWS::SSM::Parameter',
        Properties: { ...PARAM_PROPS },
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      },
      Bucket: { Type: 'AWS::S3::Bucket', Properties: { ...BUCKET_PROPS }, DeletionPolicy: 'Retain' },
      Queue: { Type: 'AWS::SQS::Queue', Properties: {}, DependsOn: ['Param', 'Bucket'] },
    },
  } as unknown as CloudFormationTemplate;

  it('saves the v1 policies after the failed deploy, calling no provider for them', async () => {
    await expect(buildEngine().deploy(STACK, v2)).rejects.toThrow();
    // The forward did run the metadata-only arm (no update call), and the
    // rollback reverted it the same way.
    expect(provider.update).not.toHaveBeenCalled();
    expect(provider.create).toHaveBeenCalled();
    const last = saveState.mock.calls.at(-1)![2] as StackState;
    expect(last.resources['Param']!.deletionPolicy).toBe('Retain');
    expect(last.resources['Param']!.updateReplacePolicy).toBe('Retain');
    expect(last.resources['Bucket']!.deletionPolicy).toBe('Delete');
    expect(last.resources['Param']!.properties).toEqual(PARAM_PROPS);
    expect(last.resources['Param']!.physicalId).toBe('param-1');
    expect(last.resources['Queue']).toBeUndefined();
  });
});

/** The op the forward's metadata-only arm journals for the parameter. */
function policyOnlyOp(): CompletedOperation {
  return {
    logicalId: 'Param',
    changeType: 'UPDATE',
    resourceType: 'AWS::SSM::Parameter',
    provisionedBy: 'sdk',
    physicalId: 'param-1',
    properties: { ...PARAM_PROPS },
    previousState: v1Resources()['Param']!,
    oldResourceRetained: false,
    oldDeletedBeforeCreate: false,
  };
}

/** State as the failed deploy left it: v2 policies, v1 properties. */
function v2State(): Record<string, ResourceState> {
  return {
    Param: record({
      physicalId: 'param-1',
      properties: { ...PARAM_PROPS },
      deletionPolicy: 'Delete',
      attributes: { Marker: 'kept' },
    }),
  };
}

describe('the journal replay and its plan (go-to-k/cdkd#6101)', () => {
  it('classifies the op as a policy restore, and as done once restored', () => {
    expect(classifyRollbackOp(policyOnlyOp(), v2State(), new Set())).toBe('restore-policies');
    expect(classifyRollbackOp(policyOnlyOp(), v1Resources(), new Set())).toBe(
      'skip-already-done'
    );
    // Negative control: a property difference still reverts through the provider.
    const changed = v2State();
    changed['Param']!.properties = { ...PARAM_PROPS, Value: 'v2' };
    expect(classifyRollbackOp(policyOnlyOp(), changed, new Set())).toBe('revert');
    // Only UpdateReplacePolicy moved: still a restore.
    const urpOnly = v1Resources();
    urpOnly['Param']!.updateReplacePolicy = undefined;
    expect(classifyRollbackOp(policyOnlyOp(), urpOnly, new Set())).toBe('restore-policies');
  });

  it('restores the policies with no provider call, keeps the rest, and a re-run skips', async () => {
    const update = vi.fn();
    const events: string[] = [];
    const afterOp = vi.fn();
    const ctx = {
      region: 'us-east-1',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
      providerRegistry: { getProviderFor: () => ({ provider: { update } }) },
      recordEvent: (e: { eventType: string }) => {
        if (e.eventType.startsWith('ROLLBACK_RESOURCE_')) events.push(e.eventType);
      },
    } as unknown as RollbackExecutorContext;
    const state = v2State();
    const result = await replayRollback([policyOnlyOp()], state, STACK, ctx, { afterOp });
    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    expect(afterOp).toHaveBeenCalledWith('Param');
    expect(events).toEqual(['ROLLBACK_RESOURCE_SUCCEEDED']);
    expect(state['Param']!.deletionPolicy).toBe('Retain');
    expect(state['Param']!.updateReplacePolicy).toBe('Retain');
    // The rest of the record is the deploy's, untouched.
    expect(state['Param']!.attributes).toEqual({ Marker: 'kept' });
    expect(state['Param']!.properties).toEqual(PARAM_PROPS);

    // Idempotent: the second replay finds it done and records nothing.
    events.length = 0;
    await replayRollback([policyOnlyOp()], state, STACK, ctx, { afterOp });
    expect(events).toEqual([]);
    expect(state['Param']!.deletionPolicy).toBe('Retain');
  });

  it('drops a policy the previous record did not declare, rather than keeping the deploy one', async () => {
    const op = policyOnlyOp();
    op.previousState = record({ physicalId: 'param-1', properties: { ...PARAM_PROPS } });
    const state = v2State();
    state['Param']!.updateReplacePolicy = 'Delete';
    const ctx = {
      region: 'us-east-1',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
      providerRegistry: { getProviderFor: () => ({ provider: { update: vi.fn() } }) },
    } as unknown as RollbackExecutorContext;
    expect(classifyRollbackOp(op, state, new Set())).toBe('restore-policies');
    // The plan preview drops them the same way.
    const preview = { ...state };
    applyPlanToPreview(planRollback([op], state), preview, false);
    expect(Object.hasOwn(preview['Param']!, 'deletionPolicy')).toBe(false);
    expect(Object.hasOwn(preview['Param']!, 'updateReplacePolicy')).toBe(false);
    await replayRollback([op], state, STACK, ctx);
    expect(Object.hasOwn(state['Param']!, 'deletionPolicy')).toBe(false);
    expect(Object.hasOwn(state['Param']!, 'updateReplacePolicy')).toBe(false);
    expect(state['Param']!.attributes).toEqual({ Marker: 'kept' });
    expect(classifyRollbackOp(op, state, new Set())).toBe('skip-already-done');
  });

  it('labels the plan row and moves the preview state the same way', () => {
    const state = v2State();
    const plan = planRollback([policyOnlyOp()], state);
    expect(plan.map((p) => p.action)).toEqual(['restore-policies']);
    expect(actionLabel(plan[0]!, false)).toBe(
      '  - revert   Param (AWS::SSM::Parameter) [DeletionPolicy / UpdateReplacePolicy only, in state; no AWS call]'
    );
    const preview = { ...state };
    applyPlanToPreview(plan, preview, false);
    expect(preview['Param']!.deletionPolicy).toBe('Retain');
    expect(preview['Param']!.updateReplacePolicy).toBe('Retain');
    expect(preview['Param']!.attributes).toEqual({ Marker: 'kept' });
  });
});
