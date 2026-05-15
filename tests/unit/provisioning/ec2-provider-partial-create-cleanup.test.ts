import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy, waitUntilInstanceRunningMock, waitUntilInstanceTerminatedMock } =
  vi.hoisted(() => ({
    mockSend: vi.fn(),
    warnSpy: vi.fn(),
    waitUntilInstanceRunningMock: vi.fn(),
    waitUntilInstanceTerminatedMock: vi.fn(() => Promise.resolve({})),
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

// Stub the SDK waiter (`waitUntilInstanceRunning`) so we can simulate timeout.
vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    waitUntilInstanceRunning: waitUntilInstanceRunningMock,
    waitUntilInstanceTerminated: waitUntilInstanceTerminatedMock,
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

describe('EC2Provider createVpc partial-create cleanup (Issue #376)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    waitUntilInstanceRunningMock.mockReset();
    waitUntilInstanceTerminatedMock.mockReset();
    waitUntilInstanceTerminatedMock.mockResolvedValue({});
    provider = new EC2Provider();
  });

  it('issues DeleteVpcCommand when ModifyVpcAttribute fails after CreateVpc succeeded', async () => {
    mockSend.mockResolvedValueOnce({ Vpc: { VpcId: 'vpc-aaa' } }); // CreateVpcCommand
    mockSend.mockRejectedValueOnce(new Error('ModifyVpcAttribute boom')); // ModifyVpcAttributeCommand
    mockSend.mockResolvedValueOnce({}); // DeleteVpcCommand cleanup

    await expect(
      provider.create('MyVpc', 'AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
        EnableDnsHostnames: true,
      })
    ).rejects.toThrow('Failed to create VPC');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['CreateVpcCommand', 'ModifyVpcAttributeCommand', 'DeleteVpcCommand']);
    expect(mockSend.mock.calls[2][0].input).toEqual({ VpcId: 'vpc-aaa' });
  });

  it('does NOT issue DeleteVpcCommand when CreateVpc itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateVpc boom'));

    await expect(
      provider.create('MyVpc', 'AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16' })
    ).rejects.toThrow('Failed to create VPC');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateVpcCommand');
  });

  it('re-throws the original error even when DeleteVpcCommand cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({ Vpc: { VpcId: 'vpc-aaa' } }); // CreateVpcCommand
    mockSend.mockRejectedValueOnce(new Error('ModifyVpcAttribute boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteVpc also failed'));

    await expect(
      provider.create('MyVpc', 'AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
        EnableDnsHostnames: true,
      })
    ).rejects.toThrow('ModifyVpcAttribute boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws ec2 delete-vpc --vpc-id');
    expect(warnMsg).toContain('vpc-aaa');
  });
});

describe('EC2Provider createSubnet partial-create cleanup (Issue #376)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    waitUntilInstanceRunningMock.mockReset();
    waitUntilInstanceTerminatedMock.mockReset();
    waitUntilInstanceTerminatedMock.mockResolvedValue({});
    provider = new EC2Provider();
  });

  it('issues DeleteSubnetCommand when ModifySubnetAttribute fails after CreateSubnet succeeded', async () => {
    mockSend.mockResolvedValueOnce({
      Subnet: { SubnetId: 'subnet-aaa', AvailabilityZone: 'us-east-1a' },
    }); // CreateSubnetCommand
    mockSend.mockResolvedValueOnce({}); // applyTags -> CreateTagsCommand (no tags property, so skipped... actually applyTags only runs if Tags is present — see provider)
    mockSend.mockRejectedValueOnce(new Error('ModifySubnetAttribute boom')); // ModifySubnetAttributeCommand
    mockSend.mockResolvedValueOnce({}); // DeleteSubnetCommand cleanup

    await expect(
      provider.create('MySubnet', 'AWS::EC2::Subnet', {
        VpcId: 'vpc-aaa',
        CidrBlock: '10.0.1.0/24',
        MapPublicIpOnLaunch: true,
        Tags: [{ Key: 'k', Value: 'v' }], // ensures applyTags fires
      })
    ).rejects.toThrow('Failed to create Subnet');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateSubnetCommand',
      'CreateTagsCommand',
      'ModifySubnetAttributeCommand',
      'DeleteSubnetCommand',
    ]);
    expect(mockSend.mock.calls[3][0].input).toEqual({ SubnetId: 'subnet-aaa' });
  });

  it('does NOT issue DeleteSubnetCommand when CreateSubnet itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateSubnet boom'));

    await expect(
      provider.create('MySubnet', 'AWS::EC2::Subnet', {
        VpcId: 'vpc-aaa',
        CidrBlock: '10.0.1.0/24',
      })
    ).rejects.toThrow('Failed to create Subnet');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateSubnetCommand');
  });

  it('re-throws the original error even when DeleteSubnetCommand cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({
      Subnet: { SubnetId: 'subnet-aaa', AvailabilityZone: 'us-east-1a' },
    }); // CreateSubnetCommand
    // applyTags swallows its own errors at WARN, so it cannot fail the
    // wiring path. ModifySubnetAttribute (gated on MapPublicIpOnLaunch)
    // is the canonical post-create call to fail.
    mockSend.mockRejectedValueOnce(new Error('ModifySubnetAttribute boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteSubnet also failed'));

    await expect(
      provider.create('MySubnet', 'AWS::EC2::Subnet', {
        VpcId: 'vpc-aaa',
        CidrBlock: '10.0.1.0/24',
        MapPublicIpOnLaunch: true,
      })
    ).rejects.toThrow('ModifySubnetAttribute boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws ec2 delete-subnet --subnet-id');
    expect(warnMsg).toContain('subnet-aaa');
  });
});

