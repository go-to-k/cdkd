import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateTagsCommand,
  DescribeInstancesCommand,
  ModifyInstanceAttributeCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#5630 (measured us-east-1, 2026-11-04): under `--no-wait` the
// DescribeInstances sent the moment RunInstances returned answered
// `InvalidInstanceID.NotFound` for the id it had just handed out. The wiring
// catch terminated the healthy instance, the engine re-ran the create under a
// new client token, and the second launch collided on the declared fixed IPv6
// address (`InvalidIPAddress.InUse`). These cases pin that the read is retried
// instead: one launch, no terminate.

const { mockSend, warnMock, waitUntilInstanceRunningMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnMock: vi.fn(),
  waitUntilInstanceRunningMock: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, waitUntilInstanceRunning: waitUntilInstanceRunningMock };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { getLogger: () => logger };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const INSTANCE_ID = 'i-0ca4747b997fd65fc';
const PROPS = {
  ImageId: 'ami-12345678',
  InstanceType: 't3.nano',
  SubnetId: 'subnet-1',
  Ipv6Addresses: [{ Ipv6Address: '2600:1f18:fe6:a400::77' }],
};

function ec2Error(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const notFound = (): Error =>
  ec2Error('InvalidInstanceID.NotFound', `The instance ID '${INSTANCE_ID}' does not exist`);

/**
 * RunInstances succeeds; DescribeInstances / ModifyInstanceAttribute answer
 * with the queued failures first (one per call), then succeed.
 */
function mockEc2(failures: {
  describe?: Error[];
  modify?: Error[];
  createTags?: Error[];
  /** Refuse the TAGGED RunInstances (no ec2:CreateTags), so the launch goes out untagged. */
  refuseTaggedLaunch?: boolean;
}) {
  const describeFailures = [...(failures.describe ?? [])];
  const modifyFailures = [...(failures.modify ?? [])];
  const createTagsFailures = [...(failures.createTags ?? [])];
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof RunInstancesCommand) {
      if (failures.refuseTaggedLaunch && command.input.TagSpecifications) {
        return Promise.reject(
          ec2Error(
            'UnauthorizedOperation',
            'You are not authorized to perform: ec2:CreateTags on resource: instance'
          )
        );
      }
      return Promise.resolve({ Instances: [{ InstanceId: INSTANCE_ID }] });
    }
    if (command instanceof CreateTagsCommand) {
      const failure = createTagsFailures.shift();
      if (failure) return Promise.reject(failure);
      return Promise.resolve({});
    }
    if (command instanceof DescribeInstancesCommand) {
      const failure = describeFailures.shift();
      if (failure) return Promise.reject(failure);
      return Promise.resolve({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: INSTANCE_ID,
                State: { Name: 'pending' },
                PrivateIpAddress: '10.0.0.5',
                PrivateDnsName: 'ip-10-0-0-5.ec2.internal',
                Placement: { AvailabilityZone: 'us-east-1a' },
                PublicDnsName: '',
              },
            ],
          },
        ],
      });
    }
    if (command instanceof ModifyInstanceAttributeCommand) {
      const failure = modifyFailures.shift();
      if (failure) return Promise.reject(failure);
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

const sleepDelays = (spy: { mock: { calls: unknown[][] } }): number[] =>
  spy.mock.calls.map((call) => call[0] as number);

const callsOf = (ctor: new (...args: never[]) => unknown): number =>
  mockSend.mock.calls.filter(([c]) => c instanceof ctor).length;

describe('EC2 Instance create: a just-launched instance not yet visible (#5630)', () => {
  let originalNoWait: string | undefined;
  let sleepSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    process.env['CDKD_NO_WAIT'] = 'true';
    sleepSpy = vi
      .spyOn(EC2Provider.prototype as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    sleepSpy.mockRestore();
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it('retries the post-launch DescribeInstances instead of terminating and relaunching', async () => {
    mockEc2({ describe: [notFound(), notFound()] });

    const result = await new EC2Provider().create('Ipv6AddressInstance5630', 'AWS::EC2::Instance', PROPS);

    expect(result.physicalId).toBe(INSTANCE_ID);
    expect(result.attributes?.['PrivateIp']).toBe('10.0.0.5');
    expect(callsOf(RunInstancesCommand)).toBe(1);
    expect(callsOf(TerminateInstancesCommand)).toBe(0);
    expect(callsOf(DescribeInstancesCommand)).toBe(3);
    expect(sleepDelays(sleepSpy)).toEqual([1000, 2000]);
  });

  it('retries the SourceDestCheck modify the same way', async () => {
    mockEc2({ modify: [notFound()] });

    const result = await new EC2Provider().create('Instance', 'AWS::EC2::Instance', {
      ...PROPS,
      SourceDestCheck: false,
    });

    expect(result.physicalId).toBe(INSTANCE_ID);
    expect(callsOf(ModifyInstanceAttributeCommand)).toBe(2);
    expect(callsOf(RunInstancesCommand)).toBe(1);
    expect(callsOf(TerminateInstancesCommand)).toBe(0);
  });

  it('still terminates and throws once the not-found outlasts the bounded budget', async () => {
    mockEc2({ describe: Array.from({ length: 8 }, notFound) });

    await expect(
      new EC2Provider().create('Ipv6AddressInstance5630', 'AWS::EC2::Instance', PROPS)
    ).rejects.toThrow(/does not exist/);

    expect(callsOf(DescribeInstancesCommand)).toBe(8);
    expect(sleepDelays(sleepSpy)).toEqual([
      1000, 2000, 4000, 8000, 8000, 8000, 8000,
    ]);
    expect(callsOf(TerminateInstancesCommand)).toBe(1);
  });

  it('does not retry an error other than InvalidInstanceID.NotFound', async () => {
    mockEc2({ describe: [ec2Error('UnauthorizedOperation', 'You are not authorized')] });

    await expect(
      new EC2Provider().create('Ipv6AddressInstance5630', 'AWS::EC2::Instance', PROPS)
    ).rejects.toThrow(/not authorized/);

    expect(callsOf(DescribeInstancesCommand)).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(callsOf(TerminateInstancesCommand)).toBe(1);
  });
  it('retries the CreateTags of an untagged launch instead of dropping the tags', async () => {
    mockEc2({ refuseTaggedLaunch: true, createTags: [notFound()] });

    const result = await new EC2Provider().create('Instance', 'AWS::EC2::Instance', {
      ...PROPS,
      Tags: [{ Key: 'team', Value: 'a' }],
    });

    expect(result.physicalId).toBe(INSTANCE_ID);
    expect(callsOf(CreateTagsCommand)).toBe(2);
    expect(callsOf(TerminateInstancesCommand)).toBe(0);
    expect(
      warnMock.mock.calls.filter(([m]) => String(m).includes('Failed to apply tags'))
    ).toEqual([]);
  });

  it('retries the DescribeInstances after the running wait too (default, no --no-wait)', async () => {
    delete process.env['CDKD_NO_WAIT'];
    mockEc2({ describe: [notFound()] });

    const result = await new EC2Provider().create('Instance', 'AWS::EC2::Instance', PROPS);

    expect(waitUntilInstanceRunningMock).toHaveBeenCalledTimes(1);
    expect(result.physicalId).toBe(INSTANCE_ID);
    expect(callsOf(DescribeInstancesCommand)).toBe(2);
    expect(callsOf(RunInstancesCommand)).toBe(1);
    expect(callsOf(TerminateInstancesCommand)).toBe(0);
  });
});
