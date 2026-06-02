import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    // The CC-API removeProtection path flips DisableApiTermination via a
    // SEPARATE EC2 client (not the cloudControl client) — that wiring is
    // exactly what this suite pins.
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => child) };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const INSTANCE = 'i-0abc';
const PROTECTION_MSG =
  "The instance 'i-0abc' may not be terminated. Modify its 'disableApiTermination' instance attribute and try again.";

// Wires the cloudControl mock so the first `failCount` DeleteResource attempts
// reach a FAILED status carrying the EC2 termination-protection message, then
// the next attempt succeeds. Each DeleteResource returns a token; the matching
// GetResourceRequestStatus reports FAILED (until failCount is exhausted) or
// SUCCESS.
function wireCloudControl(failCount: number): void {
  let deleteAttempt = 0;
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'DeleteResourceCommand') {
      deleteAttempt += 1;
      return Promise.resolve({ ProgressEvent: { RequestToken: `tok-${deleteAttempt}` } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      if (deleteAttempt <= failCount) {
        return Promise.resolve({
          ProgressEvent: {
            OperationStatus: 'FAILED',
            StatusMessage: PROTECTION_MSG,
            TypeName: 'AWS::EC2::Instance',
            Identifier: INSTANCE,
          },
        });
      }
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
    }
    return Promise.resolve({});
  });
}

const ec2CallCount = (cmdName: string): number =>
  mockEc2Send.mock.calls.filter((c) => c[0]?.constructor?.name === cmdName).length;
const ccCallCount = (cmdName: string): number =>
  mockCloudControlSend.mock.calls.filter((c) => c[0]?.constructor?.name === cmdName).length;

describe('CloudControlProvider delete: --remove-protection on a CC-API-routed EC2 Instance', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEc2Send.mockResolvedValue({});
    provider = new CloudControlProvider();
    // No real backoff waits.
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(() =>
      Promise.resolve()
    );
  });

  it('flips DisableApiTermination off and retries the CC-API delete through the propagation race', async () => {
    wireCloudControl(2); // FAILED twice, then SUCCESS

    await provider.delete(INSTANCE, INSTANCE, 'AWS::EC2::Instance', undefined, {
      removeProtection: true,
    });

    // 3 delete attempts (2 failed + 1 success).
    expect(ccCallCount('DeleteResourceCommand')).toBe(3);
    // Flip-off via the EC2 client: 1 initial + 1 re-flip per failed attempt (2) = 3.
    expect(ec2CallCount('ModifyInstanceAttributeCommand')).toBe(3);
    const flip = mockEc2Send.mock.calls.find(
      (c) => c[0]?.constructor?.name === 'ModifyInstanceAttributeCommand'
    );
    expect(flip![0].input).toEqual({
      InstanceId: INSTANCE,
      DisableApiTermination: { Value: false },
    });
  });

  it('without --remove-protection: the protection failure surfaces immediately (no EC2 flip, no retry)', async () => {
    wireCloudControl(1);

    await expect(
      provider.delete(INSTANCE, INSTANCE, 'AWS::EC2::Instance', undefined, {
        removeProtection: false,
      })
    ).rejects.toBeInstanceOf(ProvisioningError);

    expect(ccCallCount('DeleteResourceCommand')).toBe(1);
    expect(ec2CallCount('ModifyInstanceAttributeCommand')).toBe(0);
  });

  it('does not flip / retry for a non-EC2-Instance CC-API resource even with --remove-protection', async () => {
    wireCloudControl(1);

    await expect(
      provider.delete('some-id', 'some-id', 'AWS::SomeOther::Type', undefined, {
        removeProtection: true,
      })
    ).rejects.toBeInstanceOf(ProvisioningError);

    expect(ec2CallCount('ModifyInstanceAttributeCommand')).toBe(0);
    expect(ccCallCount('DeleteResourceCommand')).toBe(1);
  });
});
