import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

// Mock AWS clients before importing the provider
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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';

describe('IAMRoleProvider', () => {
  let provider: IAMRoleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMRoleProvider();
  });

  describe('delete', () => {
    it('should skip deletion when role does not exist', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'not found' })
      );

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should detach managed policies before deleting role', async () => {
      // GetRole - exists
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({
        AttachedPolicies: [
          { PolicyArn: 'arn:aws:iam::123456789012:policy/Policy1' },
          { PolicyArn: 'arn:aws:iam::123456789012:policy/Policy2' },
        ],
      });
      // DetachRolePolicy x2
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({ PolicyNames: [] });
      // ListInstanceProfilesForRole
      mockSend.mockResolvedValueOnce({ InstanceProfiles: [] });
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      expect(mockSend).toHaveBeenCalledTimes(7);

      // Verify DetachRolePolicy was called with correct args
      const detachCalls = mockSend.mock.calls.filter(
        (call) => call[0].constructor.name === 'DetachRolePolicyCommand'
      );
      expect(detachCalls).toHaveLength(2);
    });

    it('should delete inline policies before deleting role', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({
        PolicyNames: ['InlinePolicy1', 'InlinePolicy2'],
      });
      // DeleteRolePolicy x2
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});
      // ListInstanceProfilesForRole
      mockSend.mockResolvedValueOnce({ InstanceProfiles: [] });
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      expect(mockSend).toHaveBeenCalledTimes(7);

      const deleteInlineCalls = mockSend.mock.calls.filter(
        (call) => call[0].constructor.name === 'DeleteRolePolicyCommand'
      );
      expect(deleteInlineCalls).toHaveLength(2);
    });

    it('should remove role from instance profiles before deleting role', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({ PolicyNames: [] });
      // ListInstanceProfilesForRole
      mockSend.mockResolvedValueOnce({
        InstanceProfiles: [
          { InstanceProfileName: 'profile-1' },
          { InstanceProfileName: 'profile-2' },
        ],
      });
      // RemoveRoleFromInstanceProfile x2
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      expect(mockSend).toHaveBeenCalledTimes(7);

      const removeFromProfileCalls = mockSend.mock.calls.filter(
        (call) =>
          call[0].constructor.name === 'RemoveRoleFromInstanceProfileCommand'
      );
      expect(removeFromProfileCalls).toHaveLength(2);
    });

    it('should perform full cleanup: managed policies, inline policies, instance profiles, then delete', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({
        AttachedPolicies: [
          { PolicyArn: 'arn:aws:iam::123456789012:policy/ManagedPolicy' },
        ],
      });
      // DetachRolePolicy
      mockSend.mockResolvedValueOnce({});
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({ PolicyNames: ['InlinePolicy'] });
      // DeleteRolePolicy
      mockSend.mockResolvedValueOnce({});
      // ListInstanceProfilesForRole
      mockSend.mockResolvedValueOnce({
        InstanceProfiles: [{ InstanceProfileName: 'my-instance-profile' }],
      });
      // RemoveRoleFromInstanceProfile
      mockSend.mockResolvedValueOnce({});
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      // Total: GetRole + ListAttached + Detach + ListInline + DeleteInline + ListProfiles + RemoveFromProfile + DeleteRole = 8
      expect(mockSend).toHaveBeenCalledTimes(8);

      // Verify order: last call should be DeleteRole
      const lastCall = mockSend.mock.calls[mockSend.mock.calls.length - 1];
      expect(lastCall[0].constructor.name).toBe('DeleteRoleCommand');
    });

    it('should handle NoSuchEntityException gracefully when detaching already-detached policy', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({
        AttachedPolicies: [
          { PolicyArn: 'arn:aws:iam::123456789012:policy/AlreadyDetached' },
        ],
      });
      // DetachRolePolicy - already detached
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'not found' })
      );
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({ PolicyNames: [] });
      // ListInstanceProfilesForRole
      mockSend.mockResolvedValueOnce({ InstanceProfiles: [] });
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      // Should not throw
      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      expect(mockSend).toHaveBeenCalledTimes(6);
    });

    it('should handle NoSuchEntityException gracefully when deleting already-deleted inline policy', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({ PolicyNames: ['AlreadyDeleted'] });
      // DeleteRolePolicy - already deleted
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'not found' })
      );
      // ListInstanceProfilesForRole
      mockSend.mockResolvedValueOnce({ InstanceProfiles: [] });
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      expect(mockSend).toHaveBeenCalledTimes(6);
    });

    it('should handle NoSuchEntityException gracefully when removing role from already-removed instance profile', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({ PolicyNames: [] });
      // ListInstanceProfilesForRole
      mockSend.mockResolvedValueOnce({
        InstanceProfiles: [{ InstanceProfileName: 'already-removed' }],
      });
      // RemoveRoleFromInstanceProfile - already removed
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'not found' })
      );
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      expect(mockSend).toHaveBeenCalledTimes(6);
    });

    it('should throw ProvisioningError when a non-NoSuchEntity error occurs during detach', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({
        AttachedPolicies: [
          { PolicyArn: 'arn:aws:iam::123456789012:policy/Policy1' },
        ],
      });
      // DetachRolePolicy - access denied
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.delete('MyRole', 'my-role', 'AWS::IAM::Role')
      ).rejects.toThrow('Failed to delete IAM role MyRole');
    });

    it('should throw ProvisioningError when DeleteRole fails', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({ PolicyNames: [] });
      // ListInstanceProfilesForRole
      mockSend.mockResolvedValueOnce({ InstanceProfiles: [] });
      // DeleteRole - fails
      mockSend.mockRejectedValueOnce(new Error('DeleteConflict'));

      await expect(
        provider.delete('MyRole', 'my-role', 'AWS::IAM::Role')
      ).rejects.toThrow('Failed to delete IAM role MyRole');
    });

    it('should handle role with no attached policies, no inline policies, and no instance profiles', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies - empty
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      // ListRolePolicies - empty
      mockSend.mockResolvedValueOnce({ PolicyNames: [] });
      // ListInstanceProfilesForRole - empty
      mockSend.mockResolvedValueOnce({ InstanceProfiles: [] });
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      // GetRole + 3 list calls + DeleteRole = 5
      expect(mockSend).toHaveBeenCalledTimes(5);
    });

    it('should handle NoSuchEntityException during ListInstanceProfilesForRole (role deleted between steps)', async () => {
      // GetRole
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });
      // ListAttachedRolePolicies
      mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
      // ListRolePolicies
      mockSend.mockResolvedValueOnce({ PolicyNames: [] });
      // ListInstanceProfilesForRole - role was deleted between steps
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'not found' })
      );
      // DeleteRole
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyRole', 'my-role', 'AWS::IAM::Role');

      expect(mockSend).toHaveBeenCalledTimes(5);
    });
  });
});
