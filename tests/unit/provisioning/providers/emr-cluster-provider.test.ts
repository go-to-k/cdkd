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
  ListInstanceGroupsCommand,
  ListInstanceFleetsCommand,
  SetTerminationProtectionCommand,
  SetVisibleToAllUsersCommand,
  ModifyClusterCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  PutManagedScalingPolicyCommand,
  RemoveManagedScalingPolicyCommand,
  PutAutoTerminationPolicyCommand,
  RemoveAutoTerminationPolicyCommand,
  ModifyInstanceGroupsCommand,
  ModifyInstanceFleetCommand,
  PutAutoScalingPolicyCommand,
  RemoveAutoScalingPolicyCommand,
  SetUnhealthyNodeReplacementCommand,
  InvalidRequestException,
} from '@aws-sdk/client-emr';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../../src/utils/error-handler.js';
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';

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

/** A settled `ListInstanceGroups` entry, so a resize wait returns at once. */
function coreGroup(running: number): Record<string, unknown> {
  return taskGroup('ig-core', 'Core', running, 'CORE');
}

function taskGroup(
  id: string,
  name: string,
  running: number,
  type = 'TASK'
): Record<string, unknown> {
  return {
    Id: id,
    Name: name,
    InstanceGroupType: type,
    Status: { State: 'RUNNING' },
    RunningInstanceCount: running,
  };
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

  it('renames ConfigurationProperties / StepProperties to the SDK Properties member on RunJobFlow (issue #1383)', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: [clusterOf('WAITING')],
    });

    await newProvider().create('MyCluster', RESOURCE_TYPE, {
      ...BASE_PROPS,
      Configurations: [
        {
          Classification: 'spark-defaults',
          ConfigurationProperties: { 'spark.executor.memory': '4g' },
        },
      ],
      Steps: [
        {
          Name: 'my-step',
          ActionOnFailure: 'CONTINUE',
          HadoopJarStep: {
            Jar: 's3://bucket/job.jar',
            StepProperties: [{ Key: 'k', Value: 'v' }],
          },
        },
      ],
      Instances: {
        Ec2SubnetId: 'subnet-abc',
        MasterInstanceGroup: {
          InstanceCount: 1,
          InstanceType: 'm5.xlarge',
          Configurations: [
            { Classification: 'yarn-site', ConfigurationProperties: { 'yarn.a': 'b' } },
          ],
        },
      },
    });

    const input = callsOf(RunJobFlowCommand)[0]!.input;
    expect(input['Configurations']).toEqual([
      { Classification: 'spark-defaults', Properties: { 'spark.executor.memory': '4g' } },
    ]);
    expect(input['Steps']).toEqual([
      {
        Name: 'my-step',
        ActionOnFailure: 'CONTINUE',
        HadoopJarStep: {
          Jar: 's3://bucket/job.jar',
          Properties: [{ Key: 'k', Value: 'v' }],
        },
      },
    ]);
    const groups = (input['Instances'] as { InstanceGroups: Array<Record<string, unknown>> })
      .InstanceGroups;
    expect(groups[0]!['Configurations']).toEqual([
      { Classification: 'yarn-site', Properties: { 'yarn.a': 'b' } },
    ]);
  });

  it('renames per-instance-type-config Configurations inside an instance fleet (issue #1383)', async () => {
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
          InstanceTypeConfigs: [
            {
              InstanceType: 'm5.xlarge',
              Configurations: [
                { Classification: 'hive-site', ConfigurationProperties: { 'hive.a': 'b' } },
              ],
            },
          ],
        },
      },
    });

    const input = callsOf(RunJobFlowCommand)[0]!.input;
    const fleets = (input['Instances'] as { InstanceFleets: Array<Record<string, unknown>> })
      .InstanceFleets;
    expect(fleets[0]!['InstanceTypeConfigs']).toEqual([
      {
        InstanceType: 'm5.xlarge',
        Configurations: [{ Classification: 'hive-site', Properties: { 'hive.a': 'b' } }],
      },
    ]);
  });

  it('errors and best-effort terminates when the cluster reaches a terminal state during create', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: [clusterOf('STARTING'), clusterOf('TERMINATED_WITH_ERRORS')],
      SetTerminationProtectionCommand: {},
      TerminateJobFlowsCommand: {},
    });

    await expect(newProvider().create('MyCluster', RESOURCE_TYPE, { ...BASE_PROPS })).rejects.toThrow(
      ProvisioningError
    );
    // Rolled back to avoid billing: flip protection off, then terminate.
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(1);
    expect(callsOf(TerminateJobFlowsCommand)[0]!.input['JobFlowIds']).toEqual([CLUSTER_ID]);
    const names = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(names.indexOf('SetTerminationProtectionCommand')).toBeLessThan(
      names.indexOf('TerminateJobFlowsCommand')
    );
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

  // go-to-k/cdkd#5418: a replacing member recorded as its `{{resolve:...}}`
  // reference and handed here resolved is unchanged, as at the top level.
  describe('a secret-referenced Instances member beside a TerminationProtected toggle', () => {
    const REF = '{{resolve:secretsmanager:emr-key:SecretString:name}}';
    const prev = {
      ...BASE_PROPS,
      Instances: { ...BASE_PROPS.Instances, Ec2KeyName: REF, TerminationProtected: false },
    };
    const next = {
      ...BASE_PROPS,
      Instances: { ...BASE_PROPS.Instances, Ec2KeyName: 'resolved-key', TerminationProtected: true },
    };
    const maskSecrets = (text: string): string => text.split('resolved-key').join('***');

    it('applies the toggle when the member only resolves its recorded reference', async () => {
      routeSend({
        SetTerminationProtectionCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const result = await newProvider().update('MyCluster', CLUSTER_ID, RESOURCE_TYPE, next, prev, {
        maskSecrets,
      });
      expect(result.wasReplaced).toBe(false);
      expect(callsOf(SetTerminationProtectionCommand)[0]!.input['TerminationProtected']).toBe(true);
    });

    it('still refuses when the value is not one the masker resolved', async () => {
      const err = await newProvider()
        .update('MyCluster', CLUSTER_ID, RESOURCE_TYPE, next, prev)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((err as Error).message).toContain('Instances.Ec2KeyName cannot be updated in place');
      expect(mockSend).not.toHaveBeenCalled();
    });

    // go-to-k/cdkd#5422 (#5424 review): an in-place member behind a resolved
    // reference is still applied, from the raw desired value.
    it('applies an in-place member that only resolves a reference, never dropping it', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(3)] },
        ModifyInstanceGroupsCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const core = (count: unknown) => ({ InstanceCount: count, InstanceType: 'm5.xlarge' });
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        { ...BASE_PROPS, Instances: { ...BASE_PROPS.Instances, CoreInstanceGroup: core('3') } },
        { ...BASE_PROPS, Instances: { ...BASE_PROPS.Instances, CoreInstanceGroup: core(REF) } },
        { maskSecrets: (text: string) => text.split('3').join('***') }
      );
      expect(callsOf(ModifyInstanceGroupsCommand)[0]!.input['InstanceGroups']).toEqual([
        { InstanceGroupId: 'ig-core', InstanceCount: 3 },
      ]);
    });

    // go-to-k/cdkd#5422 (#5424 review): a member whose REPLACING part only
    // resolves its recorded reference, beside an in-place change, is applied in
    // place instead of refused as a replacement.
    it('applies the in-place change of a member whose replacing part only resolves a reference', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(2)] },
        ModifyInstanceGroupsCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const core = (type: string, count: number) => ({ InstanceCount: count, InstanceType: type });
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        { ...BASE_PROPS, Instances: { ...BASE_PROPS.Instances, CoreInstanceGroup: core('resolved-key', 2) } },
        { ...BASE_PROPS, Instances: { ...BASE_PROPS.Instances, CoreInstanceGroup: core(REF, 1) } },
        { maskSecrets }
      );
      expect(callsOf(ModifyInstanceGroupsCommand)[0]!.input['InstanceGroups']).toEqual([
        { InstanceGroupId: 'ig-core', InstanceCount: 2 },
      ]);
    });
  });

  it('reads an absent Instances block as empty: a lone TerminationProtected is applied', async () => {
    routeSend({ SetTerminationProtectionCommand: {}, DescribeClusterCommand: clusterOf('WAITING') });
    const { Instances: _omitted, ...withoutInstances } = BASE_PROPS;
    const result = await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...withoutInstances, Instances: { TerminationProtected: true } },
      withoutInstances
    );
    expect(result.wasReplaced).toBe(false);
    expect(callsOf(SetTerminationProtectionCommand)[0]!.input['TerminationProtected']).toBe(true);
  });

  it('names the Instances block whole when a side is not an object', async () => {
    const err = await newProvider()
      .update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        { ...BASE_PROPS, Instances: 'not-an-object' },
        { ...BASE_PROPS }
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((err as Error).message).toContain(
      "AWS EMR Cluster's Instances block cannot be updated in place"
    );
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

  // go-to-k/cdkd#5418: the diff replaces the cluster for a replacing member, so
  // this refusal is defence in depth and says what CloudFormation does.
  it('refuses a replacing Instances member as a CloudFormation replacement', async () => {
    const next = {
      ...BASE_PROPS,
      Instances: { ...BASE_PROPS.Instances, AdditionalMasterSecurityGroups: ['sg-extra'] },
    };
    const err = await newProvider()
      .update('MyCluster', CLUSTER_ID, RESOURCE_TYPE, next, { ...BASE_PROPS })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((err as Error).message).toContain(
      'Instances.AdditionalMasterSecurityGroups cannot be updated in place — CloudFormation replaces the cluster for this change.'
    );
    expect((err as Error).message).toContain('--replace --force-stateful-recreation');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // go-to-k/cdkd#5422: what CloudFormation applies in place (measured on
  // #5418) is applied in place, through the group / fleet providers' update().
  describe('in-place Instances members', () => {
    const core = (count: number, extra: Record<string, unknown> = {}) => ({
      InstanceCount: count,
      InstanceType: 'm5.xlarge',
      Name: 'Core',
      ...extra,
    });
    const withInstances = (extra: Record<string, unknown>) => ({
      ...BASE_PROPS,
      Instances: { ...BASE_PROPS.Instances, ...extra },
    });
    const POLICY = {
      Constraints: { MinCapacity: 1, MaxCapacity: 3 },
      Rules: [{ Name: 'r', Action: {}, Trigger: {} }],
    };

    it('resizes the core group with ModifyInstanceGroups and waits for the count', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(2)] },
        ModifyInstanceGroupsCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const result = await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({ CoreInstanceGroup: core(2) }),
        withInstances({ CoreInstanceGroup: core(1) })
      );
      expect(result.wasReplaced).toBe(false);
      expect(callsOf(ModifyInstanceGroupsCommand)).toHaveLength(1);
      expect(callsOf(ModifyInstanceGroupsCommand)[0]!.input).toEqual({
        ClusterId: CLUSTER_ID,
        InstanceGroups: [{ InstanceGroupId: 'ig-core', InstanceCount: 2 }],
      });
    });

    it('resizes the TASK group the template names, not another', async () => {
      routeSend({
        ListInstanceGroupsCommand: {
          InstanceGroups: [coreGroup(1), taskGroup('ig-t1', 't1', 1), taskGroup('ig-t2', 't2', 3)],
        },
        ModifyInstanceGroupsCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const tasks = (count: number) => [
        { InstanceCount: 1, InstanceType: 'm5.xlarge', Name: 't1' },
        { InstanceCount: count, InstanceType: 'm5.xlarge', Name: 't2' },
      ];
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({ TaskInstanceGroups: tasks(3) }),
        withInstances({ TaskInstanceGroups: tasks(1) })
      );
      expect(callsOf(ModifyInstanceGroupsCommand).map((c) => c.input['InstanceGroups'])).toEqual([
        [{ InstanceGroupId: 'ig-t2', InstanceCount: 3 }],
      ]);
    });

    it('refuses, calling nothing that changes AWS, when the named TASK group is not found', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(1), taskGroup('ig-t1', 't1', 1)] },
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const tasks = (count: number) => [{ InstanceCount: count, InstanceType: 'm5.xlarge', Name: 'tx' }];
      const err = await newProvider()
        .update(
          'MyCluster',
          CLUSTER_ID,
          RESOURCE_TYPE,
          withInstances({ TaskInstanceGroups: tasks(2) }),
          withInstances({ TaskInstanceGroups: tasks(1) })
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toContain('found 0 matching TASK instance groups');
      expect(callsOf(ModifyInstanceGroupsCommand)).toHaveLength(0);
    });

    it('changes nothing in AWS when a later target cannot be found', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(2), taskGroup('ig-t1', 't1', 1)] },
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const tasks = (count: number) => [{ InstanceCount: count, InstanceType: 'm5.xlarge', Name: 'tx' }];
      const err = await newProvider()
        .update(
          'MyCluster',
          CLUSTER_ID,
          RESOURCE_TYPE,
          withInstances({
            TerminationProtected: true,
            UnhealthyNodeReplacement: false,
            CoreInstanceGroup: core(2),
            TaskInstanceGroups: tasks(2),
          }),
          withInstances({ CoreInstanceGroup: core(1), TaskInstanceGroups: tasks(1) })
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      const sent = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
      expect(sent.every((name) => name === 'ListInstanceGroupsCommand')).toBe(true);
    });

    it('refuses a task group whose Name is a secret reference, before any call that changes AWS', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(1), taskGroup('ig-t1', 'batch', 1)] },
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const REF = '{{resolve:secretsmanager:group-name:SecretString:name}}';
      const task = (name: string, count: number) => [
        { InstanceCount: count, InstanceType: 'm5.xlarge', Name: name },
      ];
      const err = await newProvider()
        .update(
          'MyCluster',
          CLUSTER_ID,
          RESOURCE_TYPE,
          withInstances({ TaskInstanceGroups: task('batch', 2) }),
          withInstances({ TaskInstanceGroups: task(REF, 1) }),
          { maskSecrets: (text: string) => text.split('batch').join('***') }
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toContain('its Name is a secret reference');
      expect(callsOf(ModifyInstanceGroupsCommand)).toHaveLength(0);
    });

    it('refuses an unnamed task group whose InstanceType is a secret reference', async () => {
      routeSend({
        ListInstanceGroupsCommand: {
          InstanceGroups: [coreGroup(1), { ...taskGroup('ig-t1', 'x', 1), InstanceType: 'm5.large' }],
        },
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const REF = '{{resolve:secretsmanager:group-type:SecretString:type}}';
      const task = (type: string, count: number) => [{ InstanceCount: count, InstanceType: type }];
      const err = await newProvider()
        .update(
          'MyCluster',
          CLUSTER_ID,
          RESOURCE_TYPE,
          withInstances({ TaskInstanceGroups: task('m5.large', 2) }),
          withInstances({ TaskInstanceGroups: task(REF, 1) }),
          { maskSecrets: (text: string) => text.split('m5.large').join('***') }
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toContain('its InstanceType is a secret reference');
      expect(callsOf(ModifyInstanceGroupsCommand)).toHaveLength(0);
    });

    it('never matches a task group that is shutting down', async () => {
      routeSend({
        ListInstanceGroupsCommand: {
          InstanceGroups: [
            coreGroup(1),
            { ...taskGroup('ig-old', 't1', 1), Status: { State: 'SHUTTING_DOWN' } },
            taskGroup('ig-t1', 't1', 2),
          ],
        },
        ModifyInstanceGroupsCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const tasks = (count: number) => [{ InstanceCount: count, InstanceType: 'm5.xlarge', Name: 't1' }];
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({ TaskInstanceGroups: tasks(2) }),
        withInstances({ TaskInstanceGroups: tasks(1) })
      );
      expect(callsOf(ModifyInstanceGroupsCommand)[0]!.input['InstanceGroups']).toEqual([
        { InstanceGroupId: 'ig-t1', InstanceCount: 2 },
      ]);
    });

    it('starts no resize once the shared wait budget is spent', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(2)] },
        ModifyInstanceGroupsCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      let now = 1_000_000;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 10_000));
      try {
        const err = await newProvider({ maxWaitMs: 5000 })
          .update(
            'MyCluster',
            CLUSTER_ID,
            RESOURCE_TYPE,
            withInstances({ CoreInstanceGroup: core(2) }),
            withInstances({ CoreInstanceGroup: core(1) })
          )
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as Error).message).toContain('the earlier resizes used the whole wait');
        expect(callsOf(ModifyInstanceGroupsCommand)).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('finds an unnamed task group by its instance type', async () => {
      routeSend({
        ListInstanceGroupsCommand: {
          InstanceGroups: [
            coreGroup(1),
            { ...taskGroup('ig-small', 'x', 1), InstanceType: 'm5.large' },
            { ...taskGroup('ig-big', 'y', 3), InstanceType: 'm5.xlarge' },
          ],
        },
        ModifyInstanceGroupsCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const tasks = (count: number) => [{ InstanceCount: count, InstanceType: 'm5.xlarge' }];
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({ TaskInstanceGroups: tasks(3) }),
        withInstances({ TaskInstanceGroups: tasks(1) })
      );
      expect(callsOf(ModifyInstanceGroupsCommand)[0]!.input['InstanceGroups']).toEqual([
        { InstanceGroupId: 'ig-big', InstanceCount: 3 },
      ]);
    });

    it('restates a resize failure for the cluster, naming the Instances path', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(1)] },
        ModifyInstanceGroupsCommand: new Error('boom'),
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const err = await newProvider()
        .update(
          'MyCluster',
          CLUSTER_ID,
          RESOURCE_TYPE,
          withInstances({ CoreInstanceGroup: core(2) }),
          withInstances({ CoreInstanceGroup: core(1) })
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toContain(
        `Failed to apply Instances.CoreInstanceGroup to EMR cluster ${CLUSTER_ID}: `
      );
      expect((err as ProvisioningError).resourceType).toBe(RESOURCE_TYPE);
    });

    it('puts and removes a core group AutoScalingPolicy', async () => {
      routeSend({
        ListInstanceGroupsCommand: { InstanceGroups: [coreGroup(1)] },
        PutAutoScalingPolicyCommand: {},
        RemoveAutoScalingPolicyCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({ CoreInstanceGroup: core(1, { AutoScalingPolicy: POLICY }) }),
        withInstances({ CoreInstanceGroup: core(1) })
      );
      expect(callsOf(PutAutoScalingPolicyCommand)[0]!.input).toEqual({
        ClusterId: CLUSTER_ID,
        InstanceGroupId: 'ig-core',
        AutoScalingPolicy: POLICY,
      });
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({ CoreInstanceGroup: core(1) }),
        withInstances({ CoreInstanceGroup: core(1, { AutoScalingPolicy: POLICY }) })
      );
      expect(callsOf(RemoveAutoScalingPolicyCommand)[0]!.input).toEqual({
        ClusterId: CLUSTER_ID,
        InstanceGroupId: 'ig-core',
      });
      expect(callsOf(ModifyInstanceGroupsCommand)).toHaveLength(0);
    });

    it('sets UnhealthyNodeReplacement with SetUnhealthyNodeReplacement', async () => {
      routeSend({
        SetUnhealthyNodeReplacementCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({ UnhealthyNodeReplacement: false }),
        withInstances({ UnhealthyNodeReplacement: true })
      );
      expect(callsOf(SetUnhealthyNodeReplacementCommand)[0]!.input).toEqual({
        JobFlowIds: [CLUSTER_ID],
        UnhealthyNodeReplacement: false,
      });
    });

    // CloudFormation fails this removal (raw CFn A/B, go-to-k/cdkd#5422).
    it('refuses removing UnhealthyNodeReplacement before any call', async () => {
      const err = await newProvider()
        .update(
          'MyCluster',
          CLUSTER_ID,
          RESOURCE_TYPE,
          withInstances({}),
          withInstances({ UnhealthyNodeReplacement: false })
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((err as Error).message).toContain(
        'removing Instances.UnhealthyNodeReplacement fails under CloudFormation too'
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('names an immutable top-level change before an UnhealthyNodeReplacement removal', async () => {
      const err = await newProvider()
        .update(
          'MyCluster',
          CLUSTER_ID,
          RESOURCE_TYPE,
          { ...withInstances({}), ReleaseLabel: 'emr-7.10.0' },
          withInstances({ UnhealthyNodeReplacement: false })
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((err as Error).message).toContain('ReleaseLabel is immutable');
    });

    it('keeps the live UnhealthyNodeReplacement on a rollback replay removing it', async () => {
      routeSend({ DescribeClusterCommand: clusterOf('WAITING') });
      const result = await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({}),
        withInstances({ UnhealthyNodeReplacement: false }),
        { replayingState: true }
      );
      expect(result.wasReplaced).toBe(false);
      expect(callsOf(SetUnhealthyNodeReplacementCommand)).toHaveLength(0);
    });

    it('resizes a core fleet with ModifyInstanceFleet, sending both capacities', async () => {
      routeSend({
        ListInstanceFleetsCommand: {
          InstanceFleets: [
            {
              Id: 'if-core',
              InstanceFleetType: 'CORE',
              Name: 'Core',
              Status: { State: 'RUNNING' },
              ProvisionedOnDemandCapacity: 2,
              ProvisionedSpotCapacity: 0,
            },
          ],
        },
        ModifyInstanceFleetCommand: {},
        DescribeClusterCommand: clusterOf('WAITING'),
      });
      const fleet = (onDemand: number) => ({
        Name: 'Core',
        TargetOnDemandCapacity: onDemand,
        InstanceTypeConfigs: [{ InstanceType: 'm5.xlarge' }],
      });
      await newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        withInstances({ CoreInstanceFleet: fleet(2) }),
        withInstances({ CoreInstanceFleet: fleet(1) })
      );
      expect(callsOf(ModifyInstanceFleetCommand)[0]!.input).toEqual({
        ClusterId: CLUSTER_ID,
        InstanceFleet: { InstanceFleetId: 'if-core', TargetOnDemandCapacity: 2, TargetSpotCapacity: 0 },
      });
    });

    it('refuses before any call when a replacing member moved beside an in-place one', async () => {
      const err = await newProvider()
        .update(
          'MyCluster',
          CLUSTER_ID,
          RESOURCE_TYPE,
          withInstances({ CoreInstanceGroup: core(2), Ec2KeyName: 'k2' }),
          withInstances({ CoreInstanceGroup: core(1), Ec2KeyName: 'k1' })
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((err as Error).message).toContain('Instances.Ec2KeyName cannot be updated in place');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  it('names the replacing member, not an in-place one moved beside it', async () => {
    const core = { InstanceCount: 1, InstanceType: 'm5.xlarge', Name: 'Core' };
    const prev = { ...BASE_PROPS, Instances: { CoreInstanceGroup: core, ...BASE_PROPS.Instances } };
    const next = {
      ...BASE_PROPS,
      Instances: {
        CoreInstanceGroup: { ...core, InstanceCount: 2 },
        ...BASE_PROPS.Instances,
        AdditionalMasterSecurityGroups: ['sg-extra'],
      },
    };
    const err = await newProvider()
      .update('MyCluster', CLUSTER_ID, RESOURCE_TYPE, next, prev)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((err as Error).message).toContain(
      'Instances.AdditionalMasterSecurityGroups cannot be updated in place'
    );
    expect((err as Error).message).not.toContain('Instances.CoreInstanceGroup');
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

/** A transient throttling error the poll loop should absorb (up to its budget). */
function throttle(): Error {
  const e = new Error('Rate exceeded');
  e.name = 'ThrottlingException';
  return e;
}

describe('EMRClusterProvider polling + error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('absorbs transient DescribeCluster throttles under the budget during a create poll', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      // 3 consecutive throttles (< maxConsecutiveTransient=5) then WAITING.
      DescribeClusterCommand: [throttle(), throttle(), throttle(), clusterOf('WAITING')],
    });
    const result = await newProvider().create('MyCluster', RESOURCE_TYPE, { ...BASE_PROPS });
    expect(result.physicalId).toBe(CLUSTER_ID);
  });

  it('rethrows when consecutive DescribeCluster throttles exceed the budget, and rolls back', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: throttle(), // always throttles → exceeds budget
      SetTerminationProtectionCommand: {},
      TerminateJobFlowsCommand: {},
    });
    await expect(
      newProvider().create('MyCluster', RESOURCE_TYPE, { ...BASE_PROPS })
    ).rejects.toThrow(ProvisioningError);
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(1);
  });

  it('rolls back on a create timeout, flipping SetTerminationProtection(false) BEFORE terminating', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: clusterOf('STARTING'), // never reaches WAITING
      SetTerminationProtectionCommand: {},
      TerminateJobFlowsCommand: {},
    });
    await expect(
      newProvider({ maxWaitMs: 30 }).create('MyCluster', RESOURCE_TYPE, {
        ...BASE_PROPS,
        // A PROTECTED cluster: a naive rollback terminate would 400 and leak billing.
        Instances: { ...BASE_PROPS.Instances, TerminationProtected: true },
      })
    ).rejects.toThrow(/Timed out/);

    expect(callsOf(SetTerminationProtectionCommand)[0]!.input).toEqual({
      JobFlowIds: [CLUSTER_ID],
      TerminationProtected: false,
    });
    const names = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(names.indexOf('SetTerminationProtectionCommand')).toBeLessThan(
      names.indexOf('TerminateJobFlowsCommand')
    );
  });

  it('treats an InvalidRequestException raised DURING the termination poll as gone', async () => {
    routeSend({
      // pre-check WAITING (proceeds to terminate), then the poll read IREs (gone).
      DescribeClusterCommand: [clusterOf('WAITING'), invalidRequest()],
      TerminateJobFlowsCommand: {},
    });
    await expect(
      newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(1);
  });

  it('wraps a non-NotFound describe error in the delete pre-check (no terminate)', async () => {
    routeSend({ DescribeClusterCommand: new Error('AccessDenied') });
    await expect(
      newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      })
    ).rejects.toThrow(/before deletion/);
    expect(callsOf(TerminateJobFlowsCommand)).toHaveLength(0);
  });

  it('wraps a TerminateJobFlows failure in a ProvisioningError', async () => {
    routeSend({
      DescribeClusterCommand: clusterOf('WAITING'),
      TerminateJobFlowsCommand: new Error('boom'),
    });
    await expect(
      newProvider().delete('MyCluster', CLUSTER_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      })
    ).rejects.toThrow(/Failed to terminate/);
  });

  it('succeeds on an update even when the post-update attribute refresh fails (best-effort)', async () => {
    routeSend({
      ModifyClusterCommand: {},
      DescribeClusterCommand: new Error('transient describe failure'),
    });
    const result = await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, StepConcurrencyLevel: 5 },
      { ...BASE_PROPS, StepConcurrencyLevel: 1 }
    );
    expect(result).toEqual({ physicalId: CLUSTER_ID, wasReplaced: false });
    expect(callsOf(ModifyClusterCommand)).toHaveLength(1);
  });

  it('removes the managed-scaling policy when the desired policy has no ComputeLimits', async () => {
    routeSend({
      RemoveManagedScalingPolicyCommand: {},
      DescribeClusterCommand: clusterOf('WAITING'),
    });
    const policy = { ComputeLimits: { UnitType: 'Instances', MinimumCapacityUnits: 1, MaximumCapacityUnits: 4 } };
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, ManagedScalingPolicy: {} }, // present but empty → not a valid Put
      { ...BASE_PROPS, ManagedScalingPolicy: policy }
    );
    expect(callsOf(RemoveManagedScalingPolicyCommand)).toHaveLength(1);
    expect(callsOf(PutManagedScalingPolicyCommand)).toHaveLength(0);
  });

  it('drops a non-numeric StepConcurrencyLevel instead of forwarding NaN to RunJobFlow', async () => {
    routeSend({
      RunJobFlowCommand: { JobFlowId: CLUSTER_ID },
      DescribeClusterCommand: [clusterOf('WAITING')],
    });
    await newProvider().create('MyCluster', RESOURCE_TYPE, {
      ...BASE_PROPS,
      StepConcurrencyLevel: 'not-a-number',
    });
    expect(callsOf(RunJobFlowCommand)[0]!.input['StepConcurrencyLevel']).toBeUndefined();
  });
});

