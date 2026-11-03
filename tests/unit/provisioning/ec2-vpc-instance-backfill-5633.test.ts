import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateVpcCommand,
  GetIpamPoolAllocationsCommand,
  ModifyVpcAttributeCommand,
  DescribeInstanceAttributeCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  ModifyInstanceAttributeCommand,
  RunInstancesCommand,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#5633 (AWS::EC2::VPC Ipv4IpamPoolId / Ipv4NetmaskLength /
// VpcEncryptionControl) and go-to-k/cdkd#5630 (AWS::EC2::Instance CpuOptions /
// HibernationOptions / InstanceInitiatedShutdownBehavior): what reaches the
// SDK call, what is refused before it, and what readCurrentState reports.

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, waitUntilInstanceRunning: vi.fn(() => Promise.resolve({})) };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';

function sent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof CreateVpcCommand) {
      const input = cmd.input;
      return Promise.resolve({
        Vpc: { VpcId: 'vpc-new', CidrBlock: input.CidrBlock ?? '10.240.0.0/28' },
      });
    }
    if (cmd instanceof DescribeSecurityGroupsCommand) {
      return Promise.resolve({ SecurityGroups: [{ GroupId: 'sg-default' }] });
    }
    if (cmd instanceof DescribeVpcsCommand) {
      return Promise.resolve({ Vpcs: [{ VpcId: 'vpc-new', CidrBlock: '10.240.0.0/28' }] });
    }
    if (cmd instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
    }
    if (cmd instanceof DescribeInstancesCommand) {
      return Promise.resolve({
        Reservations: [{ Instances: [{ InstanceId: 'i-new', State: { Name: 'running' } }] }],
      });
    }
    return Promise.resolve({});
  });
});

