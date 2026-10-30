// go-to-k/cdkd#5004: a real CloudFormation A/B shows CloudFormation KEEPS the live
// value of nine removed properties (HealthCheckType, HealthCheckGracePeriod,
// Cooldown, TerminationPolicies, NewInstancesProtectedFromScaleIn,
// CapacityRebalance, DesiredCapacityType, DefaultInstanceWarmup,
// DeletionProtection), so only InstanceMaintenancePolicy, MaxInstanceLifetime,
// CapacityReservationSpecification and AvailabilityZoneDistribution reset — plus
// AvailabilityZoneImpairmentPolicy, per the #1160 A/B.
// issue #1160: absent-field removal reset to CFn defaults for
// AWS::AutoScaling::AutoScalingGroup. UpdateAutoScalingGroup uses merge
// semantics (an absent input field means "no change"), so a field DROPPED from
// the template must be sent as its explicit CFn-default / SDK-documented clear
// sentinel, else the old live value silently persists (CloudFormation resets
// removed properties to their defaults). Reference fix pattern:
// the shared `clearOnUpdateRemoval` helper (#1164 / #1157; extracted in #1223).
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
  it('resets only the properties CloudFormation resets and sends nothing for the nine it keeps (#5004, #1160)', async () => {
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
    // KEPT by CloudFormation (#5004): nothing is sent, so the live value stays.
    for (const key of [
      'HealthCheckType',
      'HealthCheckGracePeriod',
      'DefaultCooldown',
      'TerminationPolicies',
      'NewInstancesProtectedFromScaleIn',
      'CapacityRebalance',
      'DesiredCapacityType',
      'DefaultInstanceWarmup',
      'DeletionProtection',
    ]) {
      expect(input, key).not.toHaveProperty(key);
    }
    // RESET by CloudFormation (#5004 A/B).
    expect(input['MaxInstanceLifetime']).toBe(0);
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
    // RESET by CloudFormation (#1160 A/B): zonal shift off, previous behavior.
    expect(input['AvailabilityZoneImpairmentPolicy']).toEqual({
      ZonalShiftEnabled: false,
      ImpairedZoneHealthCheckBehavior: 'IgnoreUnhealthy',
    });
  });

  // go-to-k/cdkd#1160 CloudFormation A/B (CloudTrail showed the exact
  // UpdateAutoScalingGroup input CloudFormation sent on each removal).
  it('resets a removed AvailabilityZoneImpairmentPolicy the way CloudFormation does: zonal shift off, previous behavior re-sent', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 1 },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 1,
        AvailabilityZoneImpairmentPolicy: {
          ZonalShiftEnabled: true,
          ImpairedZoneHealthCheckBehavior: 'ReplaceUnhealthy',
        },
      }
    );

    expect(updateCallInput()['AvailabilityZoneImpairmentPolicy']).toEqual({
      ZonalShiftEnabled: false,
      ImpairedZoneHealthCheckBehavior: 'ReplaceUnhealthy',
    });
  });

  // Defensive branch only: the CloudFormation schema requires both members
  // (nested-required.generated.ts), so no deployable template records a policy
  // without ImpairedZoneHealthCheckBehavior. Whether AWS accepts this shape is
  // unmeasured; the case pins only that no non-string value is forwarded.
  it('sends only ZonalShiftEnabled: false when the removed policy carried no behavior string (schema-unreachable defensive branch; AWS acceptance unmeasured)', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 1 },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 1,
        AvailabilityZoneImpairmentPolicy: { ZonalShiftEnabled: true },
      }
    );

    expect(updateCallInput()['AvailabilityZoneImpairmentPolicy']).toEqual({
      ZonalShiftEnabled: false,
    });
  });

  it('passes a kept AvailabilityZoneImpairmentPolicy through verbatim', async () => {
    const provider = new ASGProvider();
    const policy = { ZonalShiftEnabled: true, ImpairedZoneHealthCheckBehavior: 'IgnoreUnhealthy' };
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 1, AvailabilityZoneImpairmentPolicy: policy },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 1,
        AvailabilityZoneImpairmentPolicy: {
          ZonalShiftEnabled: true,
          ImpairedZoneHealthCheckBehavior: 'ReplaceUnhealthy',
        },
      }
    );

    expect(updateCallInput()['AvailabilityZoneImpairmentPolicy']).toEqual(policy);
  });

  it('sends nothing for a removed DesiredCapacity, ServiceLinkedRoleARN, SkipZonalShiftValidation or Context (CloudFormation keeps / cannot reset them)', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 1 },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 1,
        DesiredCapacity: 1,
        ServiceLinkedRoleARN:
          'arn:aws:iam::123456789012:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling_custom',
        SkipZonalShiftValidation: true,
        Context: 'reserved',
      }
    );

    const input = updateCallInput();
    for (const key of [
      'DesiredCapacity',
      'ServiceLinkedRoleARN',
      'SkipZonalShiftValidation',
      'Context',
    ]) {
      expect(input, key).not.toHaveProperty(key);
    }
  });

  it('sends only the newly declared member on a LaunchTemplate -> MixedInstancesPolicy and VPCZoneIdentifier -> AvailabilityZones switch, as CloudFormation does', async () => {
    const provider = new ASGProvider();
    const mixedInstancesPolicy = {
      LaunchTemplate: {
        LaunchTemplateSpecification: { LaunchTemplateId: 'lt-0123', Version: '1' },
        Overrides: [{ InstanceType: 't3.nano' }, { InstanceType: 't3.micro' }],
      },
    };
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        MixedInstancesPolicy: mixedInstancesPolicy,
        AvailabilityZones: ['us-east-1a', 'us-east-1b'],
      },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        LaunchTemplate: { LaunchTemplateId: 'lt-0123', Version: '1' },
        VPCZoneIdentifier: ['subnet-a', 'subnet-b'],
      }
    );

    const input = updateCallInput();
    expect(input['MixedInstancesPolicy']).toEqual(mixedInstancesPolicy);
    expect(input['AvailabilityZones']).toEqual(['us-east-1a', 'us-east-1b']);
    expect(input).not.toHaveProperty('LaunchTemplate');
    expect(input).not.toHaveProperty('VPCZoneIdentifier');
  });

  it('sends only LaunchTemplate and VPCZoneIdentifier on the reverse switch, as CloudFormation does', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        LaunchTemplate: { LaunchTemplateId: 'lt-0123', Version: '1' },
        VPCZoneIdentifier: ['subnet-a', 'subnet-b'],
      },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        MixedInstancesPolicy: {
          LaunchTemplate: {
            LaunchTemplateSpecification: { LaunchTemplateId: 'lt-0123', Version: '1' },
          },
        },
        AvailabilityZones: ['us-east-1a', 'us-east-1b'],
      }
    );

    const input = updateCallInput();
    expect(input['LaunchTemplate']).toEqual({ LaunchTemplateId: 'lt-0123', Version: '1' });
    expect(input['VPCZoneIdentifier']).toBe('subnet-a,subnet-b');
    expect(input).not.toHaveProperty('MixedInstancesPolicy');
    expect(input).not.toHaveProperty('AvailabilityZones');
  });

  it('sends nothing for a removed DefaultCooldown spelling (CloudFormation keeps it, #5004)', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 0 },
      { AutoScalingGroupName: ASG_NAME, MinSize: 0, MaxSize: 0, DefaultCooldown: 240 }
    );

    expect(updateCallInput()).not.toHaveProperty('DefaultCooldown');
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

  it('passes kept/changed fields through unchanged while resetting only the removed ones CloudFormation resets', async () => {
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
    // Removed fields: MaxInstanceLifetime is reset (CloudFormation resets it);
    // CapacityRebalance is KEPT by CloudFormation, so nothing is sent (#5004).
    expect(input['MaxInstanceLifetime']).toBe(0);
    expect(input).not.toHaveProperty('CapacityRebalance');
    // Never-present stays absent.
    expect(input['DesiredCapacityType']).toBeUndefined();
  });

  // Issue #1225 — sub-field removal inside a KEPT config object (the #1160
  // bug class one level down). These pins record the DELIBERATE pass-through
  // classification (see the comment block in asg-provider.ts update()):
  // a kept-but-partial object goes to AWS verbatim, never normalized.
  it('passes a kept-but-partial InstanceMaintenancePolicy through verbatim (AWS loud-rejects — CFn parity, issue #1225)', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        // Kept block with MaxHealthyPercentage DROPPED — the SDK doc requires
        // both sub-fields, so AWS rejects this request; CloudFormation submits
        // the same partial object, so the loud failure is parity. No sub-field
        // synthesis (-1 or otherwise) may be injected here.
        InstanceMaintenancePolicy: { MinHealthyPercentage: 80 },
      },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        InstanceMaintenancePolicy: { MinHealthyPercentage: 90, MaxHealthyPercentage: 110 },
      }
    );

    const input = updateCallInput();
    expect(input['InstanceMaintenancePolicy']).toEqual({ MinHealthyPercentage: 80 });
  });

  it('passes a kept-but-partial CapacityReservationSpecification through verbatim (unprobed — issue #1225)', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        // Kept block with CapacityReservationTarget DROPPED — whether AWS
        // keeps or clears the previously-set target is unprobed (a live probe
        // needs a billed Capacity Reservation); the partial object must pass
        // through unchanged, with no synthesized target or preference.
        CapacityReservationSpecification: { CapacityReservationPreference: 'none' },
      },
      {
        AutoScalingGroupName: ASG_NAME,
        MinSize: 0,
        MaxSize: 0,
        CapacityReservationSpecification: {
          CapacityReservationPreference: 'capacity-reservations-only',
          CapacityReservationTarget: { CapacityReservationIds: ['cr-0123456789abcdef0'] },
        },
      }
    );

    const input = updateCallInput();
    expect(input['CapacityReservationSpecification']).toEqual({
      CapacityReservationPreference: 'none',
    });
  });
});
