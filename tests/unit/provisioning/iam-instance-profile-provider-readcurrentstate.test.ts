import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetInstanceProfileCommand, NoSuchEntityException } from '@aws-sdk/client-iam';

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

import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';

describe('IAMInstanceProfileProvider.readCurrentState', () => {
  let provider: IAMInstanceProfileProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMInstanceProfileProvider();
  });

  it('returns CFn-shaped properties from GetInstanceProfile (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      InstanceProfile: {
        InstanceProfileName: 'my-profile',
        Path: '/',
        Roles: [{ RoleName: 'role-a', Arn: 'arn:aws:iam::123:role/role-a' }],
        // AWS-managed fields the comparator should ignore.
        Arn: 'arn:aws:iam::123:instance-profile/my-profile',
        InstanceProfileId: 'AIPA...',
        CreateDate: new Date(0),
      },
    });

    const result = await provider.readCurrentState(
      'my-profile',
      'Logical',
      'AWS::IAM::InstanceProfile'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetInstanceProfileCommand);
    expect(result).toEqual({
      InstanceProfileName: 'my-profile',
      Path: '/',
      Roles: ['role-a'],
    });
  });

  it('returns undefined when profile does not exist', async () => {
    mockSend.mockRejectedValueOnce(
      new NoSuchEntityException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'my-profile',
      'Logical',
      'AWS::IAM::InstanceProfile'
    );
    expect(result).toBeUndefined();
  });

  it('omits Roles when none attached', async () => {
    mockSend.mockResolvedValueOnce({
      InstanceProfile: {
        InstanceProfileName: 'my-profile',
        Path: '/',
        Roles: [],
      },
    });

    const result = await provider.readCurrentState(
      'my-profile',
      'Logical',
      'AWS::IAM::InstanceProfile'
    );
    expect(result).not.toHaveProperty('Roles');
  });
});
