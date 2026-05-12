import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findPendingPrefixRenames,
  promptMigrationConfirm,
  type PendingRename,
} from '../../../src/cli/commands/prefix-migration-check.js';
import type { StackState, ResourceState } from '../../../src/types/state.js';

// Mock readline so promptMigrationConfirm doesn't actually open stdin.
vi.mock('node:readline/promises', () => {
  return {
    createInterface: vi.fn(),
  };
});

import * as readline from 'node:readline/promises';

function makeResource(physicalId: string, resourceType: string): ResourceState {
  return {
    physicalId,
    resourceType,
    properties: {},
    attributes: {},
    dependencies: [],
  };
}

function makeState(resources: Record<string, ResourceState>): StackState {
  return {
    version: 3,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  };
}

describe('findPendingPrefixRenames', () => {
  it('returns an empty list when state is undefined (first-time deploy)', () => {
    expect(findPendingPrefixRenames('MyStack', undefined)).toEqual([]);
  });

  it('skips a Pattern B resource whose physicalId equals exactly `${stackName}-` (empty suffix)', () => {
    // Edge case: `physicalId.slice('MyStack-'.length) === ''`. Reporting
    // a `→ ""` rename would surface a non-actionable line.
    const state = makeState({
      Role: makeResource('MyStack-', 'AWS::IAM::Role'),
    });
    expect(findPendingPrefixRenames('MyStack', state)).toEqual([]);
  });

  it('returns an empty list when state has no Pattern B resources', () => {
    const state = makeState({
      Bucket: makeResource('MyStack-my-bucket', 'AWS::S3::Bucket'),
      Queue: makeResource('MyStack-my-queue', 'AWS::SQS::Queue'),
      Fn: makeResource('MyStack-my-fn', 'AWS::Lambda::Function'),
    });
    expect(findPendingPrefixRenames('MyStack', state)).toEqual([]);
  });

  it('returns an empty list when all Pattern B resources are already unprefixed', () => {
    const state = makeState({
      Role: makeResource('my-role', 'AWS::IAM::Role'),
      Lb: makeResource('my-lb', 'AWS::ElasticLoadBalancingV2::LoadBalancer'),
    });
    expect(findPendingPrefixRenames('MyStack', state)).toEqual([]);
  });

  it('flags only the prefixed Pattern B resources when mixed with Pattern A and unprefixed Pattern B', () => {
    const state = makeState({
      // Pattern B, prefixed — should flag
      RoleA: makeResource('MyStack-role-a', 'AWS::IAM::Role'),
      // Pattern B, unprefixed — should pass through
      RoleB: makeResource('role-b', 'AWS::IAM::Role'),
      // Pattern A, prefixed (the prefix is real but the flag doesn't affect Pattern A) — must NOT flag
      Bucket: makeResource('MyStack-bucket', 'AWS::S3::Bucket'),
      // Pattern A, unprefixed
      Queue: makeResource('my-queue', 'AWS::SQS::Queue'),
    });
    const pending = findPendingPrefixRenames('MyStack', state);
    expect(pending).toEqual([
      {
        logicalId: 'RoleA',
        resourceType: 'AWS::IAM::Role',
        oldPhysicalId: 'MyStack-role-a',
        newPhysicalId: 'role-a',
      },
    ]);
  });

  it('covers every Pattern B type', () => {
    const state = makeState({
      Role: makeResource('MyStack-r', 'AWS::IAM::Role'),
      User: makeResource('MyStack-u', 'AWS::IAM::User'),
      Group: makeResource('MyStack-g', 'AWS::IAM::Group'),
      Profile: makeResource('MyStack-p', 'AWS::IAM::InstanceProfile'),
      Lb: makeResource('MyStack-lb', 'AWS::ElasticLoadBalancingV2::LoadBalancer'),
      Tg: makeResource('MyStack-tg', 'AWS::ElasticLoadBalancingV2::TargetGroup'),
    });
    const pending = findPendingPrefixRenames('MyStack', state);
    expect(pending).toHaveLength(6);
    expect(pending.map((p) => p.resourceType).sort()).toEqual([
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'AWS::IAM::Group',
      'AWS::IAM::InstanceProfile',
      'AWS::IAM::Role',
      'AWS::IAM::User',
    ]);
  });

  it('uses the supplied stackName as the prefix, not state.stackName', () => {
    // A defensive case: callers always pass the deploy-time stackName,
    // which should always match state.stackName, but the helper relies
    // on the argument so a mismatch is caught at the source.
    const state = makeState({
      Role: makeResource('OtherStack-role-a', 'AWS::IAM::Role'),
    });
    expect(findPendingPrefixRenames('MyStack', state)).toEqual([]);
    expect(findPendingPrefixRenames('OtherStack', state)).toEqual([
      {
        logicalId: 'Role',
        resourceType: 'AWS::IAM::Role',
        oldPhysicalId: 'OtherStack-role-a',
        newPhysicalId: 'role-a',
      },
    ]);
  });
});

