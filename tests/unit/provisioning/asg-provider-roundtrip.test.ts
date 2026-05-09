import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

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
  CreateAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  DescribeLifecycleHooksCommand,
  DescribeTrafficSourcesCommand,
  DescribeNotificationConfigurationsCommand,
  EnableMetricsCollectionCommand,
  DisableMetricsCollectionCommand,
  PutLifecycleHookCommand,
  DeleteLifecycleHookCommand,
  AttachTrafficSourcesCommand,
  DetachTrafficSourcesCommand,
  PutNotificationConfigurationCommand,
  DeleteNotificationConfigurationCommand,
} from '@aws-sdk/client-auto-scaling';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::AutoScaling::AutoScalingGroup';

beforeEach(() => {
  mockSend.mockReset();
});

describe('ASGProvider create', () => {
  it('issues CreateAutoScalingGroup with templated subset and joins VPCZoneIdentifier into a comma string', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateAutoScalingGroupCommand) return Promise.resolve({});
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        return Promise.resolve({
          AutoScalingGroups: [
            {
              AutoScalingGroupName: 'my-asg',
              AutoScalingGroupARN:
                'arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:abc:autoScalingGroupName/my-asg',
              MinSize: 1,
              MaxSize: 3,
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const provider = new ASGProvider();
    const result = await provider.create('MyAsg', RESOURCE_TYPE, {
      AutoScalingGroupName: 'my-asg',
      MinSize: 1,
      MaxSize: 3,
      DesiredCapacity: 2,
      LaunchTemplate: { LaunchTemplateId: 'lt-aaaa1111', Version: '$Latest' },
      VPCZoneIdentifier: ['subnet-aaaa1111', 'subnet-bbbb2222'],
      HealthCheckType: 'EC2',
      HealthCheckGracePeriod: 60,
      Tags: [{ Key: 'env', Value: 'dev', PropagateAtLaunch: true }],
      DeletionProtection: 'prevent-force-deletion',
    });

    expect(result.physicalId).toBe('my-asg');
    const createCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof CreateAutoScalingGroupCommand);
    expect(createCalls).toHaveLength(1);
    const input = (createCalls[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['AutoScalingGroupName']).toBe('my-asg');
    expect(input['MinSize']).toBe(1);
    expect(input['MaxSize']).toBe(3);
    expect(input['DesiredCapacity']).toBe(2);
    expect(input['LaunchTemplate']).toEqual({
      LaunchTemplateId: 'lt-aaaa1111',
      Version: '$Latest',
    });
    expect(input['VPCZoneIdentifier']).toBe('subnet-aaaa1111,subnet-bbbb2222');
    expect(input['HealthCheckType']).toBe('EC2');
    expect(input['HealthCheckGracePeriod']).toBe(60);
    expect(input['DeletionProtection']).toBe('prevent-force-deletion');
    expect(input['Tags']).toEqual([
      {
        ResourceId: 'my-asg',
        ResourceType: 'auto-scaling-group',
        Key: 'env',
        Value: 'dev',
        PropagateAtLaunch: true,
      },
    ]);
  });

  it('falls back to a generated physicalId when AutoScalingGroupName is omitted', async () => {
    mockSend.mockResolvedValue({});
    const provider = new ASGProvider();
    const result = await provider.create('SomeLogicalId', RESOURCE_TYPE, {
      MinSize: 0,
      MaxSize: 1,
    });
    expect(result.physicalId).toBeTruthy();
    expect(result.physicalId).not.toBe('');
  });

  it('coerces numeric LaunchTemplate.Version to a string before sending to AWS', async () => {
    // AWS rejects `CreateAutoScalingGroup` when `Version` is a JSON number
    // ("Invalid launch template version: either '$Default', '$Latest', or
    // a numeric version are allowed."). CDK templates emit `Version` from
    // `Fn::GetAtt <LaunchTemplate>.LatestVersionNumber`, which cdkd's
    // intrinsic resolver can return as a JS number — guard at the wire
    // layer with `String(...)`.
    mockSend.mockResolvedValue({});
    const provider = new ASGProvider();
    await provider.create('MyAsg', RESOURCE_TYPE, {
      AutoScalingGroupName: 'my-asg',
      MinSize: 0,
      MaxSize: 1,
      LaunchTemplate: { LaunchTemplateId: 'lt-aaaa1111', Version: 1 as unknown as string },
    });
    const createCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof CreateAutoScalingGroupCommand);
    expect(createCalls).toHaveLength(1);
    const input = (createCalls[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['LaunchTemplate']).toEqual({
      LaunchTemplateId: 'lt-aaaa1111',
      Version: '1',
    });
  });
});

describe('ASGProvider update', () => {
  it('issues UpdateAutoScalingGroup with mutable diff and skips immutable AutoScalingGroupName diff', async () => {
    mockSend.mockResolvedValue({});
    const provider = new ASGProvider();

    await expect(
      provider.update(
        'MyAsg',
        'my-asg',
        RESOURCE_TYPE,
        { AutoScalingGroupName: 'renamed' },
        { AutoScalingGroupName: 'my-asg' }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
  });

  it('rejects Tags / LoadBalancerNames / TargetGroupARNs diffs (sub-shape diffs covered separately)', async () => {
    mockSend.mockResolvedValue({});
    const provider = new ASGProvider();
    const cases: Array<{ key: string; before: unknown; after: unknown }> = [
      { key: 'Tags', before: [], after: [{ Key: 'env', Value: 'dev' }] },
      { key: 'LoadBalancerNames', before: [], after: ['lb-1'] },
      { key: 'TargetGroupARNs', before: [], after: ['arn:tg:1'] },
    ];
    for (const c of cases) {
      const before = { AutoScalingGroupName: 'my-asg', [c.key]: c.before };
      const after = { AutoScalingGroupName: 'my-asg', [c.key]: c.after };
      await expect(
        provider.update('MyAsg', 'my-asg', RESOURCE_TYPE, after, before)
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
    }
  });

  it('updates mutable fields in place without firing CreateAutoScalingGroup', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof UpdateAutoScalingGroupCommand) return Promise.resolve({});
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        return Promise.resolve({
          AutoScalingGroups: [
            {
              AutoScalingGroupName: 'my-asg',
              AutoScalingGroupARN: 'arn:asg:my-asg',
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const provider = new ASGProvider();
    const before = {
      AutoScalingGroupName: 'my-asg',
      MinSize: 1,
      MaxSize: 3,
      HealthCheckType: 'EC2',
    };
    const after = {
      AutoScalingGroupName: 'my-asg',
      MinSize: 1,
      MaxSize: 5,
      HealthCheckType: 'ELB',
      HealthCheckGracePeriod: 120,
    };
    await provider.update('MyAsg', 'my-asg', RESOURCE_TYPE, after, before);

    const updateCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateAutoScalingGroupCommand);
    expect(updateCalls).toHaveLength(1);
    const input = (updateCalls[0] as unknown as { input: Record<string, unknown> }).input;
    expect(input['AutoScalingGroupName']).toBe('my-asg');
    expect(input['MaxSize']).toBe(5);
    expect(input['HealthCheckType']).toBe('ELB');
    expect(input['HealthCheckGracePeriod']).toBe(120);
    expect(
      mockSend.mock.calls.some((c) => c[0] instanceof CreateAutoScalingGroupCommand)
    ).toBe(false);
  });
});

describe('ASGProvider delete', () => {
  it('without removeProtection, ForceDelete is false and no flip-off is issued', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteAutoScalingGroupCommand) return Promise.resolve({});
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        // Group is gone — simulate ValidationError so waitForGroupDeleted exits.
        const err = new Error('AutoScalingGroup name not found') as Error & { name: string };
        err.name = 'ValidationError';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const provider = new ASGProvider();
    await provider.delete('MyAsg', 'my-asg', RESOURCE_TYPE);

    const cmds = mockSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof UpdateAutoScalingGroupCommand)).toBe(false);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteAutoScalingGroupCommand);
    expect(delIdx).toBeGreaterThanOrEqual(0);
    const delInput = (cmds[delIdx] as unknown as { input: Record<string, unknown> }).input;
    expect(delInput['AutoScalingGroupName']).toBe('my-asg');
    expect(delInput['ForceDelete']).toBe(false);
  });

  it('with removeProtection=true, flips DeletionProtection off via UpdateAutoScalingGroup before DeleteAutoScalingGroup with ForceDelete=true', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteAutoScalingGroupCommand) return Promise.resolve({});
      if (command instanceof UpdateAutoScalingGroupCommand) return Promise.resolve({});
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        const err = new Error('AutoScalingGroup name not found') as Error & { name: string };
        err.name = 'ValidationError';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const provider = new ASGProvider();
    await provider.delete('MyAsg', 'my-asg', RESOURCE_TYPE, undefined, {
      removeProtection: true,
    });

    const cmds = mockSend.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof UpdateAutoScalingGroupCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteAutoScalingGroupCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(flipIdx);
    const flipInput = (cmds[flipIdx] as unknown as { input: Record<string, unknown> }).input;
    expect(flipInput['AutoScalingGroupName']).toBe('my-asg');
    expect(flipInput['DeletionProtection']).toBe('none');
    const delInput = (cmds[delIdx] as unknown as { input: Record<string, unknown> }).input;
    expect(delInput['ForceDelete']).toBe(true);
  });

  it('idempotent — UpdateAutoScalingGroup is still issued when AWS already has DeletionProtection=none', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteAutoScalingGroupCommand) return Promise.resolve({});
      if (command instanceof UpdateAutoScalingGroupCommand) return Promise.resolve({});
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        const err = new Error('AutoScalingGroup name not found') as Error & { name: string };
        err.name = 'ValidationError';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const provider = new ASGProvider();
    await provider.delete('MyAsg', 'my-asg', RESOURCE_TYPE, undefined, {
      removeProtection: true,
    });

    expect(
      mockSend.mock.calls.some((c) => c[0] instanceof UpdateAutoScalingGroupCommand)
    ).toBe(true);
  });

  it('treats ValidationError "AutoScalingGroup name not found" as idempotent success', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteAutoScalingGroupCommand) {
        const err = new Error('AutoScalingGroup name not found') as Error & { name: string };
        err.name = 'ValidationError';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });
    const provider = new ASGProvider();
    await expect(provider.delete('MyAsg', 'my-asg', RESOURCE_TYPE)).resolves.toBeUndefined();
  });
});