describe('AWS::EC2::VPC backfill (#5633)', () => {
  it('sends Ipv4IpamPoolId / Ipv4NetmaskLength without a CidrBlock and records the allocated CIDR', async () => {
    const provider = new EC2Provider();
    const result = await provider.create('Vpc', 'AWS::EC2::VPC', {
      Ipv4IpamPoolId: 'ipam-pool-0123',
      Ipv4NetmaskLength: '28',
    });
    const [input] = sent(CreateVpcCommand);
    expect(input).toMatchObject({ Ipv4IpamPoolId: 'ipam-pool-0123', Ipv4NetmaskLength: 28 });
    expect(input).not.toHaveProperty('CidrBlock');
    expect(result.attributes).toMatchObject({ VpcId: 'vpc-new', CidrBlock: '10.240.0.0/28' });
  });

  it('sends the writable VpcEncryptionControl members and leaves the read-only ones out', async () => {
    const provider = new EC2Provider();
    await provider.create('Vpc', 'AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
      VpcEncryptionControl: {
        Mode: 'enforce',
        InternetGatewayExclusion: 'enable',
        LambdaExclusion: 'disable',
        State: 'available',
        VpcEncryptionControlId: 'vpcec-x',
      },
    });
    const [input] = sent(CreateVpcCommand);
    expect(input['CidrBlock']).toBe('10.0.0.0/16');
    expect(input['VpcEncryptionControl']).toEqual({
      Mode: 'enforce',
      InternetGatewayExclusion: 'enable',
      LambdaExclusion: 'disable',
    });
  });

  it('refuses a VPC with neither CidrBlock nor Ipv4IpamPoolId before any call', async () => {
    const provider = new EC2Provider();
    await expect(provider.create('Vpc', 'AWS::EC2::VPC', {})).rejects.toThrow(
      /CidrBlock or Ipv4IpamPoolId is required/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-integer Ipv4NetmaskLength', { Ipv4IpamPoolId: 'ipam-pool-1', Ipv4NetmaskLength: 'x' }],
    ['a list Ipv4IpamPoolId', { Ipv4IpamPoolId: ['ipam-pool-1'] }],
    ['a string VpcEncryptionControl', { CidrBlock: '10.0.0.0/16', VpcEncryptionControl: 'enforce' }],
    [
      'a non-string exclusion',
      { CidrBlock: '10.0.0.0/16', VpcEncryptionControl: { Mode: 'monitor', LambdaExclusion: true } },
    ],
  ])('refuses %s before any call, on a replay too', async (_label, properties) => {
    const provider = new EC2Provider();
    for (const context of [undefined, { replayingState: true }]) {
      await expect(provider.create('Vpc', 'AWS::EC2::VPC', properties, context)).rejects.toThrow(
        /The VPC Vpc was not created/
      );
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps an IPAM VPC CidrBlock attribute across an in-place update', async () => {
    const provider = new EC2Provider();
    const props = { Ipv4IpamPoolId: 'ipam-pool-1', EnableDnsHostnames: true };
    const result = await provider.update('Vpc', 'vpc-new', 'AWS::EC2::VPC', props, {
      ...props,
      EnableDnsHostnames: false,
    });
    expect(result.attributes).toEqual({ VpcId: 'vpc-new', CidrBlock: '10.240.0.0/28' });
  });

  it('a declared CidrBlock costs the update no read', async () => {
    const provider = new EC2Provider();
    await provider.update(
      'Vpc',
      'vpc-new',
      'AWS::EC2::VPC',
      { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: true },
      { CidrBlock: '10.0.0.0/16' }
    );
    expect(sent(DescribeVpcsCommand)).toHaveLength(0);
  });

  it('reads back the netmask from the CIDR and the encryption control in the CloudFormation shape', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeVpcsCommand) {
        return Promise.resolve({
          Vpcs: [
            {
              VpcId: 'vpc-1',
              CidrBlock: '10.240.0.0/28',
              EncryptionControl: {
                Mode: 'enforce',
                State: 'available',
                ResourceExclusions: {
                  InternetGateway: { State: 'enabled' },
                  Lambda: { State: 'disabled' },
                },
              },
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const provider = new EC2Provider();
    const read = await provider.readCurrentState('vpc-1', 'Vpc', 'AWS::EC2::VPC', {
      Ipv4IpamPoolId: 'ipam-pool-1',
      Ipv4NetmaskLength: 28,
    });
    expect(read).toMatchObject({
      CidrBlock: '10.240.0.0/28',
      Ipv4NetmaskLength: 28,
      VpcEncryptionControl: {
        Mode: 'enforce',
        InternetGatewayExclusion: 'enable',
        LambdaExclusion: 'disable',
      },
    });
    expect(provider.getDriftUnknownPaths('AWS::EC2::VPC')).toEqual(['Ipv4IpamPoolId']);
    const undeclared = await provider.readCurrentState('vpc-1', 'Vpc', 'AWS::EC2::VPC', {
      CidrBlock: '10.240.0.0/28',
    });
    expect(undeclared).not.toHaveProperty('Ipv4NetmaskLength');
  });
});

describe('AWS::EC2::Instance backfill (#5630)', () => {
  const BASE = { ImageId: 'ami-1', InstanceType: 't3.nano', SubnetId: 'subnet-1' };

  it('sends CpuOptions, HibernationOptions and InstanceInitiatedShutdownBehavior on RunInstances', async () => {
    const provider = new EC2Provider();
    await provider.create('Inst', 'AWS::EC2::Instance', {
      ...BASE,
      CpuOptions: { CoreCount: '1', ThreadsPerCore: 1 },
      HibernationOptions: { Configured: 'true' },
      InstanceInitiatedShutdownBehavior: 'terminate',
    });
    const [input] = sent(RunInstancesCommand);
    expect(input).toMatchObject({
      CpuOptions: { CoreCount: 1, ThreadsPerCore: 1 },
      HibernationOptions: { Configured: true },
      InstanceInitiatedShutdownBehavior: 'terminate',
    });
  });

  it('sends none of them when the template declares none', async () => {
    const provider = new EC2Provider();
    await provider.create('Inst', 'AWS::EC2::Instance', BASE);
    const [input] = sent(RunInstancesCommand);
    expect(input).not.toHaveProperty('CpuOptions');
    expect(input).not.toHaveProperty('HibernationOptions');
    expect(input).not.toHaveProperty('InstanceInitiatedShutdownBehavior');
  });

  it.each([
    ['CpuOptions.CoreCount', { CpuOptions: { CoreCount: 'two' } }],
    ['CpuOptions.ThreadsPerCore', { CpuOptions: { ThreadsPerCore: 0 } }],
    ['HibernationOptions.Configured', { HibernationOptions: { Configured: 'yes' } }],
    ['InstanceInitiatedShutdownBehavior', { InstanceInitiatedShutdownBehavior: ['stop'] }],
  ])('refuses a malformed %s before RunInstances', async (_label, extra) => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Inst', 'AWS::EC2::Instance', { ...BASE, ...extra })
    ).rejects.toThrow(/The instance Inst was not launched/);
    expect(sent(RunInstancesCommand)).toHaveLength(0);
  });

  it('changes InstanceInitiatedShutdownBehavior in place with ModifyInstanceAttribute', async () => {
    const provider = new EC2Provider();
    await provider.update(
      'Inst',
      'i-new',
      'AWS::EC2::Instance',
      { ...BASE, InstanceInitiatedShutdownBehavior: 'stop' },
      { ...BASE, InstanceInitiatedShutdownBehavior: 'terminate' }
    );
    expect(sent(ModifyInstanceAttributeCommand)).toEqual([
      { InstanceId: 'i-new', InstanceInitiatedShutdownBehavior: { Value: 'stop' } },
    ]);
  });

  it('sends nothing for an unchanged InstanceInitiatedShutdownBehavior', async () => {
    const provider = new EC2Provider();
    const props = { ...BASE, InstanceInitiatedShutdownBehavior: 'terminate' };
    await provider.update('Inst', 'i-new', 'AWS::EC2::Instance', props, props);
    expect(sent(ModifyInstanceAttributeCommand)).toHaveLength(0);
  });

  it('refuses a removed InstanceInitiatedShutdownBehavior before any call, as CloudFormation fails it', async () => {
    const provider = new EC2Provider();
    const error = await provider
      .update('Inst', 'i-new', 'AWS::EC2::Instance', BASE, {
        ...BASE,
        InstanceInitiatedShutdownBehavior: 'terminate',
      })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/InstanceInitiatedShutdownBehavior was removed from the template/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(sent(ModifyInstanceAttributeCommand)).toHaveLength(0);
  });

  it('a rollback replay of the removal warns and keeps the live value', async () => {
    const provider = new EC2Provider();
    await provider.update(
      'Inst',
      'i-new',
      'AWS::EC2::Instance',
      BASE,
      { ...BASE, InstanceInitiatedShutdownBehavior: 'terminate' },
      { removedProperties: new Set(['InstanceInitiatedShutdownBehavior']), replayingState: true }
    );
    expect(sent(ModifyInstanceAttributeCommand)).toHaveLength(0);
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /does not declare InstanceInitiatedShutdownBehavior/
    );
  });

  it('reads back CpuOptions / HibernationOptions, and the shutdown behavior only when declared', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeInstancesCommand) {
        return Promise.resolve({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-1',
                  State: { Name: 'running' },
                  CpuOptions: { CoreCount: 1, ThreadsPerCore: 1, AmdSevSnp: 'disabled' },
                  HibernationOptions: { Configured: true },
                },
              ],
            },
          ],
        });
      }
      if (cmd instanceof DescribeInstanceAttributeCommand) {
        return Promise.resolve(
          cmd.input.Attribute === 'instanceInitiatedShutdownBehavior'
            ? { InstanceInitiatedShutdownBehavior: { Value: 'terminate' } }
            : {}
        );
      }
      return Promise.resolve({});
    });
    const provider = new EC2Provider();
    const shutdownReads = (): number =>
      sent(DescribeInstanceAttributeCommand).filter(
        (i) => i['Attribute'] === 'instanceInitiatedShutdownBehavior'
      ).length;

    const undeclared = await provider.readCurrentState('i-1', 'Inst', 'AWS::EC2::Instance', BASE);
    expect(undeclared).toMatchObject({
      CpuOptions: { CoreCount: 1, ThreadsPerCore: 1 },
      HibernationOptions: { Configured: true },
    });
    expect((undeclared as Record<string, unknown>)['CpuOptions']).not.toHaveProperty('AmdSevSnp');
    expect(undeclared).not.toHaveProperty('InstanceInitiatedShutdownBehavior');
    expect(shutdownReads()).toBe(0);

    const declared = await provider.readCurrentState('i-1', 'Inst', 'AWS::EC2::Instance', {
      ...BASE,
      InstanceInitiatedShutdownBehavior: 'terminate',
    });
    expect(declared).toMatchObject({ InstanceInitiatedShutdownBehavior: 'terminate' });
    expect(shutdownReads()).toBe(1);
  });
});

