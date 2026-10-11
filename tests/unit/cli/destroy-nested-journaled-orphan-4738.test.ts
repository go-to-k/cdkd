import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#4738, end to end through the REAL `NestedStackProvider` and the
// REAL runner at both levels: a nested child whose only skip is a journaled
// orphan (a failed CREATE's SQS queue, which no creation identity proves)
// deletes its own state, so the parent drops its row and its own state in the
// same run, while the orphan still makes the run exit 2.

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
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

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';

const REGION = 'us-east-1';
const CHILD = 'TestStack~Child';

function res(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-r',
    resourceType: 'AWS::SSM::Parameter',
    properties: {},
    attributes: {},
    dependencies: [],
    ...extra,
  };
}

function stateOf(stackName: string, resources: Record<string, ResourceState>): StackState {
  return { version: 8, stackName, region: REGION, resources, outputs: {}, lastModified: 1 };
}

/** The child's journal: a failed CREATE's queue, which nothing proves is its own. */
const childJournal = {
  journalVersion: 1,
  stackName: CHILD,
  region: REGION,
  segments: [
    {
      timestamp: 1,
      reason: 'no-rollback-failure',
      initialDeploy: false,
      skipPrefix: false,
      operations: [],
      failedOperations: [
        {
          logicalId: 'Q',
          changeType: 'CREATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/orders',
          provisionedBy: 'sdk',
          physicalIdRecoveredFromError: true,
          attemptedProperties: { QueueName: 'orders' },
        },
      ],
    },
  ],
};

describe('cdkd destroy of a parent whose nested child left only a journaled orphan (go-to-k/cdkd#4738)', () => {
  const mockDeleteState = vi.fn();
  const mockSaveState = vi.fn();
  const mockLeafDelete = vi.fn();
  let childStateKept: boolean;

  function makeRun() {
    const stateBackend = {
      getState: vi.fn(async (name: string) =>
        name === CHILD && childStateKept
          ? { state: stateOf(CHILD, { R: res() }), etag: '"e"' }
          : null
      ),
      saveState: mockSaveState,
      deleteState: mockDeleteState,
      loadRollbackJournal: vi.fn(async (name: string) => (name === CHILD ? childJournal : null)),
      dropRollbackJournalFailedOperations: vi.fn(async () => 0),
      listStacks: vi.fn(async () => []),
    } as unknown as S3StateBackend;
    const lockManager = {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
    } as unknown as LockManager;
    const nested = new NestedStackProvider();
    const providerRegistry = {
      getProviderFor: ({ resourceType }: { resourceType: string }) => ({
        provider:
          resourceType === 'AWS::CloudFormation::Stack' ? nested : { delete: mockLeafDelete },
        provisionedBy: 'sdk',
      }),
    } as unknown as ProviderRegistry;
    const nestedCtx = {
      stateBackend,
      lockManager,
      providerRegistry,
      parentStackName: 'TestStack',
      parentRegion: REGION,
      accountId: '123456789012',
      awsClients: {} as AwsClients,
      stateBucket: 'test-bucket',
    } as NestedStackProviderContext;
    const parentState = stateOf('TestStack', {
      Child: res({
        resourceType: 'AWS::CloudFormation::Stack',
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/TestStack/Child',
      }),
    });
    return withNestedStackContext(nestedCtx, () =>
      runDestroyForStack('TestStack', parentState, {
        stateBackend,
        lockManager,
        providerRegistry,
        baseAwsClients: {} as AwsClients,
        baseRegion: REGION,
        stateBucket: 'test-bucket',
        skipConfirmation: true,
        stackDestroy: true,
      })
    );
  }

  beforeEach(() => {
    childStateKept = true;
    mockDeleteState.mockReset().mockImplementation(async (name: string) => {
      if (name === CHILD) childStateKept = false;
    });
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockLeafDelete.mockReset().mockResolvedValue(undefined);
    infoSpy.mockReset();
    warnSpy.mockReset();
  });

  it('deletes the child state AND the parent state in one run, and still counts the orphan', async () => {
    const result = await makeRun();

    // The child kept the queue (warned) and deleted its own state.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Skipping failed CREATE of Q'
    );
    expect(mockDeleteState).toHaveBeenCalledWith(CHILD, REGION);
    // Before the fix the parent kept its `Child` row and its own state here.
    expect(mockDeleteState).toHaveBeenCalledWith('TestStack', REGION);
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    // Exit 2: the orphan is a skip, carried up as one that keeps no record.
    expect(result.skippedCount).toBe(1);
    expect(result.journaledOrphanSkips).toBe(1);
    expect(result.stateDeleted).toBe(true);
    expect(mockLeafDelete).toHaveBeenCalledTimes(1);
  });
});
