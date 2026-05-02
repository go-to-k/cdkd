import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetInstanceProfileCommand, ListInstanceProfilesCommand } from '@aws-sdk/client-iam';

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

import { IAMInstanceProfileProvider } from '../../../../src/provisioning/providers/iam-instance-profile-provider.js';

describe('IAMInstanceProfileProvider — import', () => {
  let provider: IAMInstanceProfileProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMInstanceProfileProvider();
  });

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyInstanceProfile',
      resourceType: 'AWS::IAM::InstanceProfile',
      cdkPath: 'MyStack/MyInstanceProfile',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {} as Record<string, unknown>,
      ...overrides,
    };
  }

  it('verifies explicit knownPhysicalId via GetInstanceProfile', async () => {
    mockSend.mockResolvedValueOnce({ InstanceProfile: { InstanceProfileName: 'my-profile' } });
    const result = await provider.import!(makeInput({ knownPhysicalId: 'my-profile' }));
    expect(result).toEqual({ physicalId: 'my-profile', attributes: {} });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetInstanceProfileCommand);
  });

  it('finds profile by aws:cdk:path tag via ListInstanceProfiles', async () => {
    mockSend.mockResolvedValueOnce({
      InstanceProfiles: [
        { InstanceProfileName: 'other', Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/X' }] },
        {
          InstanceProfileName: 'mine',
          Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyInstanceProfile' }],
        },
      ],
      IsTruncated: false,
    });
    const result = await provider.import!(makeInput());
    expect(result).toEqual({ physicalId: 'mine', attributes: {} });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListInstanceProfilesCommand);
  });

  it('returns null when no profile has matching cdkPath tag', async () => {
    mockSend.mockResolvedValueOnce({
      InstanceProfiles: [
        { InstanceProfileName: 'other', Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/X' }] },
      ],
      IsTruncated: false,
    });
    const result = await provider.import!(makeInput());
    expect(result).toBeNull();
  });
});
