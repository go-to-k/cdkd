// issue #5004: a real CloudFormation A/B showed CloudFormation KEEPS the live
// value of the default-policy shorthand fields (CreateInterval, RetainInterval,
// CopyTags, ExtendDeletion, CrossRegionCopyTargets, Exclusions) when one is
// removed from the template. UpdateLifecyclePolicy merges absent members, so
// cdkd sends NOTHING for a removed member (superseding the #1160 resets).
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

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
    warn: mockWarn,
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
import {
  UpdateLifecyclePolicyCommand,
  GetLifecyclePolicyCommand,
  TagResourceCommand,
} from '@aws-sdk/client-dlm';
import { prepareRemovalForUpdate } from '../../../../src/provisioning/update-removal.js';

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

// issue #5546: a CloudFormation A/B (us-east-1, 2026-10-30) showed CFn KEEPS a
// removed Description (alone and beside another change), ExecutionRoleArn,
// State and PolicyDetails too: its UpdateLifecyclePolicy request omitted the
// member and GetLifecyclePolicy kept the old value. cdkd keeps them and names
// each kept removal in ONE warning.
describe('DLMLifecyclePolicyProvider names a kept removed property (issue #5546)', () => {
  let provider: DLMLifecyclePolicyProvider;
  const BASE = {
    ExecutionRoleArn: ROLE_ARN,
    State: 'DISABLED',
    PolicyDetails: { ResourceTypes: ['VOLUME'] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetLifecyclePolicyCommand) {
        return Promise.resolve({ Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } });
      }
      return Promise.resolve({});
    });
  });

  function keptWarnings(): string[] {
    return mockWarn.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((line) => line.includes('AWS::DLM::LifecyclePolicy'));
  }

  it('warns once naming a removed Description, and sends none', async () => {
    const previous = { ...BASE, Description: 'old description' };
    await provider.update('Policy', POLICY_ID, RESOURCE_TYPE, { ...BASE }, previous, {
      removedProperties: new Set(['Description']),
    });

    const call = mockSend.mock.calls.find(
      (c: unknown[]) => c[0] instanceof UpdateLifecyclePolicyCommand
    );
    expect('Description' in (call?.[0] as UpdateLifecyclePolicyCommand).input).toBe(false);
    expect(keptWarnings()).toEqual([
      'Policy (AWS::DLM::LifecyclePolicy): property Description was removed from the template and keeps its current AWS value, as CloudFormation leaves it; UpdateLifecyclePolicy keeps a field it is not sent. Declare the intended value explicitly to change it.',
    ]);
  });

  it('names several kept removals in one line, in a fixed order', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { PolicyDetails: BASE.PolicyDetails },
      { ...BASE, Description: 'd', CopyTags: true },
      { removedProperties: new Set(['CopyTags', 'State', 'Description', 'ExecutionRoleArn']) }
    );

    const lines = keptWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'properties Description, ExecutionRoleArn, State, CopyTags were removed from the template and keep their current AWS value, as CloudFormation leaves them;'
    );
  });

  it('uses the rollback wording when replaying a state record', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ...BASE },
      { ...BASE, Description: 'added by the failed deploy' },
      { removedProperties: new Set(['Description']), replayingState: true }
    );

    expect(keptWarnings()).toEqual([
      'Policy (AWS::DLM::LifecyclePolicy): property Description is absent from the state being restored; UpdateLifecyclePolicy keeps a field it is not sent, so the rollback leaves the value the failed deploy applied in place.',
    ]);
  });

  it('warns about nothing on drift --revert (empty removedProperties)', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ...BASE },
      { ...BASE, Description: 'read back' },
      { removedProperties: new Set() }
    );

    expect(keptWarnings()).toEqual([]);
  });

  it('compares the bags on a direct call, skipping a recorded explicit null', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ...BASE },
      { ...BASE, Description: 'old', CopyTags: null }
    );

    const lines = keptWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('property Description was removed');
  });

  it('names a desired explicit null, which is sent as absent and so kept', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ...BASE, Description: null },
      { ...BASE, Description: 'old' },
      { removedProperties: new Set(), replayingState: true }
    );

    const lines = keptWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('property Description is absent from the state being restored');
  });

  it('warns about nothing when the desired side is an AWS readback', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ...BASE },
      { ...BASE, Description: 'read back' },
      { removedProperties: new Set(['Description']), desiredFromAwsReadback: true }
    );

    expect(keptWarnings()).toEqual([]);
  });

  it('still names the kept removal when a later tag call fails', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetLifecyclePolicyCommand) {
        return Promise.resolve({ Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } });
      }
      if (cmd instanceof TagResourceCommand) return Promise.reject(new Error('AccessDenied'));
      return Promise.resolve({});
    });
    await expect(
      provider.update(
        'Policy',
        POLICY_ID,
        RESOURCE_TYPE,
        { ...BASE, Tags: [{ Key: 'k', Value: 'new' }] },
        { ...BASE, Description: 'old', Tags: [{ Key: 'k', Value: 'old' }] },
        { removedProperties: new Set(['Description']) }
      )
    ).rejects.toThrow();

    expect(keptWarnings()).toHaveLength(1);
    expect(keptWarnings()[0]).toContain('property Description was removed');
  });

  it('warns about nothing when nothing was removed', async () => {
    await provider.update(
      'Policy',
      POLICY_ID,
      RESOURCE_TYPE,
      { ...BASE, Description: 'new' },
      { ...BASE, Description: 'old' },
      { removedProperties: new Set() }
    );

    expect(keptWarnings()).toEqual([]);
  });

  it('does not warn when the update fails', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    await expect(
      provider.update(
        'Policy',
        POLICY_ID,
        RESOURCE_TYPE,
        { ...BASE },
        { ...BASE, Description: 'old' },
        { removedProperties: new Set(['Description']) }
      )
    ).rejects.toThrow();

    expect(keptWarnings()).toEqual([]);
  });

  it('registers every handled property in removalHandledInUpdate, so the shared caller names none', () => {
    const handled = provider.handledProperties.get(RESOURCE_TYPE);
    const removal = provider.removalHandledInUpdate.get(RESOURCE_TYPE);
    expect(handled).toBeDefined();
    expect(removal).toBeDefined();
    expect([...(removal ?? [])].sort()).toEqual([...(handled ?? [])].sort());

    const prep = prepareRemovalForUpdate(provider, RESOURCE_TYPE, { ...BASE }, {
      ...BASE,
      Description: 'old',
      Tags: [{ Key: 'k', Value: 'v' }],
    });
    expect(prep.unhandled).toEqual([]);
  });
});
