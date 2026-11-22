/**
 * go-to-k/cdkd#6808: a rollback's delete of a role or group the run created
 * strips the run's own holders, those a record or the replayed journal's
 * failed ops name: the replay binds the segment's failed ops into the
 * stack-records view the provider reads them from (`stack-own-holders.ts`).
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { stackOwnHolders } from '../../../src/provisioning/stack-own-holders.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/** A provider whose delete records the group holders the bound view names. */
function ctxSeeing(seen: Array<ReturnType<typeof stackOwnHolders>>): RollbackExecutorContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  };
  const del = vi.fn(async (_logicalId: string, physicalId: string, resourceType: string) => {
    seen.push(stackOwnHolders(resourceType, physicalId));
  });
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider: { delete: del }, provisionedBy: 'sdk' }),
    },
  } as unknown as RollbackExecutorContext;
}

/** A membership a failed `UserToGroupAddition` added: no physical id, never deleted. */
const failedAddition: FailedOperation = {
  logicalId: 'Addition',
  changeType: 'CREATE',
  resourceType: 'AWS::IAM::UserToGroupAddition',
  provisionedBy: 'sdk',
  attemptedProperties: { GroupName: 'run-group', Users: ['u1'] },
};

const groupRecord: ResourceState = {
  resourceType: 'AWS::IAM::Group',
  physicalId: 'run-group',
  properties: {},
  attributes: {},
  dependencies: [],
};

describe("a rollback delete sees the replayed journal's failed writes (#6808)", () => {
  it("replayRollback: the segment's failed ops reach the completed CREATE's delete", async () => {
    const seen: Array<ReturnType<typeof stackOwnHolders>> = [];
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Group',
        changeType: 'CREATE',
        resourceType: 'AWS::IAM::Group',
        physicalId: 'run-group',
      },
    ];
    await replayRollback(ops, { Group: { ...groupRecord } }, 'S', ctxSeeing(seen), {
      failedOperations: [failedAddition],
    });
    expect(seen).toEqual([[{ name: 'u1' }]]);
  });

  it('control: without the failed ops, the membership is no holder of the run', async () => {
    const seen: Array<ReturnType<typeof stackOwnHolders>> = [];
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Group',
        changeType: 'CREATE',
        resourceType: 'AWS::IAM::Group',
        physicalId: 'run-group',
      },
    ];
    await replayRollback(ops, { Group: { ...groupRecord } }, 'S', ctxSeeing(seen));
    expect(seen).toEqual([[]]);
  });

  it('replayFailedOperations: the failed ops it replays reach a failed CREATE orphan delete', async () => {
    const seen: Array<ReturnType<typeof stackOwnHolders>> = [];
    const groupOrphan: FailedOperation = {
      logicalId: 'Group',
      changeType: 'CREATE',
      resourceType: 'AWS::IAM::Group',
      provisionedBy: 'sdk',
      physicalId: 'run-group',
      physicalIdRecoveredFromError: true,
      attemptedProperties: { GroupName: 'run-group' },
    };
    await replayFailedOperations([failedAddition, groupOrphan], {}, 'S', ctxSeeing(seen));
    expect(seen).toEqual([[{ name: 'u1' }]]);
  });
});
