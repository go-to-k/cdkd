import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { NoSuchEntityException } from '@aws-sdk/client-iam';
import { FORGED_CTRL, FORGED_QUOTE } from './pasteable-aws-command-assert.js';

const RESOURCE_TYPE = 'AWS::IAM::User';

describe('IAMUserGroupProvider createUser partial-create cleanup (Issue #376)', () => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new IAMUserGroupProvider();
  });

  it('issues cleanup (Remove* + Detach* + Delete*) when AttachUserPolicy fails after CreateUser succeeded', async () => {
    mockSend.mockResolvedValueOnce({ User: { Arn: 'arn:aws:iam::123:user/MyUser' } }); // CreateUserCommand
    mockSend.mockRejectedValueOnce(new Error('AttachUserPolicy boom')); // AttachUserPolicyCommand
    // Cleanup sequence:
    mockSend.mockResolvedValueOnce({ Groups: [] }); // ListGroupsForUserCommand
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] }); // ListAttachedUserPoliciesCommand
    mockSend.mockResolvedValueOnce({ PolicyNames: [] }); // ListUserPoliciesCommand
    const noSuchEntity = new NoSuchEntityException({ message: 'no profile', $metadata: {} });
    mockSend.mockRejectedValueOnce(noSuchEntity); // DeleteLoginProfileCommand (no profile)
    mockSend.mockRejectedValueOnce(noSuchEntity); // DeleteUserPermissionsBoundaryCommand (no boundary)
    mockSend.mockResolvedValueOnce({}); // DeleteUserCommand

    await expect(
      provider.create('MyUser', RESOURCE_TYPE, {
        UserName: 'my-test-user-xxx',
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'],
      })
    ).rejects.toThrow('Failed to create IAM user');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateUserCommand',
      'AttachUserPolicyCommand',
      'ListGroupsForUserCommand',
      'ListAttachedUserPoliciesCommand',
      'ListUserPoliciesCommand',
      'DeleteLoginProfileCommand',
      'DeleteUserPermissionsBoundaryCommand',
      'DeleteUserCommand',
    ]);
  });

  it('does NOT issue cleanup when CreateUser itself fails (nothing to clean up)', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateUser boom'));

    await expect(
      provider.create('MyUser', RESOURCE_TYPE, {
        UserName: 'my-test-user-xxx',
      })
    ).rejects.toThrow('Failed to create IAM user');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateUserCommand');
  });

  it('re-throws the original error even when cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({ User: { Arn: 'arn:aws:iam::123:user/MyUser' } }); // CreateUserCommand
    mockSend.mockRejectedValueOnce(new Error('PutUserPermissionsBoundary boom (original)')); // PutUserPermissionsBoundaryCommand
    mockSend.mockRejectedValueOnce(new Error('ListGroupsForUser also failed')); // cleanup fails

    await expect(
      provider.create('MyUser', RESOURCE_TYPE, {
        UserName: 'my-test-user-xxx',
        PermissionsBoundary: 'arn:aws:iam::aws:policy/PermBoundary',
      })
    ).rejects.toThrow('PutUserPermissionsBoundary boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws iam delete-user --user-name');
    expect(warnMsg).toContain('my-test-user-xxx');
  });

  describe('the recovery commands name the user BARE, by provenance (issue #3136)', () => {
    // The name is `generateResourceNameWithFallback`'s output, which rewrites
    // everything outside `[A-Za-z0-9-]`: a forged template name reaches the
    // command only as one plain word, so the site does not route through
    // `pasteableAwsCommand`. If the generator ever stops sanitizing, these fail.
    it.each([FORGED_QUOTE, FORGED_CTRL])('a forged UserName reaches the commands as a plain word', async (forged) => {
      mockSend.mockResolvedValueOnce({ User: { Arn: 'arn:aws:iam::123:user/MyUser' } }); // CreateUserCommand
      mockSend.mockRejectedValueOnce(new Error('PutUserPermissionsBoundary boom')); // original
      mockSend.mockRejectedValueOnce(new Error('ListGroupsForUser also failed')); // cleanup fails
      await expect(
        provider.create('MyUser', RESOURCE_TYPE, {
          UserName: forged,
          PermissionsBoundary: 'arn:aws:iam::aws:policy/PermBoundary',
        })
      ).rejects.toThrow('PutUserPermissionsBoundary boom');
      const msg = String(warnSpy.mock.calls[0][0]);
      const names = [...msg.matchAll(/--user-name ([^\s)]+)/g)].map((m) => m[1]);
      expect(names).toHaveLength(3);
      for (const name of names) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/);
    });
  });
});
