import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreatePolicyCommand,
  CreateRoleCommand,
  DeletePolicyCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { PutRuleCommand } from '@aws-sdk/client-eventbridge';

/**
 * go-to-k/cdkd#5064: the providers that re-derive a resource's name inside
 * `update()` -- and replace (IAM role, managed policy), rename (inline
 * policy) or upsert a second copy (EventBridge rule, `PutRule`) on a mismatch
 * -- keep the recorded name of a resource no template names, when the
 * mismatch is only the naming scheme. A no-op update of a legacy stack and of
 * a v13 stack replaces nothing.
 */
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';
import { generateResourceName, withStackScope } from '../../../src/provisioning/resource-name.js';

const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const STACK = 'MyStack';

const legacyScope = { stackName: STACK, stackInstanceId: undefined };
const v13Scope = { stackName: STACK, stackInstanceId: ID };
/** The name a v13 stack generates for `logicalId`. */
const suffixed = (logicalId: string, maxLength: number): string =>
  withStackScope(v13Scope, () => generateResourceName(logicalId, { maxLength }));

const sent = (klass: abstract new (...args: never[]) => unknown): Array<Record<string, unknown>> =>
  mockSend.mock.calls
    .filter((c) => c[0] instanceof klass)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({});
});

describe('IAM role update keeps a generated name (#5064)', () => {
  const doc = { Version: '2012-10-17', Statement: [] };
  const noOp = (physicalId: string) =>
    new IAMRoleProvider().update(
      'Role',
      physicalId,
      'AWS::IAM::Role',
      { AssumeRolePolicyDocument: doc },
      { AssumeRolePolicyDocument: doc }
    );

  it.each([
    ['a legacy stack, legacy name', legacyScope, `${STACK}-Role`],
    ['a v13 stack, suffixed name', v13Scope, suffixed('Role', 64)],
    ['a v13 stack holding a legacy name (an import)', v13Scope, `${STACK}-Role`],
    ['a scope missing the id, suffixed name', legacyScope, suffixed('Role', 64)],
  ])('%s: a no-op update replaces nothing', async (_label, scope, physicalId) => {
    const result = await withStackScope(scope, () => noOp(physicalId));
    expect(result.wasReplaced).toBe(false);
    expect(result.physicalId).toBe(physicalId);
    expect(sent(CreateRoleCommand)).toEqual([]);
    expect(sent(DeleteRoleCommand)).toEqual([]);
  });

  it('a declared rename still replaces', async () => {
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof CreateRoleCommand
        ? { Role: { RoleName: 'new-role', Arn: 'arn:aws:iam::1:role/new-role', RoleId: 'R' } }
        : {}
    );
    await withStackScope(v13Scope, () =>
      new IAMRoleProvider().update(
        'Role',
        'old-role',
        'AWS::IAM::Role',
        { AssumeRolePolicyDocument: doc, RoleName: 'new-role' },
        { AssumeRolePolicyDocument: doc, RoleName: 'old-role' }
      )
    ).catch(() => undefined);
    expect(sent(CreateRoleCommand).map((i) => i['RoleName'])).toEqual(['MyStack-new-role']);
  });
});

describe('IAM managed policy update keeps a generated name (#5064)', () => {
  const doc = { Version: '2012-10-17', Statement: [] };
  const arn = (name: string): string => `arn:aws:iam::123456789012:policy/${name}`;

  it.each([
    ['a legacy stack, legacy name', legacyScope, `${STACK}-Policy`],
    ['a v13 stack, suffixed name', v13Scope, suffixed('Policy', 128)],
    ['a v13 stack holding a legacy name (an import)', v13Scope, `${STACK}-Policy`],
    ['a scope missing the id, suffixed name', legacyScope, suffixed('Policy', 128)],
  ])('%s: a no-op update replaces nothing', async (_label, scope, name) => {
    const result = await withStackScope(scope, () =>
      new IAMManagedPolicyProvider().update(
        'Policy',
        arn(name),
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: doc },
        { PolicyDocument: doc }
      )
    );
    expect(result.wasReplaced).toBe(false);
    expect(result.physicalId).toBe(arn(name));
    expect(sent(CreatePolicyCommand)).toEqual([]);
    expect(sent(DeletePolicyCommand)).toEqual([]);
  });
});

describe('IAM inline policy update keeps a generated name (#5064)', () => {
  const doc = { Version: '2012-10-17', Statement: [] };

  it.each([
    ['a v13 stack holding a legacy name (an import)', v13Scope, `${STACK}-Inline`],
    ['a scope missing the id, suffixed name', legacyScope, suffixed('Inline', 64)],
  ])('%s: a no-op update renames nothing', async (_label, scope, name) => {
    const result = await withStackScope(scope, () =>
      new IAMPolicyProvider().update(
        'Inline',
        name,
        'AWS::IAM::Policy',
        { PolicyDocument: doc, Roles: ['r'] },
        { PolicyDocument: doc, Roles: ['r'] }
      )
    );
    expect(result.physicalId).toBe(name);
    expect(sent(PutRolePolicyCommand).map((i) => i['PolicyName'])).toEqual([name]);
    expect(sent(DeleteRolePolicyCommand)).toEqual([]);
  });
});

describe('EventBridge rule update keeps a generated name (#5064)', () => {
  const arn = (name: string): string => `arn:aws:events:us-east-1:123456789012:rule/${name}`;

  it.each([
    ['a legacy stack, legacy name', legacyScope, `${STACK}-Rule`],
    ['a v13 stack, suffixed name', v13Scope, suffixed('Rule', 64)],
    ['a v13 stack holding a legacy name (an import)', v13Scope, `${STACK}-Rule`],
    ['a scope missing the id, suffixed name', legacyScope, suffixed('Rule', 64)],
  ])('%s: PutRule addresses the recorded rule', async (_label, scope, name) => {
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof PutRuleCommand ? { RuleArn: arn(name) } : {}
    );
    await withStackScope(scope, () =>
      new EventBridgeRuleProvider().update(
        'Rule',
        arn(name),
        'AWS::Events::Rule',
        { ScheduleExpression: 'rate(5 minutes)' },
        { ScheduleExpression: 'rate(5 minutes)' }
      )
    );
    expect(sent(PutRuleCommand).map((i) => i['Name'])).toEqual([name]);
  });
});
