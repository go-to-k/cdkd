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

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { EMRClusterProvider } from '../../../../src/provisioning/providers/emr-cluster-provider.js';
import {
  RunJobFlowCommand,
  TerminateJobFlowsCommand,
  DescribeClusterCommand,
  SetTerminationProtectionCommand,
  SetVisibleToAllUsersCommand,
  ModifyClusterCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  PutManagedScalingPolicyCommand,
  RemoveManagedScalingPolicyCommand,
  PutAutoTerminationPolicyCommand,
  RemoveAutoTerminationPolicyCommand,
  InvalidRequestException,
} from '@aws-sdk/client-emr';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::EMR::Cluster';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';
const DNS = 'ec2-1-2-3-4.compute-1.amazonaws.com';

const BASE_PROPS = {
  Name: 'my-emr-cluster',
  ReleaseLabel: 'emr-7.2.0',
  ServiceRole: 'EMR_DefaultRole',
  JobFlowRole: 'EMR_EC2_DefaultRole',
  Applications: [{ Name: 'Spark' }],
  Instances: {
    Ec2SubnetId: 'subnet-abc',
    KeepJobFlowAliveWhenNoSteps: true,
    MasterInstanceGroup: {
      InstanceCount: 1,
      InstanceType: 'm5.xlarge',
      Market: 'ON_DEMAND',
      Name: 'Master',
    },
  },
  Tags: [{ Key: 'env', Value: 'test' }],
};

const clusterOf = (state: string, overrides: Record<string, unknown> = {}) => ({
  Cluster: {
    Id: CLUSTER_ID,
    Name: 'my-emr-cluster',
    Status: { State: state, StateChangeReason: { Message: `state is ${state}` } },
    MasterPublicDnsName: DNS,
    ...overrides,
  },
});

function callsOf(commandClass: abstract new (...args: never[]) => object): Array<{
  input: Record<string, unknown>;
}> {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((c) => c instanceof commandClass) as Array<{ input: Record<string, unknown> }>;
}

/**
 * Route mockSend by command class name. Array values are a QUEUE — each call
 * consumes the next entry, the last entry repeats. `Error` values reject.
 */
function routeSend(routes: Record<string, unknown>): void {
  const queues = new Map<string, unknown[]>();
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    if (!(name in routes)) {
      return Promise.reject(new Error(`Unexpected command: ${name}`));
    }
    let value = routes[name];
    if (Array.isArray(value)) {
      if (!queues.has(name)) queues.set(name, [...(value as unknown[])]);
      const queue = queues.get(name)!;
      value = queue.length > 1 ? queue.shift() : queue[0];
    }
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  });
}

function invalidRequest(): InvalidRequestException {
  return new InvalidRequestException({
    message: `Cluster id '${CLUSTER_ID}' is not valid.`,
    $metadata: {},
  });
}

function newProvider(overrides: { maxWaitMs?: number } = {}): EMRClusterProvider {
  return new EMRClusterProvider({ pollIntervalMs: 0, maxWaitMs: overrides.maxWaitMs ?? 5000 });
}