describe('promptMigrationConfirm', () => {
  const fakeRenames: PendingRename[] = [
    {
      logicalId: 'Role',
      resourceType: 'AWS::IAM::Role',
      oldPhysicalId: 'MyStack-role',
      newPhysicalId: 'role',
    },
  ];

  // Save + restore stdin.isTTY so the non-TTY guard tests don't bleed
  // into the interactive-path tests below (vitest runs in non-TTY by
  // default; the interactive tests need to pretend they're in a TTY).
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.mocked(readline.createInterface).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore the original TTY state so per-test overrides don't leak.
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  function pretendTTY(): void {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
  }

  function pretendNonTTY(): void {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
  }

  it('returns true and skips the prompt when there are no renames', async () => {
    const ci = vi.mocked(readline.createInterface);
    const proceed = await promptMigrationConfirm([], { yes: false });
    expect(proceed).toBe(true);
    expect(ci).not.toHaveBeenCalled();
  });

  it('returns true without prompting when opts.yes is true', async () => {
    const ci = vi.mocked(readline.createInterface);
    const proceed = await promptMigrationConfirm(fakeRenames, { yes: true });
    expect(proceed).toBe(true);
    expect(ci).not.toHaveBeenCalled();
  });

  it('returns true when the user types "y"', async () => {
    pretendTTY();
    vi.mocked(readline.createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue('y'),
      close: vi.fn(),
    } as unknown as ReturnType<typeof readline.createInterface>);
    const proceed = await promptMigrationConfirm(fakeRenames, { yes: false });
    expect(proceed).toBe(true);
  });

  it('returns true when the user types "yes" with mixed case', async () => {
    pretendTTY();
    vi.mocked(readline.createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue('YES'),
      close: vi.fn(),
    } as unknown as ReturnType<typeof readline.createInterface>);
    const proceed = await promptMigrationConfirm(fakeRenames, { yes: false });
    expect(proceed).toBe(true);
  });

  it('returns false when the user accepts the default (empty input → N)', async () => {
    pretendTTY();
    vi.mocked(readline.createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue(''),
      close: vi.fn(),
    } as unknown as ReturnType<typeof readline.createInterface>);
    const proceed = await promptMigrationConfirm(fakeRenames, { yes: false });
    expect(proceed).toBe(false);
  });

  it('returns false when the user types "n"', async () => {
    pretendTTY();
    vi.mocked(readline.createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue('n'),
      close: vi.fn(),
    } as unknown as ReturnType<typeof readline.createInterface>);
    const proceed = await promptMigrationConfirm(fakeRenames, { yes: false });
    expect(proceed).toBe(false);
  });

  it('closes the readline interface even when the user confirms', async () => {
    pretendTTY();
    const close = vi.fn();
    vi.mocked(readline.createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue('y'),
      close,
    } as unknown as ReturnType<typeof readline.createInterface>);
    await promptMigrationConfirm(fakeRenames, { yes: false });
    expect(close).toHaveBeenCalled();
  });

  it('rejects with an actionable error in a non-TTY environment when --yes is not set', async () => {
    pretendNonTTY();
    await expect(
      promptMigrationConfirm(fakeRenames, { yes: false })
    ).rejects.toThrow(/non-interactive environment.*Pass --yes/);
    // readline.createInterface must NOT be called — we error before
    // opening stdin.
    expect(vi.mocked(readline.createInterface)).not.toHaveBeenCalled();
  });

  it('non-TTY environment still passes through opts.yes (CI happy path)', async () => {
    pretendNonTTY();
    const proceed = await promptMigrationConfirm(fakeRenames, { yes: true });
    expect(proceed).toBe(true);
    expect(vi.mocked(readline.createInterface)).not.toHaveBeenCalled();
  });
});
