import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetUserCommand, GetGroupCommand } from '@aws-sdk/client-iam';

const mockSend = vi.fn();
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => 'us-east-1' } },
  }),
}));
vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
});

import { IAMUserGroupProvider } from '../../../../src/provisioning/providers/iam-user-group-provider.js';

describe('IAMUserGroupProvider — import', () => {
  let provider: IAMUserGroupProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMUserGroupProvider();
  });

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyUser',
      resourceType: 'AWS::IAM::User',
      cdkPath: 'MyStack/MyUser',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {} as Record<string, unknown>,
      ...overrides,
    };
  }

  describe('User', () => {
    it('verifies explicit UserName via GetUser', async () => {
      mockSend.mockResolvedValueOnce({ User: { UserName: 'alice' } });
      const result = await provider.import!(makeInput({ knownPhysicalId: 'alice' }));
      expect(result).toEqual({ physicalId: 'alice', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetUserCommand);
    });

    it('returns null when no user matches the cdk path tag', async () => {
      mockSend
        .mockResolvedValueOnce({ Users: [{ UserName: 'bob' }], IsTruncated: false })
        .mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Bob' }] });
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
    });
  });

  describe('Group', () => {
    it('verifies explicit GroupName via GetGroup', async () => {
      mockSend.mockResolvedValueOnce({ Group: { GroupName: 'admins' } });
      const result = await provider.import!(
        makeInput({
          resourceType: 'AWS::IAM::Group',
          logicalId: 'MyGroup',
          knownPhysicalId: 'admins',
        })
      );
      expect(result).toEqual({ physicalId: 'admins', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetGroupCommand);
    });

    it('returns null without an override (groups are not taggable)', async () => {
      const result = await provider.import!(
        makeInput({ resourceType: 'AWS::IAM::Group', logicalId: 'MyGroup' })
      );
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('UserToGroupAddition', () => {
    it('passes through explicit composite physicalId without verification', async () => {
      const result = await provider.import!(
        makeInput({
          resourceType: 'AWS::IAM::UserToGroupAddition',
          logicalId: 'MyAddition',
          knownPhysicalId: 'admins/alice',
        })
      );
      expect(result?.physicalId).toBe('admins/alice');
    });

    it('returns null without an override (attachment has no AWS-side identity)', async () => {
      const result = await provider.import!(
        makeInput({ resourceType: 'AWS::IAM::UserToGroupAddition', logicalId: 'MyAddition' })
      );
      expect(result).toBeNull();
    });
  });
});