describe('EMRClusterProvider create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs RunJobFlow, polls STARTING → BOOTSTRAPPING → WAITING, returns attributes', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: [
        clusterOf('STARTING'),
        clusterOf('BOOTSTRAPPING'),
        clusterOf('WAITING'),
      ],
    });

    const result = await newProvider().create('MyCluster', RESOURCE_TYPE, { ...BASE_PROPS });

    expect(result.physicalId).toBe(CLUSTER_ID);
    expect(result.attributes).toEqual({ Id: CLUSTER_ID, MasterPublicDNS: DNS });
  });

  it('accepts RUNNING as a create-ready state', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: [clusterOf('RUNNING')],
    });
    const result = await newProvider().create('MyCluster', RESOURCE_TYPE, { ...BASE_PROPS });
    expect(result.physicalId).toBe(CLUSTER_ID);
  });

  it('maps role-keyed CFn instance groups to a flat InstanceGroups array with InstanceRole', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: [clusterOf('WAITING')],
    });

    await newProvider().create('MyCluster', RESOURCE_TYPE, {
      ...BASE_PROPS,
      Instances: {
        Ec2SubnetId: 'subnet-abc',
        MasterInstanceGroup: { InstanceCount: 1, InstanceType: 'm5.xlarge' },
        CoreInstanceGroup: { InstanceCount: 2, InstanceType: 'm5.xlarge' },
        TaskInstanceGroups: [{ InstanceCount: 3, InstanceType: 'm5.2xlarge' }],
      },
    });

    const input = callsOf(RunJobFlowCommand)[0]!.input;
    const groups = (input['Instances'] as { InstanceGroups: Array<Record<string, unknown>> })
      .InstanceGroups;
    expect(groups.map((g) => [g['InstanceRole'], g['InstanceCount']])).toEqual([
      ['MASTER', 1],
      ['CORE', 2],
      ['TASK', 3],
    ]);
    expect((input['Instances'] as Record<string, unknown>)['Ec2SubnetId']).toBe('subnet-abc');
  });

  it('maps role-keyed CFn instance fleets to a flat InstanceFleets array with InstanceFleetType', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: [clusterOf('WAITING')],
    });

    await newProvider().create('MyCluster', RESOURCE_TYPE, {
      ...BASE_PROPS,
      Instances: {
        Ec2SubnetIds: ['subnet-abc'],
        MasterInstanceFleet: {
          TargetOnDemandCapacity: 1,
          InstanceTypeConfigs: [{ InstanceType: 'm5.xlarge' }],
        },
        CoreInstanceFleet: { TargetSpotCapacity: 2 },
      },
    });

    const input = callsOf(RunJobFlowCommand)[0]!.input;
    const fleets = (input['Instances'] as { InstanceFleets: Array<Record<string, unknown>> })
      .InstanceFleets;
    expect(fleets.map((f) => f['InstanceFleetType'])).toEqual(['MASTER', 'CORE']);
    expect(fleets[0]!['TargetOnDemandCapacity']).toBe(1);
    expect(fleets[1]!['TargetSpotCapacity']).toBe(2);
  });

  it('errors and best-effort terminates when the cluster reaches a terminal state during create', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: [clusterOf('STARTING'), clusterOf('TERMINATED_WITH_ERRORS')],
      TerminateJobFlowsCommand: {},
    });

    await expect(newProvider().create('MyCluster', RESOURCE_TYPE, { ...BASE_PROPS })).rejects.toThrow(
      ProvisioningError
    );
    // Rolled back to avoid billing.
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(1);
    expect(callsOf(TerminateJobFlowsCommand)[0]!.input['JobFlowIds']).toEqual([CLUSTER_ID]);
  });

  it('errors when RunJobFlow returns no JobFlowId (and does not attempt a rollback terminate)', async () => {
    routeSend({ RunJobFlowCommand: {} });
    await expect(newProvider().create('MyCluster', RESOURCE_TYPE, { ...BASE_PROPS })).rejects.toThrow(
      /returned no JobFlowId/
    );
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(0);
  });

  it('rejects an unsupported resource type', async () => {
    await expect(newProvider().create('X', 'AWS::S3::Bucket', {})).rejects.toThrow(
      /Unsupported resource type/
    );
  });

  it('getMinResourceTimeoutMs reports the polling ceiling', () => {
    expect(newProvider({ maxWaitMs: 12345 }).getMinResourceTimeoutMs()).toBe(12345);
  });
});

