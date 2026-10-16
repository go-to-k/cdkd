// issue #5004: a real CloudFormation A/B showed CloudFormation KEEPS the live
// value of the default-policy shorthand fields (CreateInterval, RetainInterval,
// CopyTags, ExtendDeletion, CrossRegionCopyTargets, Exclusions) when one is
// removed from the template. UpdateLifecyclePolicy merges absent members, so
// cdkd sends NOTHING for a removed member (superseding the #1160 resets).
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dlm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dlm')>();
  return {
    ...actual,
    DLMClient: vi.fn().mockImplementation(() => ({
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

import { DLMLifecyclePolicyProvider } from '../../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js';
import { UpdateLifecyclePolicyCommand, GetLifecyclePolicyCommand } from '@aws-sdk/client-dlm';

const RESOURCE_TYPE = 'AWS::DLM::LifecyclePolicy';
const POLICY_ID = 'policy-0123456789abcdef0';
const POLICY_ARN = `arn:aws:dlm:us-east-1:123456789012:policy/${POLICY_ID}`;
const ROLE_ARN = 'arn:aws:iam::123456789012:role/dlm-role';

describe('DLMLifecyclePolicyProvider removal keeps the live value like CloudFormation (issue #5004)', () => {
  let provider: DLMLifecyclePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
    // update() flow: UpdateLifecyclePolicy, then GetLifecyclePolicy for the
    // tag-diff ARN. Tags are unchanged in these tests, so no tag calls.
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetLifecyclePolicyCommand) {
        return Promise.resolve({ Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } });
      }
      return Promise.resolve({});
    });
  });

  function sentUpdateInput(): Record<string, unknown> {
    const call = mockSend.mock.calls.find(
      (c: unknown[]) => c[0] instanceof UpdateLifecyclePolicyCommand
    );
    expect(call).toBeDefined();
    return (call?.[0] as UpdateLifecyclePolicyCommand).input as unknown as Record<string, unknown>;
  }

  const FIELDS = [
    'CreateInterval',
    'RetainInterval',
    'CopyTags',
    'ExtendDeletion',
    'CrossRegionCopyTargets',
    'Exclusions',
  ];

  it('sends NO reset for any removed VOLUME shorthand field (CFn keeps the live value)', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ExecutionRoleArn: ROLE_ARN, State: 'DISABLED', DefaultPolicy: 'VOLUME' },
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CreateInterval: 2,
        RetainInterval: 3,
        CopyTags: true,
        ExtendDeletion: true,
        CrossRegionCopyTargets: [{ TargetRegion: 'us-west-2' }],
        Exclusions: { ExcludeBootVolumes: true, ExcludeTags: [{ Key: 'skip', Value: 'yes' }] },
      }
    );

    const input = sentUpdateInput();
    for (const key of FIELDS) expect(key in input).toBe(false);
  });

  it('sends NO Exclusions reset for a removed INSTANCE Exclusions', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ExecutionRoleArn: ROLE_ARN, State: 'DISABLED', DefaultPolicy: 'INSTANCE' },
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'INSTANCE',
        Exclusions: { ExcludeTags: [{ Key: 'skip', Value: 'yes' }] },
      }
    );

    expect('Exclusions' in sentUpdateInput()).toBe(false);
  });

  it('leaves never-present fields absent', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ExecutionRoleArn: ROLE_ARN, State: 'ENABLED', DefaultPolicy: 'VOLUME' },
      { ExecutionRoleArn: ROLE_ARN, State: 'DISABLED', DefaultPolicy: 'VOLUME' }
    );

    const input = sentUpdateInput();
    for (const key of FIELDS) expect(key in input).toBe(false);
  });

  it('passes kept fields through while sending nothing for the removed ones', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ExecutionRoleArn: ROLE_ARN, State: 'DISABLED', DefaultPolicy: 'VOLUME', CreateInterval: 3 },
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CreateInterval: 2,
        CopyTags: true,
      }
    );

    const input = sentUpdateInput();
    expect(input['CreateInterval']).toBe(3);
    expect('CopyTags' in input).toBe(false);
    expect('RetainInterval' in input).toBe(false);
  });

  it('passes kept CrossRegionCopyTargets and Exclusions through unchanged', async () => {
    const targets = [{ TargetRegion: 'eu-west-1' }];
    const exclusions = { ExcludeBootVolumes: true, ExcludeTags: [{ Key: 'skip', Value: 'yes' }] };
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CrossRegionCopyTargets: targets,
        Exclusions: exclusions,
      },
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CrossRegionCopyTargets: [{ TargetRegion: 'us-west-2' }],
        Exclusions: { ExcludeTags: [] },
      }
    );

    const input = sentUpdateInput();
    expect(input['CrossRegionCopyTargets']).toEqual(targets);
    expect(input['Exclusions']).toEqual(exclusions);
  });

  it('treats an explicit-null side as absent', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CreateInterval: null,
      },
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CopyTags: null,
        Exclusions: null,
      }
    );

    const input = sentUpdateInput();
    expect('CreateInterval' in input).toBe(false);
    expect('CopyTags' in input).toBe(false);
    expect('Exclusions' in input).toBe(false);
  });

  it('Number()-coerces a kept string numeric and sends nothing for a removed one', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CreateInterval: '3',
      },
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CreateInterval: '2',
        RetainInterval: '5',
      }
    );

    const input = sentUpdateInput();
    expect(input['CreateInterval']).toBe(3);
    expect('RetainInterval' in input).toBe(false);
  });

  it('does NOT reset a removed Description (no API clear sentinel)', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ExecutionRoleArn: ROLE_ARN, State: 'DISABLED', DefaultPolicy: 'VOLUME' },
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        Description: 'old description',
      }
    );

    expect('Description' in sentUpdateInput()).toBe(false);
  });
});
