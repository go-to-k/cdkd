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

import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';

const RESOURCE_TYPE = 'AWS::IAM::InstanceProfile';

describe('IAMInstanceProfileProvider partial-create cleanup (Issue #376)', () => {
  let provider: IAMInstanceProfileProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new IAMInstanceProfileProvider();
  });

  it('issues cleanup (RemoveRole + DeleteInstanceProfile) when AddRoleToInstanceProfile fails after CreateInstanceProfile succeeded', async () => {
    mockSend.mockResolvedValueOnce({
      InstanceProfile: { Arn: 'arn:aws:iam::123:instance-profile/MyProfile' },
    }); // CreateInstanceProfileCommand
    mockSend.mockResolvedValueOnce({}); // AddRoleToInstanceProfileCommand (first role attached)
    mockSend.mockRejectedValueOnce(new Error('AddRoleToInstanceProfile boom (second role)')); // AddRoleToInstanceProfileCommand (second role fails)
    // Cleanup sequence:
    mockSend.mockResolvedValueOnce({}); // RemoveRoleFromInstanceProfileCommand (first role)
    mockSend.mockResolvedValueOnce({}); // DeleteInstanceProfileCommand

    await expect(
      provider.create('MyProfile', RESOURCE_TYPE, {
        InstanceProfileName: 'my-test-profile-xxx',
        Roles: ['role-a', 'role-b'],
      })
    ).rejects.toThrow('Failed to create IAM instance profile');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateInstanceProfileCommand',
      'AddRoleToInstanceProfileCommand',
      'AddRoleToInstanceProfileCommand',
      'RemoveRoleFromInstanceProfileCommand',
      'DeleteInstanceProfileCommand',
    ]);
    expect(mockSend.mock.calls[3][0].input).toEqual({
      InstanceProfileName: 'my-test-profile-xxx',
      RoleName: 'role-a',
    });
  });

  it('does NOT issue cleanup when CreateInstanceProfile itself fails (nothing to clean up)', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateInstanceProfile boom'));

    await expect(
      provider.create('MyProfile', RESOURCE_TYPE, {
        InstanceProfileName: 'my-test-profile-xxx',
        Roles: ['role-a'],
      })
    ).rejects.toThrow('Failed to create IAM instance profile');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateInstanceProfileCommand');
  });

  it('re-throws the original error even when cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({
      InstanceProfile: { Arn: 'arn:aws:iam::123:instance-profile/MyProfile' },
    }); // CreateInstanceProfileCommand
    mockSend.mockRejectedValueOnce(new Error('AddRoleToInstanceProfile boom (original)')); // first AddRole fails
    // No roles to remove. Cleanup attempts DeleteInstanceProfile -> fails.
    mockSend.mockRejectedValueOnce(new Error('DeleteInstanceProfile also failed'));

    await expect(
      provider.create('MyProfile', RESOURCE_TYPE, {
        InstanceProfileName: 'my-test-profile-xxx',
        Roles: ['role-a'],
      })
    ).rejects.toThrow('AddRoleToInstanceProfile boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws iam delete-instance-profile --instance-profile-name');
    expect(warnMsg).toContain('my-test-profile-xxx');
  });
});
