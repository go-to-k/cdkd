import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * AWS::ECS::Service removal semantics for the members a CloudFormation A/B
 * settled (#1160): a throwaway stack set each member, then removed it.
 *
 * - Monitoring: CloudFormation resets the service revision to
 *   `{ metricConfigurations: [] }`; UpdateService keeps an absent member.
 * - VolumeConfigurations / VpcLatticeConfigurations: CloudFormation clears
 *   both; UpdateService clears on `[]`.
 * - AvailabilityZoneRebalancing: CloudFormation KEEPS the live value
 *   (DISABLED stayed DISABLED), so nothing is sent.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ecs')>('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
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

import { UpdateServiceCommand, type UpdateServiceCommandInput } from '@aws-sdk/client-ecs';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';

const TYPE = 'AWS::ECS::Service';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/ecs-infra';
const TG_ARN = 'arn:aws:vpc-lattice:us-east-1:123456789012:targetgroup/tg-0123456789abcdef0';

const baseProps = (): Record<string, unknown> => ({
  Cluster: 'my-cluster',
  TaskDefinition: 'my-task:1',
  DesiredCount: 0,
});

// The exact shapes the CloudFormation A/B deployed.
const MONITORING = {
  MetricConfigurations: [{ MetricNames: ['CPUUtilization'], ResolutionSeconds: 20 }],
};
const VOLUMES = [{ Name: 'data', ManagedEBSVolume: { RoleArn: ROLE_ARN, SizeInGiB: 1 } }];
const LATTICE = [{ RoleArn: ROLE_ARN, TargetGroupArn: TG_ARN, PortName: 'web' }];

describe('ECS Service removal semantics measured by the #1160 CloudFormation A/B', () => {
  let provider: ECSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ECSProvider();
  });

  const updateInput = async (
    props: Record<string, unknown>,
    prev: Record<string, unknown>
  ): Promise<UpdateServiceCommandInput> => {
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });
    await provider.update('Svc', SERVICE_ARN, TYPE, props, prev);
    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateServiceCommand);
    expect(updates).toHaveLength(1);
    return (updates[0]![0] as UpdateServiceCommand).input;
  };

  it('a removed Monitoring resets to an empty metric list, as CloudFormation does', async () => {
    const input = await updateInput(baseProps(), { ...baseProps(), Monitoring: MONITORING });
    expect(input.monitoring).toEqual({ metricConfigurations: [] });
  });

  it('a Monitoring that was never declared sends nothing', async () => {
    const input = await updateInput(
      { ...baseProps(), DesiredCount: 1 },
      { ...baseProps(), DesiredCount: 0 }
    );
    expect(input.monitoring).toBeUndefined();
  });

  it('a Monitoring still declared is sent converted, not reset', async () => {
    const input = await updateInput(
      { ...baseProps(), Monitoring: MONITORING },
      {
        ...baseProps(),
        Monitoring: {
          MetricConfigurations: [{ MetricNames: ['CPUUtilization'], ResolutionSeconds: 60 }],
        },
      }
    );
    expect(input.monitoring).toEqual({
      metricConfigurations: [{ metricNames: ['CPUUtilization'], resolutionSeconds: 20 }],
    });
  });

  it('a removed AvailabilityZoneRebalancing sends nothing, since CloudFormation keeps DISABLED', async () => {
    const input = await updateInput(baseProps(), {
      ...baseProps(),
      AvailabilityZoneRebalancing: 'DISABLED',
    });
    expect(input.availabilityZoneRebalancing).toBeUndefined();
  });

  it('removing all four members at once (the A/B shape) clears three and keeps the rebalancing setting', async () => {
    const input = await updateInput(
      { ...baseProps(), TaskDefinition: 'my-task-plain:1' },
      {
        ...baseProps(),
        AvailabilityZoneRebalancing: 'DISABLED',
        Monitoring: MONITORING,
        VolumeConfigurations: VOLUMES,
        VpcLatticeConfigurations: LATTICE,
      }
    );
    expect(input.monitoring).toEqual({ metricConfigurations: [] });
    expect(input.volumeConfigurations).toEqual([]);
    expect(input.vpcLatticeConfigurations).toEqual([]);
    expect(input.availabilityZoneRebalancing).toBeUndefined();
    expect(input.taskDefinition).toBe('my-task-plain:1');
  });
});