const CDK_PATH = 'MyStack/MyCluster/Resource';

function importInput(overrides: Record<string, unknown> = {}) {
  return {
    logicalId: 'MyCluster',
    resourceType: RESOURCE_TYPE,
    stackName: 'MyStack',
    region: 'us-east-1',
    properties: { ...BASE_PROPS },
    ...overrides,
  };
}

describe('EMRClusterProvider import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies an explicit cluster id (knownPhysicalId) via DescribeCluster and returns attributes', async () => {
    routeSend({ DescribeClusterCommand: clusterOf('WAITING') });

    const result = await newProvider().import(importInput({ knownPhysicalId: CLUSTER_ID }));

    expect(result).toEqual({
      physicalId: CLUSTER_ID,
      attributes: { Id: CLUSTER_ID, MasterPublicDNS: DNS },
    });
    expect(callsOf(DescribeClusterCommand)[0]!.input['ClusterId']).toBe(CLUSTER_ID);
  });

  it('returns null when the explicit cluster id is unknown (InvalidRequestException)', async () => {
    routeSend({ DescribeClusterCommand: invalidRequest() });
    const result = await newProvider().import(importInput({ knownPhysicalId: CLUSTER_ID }));
    expect(result).toBeNull();
  });

  it('returns null when the explicit cluster id is already terminated', async () => {
    routeSend({ DescribeClusterCommand: clusterOf('TERMINATED') });
    const result = await newProvider().import(importInput({ knownPhysicalId: CLUSTER_ID }));
    expect(result).toBeNull();
  });

  // The `aws:cdk:path` tag walk was removed (issue #1134): AWS rejects
  // `aws:`-prefixed tag writes, so the tag never exists on a real cluster.
  // With no explicit id, import returns null without issuing any AWS call.
  it('returns null without any AWS call when only a cdkPath is available', async () => {
    routeSend({});
    const result = await newProvider().import(importInput());
    expect(result).toBeNull();
    expect(callsOf(DescribeClusterCommand)).toHaveLength(0);
  });
});

