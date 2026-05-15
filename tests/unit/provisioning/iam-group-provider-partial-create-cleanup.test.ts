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

const RESOURCE_TYPE = 'AWS::IAM::Group';

describe('IAMUserGroupProvider createGroup partial-create cleanup (Issue #376)', () => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new IAMUserGroupProvider();
  });

  it('issues cleanup (DetachGroupPolicy + DeleteGroupPolicy + DeleteGroup) when AttachGroupPolicy fails after CreateGroup succeeded', async () => {
    mockSend.mockResolvedValueOnce({ Group: { Arn: 'arn:aws:iam::123:group/MyGroup' } }); // CreateGroupCommand
    mockSend.mockRejectedValueOnce(new Error('AttachGroupPolicy boom')); // AttachGroupPolicyCommand
    // Cleanup sequence:
    mockSend.mockResolvedValueOnce({
      AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::aws:policy/PartiallyAttached' }],
    }); // ListAttachedGroupPolicies
    mockSend.mockResolvedValueOnce({}); // DetachGroupPolicyCommand
    mockSend.mockResolvedValueOnce({ PolicyNames: [] }); // ListGroupPoliciesCommand
    mockSend.mockResolvedValueOnce({}); // DeleteGroupCommand

    await expect(
      provider.create('MyGroup', RESOURCE_TYPE, {
        GroupName: 'my-test-group-xxx',
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'],
      })
    ).rejects.toThrow('Failed to create IAM group');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateGroupCommand',
      'AttachGroupPolicyCommand',
      'ListAttachedGroupPoliciesCommand',
      'DetachGroupPolicyCommand',
      'ListGroupPoliciesCommand',
      'DeleteGroupCommand',
    ]);
  });

  it('does NOT issue cleanup when CreateGroup itself fails (nothing to clean up)', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateGroup boom'));

    await expect(
      provider.create('MyGroup', RESOURCE_TYPE, {
        GroupName: 'my-test-group-xxx',
      })
    ).rejects.toThrow('Failed to create IAM group');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateGroupCommand');
  });

  it('re-throws the original error even when cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({ Group: { Arn: 'arn:aws:iam::123:group/MyGroup' } }); // CreateGroupCommand
    mockSend.mockRejectedValueOnce(new Error('PutGroupPolicy boom (original)')); // PutGroupPolicyCommand
    mockSend.mockRejectedValueOnce(new Error('ListAttachedGroupPolicies also failed'));

    await expect(
      provider.create('MyGroup', RESOURCE_TYPE, {
        GroupName: 'my-test-group-xxx',
        Policies: [
          {
            PolicyName: 'InlinePol',
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        ],
      })
    ).rejects.toThrow('PutGroupPolicy boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws iam delete-group --group-name');
    expect(warnMsg).toContain('my-test-group-xxx');
  });
});
