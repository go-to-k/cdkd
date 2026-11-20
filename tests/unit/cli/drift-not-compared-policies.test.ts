import { describe, it, expect } from 'vite-plus/test';
import type { ResourceState } from '../../../src/types/state.js';
import type { DriftOutcome } from '../../../src/cli/commands/drift/outcome.js';
import {
  managedPoliciesFirst,
  notComparedManagedPolicyArns,
  restoreEntryOrder,
} from '../../../src/cli/commands/drift/not-compared-policies.js';

/** go-to-k/cdkd#6697: the helpers `runDriftForStack` and `--revert` share. */
const rec = (resourceType: string, physicalId = ''): ResourceState => ({
  resourceType,
  physicalId,
  properties: {},
});
const MP = 'AWS::IAM::ManagedPolicy';

describe('notComparedManagedPolicyArns', () => {
  const resources: Record<string, ResourceState> = {
    Clean: rec(MP, 'arn:clean'),
    Drifted: rec(MP, 'arn:drifted'),
    Failed: rec(MP, 'arn:failed'),
    Refused: rec(MP, 'arn:refused'),
    Deleted: rec(MP, 'arn:deleted'),
    NoOutcome: rec(MP, 'arn:none'),
    Unborn: rec(MP),
    Role: rec('AWS::IAM::Role', 'role'),
  };
  const outcomes: DriftOutcome[] = [
    { kind: 'clean', logicalId: 'Clean', resourceType: MP },
    {
      kind: 'drifted',
      logicalId: 'Drifted',
      resourceType: MP,
      changes: [],
      awsProperties: {},
      secrets: new Map(),
      maskedPaths: new Set(),
      uncertifiedPaths: [],
      secretsIncomplete: false,
      // A partially compared policy still compared its plain-name lists.
      notComparedCause: 'unresolvedToken',
    } as unknown as DriftOutcome,
    { kind: 'notCompared', logicalId: 'Failed', resourceType: MP, notComparedCause: 'readFailed' },
    {
      kind: 'notCompared',
      logicalId: 'Refused',
      resourceType: MP,
      notComparedCause: 'baselineRefused',
    },
    { kind: 'deleted', logicalId: 'Deleted', resourceType: MP },
    { kind: 'notCompared', logicalId: 'Role', resourceType: 'AWS::IAM::Role', notComparedCause: 'readFailed' },
  ];

  it('names every managed policy with a physical id whose outcome is neither clean nor drifted', () => {
    expect([...notComparedManagedPolicyArns(resources, outcomes)].sort()).toEqual([
      'arn:deleted',
      'arn:failed',
      'arn:none',
      'arn:refused',
    ]);
  });

  it('is empty without records', () => {
    expect(notComparedManagedPolicyArns(undefined, outcomes).size).toBe(0);
  });
});

describe('managedPoliciesFirst / restoreEntryOrder', () => {
  const entries: Array<[string, ResourceState]> = [
    ['A', rec('AWS::IAM::Group', 'a')],
    ['B', rec(MP, 'arn:b')],
    ['C', rec('AWS::IAM::Role', 'c')],
    ['D', rec(MP, 'arn:d')],
  ];

  it('moves the managed policies to the front, each group in its order', () => {
    expect(managedPoliciesFirst(entries).map(([id]) => id)).toEqual(['B', 'D', 'A', 'C']);
  });

  it('puts the walk\'s outcomes back in entry order and leaves earlier ones in place', () => {
    const o = (logicalId: string): DriftOutcome => ({
      kind: 'clean',
      logicalId,
      resourceType: 'X',
    });
    const outcomes = [o('pre'), ...['B', 'D', 'A', 'C'].map(o)];
    restoreEntryOrder(outcomes, 1, entries);
    expect(outcomes.map((x) => x.logicalId)).toEqual(['pre', 'A', 'B', 'C', 'D']);
  });
});