describe('EMRClusterProvider readCurrentState (reverse-mapping)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverses a flat InstanceGroups array back into role-keyed CFn Instances', async () => {
    routeSend({
      DescribeClusterCommand: clusterOf('WAITING', {
        InstanceCollectionType: 'INSTANCE_GROUP',
        TerminationProtected: true,
        Ec2InstanceAttributes: {
          Ec2SubnetId: 'subnet-abc',
          Ec2KeyName: 'my-key',
          IamInstanceProfile: 'EMR_EC2_DefaultRole',
          EmrManagedMasterSecurityGroup: 'sg-master',
        },
        Tags: [
          { Key: 'env', Value: 'test' },
          { Key: 'aws:cdk:path', Value: CDK_PATH },
        ],
      }),
      ListInstanceGroupsCommand: {
        InstanceGroups: [
          {
            InstanceGroupType: 'MASTER',
            InstanceType: 'm5.xlarge',
            // Requested != Running (mid-resize): CFn `InstanceCount` must map to
            // the REQUESTED count, not the running one, or a resize transiently
            // reports drift. The differing values make the mapping load-bearing.
            RequestedInstanceCount: 1,
            RunningInstanceCount: 5,
            Name: 'Master',
            Market: 'ON_DEMAND',
          },
          { InstanceGroupType: 'CORE', InstanceType: 'm5.xlarge', RequestedInstanceCount: 2 },
          { InstanceGroupType: 'TASK', InstanceType: 'm5.2xlarge', RequestedInstanceCount: 3 },
        ],
      },
    });

    const state = await newProvider().readCurrentState(CLUSTER_ID, 'MyCluster', RESOURCE_TYPE);
    const instances = (state as Record<string, unknown>)['Instances'] as Record<string, any>;

    expect(instances['MasterInstanceGroup']).toMatchObject({
      InstanceType: 'm5.xlarge',
      InstanceCount: 1,
      Name: 'Master',
      Market: 'ON_DEMAND',
    });
    // InstanceCount is the REQUESTED count (1), never the running count (5).
    expect(instances['MasterInstanceGroup']['InstanceCount']).toBe(1);
    expect(instances['CoreInstanceGroup']).toMatchObject({ InstanceCount: 2 });
    expect(instances['TaskInstanceGroups']).toHaveLength(1);
    expect(instances['TaskInstanceGroups'][0]).toMatchObject({ InstanceCount: 3 });
    // No fleets on an INSTANCE_GROUP cluster.
    expect(instances['MasterInstanceFleet']).toBeUndefined();
    expect(callsOf(ListInstanceFleetsCommand)).toHaveLength(0);
    // Ec2 attributes folded back in.
    expect(instances['Ec2SubnetId']).toBe('subnet-abc');
    expect(instances['Ec2KeyName']).toBe('my-key');
    expect(instances['EmrManagedMasterSecurityGroup']).toBe('sg-master');
    expect(instances['TerminationProtected']).toBe(true);
    // Top-level fields.
    expect((state as Record<string, unknown>)['JobFlowRole']).toBe('EMR_EC2_DefaultRole');
    // aws: tags stripped; user tags kept.
    expect((state as Record<string, unknown>)['Tags']).toEqual([{ Key: 'env', Value: 'test' }]);
  });

  it('reverses a flat InstanceFleets array back into role-keyed CFn Instances', async () => {
    routeSend({
      DescribeClusterCommand: clusterOf('WAITING', {
        InstanceCollectionType: 'INSTANCE_FLEET',
        Ec2InstanceAttributes: { RequestedEc2SubnetIds: ['subnet-a', 'subnet-b'] },
      }),
      ListInstanceFleetsCommand: {
        InstanceFleets: [
          { InstanceFleetType: 'MASTER', Name: 'M', TargetOnDemandCapacity: 1 },
          { InstanceFleetType: 'CORE', TargetSpotCapacity: 2 },
          { InstanceFleetType: 'TASK', TargetSpotCapacity: 5 },
        ],
      },
    });

    const state = await newProvider().readCurrentState(CLUSTER_ID, 'MyCluster', RESOURCE_TYPE);
    const instances = (state as Record<string, unknown>)['Instances'] as Record<string, any>;

    expect(instances['MasterInstanceFleet']).toMatchObject({ Name: 'M', TargetOnDemandCapacity: 1 });
    expect(instances['CoreInstanceFleet']).toMatchObject({ TargetSpotCapacity: 2 });
    expect(instances['TaskInstanceFleets']).toHaveLength(1);
    expect(instances['TaskInstanceFleets'][0]).toMatchObject({ TargetSpotCapacity: 5 });
    expect(instances['Ec2SubnetIds']).toEqual(['subnet-a', 'subnet-b']);
    // Fleet clusters do not list instance groups.
    expect(callsOf(ListInstanceGroupsCommand)).toHaveLength(0);
  });

  it('keeps undefined for InvalidRequestException (EMR uses it for more than an unknown id)', async () => {
    routeSend({ DescribeClusterCommand: invalidRequest() });
    const state = await newProvider().readCurrentState(CLUSTER_ID, 'MyCluster', RESOURCE_TYPE);
    expect(state).toBeUndefined();
  });

  it.each(['TERMINATED', 'TERMINATED_WITH_ERRORS'] as const)(
    'returns RESOURCE_NOT_FOUND for a %s cluster',
    async (terminal) => {
      routeSend({ DescribeClusterCommand: clusterOf(terminal) });
      const state = await newProvider().readCurrentState(CLUSTER_ID, 'MyCluster', RESOURCE_TYPE);
      expect(state).toBe(RESOURCE_NOT_FOUND);
      expect(callsOf(ListInstanceGroupsCommand)).toHaveLength(0);
    }
  );

  it('getDriftUnknownPaths lists the create-only + lossy-reverse paths', () => {
    const paths = newProvider().getDriftUnknownPaths(RESOURCE_TYPE);

    // Top-level create-only sub-config AWS does not read back faithfully.
    for (const p of [
      'AdditionalInfo',
      'Applications',
      'AutoTerminationPolicy',
      'BootstrapActions',
      'Configurations',
      'KerberosAttributes',
      'ManagedScalingPolicy',
      'PlacementGroupConfigs',
      'Steps',
    ]) {
      expect(paths).toContain(p);
    }

    // `Instances.*` sub-fields reverseInstancesToCfn intentionally omits — must
    // be skipped or they phantom-drift on the `properties`-fallback path.
    for (const p of [
      'Instances.HadoopVersion',
      'Instances.KeepJobFlowAliveWhenNoSteps',
      'Instances.Placement',
      'Instances.MasterInstanceGroup.EbsConfiguration',
      'Instances.MasterInstanceGroup.AutoScalingPolicy',
      'Instances.MasterInstanceGroup.Configurations',
      'Instances.CoreInstanceGroup.EbsConfiguration',
      'Instances.CoreInstanceGroup.AutoScalingPolicy',
      'Instances.CoreInstanceGroup.Configurations',
      'Instances.MasterInstanceFleet.InstanceTypeConfigs',
      'Instances.MasterInstanceFleet.LaunchSpecifications',
      'Instances.MasterInstanceFleet.ResizeSpecifications',
      'Instances.CoreInstanceFleet.InstanceTypeConfigs',
      'Instances.CoreInstanceFleet.LaunchSpecifications',
      'Instances.CoreInstanceFleet.ResizeSpecifications',
      // Task groups/fleets are arrays → ignored whole (leaf comparison).
      'Instances.TaskInstanceGroups',
      'Instances.TaskInstanceFleets',
    ]) {
      expect(paths).toContain(p);
    }

    // The whole `Instances` block must NOT be blanket-ignored — mutable
    // primary topology (e.g. InstanceCount resize) still needs drift coverage.
    expect(paths).not.toContain('Instances');
  });
});