describe('EC2Provider createSecurityGroup partial-create cleanup (Issue #376)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    waitUntilInstanceRunningMock.mockReset();
    waitUntilInstanceTerminatedMock.mockReset();
    waitUntilInstanceTerminatedMock.mockResolvedValue({});
    provider = new EC2Provider();
  });

  it('issues DeleteSecurityGroupCommand when AuthorizeSecurityGroupIngress fails after CreateSecurityGroup succeeded', async () => {
    mockSend.mockResolvedValueOnce({ GroupId: 'sg-aaa' }); // CreateSecurityGroupCommand
    mockSend.mockRejectedValueOnce(new Error('Authorize boom')); // AuthorizeSecurityGroupIngressCommand
    mockSend.mockResolvedValueOnce({}); // DeleteSecurityGroupCommand cleanup

    await expect(
      provider.create('MySg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'test',
        VpcId: 'vpc-aaa',
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
        ],
      })
    ).rejects.toThrow('Failed to create SecurityGroup');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateSecurityGroupCommand',
      'AuthorizeSecurityGroupIngressCommand',
      'DeleteSecurityGroupCommand',
    ]);
    expect(mockSend.mock.calls[2][0].input).toEqual({ GroupId: 'sg-aaa' });
  });

  it('does NOT issue DeleteSecurityGroupCommand when CreateSecurityGroup itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateSecurityGroup boom'));

    await expect(
      provider.create('MySg', 'AWS::EC2::SecurityGroup', { GroupDescription: 'test' })
    ).rejects.toThrow('Failed to create SecurityGroup');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateSecurityGroupCommand');
  });

  it('re-throws the original error even when DeleteSecurityGroupCommand cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({ GroupId: 'sg-aaa' }); // CreateSecurityGroupCommand
    mockSend.mockRejectedValueOnce(new Error('Authorize boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteSG also failed'));

    await expect(
      provider.create('MySg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'test',
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
        ],
      })
    ).rejects.toThrow('Authorize boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws ec2 delete-security-group --group-id');
    expect(warnMsg).toContain('sg-aaa');
  });
});

describe('EC2Provider createInstance partial-create cleanup (Issue #376)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    waitUntilInstanceRunningMock.mockReset();
    waitUntilInstanceTerminatedMock.mockReset();
    waitUntilInstanceTerminatedMock.mockResolvedValue({});
    provider = new EC2Provider();
  });

  it('issues TerminateInstancesCommand (no wait) when waitUntilInstanceRunning fails after RunInstances succeeded', async () => {
    mockSend.mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-aaa' }] }); // RunInstancesCommand
    waitUntilInstanceRunningMock.mockRejectedValueOnce(
      new Error('Waiter timed out — instance never reached running state')
    );
    mockSend.mockResolvedValueOnce({}); // TerminateInstancesCommand cleanup

    await expect(
      provider.create('MyInstance', 'AWS::EC2::Instance', {
        ImageId: 'ami-aaa',
        InstanceType: 't3.micro',
      })
    ).rejects.toThrow('Failed to create EC2 Instance');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['RunInstancesCommand', 'TerminateInstancesCommand']);
    expect(mockSend.mock.calls[1][0].input).toEqual({ InstanceIds: ['i-aaa'] });
    // Lock in the no-wait contract: the cleanup path must NOT call
    // waitUntilInstanceTerminated. The deploy is already failing, so
    // blocking another 30-120s on terminate confirmation is wrong.
    expect(waitUntilInstanceTerminatedMock).not.toHaveBeenCalled();
  });

  it('does NOT issue TerminateInstancesCommand when RunInstances itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('RunInstances boom'));

    await expect(
      provider.create('MyInstance', 'AWS::EC2::Instance', {
        ImageId: 'ami-aaa',
      })
    ).rejects.toThrow('Failed to create EC2 Instance');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('RunInstancesCommand');
  });

  it('emits CRITICAL recovery hint (instance still billing!) when TerminateInstances cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({ Instances: [{ InstanceId: 'i-aaa' }] }); // RunInstancesCommand
    waitUntilInstanceRunningMock.mockRejectedValueOnce(new Error('Waiter timed out (original)'));
    mockSend.mockRejectedValueOnce(new Error('TerminateInstances also failed'));

    await expect(
      provider.create('MyInstance', 'AWS::EC2::Instance', {
        ImageId: 'ami-aaa',
      })
    ).rejects.toThrow('Waiter timed out (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('THE INSTANCE IS STILL RUNNING AND BILLING');
    expect(warnMsg).toContain('aws ec2 terminate-instances --instance-ids');
    expect(warnMsg).toContain('i-aaa');
  });
});
