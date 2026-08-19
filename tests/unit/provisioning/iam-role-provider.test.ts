import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
    // Issue #1819: a RoleName change is immutable, so the provider replaces --
    // create the new role, then delete the old. When that delete fails the old
    // role survives untracked, and before the outcome channel that was a bare
    // logger.warn with the deploy exiting 0.
    it('reports partial when the old role cannot be deleted during a replacement', async () => {
      mockSend.mockResolvedValueOnce({
        Role: { RoleName: 'new-role', Arn: 'arn:aws:iam::0:role/new-role', RoleId: 'r2' },
      }); // create()
      mockSend.mockRejectedValueOnce(new Error('DeleteConflict: role has attached entities'));

      const result = await provider.update(
        'L',
        'old-role',
        'AWS::IAM::Role',
        { RoleName: 'new-role', AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
        { RoleName: 'old-role', AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } }
      );

      // The row succeeded: the new role exists and is what state points at.
      expect(result.wasReplaced).toBe(true);
      expect(result.outcome).toBe('partial');
      // Names the OLD physical id -- the only place it still exists once state
      // has been re-pointed.
      expect(result.reason).toContain('old-role');
      expect(result.reason).toContain('DeleteConflict');
    });

    // The #1778 SKIP class: non-throwing, so it sails past the catch that would
    // otherwise have reported it.
    it('reports partial when the inner delete SKIPS rather than throws', async () => {
      mockSend.mockResolvedValueOnce({
        Role: { RoleName: 'new-role', Arn: 'arn:aws:iam::0:role/new-role', RoleId: 'r2' },
      });
      vi.spyOn(provider, 'delete').mockResolvedValue({
        outcome: 'skipped',
        reason: 'malformed physicalId in state — no delete issued',
      });

      const result = await provider.update(
        'L',
        'old-role',
        'AWS::IAM::Role',
        { RoleName: 'new-role', AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
        { RoleName: 'old-role', AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } }
      );

      expect(result.outcome).toBe('partial');
      expect(result.reason).toContain('old-role');
      expect(result.reason).toContain('no delete issued');
    });

    // The clean control: a replacement whose delete SUCCEEDS must carry no
    // outcome, or every replacement would render and count as a partial.
    it('reports no outcome when the old role is deleted cleanly', async () => {
      mockSend.mockResolvedValueOnce({
        Role: { RoleName: 'new-role', Arn: 'arn:aws:iam::0:role/new-role', RoleId: 'r2' },
      }); // create()
      mockSend.mockResolvedValue({}); // the delete()'s cleanup calls all succeed

      const result = await provider.update(
        'L',
        'old-role',
        'AWS::IAM::Role',
        { RoleName: 'new-role', AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
        { RoleName: 'old-role', AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } }
      );

      expect(result.wasReplaced).toBe(true);
      expect(result.outcome).toBeUndefined();
      expect(result.reason).toBeUndefined();
    });

    it('sends UpdateRoleCommand with Description="" so AWS clears the existing description (not silently dropped by truthy gate)', async () => {
      // Regression for the `cdkd drift --revert` "✓ reverted but next
      // drift re-detects the same drift" symptom on IAM Role
      // Description: AWS's `UpdateRole` accepts empty-string as the
      // documented way to clear the description, but the previous
      // truthy gate (`if (properties['Description'])`) silently
      // dropped empty strings and never sent them to AWS. The fix
      // gates on `!== undefined` so the empty string reaches AWS.
      //
      // Only TWO sends actually fire: the props carry no policies/tags, so
      // the policy/tag helpers issue none. Priming the three no-op
      // responses this test used to declare leaked them into the next
      // tests in this file (issue #1655).
      mockSend.mockResolvedValueOnce({}); // UpdateRoleCommand
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

      // Every primed response must be consumed HERE — a leftover shifts
      // every later test in this file (issue #1655).
      expect(mockSend).toHaveBeenCalledTimes(2);
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

    // Issue #1160 clear-on-removal trio (docs/provider-development.md §2a):
    // IAM UpdateRole has merge semantics (absent field = "no change",
    // live-verified 2026-07-27), while CFn resets a template-removed
    // property to its default. update() must therefore send an explicit
    // reset when a field was present before and is absent now — and ONLY
    // then.
    describe('clear-on-removal (issue #1160)', () => {
      const mockUpdateFlow = () => {
        // With no policies/tags in the props, the policy/tag helpers issue
        // zero sends — the actual consumption is UpdateRoleCommand then
        // GetRoleCommand. (The trio tests only inspect the
        // UpdateRoleCommand input.)
        mockSend.mockResolvedValueOnce({}); // UpdateRoleCommand
        mockSend.mockResolvedValueOnce({
          Role: {
            RoleName: 'my-role',
            Arn: 'arn:aws:iam::0:role/my-role',
            Path: '/',
            RoleId: 'role-id',
          },
        }); // GetRoleCommand
      };
      const baseProps = {
        RoleName: 'my-role',
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
      };
      const findUpdateInput = () => {
        // Pins that mockUpdateFlow() primed exactly what the flow consumes
        // — an over-priming leaks into the next test (issue #1655).
        expect(mockSend).toHaveBeenCalledTimes(2);
        const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateRoleCommand);
        expect(updateCall).toBeDefined();
        return updateCall![0].input as {
          RoleName: string;
          Description?: string;
          MaxSessionDuration?: number;
        };
      };

      it('removal: Description and MaxSessionDuration present before, absent now -> explicit resets ("" / 3600)', async () => {
        mockUpdateFlow();

        await provider.update('L', 'my-role', 'AWS::IAM::Role', baseProps, {
          ...baseProps,
          Description: 'old-description',
          MaxSessionDuration: 7200,
        });

        const input = findUpdateInput();
        // Merge semantics: omitting the fields would silently keep the
        // old live values, so removal must send the CFn defaults.
        expect(input.Description).toBe('');
        expect(input.MaxSessionDuration).toBe(3600);
      });

      it('never present: fields absent from both sides stay absent from the input (no spurious reset)', async () => {
        mockUpdateFlow();

        await provider.update('L', 'my-role', 'AWS::IAM::Role', baseProps, baseProps);

        const input = findUpdateInput();
        expect(input).not.toHaveProperty('Description');
        expect(input).not.toHaveProperty('MaxSessionDuration');
      });

      it('mixed: kept Description passes through unchanged while removed MaxSessionDuration resets to 3600', async () => {
        mockUpdateFlow();

        await provider.update(
          'L',
          'my-role',
          'AWS::IAM::Role',
          { ...baseProps, Description: 'kept-description' },
          { ...baseProps, Description: 'kept-description', MaxSessionDuration: 7200 }
        );

        const input = findUpdateInput();
        expect(input.Description).toBe('kept-description');
        expect(input.MaxSessionDuration).toBe(3600);
      });
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
      // Two sends only — the empty ManagedPolicyArns / Tags produce no
      // delta, so the policy/tag helpers issue none (issue #1655).
      mockSend.mockResolvedValueOnce({}); // UpdateRoleCommand
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
      expect(mockSend).toHaveBeenCalledTimes(2);
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

  describe('import', () => {
    // Deliberately NO `mockSend.mockReset()` drain here. It used to guard
    // against responses leaked by the update tests above, which no longer
    // leak (issue #1655) — and a drain would make any FUTURE leak crossing
    // into this block invisible to the detector, re-grandfathering the tail
    // of a file this issue just un-grandfathered.

    const importInput = (overrides: Record<string, unknown> = {}) => ({
      logicalId: 'MyRole',
      resourceType: 'AWS::IAM::Role',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    });

    it('explicit override: verifies via GetRole and returns the physicalId', async () => {
      mockSend.mockResolvedValueOnce({ Role: { RoleName: 'my-role' } });

      const result = await provider.import(importInput({ knownPhysicalId: 'my-role' }));

      expect(result).toEqual({ physicalId: 'my-role', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetRoleCommand);
    });

    // The `aws:cdk:path` tag walk was removed (issue #1134): AWS rejects
    // `aws:`-prefixed tag writes, so the tag never exists on a real role.
    // With no explicit id, import returns null without issuing any AWS call.
    it('returns null without any AWS call when no explicit id is given', async () => {
      const result = await provider.import(importInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
