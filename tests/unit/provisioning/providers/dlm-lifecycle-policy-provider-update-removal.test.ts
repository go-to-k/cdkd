// issue #1160: absent-field removal reset to CFn defaults (dlm batch).
// UpdateLifecyclePolicy uses merge semantics (live-probed 2026-07-27: an
// update carrying only PolicyId retains every live value), so a
// default-policy shorthand field DROPPED from the template must be sent as
// its explicit default — CreateInterval->1, RetainInterval->7,
// CopyTags->false, ExtendDeletion->false, CrossRegionCopyTargets->[],
// Exclusions->the per-DefaultPolicy explicit-empty shape — else the old
// live value silently persists.
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

describe('DLMLifecyclePolicyProvider removal reset to CFn defaults (issue #1160)', () => {
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

  it('resets all removed VOLUME default-policy shorthand fields to their defaults', async () => {
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
    expect(input['CreateInterval']).toBe(1);
    expect(input['RetainInterval']).toBe(7);
    expect(input['CopyTags']).toBe(false);
    expect(input['ExtendDeletion']).toBe(false);
    expect(input['CrossRegionCopyTargets']).toEqual([]);
    expect(input['Exclusions']).toEqual({
      ExcludeBootVolumes: false,
      ExcludeVolumeTypes: [],
      ExcludeTags: [],
    });
  });

  it('uses the INSTANCE clear shape for a removed Exclusions (volume-only sub-fields rejected there)', async () => {
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

    const input = sentUpdateInput();
    expect(input['Exclusions']).toEqual({ ExcludeTags: [] });
  });

  it('leaves never-present fields absent (no spurious reset)', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ExecutionRoleArn: ROLE_ARN, State: 'ENABLED', DefaultPolicy: 'VOLUME' },
      { ExecutionRoleArn: ROLE_ARN, State: 'DISABLED', DefaultPolicy: 'VOLUME' }
    );

    const input = sentUpdateInput();
    for (const key of [
      'CreateInterval',
      'RetainInterval',
      'CopyTags',
      'ExtendDeletion',
      'CrossRegionCopyTargets',
      'Exclusions',
    ]) {
      expect(key in input).toBe(false);
    }
  });

  it('passes kept fields through while resetting only the removed ones', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        DefaultPolicy: 'VOLUME',
        CreateInterval: 3,
      },
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
    expect(input['CopyTags']).toBe(false);
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

  it('treats an explicit-null side as absent (no spurious reset — the != null guards)', async () => {
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
    // null new side with absent previous -> nothing to reset; null previous
    // side must not fire a reset either.
    expect('CreateInterval' in input).toBe(false);
    expect('CopyTags' in input).toBe(false);
    expect('Exclusions' in input).toBe(false);
  });

  it('Number()-coerces string-form numerics on both the kept and the removed path', async () => {
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
    // kept string value -> coerced number wins over toSdkFields' raw spread
    expect(input['CreateInterval']).toBe(3);
    // removed string value -> reset to the numeric default
    expect(input['RetainInterval']).toBe(7);
  });

  it('does NOT reset a removed Description (no API clear sentinel — documented deferral)', async () => {
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

    const input = sentUpdateInput();
    expect('Description' in input).toBe(false);
  });

  it('does NOT synthesize an Exclusions clear without a known DefaultPolicy type', async () => {
    // A standard policy cannot legitimately carry Exclusions, but the gate
    // must not guess a clear shape when the policy kind is unknown.
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ExecutionRoleArn: ROLE_ARN, State: 'DISABLED' },
      {
        ExecutionRoleArn: ROLE_ARN,
        State: 'DISABLED',
        Exclusions: { ExcludeTags: [{ Key: 'skip', Value: 'yes' }] },
      }
    );

    const input = sentUpdateInput();
    expect('Exclusions' in input).toBe(false);
  });
});