describe('ASGProvider getAttribute', () => {
  it('returns AutoScalingGroupARN under Arn', async () => {
    mockSend.mockResolvedValue({
      AutoScalingGroups: [
        {
          AutoScalingGroupName: 'my-asg',
          AutoScalingGroupARN: 'arn:aws:autoscaling:us-east-1:123:my-asg',
          LaunchTemplate: { LaunchTemplateId: 'lt-zzzz9999' },
        },
      ],
    });
    const provider = new ASGProvider();
    expect(await provider.getAttribute('my-asg', RESOURCE_TYPE, 'Arn')).toBe(
      'arn:aws:autoscaling:us-east-1:123:my-asg'
    );
    expect(await provider.getAttribute('my-asg', RESOURCE_TYPE, 'LaunchTemplateID')).toBe(
      'lt-zzzz9999'
    );
  });
});

describe('ASGProvider readCurrentState', () => {
  it('surfaces user-controllable subset with always-emit placeholders for v3 baseline', async () => {
    mockSend.mockResolvedValue({
      AutoScalingGroups: [
        {
          AutoScalingGroupName: 'my-asg',
          AutoScalingGroupARN: 'arn:asg:my-asg',
          MinSize: 1,
          MaxSize: 3,
          DesiredCapacity: 2,
          DefaultCooldown: 300,
          AvailabilityZones: ['us-east-1a', 'us-east-1b'],
          HealthCheckType: 'EC2',
          HealthCheckGracePeriod: 60,
          NewInstancesProtectedFromScaleIn: false,
          TerminationPolicies: ['Default'],
          CapacityRebalance: false,
          VPCZoneIdentifier: 'subnet-aaaa1111,subnet-bbbb2222',
          Tags: [
            {
              Key: 'env',
              Value: 'dev',
              PropagateAtLaunch: true,
              ResourceId: 'my-asg',
              ResourceType: 'auto-scaling-group',
            },
            // CDK auto-tag — must be filtered out so it doesn't fire false drift.
            { Key: 'aws:cdk:path', Value: 'MyStack/MyAsg', PropagateAtLaunch: false },
          ],
          // DeletionProtection is omitted by AWS when 'none' — provider
          // emits a placeholder.
        },
      ],
    });
    const provider = new ASGProvider();
    const state = await provider.readCurrentState('my-asg', 'MyAsg', RESOURCE_TYPE);
    expect(state).toBeDefined();
    expect(state?.['VPCZoneIdentifier']).toEqual(['subnet-aaaa1111', 'subnet-bbbb2222']);
    expect(state?.['MinSize']).toBe(1);
    expect(state?.['MaxSize']).toBe(3);
    expect(state?.['DesiredCapacity']).toBe(2);
    expect(state?.['Cooldown']).toBe(300);
    expect(state?.['DeletionProtection']).toBe('none');
    expect(state?.['LoadBalancerNames']).toEqual([]);
    expect(state?.['TargetGroupARNs']).toEqual([]);
    expect(state?.['Tags']).toEqual([{ Key: 'env', Value: 'dev' }]);
  });

  it('returns undefined when AWS reports the group is gone', async () => {
    mockSend.mockImplementation(() => {
      const err = new Error('AutoScalingGroup name not found') as Error & { name: string };
      err.name = 'ValidationError';
      return Promise.reject(err);
    });
    const provider = new ASGProvider();
    const result = await provider.readCurrentState('missing', 'M', RESOURCE_TYPE);
    expect(result).toBeUndefined();
  });
});

