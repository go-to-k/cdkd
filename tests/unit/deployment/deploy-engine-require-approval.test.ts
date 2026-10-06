/**
 * `cdkd deploy --require-approval` in the engine (go-to-k/cdkd#4429, AWS CDK
 * CLI parity with aws/aws-cdk-cli#2021): the approval is asked on the diff the
 * deploy executes, after the dry-run return and before any provider call, and
 * a decline changes nothing. Harness: `deploy-engine-type-change-nested-guard.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { DeploymentApprovalRequest } from '../../../src/deployment/deploy-engine/options.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK_NAME = 'MyStack';

function record(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'pid',
    resourceType: 'AWS::SQS::Queue',
    properties: { Marker: 'old' },
    attributes: {},
    dependencies: [],
    ...extra,
  } as ResourceState;
}

/** An in-place UPDATE of `Kept`, plus whatever `extra` rows the case adds. */
function arrange(
  mocks: { getState: ReturnType<typeof vi.fn>; calculateDiff: ReturnType<typeof vi.fn> },
  resources: Record<string, ResourceState>,
  changes: ResourceChange[]
): CloudFormationTemplate {
  const state: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: 'us-east-1',
    stackName: STACK_NAME,
    resources,
    outputs: {},
    lastModified: 0,
  };
  mocks.getState.mockResolvedValue({ state, etag: 'etag-old' });
  mocks.calculateDiff.mockResolvedValue(new Map(changes.map((c) => [c.logicalId, c])));
  return {
    Resources: {
      Kept: {
        Type: 'AWS::SQS::Queue',
        Properties: { Marker: 'new' },
        Metadata: { 'aws:cdk:path': 'MyStack/Kept/Resource' },
      },
    },
  } as CloudFormationTemplate;
}

const inPlaceUpdate: ResourceChange = {
  logicalId: 'Kept',
  changeType: 'UPDATE',
  resourceType: 'AWS::SQS::Queue',
  currentProperties: { Marker: 'old' },
  desiredProperties: { Marker: 'new' },
  propertyChanges: [{ path: 'Marker', oldValue: 'old', newValue: 'new', requiresReplacement: false }],
};

const deletion: ResourceChange = {
  logicalId: 'Gone',
  changeType: 'DELETE',
  resourceType: 'AWS::SQS::Queue',
  currentProperties: { Marker: 'old' },
};

