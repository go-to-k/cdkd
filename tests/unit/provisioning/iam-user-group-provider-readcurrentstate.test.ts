import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetUserCommand,
  GetUserPolicyCommand,
  GetGroupCommand,
  GetGroupPolicyCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListUserPoliciesCommand,
  ListAttachedGroupPoliciesCommand,
  ListGroupPoliciesCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';

describe('IAMUserGroupProvider.readCurrentState', () => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMUserGroupProvider();
  });

  describe('AWS::IAM::User', () => {
    it('returns CFn-shaped properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        User: {
          UserName: 'alice',
          Path: '/team/',
          PermissionsBoundary: { PermissionsBoundaryArn: 'arn:aws:iam::aws:policy/Boundary' },
          Arn: 'arn:aws:iam::123:user/alice',
        },
      });
      mockSend.mockResolvedValueOnce({
        AttachedPolicies: [
          { PolicyArn: 'arn:aws:iam::aws:policy/ReadOnlyAccess', PolicyName: 'ro' },
        ],
      });
      mockSend.mockResolvedValueOnce({
        Groups: [{ GroupName: 'engineers' }, { GroupName: 'admins' }],
      });
      // ListUserPolicies — no inline.
      mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });

      const result = await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetUserCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListAttachedUserPoliciesCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListGroupsForUserCommand);
      expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(ListUserPoliciesCommand);
      expect(result).toEqual({
        UserName: 'alice',
        Path: '/team/',
        PermissionsBoundary: 'arn:aws:iam::aws:policy/Boundary',
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
        Groups: ['engineers', 'admins'],
        Policies: [],
      });
    });

    it('emits PermissionsBoundary placeholder when AWS reports none', async () => {
      // Always-emit guard (PR #145 pattern): without the placeholder a
      // console-side ADD on a user deployed without a boundary would
      // never enter observedProperties and the drift comparator would
      // silently ignore it.
      mockSend.mockResolvedValueOnce({
        User: { UserName: 'alice', Path: '/' },
      });
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({ Groups: [] });
      mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });

      const result = await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User');
      expect(result?.PermissionsBoundary).toBe('');
    });

    it('surfaces inline Policies with parsed PolicyDocument bodies and reconciles order against state', async () => {
      const docA = { V: 'a' };
      const docB = { V: 'b' };
      mockSend.mockResolvedValueOnce({
        User: { UserName: 'alice', Path: '/' },
      });
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({ Groups: [] });
      // AWS returns lex order ['A', 'B']; state has order (B, A).
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['A', 'B'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetUserPolicyCommand) {
          const input = (cmd as GetUserPolicyCommand).input;
          return Promise.resolve({
            UserName: 'alice',
            PolicyName: input.PolicyName,
            PolicyDocument: encodeURIComponent(
              JSON.stringify(input.PolicyName === 'A' ? docA : docB)
            ),
          });
        }
        return Promise.resolve({});
      });

      const result = await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User', {
        Policies: [
          { PolicyName: 'B', PolicyDocument: docB },
          { PolicyName: 'A', PolicyDocument: docA },
        ],
      });

      // Order should match state's (B, A) so positional compare passes.
      expect(result?.Policies).toEqual([
        { PolicyName: 'B', PolicyDocument: docB },
        { PolicyName: 'A', PolicyDocument: docA },
      ]);
    });

    it('returns undefined when user gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ message: 'gone', $metadata: {} })
      );

      const result = await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User');
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::IAM::Group', () => {
    it('returns CFn-shaped properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        Group: { GroupName: 'engineers', Path: '/', Arn: 'arn:aws:iam::123:group/engineers' },
      });
      mockSend.mockResolvedValueOnce({
        AttachedPolicies: [
          { PolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess', PolicyName: 's3' },
        ],
      });
      // ListGroupPolicies — no inline.
      mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });

      const result = await provider.readCurrentState(
        'engineers',
        'Logical',
        'AWS::IAM::Group'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetGroupCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListAttachedGroupPoliciesCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListGroupPoliciesCommand);
      expect(result).toEqual({
        GroupName: 'engineers',
        Path: '/',
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonS3FullAccess'],
        Policies: [],
      });
    });

    it('surfaces inline Policies for groups via GetGroupPolicy', async () => {
      const doc = { V: 1 };
      mockSend.mockResolvedValueOnce({
        Group: { GroupName: 'engineers', Path: '/' },
      });
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['Inline1'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetGroupPolicyCommand) {
          return Promise.resolve({
            GroupName: 'engineers',
            PolicyName: 'Inline1',
            PolicyDocument: encodeURIComponent(JSON.stringify(doc)),
          });
        }
        return Promise.resolve({});
      });

      const result = await provider.readCurrentState('engineers', 'Logical', 'AWS::IAM::Group');
      expect(result?.Policies).toEqual([{ PolicyName: 'Inline1', PolicyDocument: doc }]);
    });

    it('returns undefined when group gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ message: 'gone', $metadata: {} })
      );

      const result = await provider.readCurrentState(
        'engineers',
        'Logical',
        'AWS::IAM::Group'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('issue #323: filter inline policies managed by sibling AWS::IAM::Policy', () => {
    it('User: excludes inline policy whose name matches sibling AWS::IAM::Policy.Users', async () => {
      mockSend.mockResolvedValueOnce({
        User: { UserName: 'alice', Path: '/' },
      });
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({ Groups: [] });
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['SiblingManagedPolicy'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetUserPolicyCommand) {
          return Promise.resolve({
            UserName: 'alice',
            PolicyName: 'SiblingManagedPolicy',
            PolicyDocument: encodeURIComponent(JSON.stringify({ Doc: 'managed' })),
          });
        }
        return Promise.resolve({ Tags: [], IsTruncated: false });
      });

      const result = await provider.readCurrentState(
        'alice',
        'User',
        'AWS::IAM::User',
        { Policies: [] },
        {
          siblings: {
            SiblingPolicy: {
              resourceType: 'AWS::IAM::Policy',
              properties: { PolicyName: 'SiblingManagedPolicy', Users: ['alice'] },
            },
          },
        }
      );

      expect(result?.Policies).toEqual([]);
    });

    it('Group: excludes inline policy whose name matches sibling AWS::IAM::Policy.Groups', async () => {
      mockSend.mockResolvedValueOnce({
        Group: { GroupName: 'engineers', Path: '/' },
      });
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['SiblingGroupPolicy'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetGroupPolicyCommand) {
          return Promise.resolve({
            GroupName: 'engineers',
            PolicyName: 'SiblingGroupPolicy',
            PolicyDocument: encodeURIComponent(JSON.stringify({ Doc: 'managed' })),
          });
        }
        return Promise.resolve({ Tags: [], IsTruncated: false });
      });

      const result = await provider.readCurrentState(
        'engineers',
        'Group',
        'AWS::IAM::Group',
        { Policies: [] },
        {
          siblings: {
            SiblingPolicy: {
              resourceType: 'AWS::IAM::Policy',
              properties: { PolicyName: 'SiblingGroupPolicy', Groups: ['engineers'] },
            },
          },
        }
      );

      expect(result?.Policies).toEqual([]);
    });

    it('User: cross-target sibling (Users for a different user) is NOT filtered out', async () => {
      mockSend.mockResolvedValueOnce({
        User: { UserName: 'alice', Path: '/' },
      });
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      mockSend.mockResolvedValueOnce({ Groups: [] });
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['MyPolicy'],
        IsTruncated: false,
      });
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetUserPolicyCommand) {
          return Promise.resolve({
            UserName: 'alice',
            PolicyName: 'MyPolicy',
            PolicyDocument: encodeURIComponent(JSON.stringify({ Doc: 'mine' })),
          });
        }
        return Promise.resolve({ Tags: [], IsTruncated: false });
      });

      const result = await provider.readCurrentState(
        'alice',
        'User',
        'AWS::IAM::User',
        { Policies: [{ PolicyName: 'MyPolicy', PolicyDocument: { Doc: 'mine' } }] },
        {
          siblings: {
            UnrelatedPolicy: {
              // Same PolicyName but attached to a different user — must NOT
              // be considered a match for alice.
              resourceType: 'AWS::IAM::Policy',
              properties: { PolicyName: 'MyPolicy', Users: ['bob'] },
            },
          },
        }
      );

      expect(result?.Policies).toEqual([
        { PolicyName: 'MyPolicy', PolicyDocument: { Doc: 'mine' } },
      ]);
    });
  });

  describe('AWS::IAM::UserToGroupAddition', () => {
    it('returns undefined (membership-only resource, see JSDoc)', async () => {
      const result = await provider.readCurrentState(
        'someId',
        'Logical',
        'AWS::IAM::UserToGroupAddition'
      );
      expect(result).toBeUndefined();
      // No SDK call should have happened.
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