describe('EMRClusterProvider update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when nothing mutable changed', async () => {
    const result = await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      { ...BASE_PROPS }
    );
    expect(result).toEqual({ physicalId: CLUSTER_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('flips SetTerminationProtection when only Instances.TerminationProtected changed', async () => {
    routeSend({
      SetTerminationProtectionCommand: {},
      DescribeClusterCommand: clusterOf('WAITING'),
    });
    const prev = { ...BASE_PROPS, Instances: { ...BASE_PROPS.Instances, TerminationProtected: false } };
    const next = { ...BASE_PROPS, Instances: { ...BASE_PROPS.Instances, TerminationProtected: true } };

    const result = await newProvider().update('MyCluster', CLUSTER_ID, RESOURCE_TYPE, next, prev);

    expect(result.wasReplaced).toBe(false);
    expect(callsOf(SetTerminationProtectionCommand)[0]!.input).toEqual({
      JobFlowIds: [CLUSTER_ID],
      TerminationProtected: true,
    });
  });

  it('sends SetVisibleToAllUsers on a VisibleToAllUsers change', async () => {
    routeSend({ SetVisibleToAllUsersCommand: {}, DescribeClusterCommand: clusterOf('WAITING') });
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, VisibleToAllUsers: false },
      { ...BASE_PROPS, VisibleToAllUsers: true }
    );
    expect(callsOf(SetVisibleToAllUsersCommand)[0]!.input).toEqual({
      JobFlowIds: [CLUSTER_ID],
      VisibleToAllUsers: false,
    });
  });

  it('sends ModifyCluster on a StepConcurrencyLevel change', async () => {
    routeSend({ ModifyClusterCommand: {}, DescribeClusterCommand: clusterOf('WAITING') });
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, StepConcurrencyLevel: 5 },
      { ...BASE_PROPS, StepConcurrencyLevel: 1 }
    );
    expect(callsOf(ModifyClusterCommand)[0]!.input).toEqual({
      ClusterId: CLUSTER_ID,
      StepConcurrencyLevel: 5,
    });
  });

  it('puts a managed-scaling policy when added, removes it when cleared', async () => {
    routeSend({
      PutManagedScalingPolicyCommand: {},
      RemoveManagedScalingPolicyCommand: {},
      DescribeClusterCommand: clusterOf('WAITING'),
    });
    const policy = { ComputeLimits: { UnitType: 'Instances', MinimumCapacityUnits: 1, MaximumCapacityUnits: 4 } };

    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, ManagedScalingPolicy: policy },
      { ...BASE_PROPS }
    );
    expect(callsOf(PutManagedScalingPolicyCommand)[0]!.input['ManagedScalingPolicy']).toMatchObject({
      ComputeLimits: { MinimumCapacityUnits: 1, MaximumCapacityUnits: 4 },
    });

    vi.clearAllMocks();
    routeSend({
      RemoveManagedScalingPolicyCommand: {},
      DescribeClusterCommand: clusterOf('WAITING'),
    });
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      { ...BASE_PROPS, ManagedScalingPolicy: policy }
    );
    expect(callsOf(RemoveManagedScalingPolicyCommand)).toHaveLength(1);
  });

  it('puts an auto-termination policy when added, removes it when cleared', async () => {
    routeSend({
      PutAutoTerminationPolicyCommand: {},
      DescribeClusterCommand: clusterOf('WAITING'),
    });
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, AutoTerminationPolicy: { IdleTimeout: 3600 } },
      { ...BASE_PROPS }
    );
    expect(callsOf(PutAutoTerminationPolicyCommand)[0]!.input['AutoTerminationPolicy']).toEqual({
      IdleTimeout: 3600,
    });

    vi.clearAllMocks();
    routeSend({
      RemoveAutoTerminationPolicyCommand: {},
      DescribeClusterCommand: clusterOf('WAITING'),
    });
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      { ...BASE_PROPS, AutoTerminationPolicy: { IdleTimeout: 3600 } }
    );
    expect(callsOf(RemoveAutoTerminationPolicyCommand)).toHaveLength(1);
  });

  it('applies a Tags diff via RemoveTags then AddTags (full-tag-removal handled)', async () => {
    routeSend({
      AddTagsCommand: {},
      RemoveTagsCommand: {},
      DescribeClusterCommand: clusterOf('WAITING'),
    });
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, Tags: [{ Key: 'team', Value: 'data' }] },
      { ...BASE_PROPS, Tags: [{ Key: 'env', Value: 'test' }] }
    );
    expect(callsOf(RemoveTagsCommand)[0]!.input).toEqual({ ResourceId: CLUSTER_ID, TagKeys: ['env'] });
    expect(callsOf(AddTagsCommand)[0]!.input).toEqual({
      ResourceId: CLUSTER_ID,
      Tags: [{ Key: 'team', Value: 'data' }],
    });
  });

  it('removes all tags when the desired tag set is empty', async () => {
    routeSend({ RemoveTagsCommand: {}, DescribeClusterCommand: clusterOf('WAITING') });
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, Tags: [] },
      { ...BASE_PROPS, Tags: [{ Key: 'env', Value: 'test' }] }
    );
    expect(callsOf(RemoveTagsCommand)[0]!.input['TagKeys']).toEqual(['env']);
    expect(callsOf(AddTagsCommand)).toHaveLength(0);
  });

  it('refuses an immutable Instances sub-field change with a --replace pointer', async () => {
    const prev = { ...BASE_PROPS };
    const next = {
      ...BASE_PROPS,
      Instances: {
        ...BASE_PROPS.Instances,
        MasterInstanceGroup: { InstanceCount: 1, InstanceType: 'm5.2xlarge' },
      },
    };
    await expect(
      newProvider().update('MyCluster', CLUSTER_ID, RESOURCE_TYPE, next, prev)
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses an immutable top-level property change with a --replace pointer', async () => {
    await expect(
      newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        { ...BASE_PROPS, ReleaseLabel: 'emr-6.15.0' },
        { ...BASE_PROPS }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
  });
});

