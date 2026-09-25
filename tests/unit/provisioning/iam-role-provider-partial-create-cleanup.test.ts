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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { FORGED_CTRL, FORGED_QUOTE } from './pasteable-aws-command-assert.js';

const RESOURCE_TYPE = 'AWS::IAM::Role';

const ASSUME_ROLE_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
};

describe('IAMRoleProvider partial-create cleanup (Issue #376)', () => {
  let provider: IAMRoleProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new IAMRoleProvider();
  });

  it('issues cleanup (Detach + DeleteRolePolicy + DeleteRole) when AttachRolePolicy fails after CreateRole succeeded', async () => {
    mockSend.mockResolvedValueOnce({ Role: { Arn: 'arn:aws:iam::123:role/MyRole', RoleId: 'AROAXX' } }); // CreateRoleCommand
    mockSend.mockRejectedValueOnce(new Error('AttachRolePolicy boom')); // AttachRolePolicyCommand
    // Cleanup sequence: ListAttachedRolePolicies (returns one attached arn) -> DetachRolePolicy -> ListRolePolicies (empty) -> DeleteRole
    mockSend.mockResolvedValueOnce({
      AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::aws:policy/PartiallyAttached' }],
    });
    mockSend.mockResolvedValueOnce({}); // DetachRolePolicyCommand
    mockSend.mockResolvedValueOnce({ PolicyNames: [] }); // ListRolePoliciesCommand
    mockSend.mockResolvedValueOnce({}); // DeleteRoleCommand

    await expect(
      provider.create('MyRole', RESOURCE_TYPE, {
        RoleName: 'my-test-role-xxx',
        AssumeRolePolicyDocument: ASSUME_ROLE_POLICY,
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'],
      })
    ).rejects.toThrow('Failed to create IAM role');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateRoleCommand',
      'AttachRolePolicyCommand',
      'ListAttachedRolePoliciesCommand',
      'DetachRolePolicyCommand',
      'ListRolePoliciesCommand',
      'DeleteRoleCommand',
    ]);
  });

  it('does NOT issue cleanup when CreateRole itself fails (nothing to clean up)', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateRole boom'));

    await expect(
      provider.create('MyRole', RESOURCE_TYPE, {
        RoleName: 'my-test-role-xxx',
        AssumeRolePolicyDocument: ASSUME_ROLE_POLICY,
      })
    ).rejects.toThrow('Failed to create IAM role');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateRoleCommand');
  });

  it('re-throws the original error even when cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({ Role: { Arn: 'arn:aws:iam::123:role/MyRole' } }); // CreateRoleCommand
    mockSend.mockRejectedValueOnce(new Error('PutRolePolicy boom (original)')); // PutRolePolicyCommand
    // Cleanup attempts — first one fails to abort the cleanup
    mockSend.mockRejectedValueOnce(new Error('ListAttachedRolePolicies also failed'));

    await expect(
      provider.create('MyRole', RESOURCE_TYPE, {
        RoleName: 'my-test-role-xxx',
        AssumeRolePolicyDocument: ASSUME_ROLE_POLICY,
        Policies: [
          {
            PolicyName: 'InlinePol',
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        ],
      })
    ).rejects.toThrow('PutRolePolicy boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws iam delete-role --role-name');
    expect(warnMsg).toContain('MyRole');
  });

  describe('the recovery commands name the role BARE, by provenance (issue #3136)', () => {
    // The name is `generateResourceNameWithFallback`'s output, which rewrites
    // everything outside `[A-Za-z0-9-]`: a forged template name reaches the
    // commands only as one plain word, so the site does not route through
    // `pasteableAwsCommand`. If the generator ever stops sanitizing, this fails.
    it.each([FORGED_QUOTE, FORGED_CTRL])('a forged RoleName reaches every command as a plain word, and the holes are quoted', async (forged) => {
      mockSend.mockResolvedValueOnce({ Role: { Arn: 'arn:aws:iam::123:role/MyRole' } }); // CreateRoleCommand
      mockSend.mockRejectedValueOnce(new Error('PutRolePolicy boom')); // PutRolePolicyCommand
      mockSend.mockRejectedValueOnce(new Error('ListAttachedRolePolicies also failed'));
      await expect(
        provider.create('MyRole', RESOURCE_TYPE, {
          RoleName: forged,
          AssumeRolePolicyDocument: ASSUME_ROLE_POLICY,
          Policies: [
            { PolicyName: 'InlinePol', PolicyDocument: { Version: '2012-10-17', Statement: [] } },
          ],
        })
      ).rejects.toThrow('PutRolePolicy boom');
      const msg = String(warnSpy.mock.calls[0][0]);
      const names = [...msg.matchAll(/--role-name ([^\s)]+)/g)].map((m) => m[1]);
      expect(names).toHaveLength(5);
      for (const name of names) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/);
      // A bare `<arn>` / `<name>` is two shell redirections.
      expect(msg).toContain(`--policy-arn '<arn>'`);
      expect(msg).toContain(`--policy-name '<name>'`);
    });
  });
});
