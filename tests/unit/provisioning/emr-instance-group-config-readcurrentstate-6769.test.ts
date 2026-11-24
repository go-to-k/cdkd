import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  InvalidRequestException,
  ListInstanceGroupsCommand,
  type InstanceGroup,
} from '@aws-sdk/client-emr';

/**
 * go-to-k/cdkd#6769: `AWS::EMR::InstanceGroupConfig` reads back through
 * `ListInstanceGroups` on the recorded cluster (Cloud Control cannot address
 * the bare group id, #5179).
 */

const send = vi.fn();
vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: class {
      send = send;
    },
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { EMRInstanceGroupConfigProvider } from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::EMR::InstanceGroupConfig';
const GROUP_ID = 'ig-ABC123';
const CLUSTER_ID = 'j-CLUSTER1';

const POLICY = {
  Constraints: { MinCapacity: 1, MaxCapacity: 3 },
  Rules: [
    {
      Name: 'scale-out',
      Action: { SimpleScalingPolicyConfiguration: { AdjustmentType: 'CHANGE_IN_CAPACITY', ScalingAdjustment: 1, CoolDown: 300 } },
      Trigger: {
        CloudWatchAlarmDefinition: {
          ComparisonOperator: 'LESS_THAN',
          EvaluationPeriods: 1,
          MetricName: 'YARNMemoryAvailablePercentage',
          Namespace: 'AWS/ElasticMapReduce',
          Period: 300,
          Statistic: 'AVERAGE',
          Threshold: 15,
          Unit: 'PERCENT',
          Dimensions: [{ Key: 'JobFlowId', Value: CLUSTER_ID }],
        },
      },
    },
  ],
};

/** What CDK's `CfnInstanceGroupConfig` emits for a TASK group. */
const RECORDED = {
  JobFlowId: CLUSTER_ID,
  InstanceRole: 'TASK',
  InstanceType: 'm5.xlarge',
  InstanceCount: 1,
  Name: 'task',
  Market: 'ON_DEMAND',
  Configurations: [{ Classification: 'yarn-site', ConfigurationProperties: { 'yarn.x': '1' } }],
  EbsConfiguration: {
    EbsBlockDeviceConfigs: [{ VolumeSpecification: { VolumeType: 'gp3', SizeInGB: 32 }, VolumesPerInstance: 2 }],
    EbsOptimized: true,
  },
  AutoScalingPolicy: POLICY,
};

function liveGroup(over: Partial<InstanceGroup> = {}): InstanceGroup {
  return {
    Id: GROUP_ID,
    Name: 'task',
    Market: 'ON_DEMAND',
    InstanceGroupType: 'TASK',
    InstanceType: 'm5.xlarge',
    RequestedInstanceCount: 1,
    RunningInstanceCount: 1,
    Status: { State: 'RUNNING' },
    Configurations: [{ Classification: 'yarn-site', Properties: { 'yarn.x': '1' } }],
    ConfigurationsVersion: 1,
    EbsOptimized: true,
    EbsBlockDevices: [
      { Device: '/dev/sdb', VolumeSpecification: { VolumeType: 'gp3', SizeInGB: 32 } },
      { Device: '/dev/sdc', VolumeSpecification: { VolumeType: 'gp3', SizeInGB: 32 } },
    ],
    AutoScalingPolicy: { Status: { State: 'ATTACHED' }, ...POLICY } as InstanceGroup['AutoScalingPolicy'],
    ...over,
  };
}

describe('EMRInstanceGroupConfigProvider.readCurrentState (go-to-k/cdkd#6769)', () => {
  let provider: EMRInstanceGroupConfigProvider;
  beforeEach(() => {
    send.mockReset();
    provider = new EMRInstanceGroupConfigProvider();
  });
  const read = (properties: Record<string, unknown> | undefined = RECORDED) =>
    provider.readCurrentState(GROUP_ID, 'Group', TYPE, properties);
  const pages = (...p: InstanceGroup[][]) =>
    send.mockImplementation((cmd: unknown) => {
      if (!(cmd instanceof ListInstanceGroupsCommand)) return Promise.reject(new Error('unexpected'));
      expect(cmd.input.ClusterId).toBe(CLUSTER_ID);
      const i = cmd.input.Marker === undefined ? 0 : Number(cmd.input.Marker);
      return Promise.resolve({
        InstanceGroups: p[i] ?? [],
        ...(i + 1 < p.length && { Marker: String(i + 1) }),
      });
    });

  it('reads a clean group back as the record', async () => {
    pages([liveGroup()]);
    expect(await read()).toEqual(RECORDED);
  });

  it('reads the requested count, so a mid-resize group is not drift', async () => {
    pages([liveGroup({ RunningInstanceCount: 3, Status: { State: 'RESIZING' } })]);
    expect(await read()).toMatchObject({ InstanceCount: 1 });
  });

  it('reports an out-of-band count change and a detached scaling policy', async () => {
    pages([liveGroup({ RequestedInstanceCount: 2, AutoScalingPolicy: undefined })]);
    const result = (await read()) as Record<string, unknown>;
    expect(result['InstanceCount']).toBe(2);
    expect(result).not.toHaveProperty('AutoScalingPolicy');
  });

  it('follows the Marker to the group on a later page', async () => {
    pages([liveGroup({ Id: 'ig-OTHER' })], [liveGroup()]);
    expect(await read()).toEqual(RECORDED);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('is RESOURCE_NOT_FOUND when the cluster lists no such group', async () => {
    pages([liveGroup({ Id: 'ig-OTHER' })]);
    expect(await read()).toBe(RESOURCE_NOT_FOUND);
  });

  it.each(['TERMINATED', 'ENDED'] as const)('is RESOURCE_NOT_FOUND for an %s group', async (State) => {
    pages([liveGroup({ Status: { State } })]);
    expect(await read()).toBe(RESOURCE_NOT_FOUND);
  });

  it('is drift unknown on InvalidRequestException, which is no evidence the group is gone', async () => {
    send.mockRejectedValue(new InvalidRequestException({ message: 'Cluster id is not valid', $metadata: {} }));
    expect(await read()).toBeUndefined();
  });

  it('throws any other failure', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    send.mockRejectedValue(denied);
    await expect(read()).rejects.toBe(denied);
  });

  it.each([
    ['a redacted JobFlowId', { ...RECORDED, JobFlowId: '***' }],
    ['no JobFlowId', { InstanceRole: 'TASK' }],
    ['no properties', undefined],
  ])('is drift unknown, with no call, for %s', async (_label, properties) => {
    pages([liveGroup()]);
    expect(await provider.readCurrentState(GROUP_ID, 'Group', TYPE, properties)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
