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
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';

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
      // go-to-k/cdkd#4945: CreateVpc sends no name and no token, so its replay
      // would make another VPC; the others collide or resume on a token.
      expect(isMarkedNonRetryable(error)).toBe(c.type === 'AWS::EC2::VPC');
    });

    it('names nothing when the cleanup succeeded', async () => {
      respond({ ...c.create, ...c.wiring });

      const error = await failure(() => provider.create(`${c.label}Clean`, c.type, c.props));

      expect((error as Error).message).toContain('wiring boom');
      expect(mockSend.mock.calls.map((x) => x[0].constructor.name)).toContain(c.cleanup);
      expect(createdBeforeFailure(error, `${c.label}Clean`, c.type)).toBeUndefined();
      expect(isMarkedNonRetryable(error)).toBe(false);
    });

    it("names nothing when the create call's own failure is thrown", async () => {
      respond({ [c.createCall]: boom('create boom') });

      const error = await failure(() => provider.create(`${c.label}Own`, c.type, c.props));

      expect((error as Error).message).toContain('create boom');
      expect(createdBeforeFailure(error, `${c.label}Own`, c.type)).toBeUndefined();
    });

    // go-to-k/cdkd#5511: reported right after the create call returned, before
    // the wiring; withdrawn when the cleanup removed the resource.
    it('reports the id before the wiring calls when the cleanup fails too', async () => {
      const sink = new CreatedResourceSink(`${c.label}Rep`, c.type);
      let atWiring: unknown = 'unset';
      const wiring: Responder = {};
      for (const [name, answer] of Object.entries(c.wiring as Responder)) {
        wiring[name] = () => {
          atWiring = sink.report;
          return answer();
        };
      }
      waitUntilInstanceRunningMock.mockImplementation(() => {
        atWiring = sink.report;
        return Promise.reject(new Error('wiring boom'));
      });
      respond({ ...c.create, ...wiring, [c.cleanup]: boom('cleanup refused') });

      await collectCreatedResources(sink, () =>
        failure(() => provider.create(`${c.label}Rep`, c.type, c.props))
      );

      expect(atWiring).toEqual({ physicalId: c.id });
      expect(sink.report).toEqual({ physicalId: c.id });
    });

    it('leaves nothing reported when the cleanup succeeded', async () => {
      const sink = new CreatedResourceSink(`${c.label}Gone`, c.type);
      respond({ ...c.create, ...c.wiring });

      await collectCreatedResources(sink, () =>
        failure(() => provider.create(`${c.label}Gone`, c.type, c.props))
      );

      expect(mockSend.mock.calls.map((x) => x[0].constructor.name)).toContain(c.cleanup);
      expect(sink.report).toBeUndefined();
    });

    it("reports nothing when the create call's own failure is thrown", async () => {
      const sink = new CreatedResourceSink(`${c.label}NoRep`, c.type);
      respond({ [c.createCall]: boom('create boom') });

      await collectCreatedResources(sink, () =>
        failure(() => provider.create(`${c.label}NoRep`, c.type, c.props))
      );

      expect(sink.report).toBeUndefined();
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

      respond({
        ...allocate,
        AssociateAddressCommand: boom('associate boom'),
        ReleaseAddressCommand: boom('release refused'),
      });
      const error = await failure(() => provider.create('EipLeft', TYPE, { InstanceId: 'i-aaa' }));

      expect((error as Error).message).toContain('associate boom');
      expect(createdBeforeFailure(error, 'EipLeft', TYPE)).toBe(success.physicalId);
      // go-to-k/cdkd#4945: a replayed AllocateAddress would allocate another.
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(success.physicalId).toBe('54.0.0.9|eipalloc-4583');
    });

    it('releases the address a transient association failure followed, leaving it retryable (#4945)', async () => {
      const throttled = Object.assign(new Error('Request limit exceeded.'), {
        name: 'RequestLimitExceeded',
      });
      respond({ ...allocate, AssociateAddressCommand: () => Promise.reject(throttled) });
      const error = await failure(() => provider.create('EipRetry', TYPE, { InstanceId: 'i-aaa' }));

      const release = mockSend.mock.calls.find((x) => x[0].constructor.name === 'ReleaseAddressCommand');
      expect(release?.[0].input).toEqual({ AllocationId: 'eipalloc-4583' });
      expect(createdBeforeFailure(error, 'EipRetry', TYPE)).toBeUndefined();
      expect(isMarkedNonRetryable(error)).toBe(false);
    });

    it('retries a throttled release, then leaves the error retryable (#4945)', async () => {
      const throttled = (): Error =>
        Object.assign(new Error('Request limit exceeded.'), { name: 'RequestLimitExceeded' });
      let releases = 0;
      respond({
        ...allocate,
        AssociateAddressCommand: () => Promise.reject(throttled()),
        ReleaseAddressCommand: () => (++releases === 1 ? Promise.reject(throttled()) : Promise.resolve({})),
      });
      const error = await failure(() => provider.create('EipThrottled', TYPE, { InstanceId: 'i-aaa' }));

      expect(releases).toBe(2);
      expect(createdBeforeFailure(error, 'EipThrottled', TYPE)).toBeUndefined();
      expect(isMarkedNonRetryable(error)).toBe(false);
    });

    it('keeps the mark when the release reads NotFound (a just-allocated address can)', async () => {
      respond({
        ...allocate,
        AssociateAddressCommand: boom('associate boom'),
        ReleaseAddressCommand: () =>
          Promise.reject(
            Object.assign(new Error('The allocation ID does not exist'), {
              name: 'InvalidAllocationID.NotFound',
            })
          ),
      });
      const error = await failure(() => provider.create('EipNotFound', TYPE, { InstanceId: 'i-aaa' }));

      expect(createdBeforeFailure(error, 'EipNotFound', TYPE)).toBe('54.0.0.9|eipalloc-4583');
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    // go-to-k/cdkd#5511: reported before the association; withdrawn on release.
    it('reports the composite id before the association call', async () => {
      const sink = new CreatedResourceSink('EipRep', TYPE);
      let atAssociate: unknown = 'unset';
      respond({
        ...allocate,
        AssociateAddressCommand: () => {
          atAssociate = sink.report;
          return Promise.reject(new Error('associate boom'));
        },
        ReleaseAddressCommand: boom('release refused'),
      });

      await collectCreatedResources(sink, () =>
        failure(() => provider.create('EipRep', TYPE, { InstanceId: 'i-aaa' }))
      );

      expect(atAssociate).toEqual({ physicalId: '54.0.0.9|eipalloc-4583' });
      expect(sink.report).toEqual({ physicalId: '54.0.0.9|eipalloc-4583' });
    });

    it('leaves nothing reported when the address was released', async () => {
      const sink = new CreatedResourceSink('EipRel', TYPE);
      respond({ ...allocate, AssociateAddressCommand: boom('associate boom') });

      await collectCreatedResources(sink, () =>
        failure(() => provider.create('EipRel', TYPE, { InstanceId: 'i-aaa' }))
      );

      expect(mockSend.mock.calls.map((x) => x[0].constructor.name)).toContain(
        'ReleaseAddressCommand'
      );
      expect(sink.report).toBeUndefined();
    });

    it('keeps the report when the release reads NotFound', async () => {
      const sink = new CreatedResourceSink('EipNf', TYPE);
      respond({
        ...allocate,
        AssociateAddressCommand: boom('associate boom'),
        ReleaseAddressCommand: () =>
          Promise.reject(
            Object.assign(new Error('The allocation ID does not exist'), {
              name: 'InvalidAllocationID.NotFound',
            })
          ),
      });

      await collectCreatedResources(sink, () =>
        failure(() => provider.create('EipNf', TYPE, { InstanceId: 'i-aaa' }))
      );

      expect(sink.report).toEqual({ physicalId: '54.0.0.9|eipalloc-4583' });
    });

    it('reports nothing when AllocateAddress itself fails', async () => {
      const sink = new CreatedResourceSink('EipNone', TYPE);
      respond({ AllocateAddressCommand: boom('allocate boom') });

      await collectCreatedResources(sink, () => failure(() => provider.create('EipNone', TYPE, {})));

      expect(sink.report).toBeUndefined();
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
      // Its ClientToken makes the replay return the same gateway.
      expect(isMarkedNonRetryable(error)).toBe(false);
    });

    // go-to-k/cdkd#5511: reported before the available-state wait.
    it('reports the gateway id before the available-state wait', async () => {
      const sink = new CreatedResourceSink('NatRep', TYPE);
      let atWait: unknown = 'unset';
      respond({ CreateNatGatewayCommand: ok({ NatGateway: { NatGatewayId: 'nat-4583' } }) });
      waitUntilNatGatewayAvailableMock.mockImplementation(() => {
        atWait = sink.report;
        return Promise.reject(new Error('wait boom'));
      });

      await collectCreatedResources(sink, () =>
        failure(() => provider.create('NatRep', TYPE, props))
      );

      expect(atWait).toEqual({ physicalId: 'nat-4583' });
      expect(sink.report).toEqual({ physicalId: 'nat-4583' });
    });

    it('reports nothing when CreateNatGateway itself fails', async () => {
      const sink = new CreatedResourceSink('NatNone', TYPE);
      respond({ CreateNatGatewayCommand: boom('create boom') });

      await collectCreatedResources(sink, () =>
        failure(() => provider.create('NatNone', TYPE, props))
      );

      expect(sink.report).toBeUndefined();
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

  // go-to-k/cdkd#5511: a VPN gateway attachment is reported once AttachVpnGateway
  // returned, before the attached-state wait. An internet gateway attach has no
  // mark, so it reports nothing.
  describe('VPCGatewayAttachment', () => {
    const TYPE = 'AWS::EC2::VPCGatewayAttachment';

    it('reports the composite id before the attached-state wait (VPN gateway)', async () => {
      const sink = new CreatedResourceSink('VgwRep', TYPE);
      let atWait: unknown = 'unset';
      respond({
        DescribeVpnGatewaysCommand: () => {
          atWait = sink.report;
          return Promise.reject(new Error('describe boom'));
        },
      });

      const error = await collectCreatedResources(sink, () =>
        failure(() => provider.create('VgwRep', TYPE, { VpcId: 'vpc-aaa', VpnGatewayId: 'vgw-4583' }))
      );

      const marked = createdBeforeFailure(error, 'VgwRep', TYPE);
      expect(marked).toEqual(expect.stringContaining('vgw-4583'));
      expect(atWait).toEqual({ physicalId: marked });
      expect(sink.report).toEqual({ physicalId: marked });
    });

    it('reports nothing when AttachVpnGateway itself fails', async () => {
      const sink = new CreatedResourceSink('VgwNone', TYPE);
      respond({ AttachVpnGatewayCommand: boom('attach boom') });

      await collectCreatedResources(sink, () =>
        failure(() =>
          provider.create('VgwNone', TYPE, { VpcId: 'vpc-aaa', VpnGatewayId: 'vgw-4583' })
        )
      );

      expect(sink.report).toBeUndefined();
    });

    it('reports nothing for an internet gateway attachment', async () => {
      const sink = new CreatedResourceSink('IgwNone', TYPE);
      respond({ AttachInternetGatewayCommand: boom('attach boom') });

      await collectCreatedResources(sink, () =>
        failure(() =>
          provider.create('IgwNone', TYPE, { VpcId: 'vpc-aaa', InternetGatewayId: 'igw-4583' })
        )
      );

      expect(sink.report).toBeUndefined();
    });
  });
});
