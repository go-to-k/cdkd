import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetInstanceProfileCommand, NoSuchEntityException } from '@aws-sdk/client-iam';

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

  it('returns null when explicit knownPhysicalId does not exist (NoSuchEntity)', async () => {
    mockSend.mockRejectedValueOnce(
      new NoSuchEntityException({ $metadata: {}, message: 'no such entity' })
    );
    const result = await provider.import!(makeInput({ knownPhysicalId: 'gone' }));
    expect(result).toBeNull();
  });

  // The `aws:cdk:path` tag walk was removed (issue #1134): AWS rejects
  // `aws:`-prefixed tag writes, so the tag never exists on a real profile.
  // With no explicit id, import returns null without issuing any AWS call.
  it('returns null without any AWS call when only cdkPath is given', async () => {
    const result = await provider.import!(makeInput());
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
