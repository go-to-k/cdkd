/**
 * go-to-k/cdkd#4225: an `AWS::IAM::Role` / `User` / `Group` update keeps a
 * `Policies` entry it drops when `UpdateContext.inlinePolicyClaimed` says
 * another resource has already put that name on the principal. A rollback
 * hands the predicate to a principal revert: reverting a hand-off to the
 * principal's own `Policies`, the policy's reverse re-create puts the name
 * back first, and the principal's revert then dropped it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteGroupPolicyCommand,
  DeleteRolePolicyCommand,
  DeleteUserPolicyCommand,
  PutGroupPolicyCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l: Record<string, unknown> = {};
  Object.assign(l, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => l });
  return { getLogger: () => l };
});

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import type { InlinePolicyClaimed, InlinePolicyPrincipalKind } from '../../../src/types/resource.js';

const DOC = { Version: '2012-10-17', Statement: [] };
const entry = (PolicyName: string) => ({ PolicyName, PolicyDocument: DOC });

type Case = {
  kind: InlinePolicyPrincipalKind;
  type: string;
  name: string;
  put: new (...args: never[]) => unknown;
  del: new (...args: never[]) => unknown;
  update: (
    previous: Record<string, unknown>,
    desired: Record<string, unknown>,
    claimed?: InlinePolicyClaimed
  ) => Promise<unknown>;
};

const CASES: Case[] = [
  {
    kind: 'role',
    type: 'AWS::IAM::Role',
    name: 'my-role',
    put: PutRolePolicyCommand,
    del: DeleteRolePolicyCommand,
    update: (previous, desired, claimed) =>
      new IAMRoleProvider().update(
        'R',
        'my-role',
        'AWS::IAM::Role',
        { RoleName: 'my-role', AssumeRolePolicyDocument: DOC, ...desired },
        { RoleName: 'my-role', AssumeRolePolicyDocument: DOC, ...previous },
        claimed ? { inlinePolicyClaimed: claimed } : undefined
      ),
  },
  {
    kind: 'user',
    type: 'AWS::IAM::User',
    name: 'alice',
    put: PutUserPolicyCommand,
    del: DeleteUserPolicyCommand,
    update: (previous, desired, claimed) =>
      new IAMUserGroupProvider().update(
        'U',
        'alice',
        'AWS::IAM::User',
        { UserName: 'alice', ...desired },
        { UserName: 'alice', ...previous },
        claimed ? { inlinePolicyClaimed: claimed } : undefined
      ),
  },
  {
    kind: 'group',
    type: 'AWS::IAM::Group',
    name: 'engineers',
    put: PutGroupPolicyCommand,
    del: DeleteGroupPolicyCommand,
    update: (previous, desired, claimed) =>
      new IAMUserGroupProvider().update(
        'G',
        'engineers',
        'AWS::IAM::Group',
        { GroupName: 'engineers', ...desired },
        { GroupName: 'engineers', ...previous },
        claimed ? { inlinePolicyClaimed: claimed } : undefined
      ),
  },
];

const deleted = (del: Case['del']): string[] =>
  mockSend.mock.calls
    .filter((c) => c[0] instanceof del)
    .map((c) => (c[0] as { input: { PolicyName: string } }).input.PolicyName);

describe.each(CASES)('$type update asks inlinePolicyClaimed before dropping a Policies entry (go-to-k/cdkd#4225)', (c) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({
      Role: { RoleName: c.name, Arn: `arn:aws:iam::123:role/${c.name}` },
      User: { UserName: c.name, Arn: `arn:aws:iam::123:user/${c.name}` },
      Group: { GroupName: c.name, Arn: `arn:aws:iam::123:group/${c.name}` },
    });
  });

  const previous = { Policies: [entry('kept'), entry('claimed'), entry('gone')] };
  const desired = { Policies: [entry('kept')] };

  it('keeps a dropped name another resource claims, removes the rest', async () => {
    const claimed = vi.fn((_k: InlinePolicyPrincipalKind, _p: string, n: string) => n === 'claimed');

    await c.update(previous, desired, claimed);

    expect(deleted(c.del)).toEqual(['gone']);
    expect(claimed).toHaveBeenCalledWith(c.kind, c.name, 'claimed');
    expect(claimed).toHaveBeenCalledWith(c.kind, c.name, 'gone');
    // Only removals ask; a name the update still puts is never in question.
    expect(claimed).not.toHaveBeenCalledWith(c.kind, c.name, 'kept');
    expect(mockSend.mock.calls.filter((call) => call[0] instanceof c.put)).toHaveLength(1);
  });

  it('CONTROL: with no predicate every dropped name is removed', async () => {
    await c.update(previous, desired);

    expect(deleted(c.del)).toEqual(['claimed', 'gone']);
  });
});
