import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#4583: when an EC2 create fails AFTER its create call returned
// and the resource is left in AWS (its cleanup failed, or it has none), the
// thrown error names the id `delete()` takes so `cdkd rollback
// --revert-failed` can delete it. A cleanup that succeeded, the create call's
// own failure and a pre-flight refusal name nothing.

const { mockSend, waitUntilInstanceRunningMock, waitUntilNatGatewayAvailableMock } = vi.hoisted(
  () => ({
    mockSend: vi.fn(),
    waitUntilInstanceRunningMock: vi.fn(),
    waitUntilNatGatewayAvailableMock: vi.fn(),
  })
);

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
    waitUntilNatGatewayAvailable: waitUntilNatGatewayAvailableMock,
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

type Responder = Record<string, () => Promise<unknown>>;

/** Answer each command by its class name; anything unlisted resolves `{}`. */
function respond(table: Responder): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    const answer = table[command.constructor.name];
    return answer ? answer() : Promise.resolve({});
  });
}

const ok = (value: unknown) => () => Promise.resolve(value);
const boom = (message: string) => () => Promise.reject(new Error(message));

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

/** The resources whose create deletes what it made when the wiring fails. */
const selfCleaning = [
  {
    label: 'VPC',
    type: 'AWS::EC2::VPC',
    id: 'vpc-4583',
    props: { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: true },
    create: { CreateVpcCommand: ok({ Vpc: { VpcId: 'vpc-4583' } }) },
    createCall: 'CreateVpcCommand',
    wiring: { ModifyVpcAttributeCommand: boom('wiring boom') },
    cleanup: 'DeleteVpcCommand',
    refusal: {},
  },
  {
    label: 'Subnet',
    type: 'AWS::EC2::Subnet',
    id: 'subnet-4583',
    props: { VpcId: 'vpc-aaa', CidrBlock: '10.0.1.0/24', MapPublicIpOnLaunch: true },
    create: {
      CreateSubnetCommand: ok({ Subnet: { SubnetId: 'subnet-4583', AvailabilityZone: 'us-east-1a' } }),
    },
    createCall: 'CreateSubnetCommand',
    wiring: { ModifySubnetAttributeCommand: boom('wiring boom') },
    cleanup: 'DeleteSubnetCommand',
    refusal: { VpcId: 'vpc-aaa' },
  },
  {
    label: 'SecurityGroup',
    type: 'AWS::EC2::SecurityGroup',
    id: 'sg-4583',
    props: {
      GroupDescription: 'test',
      VpcId: 'vpc-aaa',
      SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' }],
    },
    create: { CreateSecurityGroupCommand: ok({ GroupId: 'sg-4583' }) },
    createCall: 'CreateSecurityGroupCommand',
    wiring: { AuthorizeSecurityGroupIngressCommand: boom('wiring boom') },
    cleanup: 'DeleteSecurityGroupCommand',
    refusal: { VpcId: 'vpc-aaa' },
  },
  {
    label: 'Instance',
    type: 'AWS::EC2::Instance',
    id: 'i-4583',
    props: { ImageId: 'ami-aaa', InstanceType: 't3.micro' },
    create: { RunInstancesCommand: ok({ Instances: [{ InstanceId: 'i-4583' }] }) },
    createCall: 'RunInstancesCommand',
    // The wiring failure is the running-state waiter, set per case below.
    wiring: {},
    cleanup: 'TerminateInstancesCommand',
    refusal: { InstanceType: 't3.micro' },
  },
] as const;

