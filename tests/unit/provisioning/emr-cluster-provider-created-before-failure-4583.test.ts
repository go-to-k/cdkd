/**
 * go-to-k/cdkd#4583: a cluster RunJobFlow returned, left running because the
 * failed create's own terminate FAILED, is named on the thrown error for the
 * failed-CREATE journal -- and only then.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const child = { ...l, child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ ...l, child: () => child }) };
});

import { EMRClusterProvider } from '../../../src/provisioning/providers/emr-cluster-provider.js';
import { TerminateJobFlowsCommand } from '@aws-sdk/client-emr';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::EMR::Cluster';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';
const PROPS = {
  Name: 'my-emr-cluster',
  ReleaseLabel: 'emr-7.2.0',
  ServiceRole: 'EMR_DefaultRole',
  JobFlowRole: 'EMR_EC2_DefaultRole',
  Instances: {
    Ec2SubnetId: 'subnet-abc',
    MasterInstanceGroup: { InstanceCount: 1, InstanceType: 'm5.xlarge', Name: 'Master' },
  },
};

const clusterOf = (state: string) => ({
  Cluster: {
    Id: CLUSTER_ID,
    Name: 'my-emr-cluster',
    Status: { State: state, StateChangeReason: { Message: `state is ${state}` } },
  },
});

/** Route by command class name; an Error value rejects. */
function routeSend(routes: Record<string, unknown>): void {
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    if (!(name in routes)) return Promise.reject(new Error(`Unexpected command: ${name}`));
    const value = routes[name];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
}

function terminateCalls(): unknown[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof TerminateJobFlowsCommand);
}

// A distinct logical id per case: RunJobFlow's orphan latch is module-global.
async function failedCreate(logicalId: string): Promise<unknown> {
  return new EMRClusterProvider({ pollIntervalMs: 0, maxWaitMs: 5000 })
    .create(logicalId, TYPE, { ...PROPS })
    .then(
      () => {
        throw new Error('create unexpectedly succeeded');
      },
      (e: unknown) => e
    );
}

describe('EMRClusterProvider.create — created-before-failure mark (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the cluster id when it went terminal and the terminate FAILS (pass-through arm)', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: clusterOf('TERMINATED_WITH_ERRORS'),
      SetTerminationProtectionCommand: {},
      TerminateJobFlowsCommand: new Error('AccessDenied'),
    });

    const error = await failedCreate('ClusterA');

    expect(terminateCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'ClusterA', TYPE)).toBe(CLUSTER_ID);
  });

  it('marks the cluster id when the protection flip fails before the terminate (pass-through arm)', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: clusterOf('TERMINATED_WITH_ERRORS'),
      SetTerminationProtectionCommand: new Error('AccessDenied'),
    });

    const error = await failedCreate('ClusterB');

    expect(terminateCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'ClusterB', TYPE)).toBe(CLUSTER_ID);
  });

  it('marks the cluster id when a raw failure follows RunJobFlow and the terminate FAILS (wrap arm)', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: new Error('AccessDeniedException: no describe'),
      SetTerminationProtectionCommand: {},
      TerminateJobFlowsCommand: new Error('AccessDenied'),
    });

    const error = await failedCreate('ClusterC');

    expect((error as Error).message).toMatch(/^Failed to create EMR Cluster ClusterC/);
    expect(terminateCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'ClusterC', TYPE)).toBe(CLUSTER_ID);
  });

  it('does not mark when the terminate succeeded (pass-through arm)', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: clusterOf('TERMINATED_WITH_ERRORS'),
      SetTerminationProtectionCommand: {},
      TerminateJobFlowsCommand: {},
    });

    const error = await failedCreate('ClusterD');

    expect(terminateCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'ClusterD', TYPE)).toBeUndefined();
  });

  it('does not mark when the terminate succeeded (wrap arm)', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: new Error('AccessDeniedException: no describe'),
      SetTerminationProtectionCommand: {},
      TerminateJobFlowsCommand: {},
    });

    const error = await failedCreate('ClusterE');

    expect((error as Error).message).toMatch(/^Failed to create EMR Cluster ClusterE/);
    expect(terminateCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'ClusterE', TYPE)).toBeUndefined();
  });

  it("does not mark RunJobFlow's own failure", async () => {
    routeSend({ RunJobFlowCommand: new Error('ValidationException: bad release') });

    const error = await failedCreate('ClusterF');

    expect(terminateCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'ClusterF', TYPE)).toBeUndefined();
  });

  it('does not mark a RunJobFlow answer with no JobFlowId', async () => {
    routeSend({ RunJobFlowCommand: {} });

    const error = await failedCreate('ClusterG');

    expect((error as Error).message).toMatch(/returned no JobFlowId/);
    expect(createdBeforeFailure(error, 'ClusterG', TYPE)).toBeUndefined();
  });
});
