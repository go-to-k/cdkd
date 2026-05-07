import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetRoleCommand,
  NoSuchEntityException,
  UpdateRoleCommand,
} from '@aws-sdk/client-iam';

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

  describe('getAttribute', () => {
    it('returns Arn from GetRole', async () => {
      mockSend.mockResolvedValueOnce({
        Role: {
          RoleName: 'my-role',
          Arn: 'arn:aws:iam::123456789012:role/my-role',
          RoleId: 'AROAEXAMPLE',
        },
      });

      const result = await provider.getAttribute('my-role', 'AWS::IAM::Role', 'Arn');
      expect(result).toBe('arn:aws:iam::123456789012:role/my-role');
    });

    it('returns RoleId from GetRole', async () => {
      mockSend.mockResolvedValueOnce({
        Role: {
          RoleName: 'my-role',
          Arn: 'arn:aws:iam::123456789012:role/my-role',
          RoleId: 'AROAEXAMPLE',
        },
      });

      const result = await provider.getAttribute('my-role', 'AWS::IAM::Role', 'RoleId');
      expect(result).toBe('AROAEXAMPLE');
    });

    it('returns undefined for unknown attribute', async () => {
      mockSend.mockResolvedValueOnce({
        Role: { RoleName: 'my-role', Arn: 'arn', RoleId: 'AROA' },
      });

      const result = await provider.getAttribute('my-role', 'AWS::IAM::Role', 'Unknown');
      expect(result).toBeUndefined();
    });

    it('returns undefined when role not found', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'not found' })
      );

      const result = await provider.getAttribute('missing-role', 'AWS::IAM::Role', 'Arn');
      expect(result).toBeUndefined();
    });
  });

  describe('update', () => {
    it('sends UpdateRoleCommand with Description="" so AWS clears the existing description (not silently dropped by truthy gate)', async () => {
      // Regression for the `cdkd drift --revert` "✓ reverted but next
      // drift re-detects the same drift" symptom on IAM Role
      // Description: AWS's `UpdateRole` accepts empty-string as the
      // documented way to clear the description, but the previous
      // truthy gate (`if (properties['Description'])`) silently
      // dropped empty strings and never sent them to AWS. The fix
      // gates on `!== undefined` so the empty string reaches AWS.
      mockSend.mockResolvedValueOnce({}); // UpdateRoleCommand
      mockSend.mockResolvedValueOnce({}); // updateManagedPolicies (no-op)
      mockSend.mockResolvedValueOnce({}); // updateInlinePolicies (no-op)
      mockSend.mockResolvedValueOnce({}); // updateTags (no-op)
      mockSend.mockResolvedValueOnce({
        Role: {
          RoleName: 'my-role',
          Arn: 'arn:aws:iam::0:role/my-role',
          Path: '/',
          RoleId: 'role-id',
        },
      }); // GetRoleCommand

      await provider.update(
        'L',
        'my-role',
        'AWS::IAM::Role',
        {
          RoleName: 'my-role',
          AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
          Description: '',
          MaxSessionDuration: 3600,
        },
        {
          RoleName: 'my-role',
          AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
          Description: 'old-description',
          MaxSessionDuration: 7200,
        }
      );

      const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateRoleCommand);
      expect(updateCall).toBeDefined();
      const input = updateCall![0].input as {
        RoleName: string;
        Description?: string;
        MaxSessionDuration?: number;
      };
      expect(input.RoleName).toBe('my-role');
      // Empty string MUST reach the API (was dropped by the previous
      // truthy gate); MaxSessionDuration also flows through.
      expect(input.Description).toBe('');
      expect(input.MaxSessionDuration).toBe(3600);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof GetRoleCommand)).toBe(true);
    });

    it('omits Description from UpdateRoleCommand when newProperties does not carry the key', async () => {
      // Confirms the fix did not flip the gate from truthy to "always
      // send" — `undefined` (key absent) still skips the update field
      // so a partial newProps does NOT silently clear AWS-side
      // description.
      mockSend.mockResolvedValueOnce({}); // UpdateRoleCommand
      mockSend.mockResolvedValueOnce({}); // updateManagedPolicies (no-op)
      mockSend.mockResolvedValueOnce({}); // updateInlinePolicies (no-op)
      mockSend.mockResolvedValueOnce({}); // updateTags (no-op)
      mockSend.mockResolvedValueOnce({
        Role: {
          RoleName: 'my-role',
          Arn: 'arn:aws:iam::0:role/my-role',
          Path: '/',
          RoleId: 'role-id',
        },
      });

      await provider.update(
        'L',
        'my-role',
        'AWS::IAM::Role',
        {
          RoleName: 'my-role',
          AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
        },
        {
          RoleName: 'my-role',
          AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
          Description: 'kept-on-aws',
        }
      );

      const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateRoleCommand);
      expect(updateCall).toBeDefined();
      const input = updateCall![0].input as { Description?: string };
      expect(input).not.toHaveProperty('Description');
    });

    it('round-trip: empty-string Description placeholder reaches UpdateRoleCommand (truthy-gate guard)', async () => {
      // Mechanical guard for the truthy-gate regression. See
      // docs/provider-development.md § 3b "Read-update round-trip test".
      //
      // The IAM Role bug class:
      //   - readCurrentState emits Description: '' as the always-emit
      //     placeholder when AWS has no description.
      //   - update() must propagate '' to UpdateRoleCommand so AWS clears
      //     the description on revert. A truthy gate (`if (props['X'])`)
      //     would silently drop '' and `cdkd drift --revert` would
      //     report "reverted" but the next drift re-detects the same
      //     drift (the original silent fail mode).

      // Build observed snapshot directly (matches what readCurrentState
      // would produce for a role with no description) — readCurrentState
      // is exercised by its own dedicated test file.
      const observed = {
        RoleName: 'my-role',
        Path: '/',
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
        Description: '',
        MaxSessionDuration: 3600,
        ManagedPolicyArns: [] as string[],
        Tags: [] as Array<{ Key: string; Value: string }>,
      };

      // Round-trip: pass observed as both new (desired) and old.
      mockSend.mockResolvedValueOnce({}); // UpdateRoleCommand
      mockSend.mockResolvedValueOnce({}); // updateManagedPolicies (no-op)
      mockSend.mockResolvedValueOnce({}); // updateInlinePolicies (no-op)
      mockSend.mockResolvedValueOnce({}); // updateTags (no-op)
      mockSend.mockResolvedValueOnce({
        Role: {
          RoleName: 'my-role',
          Arn: 'arn:aws:iam::0:role/my-role',
          Path: '/',
          RoleId: 'role-id',
        },
      });

      await provider.update('L', 'my-role', 'AWS::IAM::Role', observed, observed);

      // Truthy-gate assertion: UpdateRole MUST receive the empty
      // Description so AWS clears it. The previous truthy gate would
      // have dropped this and the test would fail.
      const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateRoleCommand);
      expect(updateCall).toBeDefined();
      const input = updateCall![0].input as {
        RoleName: string;
        Description?: string;
        MaxSessionDuration?: number;
      };
      expect(input.Description).toBe('');
      expect(input.MaxSessionDuration).toBe(3600);
    });
  });
});
