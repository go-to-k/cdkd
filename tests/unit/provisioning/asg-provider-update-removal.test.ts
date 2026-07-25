// issue #1160: absent-field removal reset to CFn defaults for
// AWS::AutoScaling::AutoScalingGroup. UpdateAutoScalingGroup uses merge
// semantics (an absent input field means "no change"), so a field DROPPED from
// the template must be sent as its explicit CFn-default / SDK-documented clear
// sentinel, else the old live value silently persists (CloudFormation resets
// removed properties to their defaults). Reference fix pattern:
// `ECSProvider.clearOnUpdateRemoval` (#1164) / `LambdaFunctionProvider` (#1157).
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-auto-scaling')>(
      '@aws-sdk/client-auto-scaling'
    );
  return {
    ...actual,
    AutoScalingClient: vi.fn().mockImplementation(() => ({
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

import {
  UpdateAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';

const RESOURCE_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const ASG_NAME = 'my-asg';

type CommandInput = Record<string, unknown>;

function installUpdateHappyPath(): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof UpdateAutoScalingGroupCommand) return Promise.resolve({});
    if (command instanceof DescribeAutoScalingGroupsCommand) {
      return Promise.resolve({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: ASG_NAME,
            AutoScalingGroupARN: `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:abc:autoScalingGroupName/${ASG_NAME}`,
            MinSize: 0,
            MaxSize: 0,
          },
        ],
      });
    }
    return Promise.resolve({});
  });
}

function updateCallInput(): CommandInput {
  const call = mockSend.mock.calls.find(
    (c: unknown[]) => c[0] instanceof UpdateAutoScalingGroupCommand
  ) as [UpdateAutoScalingGroupCommand] | undefined;
  expect(call).toBeDefined();
  return (call as [UpdateAutoScalingGroupCommand])[0].input as unknown as CommandInput;
}

beforeEach(() => {
  mockSend.mockReset();
  mockEc2Send.mockReset();
  mockEc2Send.mockResolvedValue({});
  installUpdateHappyPath();
});

describe('ASGProvider update — removal reset to CFn defaults (issue #1160)', () => {
  it('resets every removed optional field to its CFn default / SDK clear sentinel', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
      },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        HealthCheckType: 'ELB',
        HealthCheckGracePeriod: 90,
        Cooldown: 120,
        TerminationPolicies: ['OldestInstance'],
        NewInstancesProtectedFromScaleIn: true,
        CapacityRebalance: true,
        MaxInstanceLifetime: 604800,
        DesiredCapacityType: 'vcpu',
        DefaultInstanceWarmup: 60,
        InstanceMaintenancePolicy: { MinHealthyPercentage: 90, MaxHealthyPercentage: 110 },
        CapacityReservationSpecification: {
          CapacityReservationPreference: 'capacity-reservations-only',
        },
        AvailabilityZoneDistribution: { CapacityDistributionStrategy: 'balanced-only' },
        AvailabilityZoneImpairmentPolicy: {
          ZonalShiftEnabled: true,
          ImpairedZoneHealthCheckBehavior: 'IgnoreUnhealthy',
        },
        DeletionProtection: 'prevent-force-deletion',
      }
    );

    const input = updateCallInput();
    expect(input['HealthCheckType']).toBe('EC2');
    expect(input['HealthCheckGracePeriod']).toBe(0);
    expect(input['DefaultCooldown']).toBe(300);
    expect(input['TerminationPolicies']).toEqual(['Default']);
    expect(input['NewInstancesProtectedFromScaleIn']).toBe(false);
    expect(input['CapacityRebalance']).toBe(false);
    expect(input['MaxInstanceLifetime']).toBe(0);
    expect(input['DesiredCapacityType']).toBe('units');
    expect(input['DefaultInstanceWarmup']).toBe(-1);
    expect(input['InstanceMaintenancePolicy']).toEqual({
      MinHealthyPercentage: -1,
      MaxHealthyPercentage: -1,
    });
    expect(input['CapacityReservationSpecification']).toEqual({
      CapacityReservationPreference: 'default',
    });
    expect(input['AvailabilityZoneDistribution']).toEqual({
      CapacityDistributionStrategy: 'balanced-best-effort',
    });
    expect(input['DeletionProtection']).toBe('none');
    // DEFERRED: no SDK-documented default for the sub-fields — removal keeps
    // the live value (stays absent from the SDK input).
    expect(input['AvailabilityZoneImpairmentPolicy']).toBeUndefined();
  });

  it('resets a removed DefaultCooldown spelling too (dual-key logical field)', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 0 },
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 0, DefaultCooldown: 240 }
    );

    expect(updateCallInput()['DefaultCooldown']).toBe(300);
  });

  it('does not misread a Cooldown -> DefaultCooldown spelling switch as a removal', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 0, DefaultCooldown: 240 },
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 0, Cooldown: 120 }
    );

    expect(updateCallInput()['DefaultCooldown']).toBe(240);
  });

  it('leaves never-present fields absent from the SDK input (no spurious reset)', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 1 },
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 0 }
    );

    const input = updateCallInput();
    expect(input['MaxSize']).toBe(1);
    expect(input['HealthCheckType']).toBeUndefined();
    expect(input['HealthCheckGracePeriod']).toBeUndefined();
    expect(input['DefaultCooldown']).toBeUndefined();
    expect(input['TerminationPolicies']).toBeUndefined();
    expect(input['NewInstancesProtectedFromScaleIn']).toBeUndefined();
    expect(input['CapacityRebalance']).toBeUndefined();
    expect(input['MaxInstanceLifetime']).toBeUndefined();
    expect(input['DesiredCapacityType']).toBeUndefined();
    expect(input['DefaultInstanceWarmup']).toBeUndefined();
    expect(input['InstanceMaintenancePolicy']).toBeUndefined();
    expect(input['CapacityReservationSpecification']).toBeUndefined();
    expect(input['AvailabilityZoneDistribution']).toBeUndefined();
    expect(input['AvailabilityZoneImpairmentPolicy']).toBeUndefined();
    expect(input['DeletionProtection']).toBeUndefined();
  });

  it('passes kept/changed fields through unchanged while resetting only the removed ones', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        // Kept (changed) fields pass through:
        HealthCheckType: 'VPC_LATTICE',
        HealthCheckGracePeriod: 45,
        TerminationPolicies: ['NewestInstance'],
        InstanceMaintenancePolicy: { MinHealthyPercentage: 80, MaxHealthyPercentage: 120 },
      },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        HealthCheckType: 'ELB',
        HealthCheckGracePeriod: 90,
        TerminationPolicies: ['OldestInstance'],
        InstanceMaintenancePolicy: { MinHealthyPercentage: 90, MaxHealthyPercentage: 110 },
        // Removed fields:
        MaxInstanceLifetime: 604800,
        CapacityRebalance: true,
      }
    );

    const input = updateCallInput();
    // Kept fields: exact template values, no reset applied.
    expect(input['HealthCheckType']).toBe('VPC_LATTICE');
    expect(input['HealthCheckGracePeriod']).toBe(45);
    expect(input['TerminationPolicies']).toEqual(['NewestInstance']);
    expect(input['InstanceMaintenancePolicy']).toEqual({
      MinHealthyPercentage: 80,
      MaxHealthyPercentage: 120,
    });
    // Removed fields: explicit resets.
    expect(input['MaxInstanceLifetime']).toBe(0);
    expect(input['CapacityRebalance']).toBe(false);
    // Never-present stays absent.
    expect(input['DesiredCapacityType']).toBeUndefined();
  });
});