describe('EC2Provider create marks a resource its cleanup left behind (go-to-k/cdkd#4583)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    waitUntilInstanceRunningMock.mockReset();
    waitUntilInstanceRunningMock.mockRejectedValue(new Error('wiring boom'));
    waitUntilNatGatewayAvailableMock.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new EC2Provider();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  describe.each(selfCleaning)('$label', (c) => {
    it('names the id when the wiring fails and the cleanup fails too', async () => {
      respond({ ...c.create, ...c.wiring, [c.cleanup]: boom('cleanup refused') });

      const error = await failure(() => provider.create(`${c.label}Left`, c.type, c.props));

      expect((error as Error).message).toContain('wiring boom');
      expect(mockSend.mock.calls.map((x) => x[0].constructor.name)).toContain(c.cleanup);
      expect(createdBeforeFailure(error, `${c.label}Left`, c.type)).toBe(c.id);
    });

    it('names nothing when the cleanup succeeded', async () => {
      respond({ ...c.create, ...c.wiring });

      const error = await failure(() => provider.create(`${c.label}Clean`, c.type, c.props));

      expect((error as Error).message).toContain('wiring boom');
      expect(mockSend.mock.calls.map((x) => x[0].constructor.name)).toContain(c.cleanup);
      expect(createdBeforeFailure(error, `${c.label}Clean`, c.type)).toBeUndefined();
    });

    it("names nothing when the create call's own failure is thrown", async () => {
      respond({ [c.createCall]: boom('create boom') });

      const error = await failure(() => provider.create(`${c.label}Own`, c.type, c.props));

      expect((error as Error).message).toContain('create boom');
      expect(createdBeforeFailure(error, `${c.label}Own`, c.type)).toBeUndefined();
    });

    it('names nothing for a pre-flight refusal', async () => {
      const error = await failure(() => provider.create(`${c.label}Refused`, c.type, c.refusal));

      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, `${c.label}Refused`, c.type)).toBeUndefined();
    });
  });

  // The `error instanceof ProvisioningError ? error : wrap` arm: a wiring step
  // that throws a cdkd-typed error is re-thrown as is, and must still carry the
  // mark when the terminate fails. No production wiring step raises one today,
  // so the waiter stands in for it.
  describe('Instance, a ProvisioningError from the wiring', () => {
    const props = { ImageId: 'ami-aaa', InstanceType: 't3.micro' };

    it('names the instance id when the terminate fails, on the same error instance', async () => {
      const waiterError = new ProvisioningError(
        'Timed out waiting for instance i-4583 to be running',
        'AWS::EC2::Instance',
        'InstancePe',
        'i-4583'
      );
      waitUntilInstanceRunningMock.mockRejectedValue(waiterError);
      respond({
        RunInstancesCommand: ok({ Instances: [{ InstanceId: 'i-4583' }] }),
        TerminateInstancesCommand: boom('cleanup refused'),
      });

      const error = await failure(() => provider.create('InstancePe', 'AWS::EC2::Instance', props));

      expect(error).toBe(waiterError);
      expect(waitUntilInstanceRunningMock).toHaveBeenCalled();
      expect(mockSend.mock.calls.map((x) => x[0].constructor.name)).toContain(
        'TerminateInstancesCommand'
      );
      expect(createdBeforeFailure(error, 'InstancePe', 'AWS::EC2::Instance')).toBe('i-4583');
    });
  });

  describe('EIP (no cleanup)', () => {
    const TYPE = 'AWS::EC2::EIP';
    const allocate = { AllocateAddressCommand: ok({ AllocationId: 'eipalloc-4583', PublicIp: '54.0.0.9' }) };

    it('names the id a successful create returns when the association fails', async () => {
      respond(allocate);
      const success = await provider.create('EipOk', TYPE, {});

      respond({ ...allocate, AssociateAddressCommand: boom('associate boom') });
      const error = await failure(() => provider.create('EipLeft', TYPE, { InstanceId: 'i-aaa' }));

      expect((error as Error).message).toContain('associate boom');
      expect(createdBeforeFailure(error, 'EipLeft', TYPE)).toBe(success.physicalId);
      expect(success.physicalId).toBe('54.0.0.9|eipalloc-4583');
    });

    it('names nothing when AllocateAddress itself fails', async () => {
      respond({ AllocateAddressCommand: boom('allocate boom') });

      const error = await failure(() => provider.create('EipOwn', TYPE, {}));

      expect((error as Error).message).toContain('allocate boom');
      expect(createdBeforeFailure(error, 'EipOwn', TYPE)).toBeUndefined();
    });
  });

  describe('NatGateway (no cleanup)', () => {
    const TYPE = 'AWS::EC2::NatGateway';
    const props = { SubnetId: 'subnet-aaa', AllocationId: 'eipalloc-aaa' };

    it('names the gateway when the available-state wait fails', async () => {
      respond({ CreateNatGatewayCommand: ok({ NatGateway: { NatGatewayId: 'nat-4583' } }) });
      waitUntilNatGatewayAvailableMock.mockRejectedValue(new Error('wait boom'));

      const error = await failure(() => provider.create('NatLeft', TYPE, props));

      expect((error as Error).message).toContain('wait boom');
      expect(createdBeforeFailure(error, 'NatLeft', TYPE)).toBe('nat-4583');
    });

    it('names nothing when CreateNatGateway itself fails', async () => {
      respond({ CreateNatGatewayCommand: boom('create boom') });

      const error = await failure(() => provider.create('NatOwn', TYPE, props));

      expect((error as Error).message).toContain('create boom');
      expect(createdBeforeFailure(error, 'NatOwn', TYPE)).toBeUndefined();
    });

    it('names nothing for a pre-flight refusal', async () => {
      const error = await failure(() => provider.create('NatRefused', TYPE, {}));

      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'NatRefused', TYPE)).toBeUndefined();
    });
  });
});
