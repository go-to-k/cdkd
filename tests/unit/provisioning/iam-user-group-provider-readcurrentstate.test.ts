import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetUserCommand,
  GetGroupCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListAttachedGroupPoliciesCommand,
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

      const result = await provider.readCurrentState('alice', 'Logical', 'AWS::IAM::User');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetUserCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListAttachedUserPoliciesCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListGroupsForUserCommand);
      expect(result).toEqual({
        UserName: 'alice',
        Path: '/team/',
        PermissionsBoundary: 'arn:aws:iam::aws:policy/Boundary',
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
        Groups: ['engineers', 'admins'],
      });
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

      const result = await provider.readCurrentState(
        'engineers',
        'Logical',
        'AWS::IAM::Group'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetGroupCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListAttachedGroupPoliciesCommand);
      expect(result).toEqual({
        GroupName: 'engineers',
        Path: '/',
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonS3FullAccess'],
      });
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