describe('EMRClusterProvider delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('terminates and polls TERMINATING → TERMINATED', async () => {
    routeSend({
      DescribeClusterCommand: [clusterOf('WAITING'), clusterOf('TERMINATING'), clusterOf('TERMINATED')],
      TerminateJobFlowsCommand: {},
    });
    await newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
      expectedRegion: 'us-east-1',
    });
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(1);
  });

  it('is idempotent when the cluster is already TERMINATED (no terminate call)', async () => {
    routeSend({ DescribeClusterCommand: clusterOf('TERMINATED') });
    await newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
      expectedRegion: 'us-east-1',
    });
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(0);
  });

  it('treats TERMINATED_WITH_ERRORS as gone during delete polling', async () => {
    routeSend({
      DescribeClusterCommand: [clusterOf('WAITING'), clusterOf('TERMINATED_WITH_ERRORS')],
      TerminateJobFlowsCommand: {},
    });
    await expect(
      newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('treats an InvalidRequestException pre-check as gone when the region matches', async () => {
    routeSend({ DescribeClusterCommand: invalidRequest() });
    await expect(
      newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(0);
  });

  it('refuses to trust a NotFound when the client region mismatches the state region', async () => {
    routeSend({ DescribeClusterCommand: invalidRequest() });
    await expect(
      newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'eu-west-1',
      })
    ).rejects.toThrow(ProvisioningError);
  });

  it('flips SetTerminationProtection(false) before terminating under --remove-protection', async () => {
    routeSend({
      DescribeClusterCommand: [clusterOf('WAITING'), clusterOf('TERMINATED')],
      SetTerminationProtectionCommand: {},
      TerminateJobFlowsCommand: {},
    });
    await newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
      expectedRegion: 'us-east-1',
      removeProtection: true,
    });
    expect(callsOf(SetTerminationProtectionCommand)[0]!.input).toEqual({
      JobFlowIds: [CLUSTER_ID],
      TerminationProtected: false,
    });
    // Order: protection flip precedes the terminate.
    const names = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(names.indexOf('SetTerminationProtectionCommand')).toBeLessThan(
      names.indexOf('TerminateJobFlowsCommand')
    );
  });

  it('does not flip termination protection without --remove-protection', async () => {
    routeSend({
      DescribeClusterCommand: [clusterOf('WAITING'), clusterOf('TERMINATED')],
      TerminateJobFlowsCommand: {},
    });
    await newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
      expectedRegion: 'us-east-1',
    });
    expect(callsOf(SetTerminationProtectionCommand)).toHaveLength(0);
  });

  it('hard-errors on a termination timeout (never silently succeeds)', async () => {
    routeSend({
      DescribeClusterCommand: [clusterOf('WAITING'), clusterOf('TERMINATING')],
      TerminateJobFlowsCommand: {},
    });
    await expect(
      newProvider({ maxWaitMs: 30 }).delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      })
    ).rejects.toThrow(/Timed out/);
  });
});

describe('EMRClusterProvider getAttribute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the physical id for Id without an API call', async () => {
    const result = await newProvider().getAttribute(CLUSTER_ID, RESOURCE_TYPE, 'Id');
    expect(result).toBe(CLUSTER_ID);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('resolves MasterPublicDNS via DescribeCluster', async () => {
    routeSend({ DescribeClusterCommand: clusterOf('WAITING') });
    const result = await newProvider().getAttribute(CLUSTER_ID, RESOURCE_TYPE, 'MasterPublicDNS');
    expect(result).toBe(DNS);
  });

  it('returns undefined for an unknown attribute', async () => {
    routeSend({ DescribeClusterCommand: clusterOf('WAITING') });
    const result = await newProvider().getAttribute(CLUSTER_ID, RESOURCE_TYPE, 'Nope');
    expect(result).toBeUndefined();
  });
});
