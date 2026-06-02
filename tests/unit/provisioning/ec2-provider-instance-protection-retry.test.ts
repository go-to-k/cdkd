import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::EC2::Instance';
const INSTANCE_ID = 'i-0123456789abcdef0';

// AWS's `ModifyInstanceAttribute` write (clearing DisableApiTermination) lags
// the `TerminateInstances` read, so a `destroy --remove-protection` that flips
// protection off then immediately terminates can 400 with "may not be
// terminated. Modify its 'disableApiTermination' instance attribute". cdkd
// retries the flip + terminate to close the propagation window — but ONLY when
// `--remove-protection` was requested (a protected instance WITHOUT the flag
// must fail fast so the user is told to pass it).
describe('EC2Provider instance disableApiTermination propagation-race retry', () => {
  let provider: EC2Provider;

  const installFastSleep = (p: EC2Provider): void => {
    (p as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(() =>
      Promise.resolve()
    );
  };

  const protectionError = (): Error =>
    new Error(
      `The instance '${INSTANCE_ID}' may not be terminated. Modify its 'disableApiTermination' instance attribute and try again.`
    );

  // Dispatch the mock by command class name. `terminateBehavior` is consumed
  // one entry per TerminateInstancesCommand call ('fail' = throw protection
  // error, 'ok' = resolve). DescribeInstances (from waitUntilInstanceTerminated)
  // always reports terminated so the waiter resolves immediately once a
  // terminate succeeds.
  const wire = (terminateBehavior: Array<'fail' | 'ok'>): void => {
    let terminateCall = 0;
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'ModifyInstanceAttributeCommand') return Promise.resolve({});
      if (name === 'TerminateInstancesCommand') {
        const behavior = terminateBehavior[terminateCall] ?? 'ok';
        terminateCall++;
        if (behavior === 'fail') return Promise.reject(protectionError());
        return Promise.resolve({ TerminatingInstances: [{ CurrentState: { Name: 'shutting-down' } }] });
      }
      if (name === 'DescribeInstancesCommand') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID, State: { Name: 'terminated' } }] }],
        });
      }
      return Promise.resolve({});
    });
  };

  const callCount = (commandName: string): number =>
    mockSend.mock.calls.filter((c) => c[0]?.constructor?.name === commandName).length;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EC2Provider();
    installFastSleep(provider);
  });

  it('--remove-protection: retries flip+terminate through the propagation-race 400, then succeeds', async () => {
    // terminate fails twice (protection not yet propagated), succeeds on the 3rd.
    wire(['fail', 'fail', 'ok']);

    await provider.delete(INSTANCE_ID, INSTANCE_ID, RESOURCE_TYPE, undefined, {
      removeProtection: true,
    });

    expect(callCount('TerminateInstancesCommand')).toBe(3);
    // Flip-off: 1 initial + 1 re-flip per failed attempt (2) = 3.
    expect(callCount('ModifyInstanceAttributeCommand')).toBe(3);
  });

  it('without --remove-protection: the protection 400 fails fast (no retry, no flip-off)', async () => {
    wire(['fail']);

    await expect(
      provider.delete(INSTANCE_ID, INSTANCE_ID, RESOURCE_TYPE, undefined, { removeProtection: false })
    ).rejects.toBeInstanceOf(ProvisioningError);

    expect(callCount('TerminateInstancesCommand')).toBe(1);
    expect(callCount('ModifyInstanceAttributeCommand')).toBe(0);
  });

  it('--remove-protection: a non-protection terminate error fails fast (not retried)', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'ModifyInstanceAttributeCommand') return Promise.resolve({});
      if (name === 'TerminateInstancesCommand') return Promise.reject(new Error('InsufficientInstanceCapacity'));
      return Promise.resolve({});
    });

    await expect(
      provider.delete(INSTANCE_ID, INSTANCE_ID, RESOURCE_TYPE, undefined, { removeProtection: true })
    ).rejects.toThrow(/Failed to terminate EC2 Instance/);

    // Only the initial flip-off + a single terminate attempt (non-protection
    // errors are not part of the propagation-race retry).
    expect(callCount('TerminateInstancesCommand')).toBe(1);
    expect(callCount('ModifyInstanceAttributeCommand')).toBe(1);
  });

  it('--remove-protection: gives up after the retry budget if protection never clears', async () => {
    // Always fails with the protection error -> exhausts the 5-attempt budget.
    wire(['fail', 'fail', 'fail', 'fail', 'fail']);

    await expect(
      provider.delete(INSTANCE_ID, INSTANCE_ID, RESOURCE_TYPE, undefined, { removeProtection: true })
    ).rejects.toThrow(/may not be terminated/);

    expect(callCount('TerminateInstancesCommand')).toBe(5);
  });
});