describe('DeployEngine --require-approval', () => {
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
  };
  let approve: ReturnType<typeof vi.fn<(r: DeploymentApprovalRequest) => Promise<boolean>>>;
  let releaseLock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'pid' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    approve = vi.fn();
    releaseLock = vi.fn().mockResolvedValue(undefined);
  });

  function makeEngine(options: Record<string, unknown>) {
    return new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock,
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false, approveDeployment: approve, ...options } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const mocks = () => ({
    getState: mockStateBackend.getState,
    calculateDiff: mockDiffCalculator.calculateDiff,
  });

  it('destructive: does not ask for an in-place update', async () => {
    const template = arrange(mocks(), { Kept: record() }, [inPlaceUpdate]);
    await makeEngine({ requireApproval: 'destructive' }).deploy(STACK_NAME, template);
    expect(approve).not.toHaveBeenCalled();
  });

  it('destructive: asks for a deletion with the classified changes, and deploys on yes', async () => {
    approve.mockResolvedValue(true);
    const template = arrange(
      mocks(),
      { Kept: record(), Gone: record({ physicalId: 'gone', deletionPolicy: 'Retain' }) },
      [inPlaceUpdate, deletion]
    );
    await makeEngine({ requireApproval: 'destructive' }).deploy(STACK_NAME, template);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toEqual({
      stackName: STACK_NAME,
      level: 'destructive',
      counts: { create: 0, update: 1, delete: 1 },
      destructiveChanges: [
        {
          stackName: STACK_NAME,
          logicalId: 'Gone',
          resourceType: 'AWS::SQS::Queue',
          impact: 'WILL_ORPHAN',
        },
      ],
    });
    expect(mockStateBackend.saveState).toHaveBeenCalled();
  });

  it('a decline refuses before any provider call or state write', async () => {
    approve.mockResolvedValue(false);
    const template = arrange(mocks(), { Kept: record(), Gone: record({ physicalId: 'gone' }) }, [
      inPlaceUpdate,
      deletion,
    ]);
    const err = await makeEngine({ requireApproval: 'destructive' })
      .deploy(STACK_NAME, template)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toMatchObject({ code: 'DEPLOY_NOT_APPROVED' });
    expect((err as Error).message).toBe(
      'Deployment of stack MyStack was not approved (--require-approval=destructive). Nothing was changed.'
    );
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(provider.update).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    // The stack lock is released on the way out.
    expect(releaseLock).toHaveBeenCalledWith(STACK_NAME, 'us-east-1');
  });

  it('any-change: asks for an in-place update too', async () => {
    approve.mockResolvedValue(true);
    const template = arrange(mocks(), { Kept: record() }, [inPlaceUpdate]);
    await makeEngine({ requireApproval: 'any-change' }).deploy(STACK_NAME, template);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toMatchObject({
      level: 'any-change',
      destructiveChanges: [],
    });
  });

  it('destructive: asks for an in-place update of a --recreate-via-* target', async () => {
    approve.mockResolvedValue(true);
    const template = arrange(mocks(), { Kept: record() }, [inPlaceUpdate]);
    await makeEngine({
      requireApproval: 'destructive',
      recreateTargets: { stackName: STACK_NAME, viaCcApi: new Set(['Kept']), viaSdkProvider: new Set() },
    })
      .deploy(STACK_NAME, template)
      .catch(() => undefined);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0].destructiveChanges).toMatchObject([
      { logicalId: 'Kept', impact: 'WILL_REPLACE' },
    ]);
  });

  describe('an Outputs-only change (no resource change)', () => {
    function arrangeOutputs(): CloudFormationTemplate {
      const template = arrange(mocks(), { Kept: record() }, []);
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: 'us-east-1',
          stackName: STACK_NAME,
          resources: { Kept: record() },
          outputs: { Url: 'old' },
          lastModified: 0,
        },
        etag: 'etag-old',
      });
      mockDiffCalculator.hasChanges.mockReturnValue(false);
      return { ...template, Outputs: { Url: { Value: 'new' } } } as CloudFormationTemplate;
    }

    it('any-change: asks before the outputs are written, and a decline writes nothing', async () => {
      approve.mockResolvedValue(false);
      const err = await makeEngine({ requireApproval: 'any-change' })
        .deploy(STACK_NAME, arrangeOutputs())
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve.mock.calls[0]![0]).toEqual({
        stackName: STACK_NAME,
        level: 'any-change',
        counts: { create: 0, update: 0, delete: 0 },
        destructiveChanges: [],
        outputsOnly: true,
      });
      expect(err).toMatchObject({ code: 'DEPLOY_NOT_APPROVED' });
      // A retried decline would ask again.
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(mockStateBackend.saveState).not.toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalled();
    });

    function loadOutputs(outputs: Record<string, string>, exportNames?: string[]): void {
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: 'us-east-1',
          stackName: STACK_NAME,
          resources: { Kept: record() },
          outputs,
          ...(exportNames && { exportNames }),
          lastModified: 0,
        },
        etag: 'etag-old',
      });
    }

    it('any-change: does not ask for the export-list backfill of a record written before v9', async () => {
      const template = arrangeOutputs();
      // Unchanged output, no `exportNames` on the record: the no-change path
      // backfills the list (a save) though the user changed nothing.
      loadOutputs({ Url: 'new' });
      await makeEngine({ requireApproval: 'any-change' }).deploy(STACK_NAME, template);
      expect(approve).not.toHaveBeenCalled();
      expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    });

    it('any-change: asks when a v9 record\'s export set changes with equal values', async () => {
      approve.mockResolvedValue(true);
      const template = arrangeOutputs();
      // The bag already holds the alias key, so the values are equal and only
      // the recorded export set (`[]`) differs.
      loadOutputs({ Url: 'new', 'shared-url': 'new' }, []);
      await makeEngine({ requireApproval: 'any-change' }).deploy(STACK_NAME, {
        ...template,
        Outputs: { Url: { Value: 'new', Export: { Name: 'shared-url' } } },
      } as CloudFormationTemplate);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve.mock.calls[0]![0]).toMatchObject({ outputsOnly: true });
    });

    it('never asks under --dry-run, which writes nothing', async () => {
      await makeEngine({ requireApproval: 'any-change', dryRun: true }).deploy(
        STACK_NAME,
        arrangeOutputs()
      );
      expect(approve).not.toHaveBeenCalled();
      expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    });

    it('any-change: writes the outputs once approved', async () => {
      approve.mockResolvedValue(true);
      await makeEngine({ requireApproval: 'any-change' }).deploy(STACK_NAME, arrangeOutputs());
      expect(approve).toHaveBeenCalledTimes(1);
      const saved = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
      expect(saved.outputs).toEqual({ Url: 'new' });
    });

    it('destructive: does not ask, since no resource is touched', async () => {
      await makeEngine({ requireApproval: 'destructive' }).deploy(STACK_NAME, arrangeOutputs());
      expect(approve).not.toHaveBeenCalled();
      expect(mockStateBackend.saveState).toHaveBeenCalled();
    });
  });

  it('never asks under --dry-run', async () => {
    const template = arrange(mocks(), { Kept: record(), Gone: record({ physicalId: 'gone' }) }, [
      deletion,
    ]);
    await makeEngine({ requireApproval: 'destructive', dryRun: true }).deploy(
      STACK_NAME,
      template
    );
    expect(approve).not.toHaveBeenCalled();
  });

  it('never asks without a level, or when nothing changed', async () => {
    const template = arrange(mocks(), { Kept: record(), Gone: record({ physicalId: 'gone' }) }, [
      deletion,
    ]);
    await makeEngine({}).deploy(STACK_NAME, template);
    expect(approve).not.toHaveBeenCalled();

    mockDiffCalculator.hasChanges.mockReturnValue(false);
    arrange(mocks(), { Kept: record() }, []);
    await makeEngine({ requireApproval: 'any-change' }).deploy(STACK_NAME, template);
    expect(approve).not.toHaveBeenCalled();
  });
});
