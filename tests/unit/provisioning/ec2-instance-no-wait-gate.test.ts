import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { RunInstancesCommand } from '@aws-sdk/client-ec2';

// Issue #1277: the EC2 Instance `running` wait was unconditional, so
// `cdkd deploy --no-wait` still blocked on it. The NAT Gateway wait in the
// same provider has always been gated; these cases pin that the Instance
// wait now matches, and that the DEFAULT path is unchanged (which is what
// keeps previously published default-mode measurements valid).

const { mockSend, waitUntilInstanceRunningMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  waitUntilInstanceRunningMock: vi.fn(() => Promise.resolve({})),
}));

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

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    waitUntilInstanceRunning: waitUntilInstanceRunningMock,
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const PROPS = { ImageId: 'ami-12345678', InstanceType: 't3.micro', SubnetId: 'subnet-1' };

function mockRunInstancesOk(state: 'pending' | 'running') {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-1234567890abcdef0' }] });
    }
    // DescribeInstances (and the tag call, which returns nothing meaningful).
    return Promise.resolve({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-1234567890abcdef0',
              State: { Name: state },
              // Under --no-wait the instance can still be `pending`, so AWS
              // has not assigned the addresses yet.
              ...(state === 'running'
                ? {
                    PrivateIpAddress: '10.0.0.5',
                    PublicIpAddress: '54.0.0.5',
                    Placement: { AvailabilityZone: 'us-east-1a' },
                  }
                : {}),
            },
          ],
        },
      ],
    });
  });
}

describe('EC2 Instance running-state wait gating (issue #1277)', () => {
  let originalNoWait: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it('waits for running by default (unchanged behavior)', async () => {
    mockRunInstancesOk('running');

    const result = await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', PROPS);

    expect(result.physicalId).toBe('i-1234567890abcdef0');
    expect(waitUntilInstanceRunningMock).toHaveBeenCalledTimes(1);
    const [, input] = waitUntilInstanceRunningMock.mock.calls[0] as unknown as [
      unknown,
      { InstanceIds: string[] },
    ];
    expect(input.InstanceIds).toEqual(['i-1234567890abcdef0']);
    expect(result.attributes?.['PrivateIp']).toBe('10.0.0.5');
  });

  it('skips the wait under CDKD_NO_WAIT', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockRunInstancesOk('pending');

    const result = await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', PROPS);

    expect(waitUntilInstanceRunningMock).not.toHaveBeenCalled();
    expect(result.physicalId).toBe('i-1234567890abcdef0');
  });

  it('still returns attributes when the pending instance has no addresses yet', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockRunInstancesOk('pending');

    const result = await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', PROPS);

    // The accepted --no-wait trade-off: empty rather than a hard failure.
    expect(result.attributes?.['PrivateIp']).toBe('');
    expect(result.attributes?.['PublicIp']).toBe('');
    expect(result.attributes?.['InstanceId']).toBe('i-1234567890abcdef0');
  });
});