describe('AWS::EC2::VPC backfill (#5633): review round 1', () => {
  it('import() records the CIDR an IPAM-allocated VPC does not declare', async () => {
    const provider = new EC2Provider();
    const result = await provider.import({
      logicalId: 'Vpc',
      resourceType: 'AWS::EC2::VPC',
      stackName: 'S',
      region: 'us-east-1',
      properties: { Ipv4IpamPoolId: 'ipam-pool-1' },
      knownPhysicalId: 'vpc-new',
    });
    expect(result).toStrictEqual({
      physicalId: 'vpc-new',
      attributes: { VpcId: 'vpc-new', CidrBlock: '10.240.0.0/28' },
    });
  });

  it('reads an IPAM VPC CIDR before the first change it sends', async () => {
    const provider = new EC2Provider();
    const props = { Ipv4IpamPoolId: 'ipam-pool-1', EnableDnsHostnames: true };
    await provider.update('Vpc', 'vpc-new', 'AWS::EC2::VPC', props, {
      ...props,
      EnableDnsHostnames: false,
    });
    const names = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(names.indexOf('DescribeVpcsCommand')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('DescribeVpcsCommand')).toBeLessThan(
      names.indexOf(ModifyVpcAttributeCommand.name)
    );
  });

  it('reports only the pool\'s own untagged VPCs as orphans of an IPAM CreateVpc', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetIpamPoolAllocationsCommand) {
        return Promise.resolve({
          IpamPoolAllocations: [
            { ResourceType: 'vpc', ResourceId: 'vpc-inpool' },
            { ResourceType: 'vpc', ResourceId: 'vpc-inpool-tagged' },
            { ResourceType: 'custom', ResourceId: 'vpc-notavpc' },
          ],
        });
      }
      if (cmd instanceof DescribeVpcsCommand) {
        return Promise.resolve({
          Vpcs: [
            { VpcId: 'vpc-inpool', CidrBlock: '10.240.0.0/28', IsDefault: false },
            { VpcId: 'vpc-inpool-tagged', CidrBlock: '10.240.0.16/28', IsDefault: false, Tags: [{ Key: 'x', Value: 'y' }] },
            { VpcId: 'vpc-elsewhere', CidrBlock: '10.240.0.32/28', IsDefault: false },
            { VpcId: 'vpc-notavpc', CidrBlock: '10.240.0.48/28', IsDefault: false },
          ],
        });
      }
      return Promise.resolve({});
    });
    const provider = new EC2Provider() as unknown as {
      reportPossibleOrphanVpcs: (
        logicalId: string,
        match: { ipamPoolId: string },
        sent: unknown[],
        window: { floorMs: number; ceilingMs: number },
        context: undefined
      ) => Promise<void>;
    };
    await provider.reportPossibleOrphanVpcs(
      'Vpc',
      { ipamPoolId: 'ipam-pool-1' },
      [],
      { floorMs: 0, ceilingMs: 1 },
      undefined
    );
    expect(sent(GetIpamPoolAllocationsCommand)).toEqual([
      { IpamPoolId: 'ipam-pool-1', NextToken: undefined },
    ]);
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('a VPC allocated from IPAM pool ipam-pool-1');
    expect(line).toContain('vpc-inpool');
    expect(line).not.toContain('vpc-inpool-tagged');
    expect(line).not.toContain('vpc-elsewhere');
    expect(line).not.toContain('vpc-notavpc');
  });

  it('treats a null VpcEncryptionControl as absent and refuses a blank Mode', async () => {
    const provider = new EC2Provider();
    await provider.create('Vpc', 'AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
      VpcEncryptionControl: null,
    });
    expect(sent(CreateVpcCommand)[0]).not.toHaveProperty('VpcEncryptionControl');
    mockSend.mockClear();
    await expect(
      provider.create('Vpc', 'AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
        VpcEncryptionControl: { Mode: '' },
      })
    ).rejects.toThrow(/VpcEncryptionControl.Mode must not be blank/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('names the state record in a replayed refusal, and not in a template one', async () => {
    const provider = new EC2Provider();
    const bad = { Ipv4IpamPoolId: 'ipam-pool-1', Ipv4NetmaskLength: 'x' };
    const template = await provider.create('Vpc', 'AWS::EC2::VPC', bad).catch((e: unknown) => e);
    const replay = await provider
      .create('Vpc', 'AWS::EC2::VPC', bad, { replayingState: true })
      .catch((e: unknown) => e);
    expect(String(template)).not.toContain('state record being restored');
    expect(String(replay)).toContain('The value comes from the state record being restored');
  });

  it('folds a transitional exclusion state onto the value it is moving to', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof DescribeVpcsCommand
          ? {
              Vpcs: [
                {
                  VpcId: 'vpc-1',
                  CidrBlock: '10.0.0.0/16',
                  EncryptionControl: {
                    Mode: 'enforce',
                    ResourceExclusions: {
                      NatGateway: { State: 'enabling' },
                      VpcPeering: { State: 'disabling' },
                    },
                  },
                },
              ],
            }
          : {}
      )
    );
    const read = await new EC2Provider().readCurrentState('vpc-1', 'Vpc', 'AWS::EC2::VPC');
    expect((read as Record<string, unknown>)['VpcEncryptionControl']).toEqual({
      Mode: 'enforce',
      NatGatewayExclusion: 'enable',
      VpcPeeringExclusion: 'disable',
    });
  });

  it('declares exclusions unreadable on a monitor control only', () => {
    const provider = new EC2Provider();
    expect(
      provider.getDriftUnknownPaths('AWS::EC2::VPC', {
        VpcEncryptionControl: { Mode: 'monitor', LambdaExclusion: 'enable' },
      })
    ).toContain('VpcEncryptionControl.LambdaExclusion');
    expect(
      provider.getDriftUnknownPaths('AWS::EC2::VPC', {
        VpcEncryptionControl: { Mode: 'enforce', LambdaExclusion: 'enable' },
      })
    ).toEqual(['Ipv4IpamPoolId']);
  });
});

describe('AWS::EC2::Instance backfill (#5630): review round 1', () => {
  it('omits InstanceInitiatedShutdownBehavior when its DescribeInstanceAttribute read fails', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeInstancesCommand) {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
        });
      }
      if (
        cmd instanceof DescribeInstanceAttributeCommand &&
        cmd.input.Attribute === 'instanceInitiatedShutdownBehavior'
      ) {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }));
      }
      return Promise.resolve({});
    });
    const read = await new EC2Provider().readCurrentState('i-1', 'Inst', 'AWS::EC2::Instance', {
      ImageId: 'ami-1',
      InstanceInitiatedShutdownBehavior: 'terminate',
    });
    expect(read).not.toHaveProperty('InstanceInitiatedShutdownBehavior');
    expect(read).toHaveProperty('Tags');
  });
});
