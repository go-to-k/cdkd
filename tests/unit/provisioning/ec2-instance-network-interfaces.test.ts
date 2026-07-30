import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { RunInstancesCommand } from '@aws-sdk/client-ec2';

// Issue #1281: setting `associatePublicIpAddress` (either value) makes the CDK
// L2 `ec2.Instance` DROP SubnetId / SecurityGroupIds and emit
// `NetworkInterfaces` instead -- which was in neither `handledProperties` nor
// `unhandledByDesign`, so the #614 silent-drop rule routed every public-subnet
// instance authored the CDK-docs way onto the Cloud Control path. These cases
// pin the RunInstances mapping, the routing declaration, the replacement
// classification, and the drift-unknown declaration.

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

// The exact shape CDK's L2 `ec2.Instance` synthesizes with
// `associatePublicIpAddress: true` (aws-cdk-lib 2.244.0): no top-level
// SubnetId / SecurityGroupIds, one NetworkInterfaces entry, stringly-typed
// DeviceIndex.
const NI_PROPS = {
  ImageId: 'ami-12345678',
  InstanceType: 't3.micro',
  AvailabilityZone: 'us-east-1a',
  NetworkInterfaces: [
    {
      DeviceIndex: '0',
      AssociatePublicIpAddress: true,
      SubnetId: 'subnet-1',
      GroupSet: ['sg-1'],
    },
  ],
};

function mockRunInstancesOk() {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-1234567890abcdef0' }] });
    }
    return Promise.resolve({
      Reservations: [
        { Instances: [{ InstanceId: 'i-1234567890abcdef0', State: { Name: 'running' } }] },
      ],
    });
  });
}

function runInstancesInput(): Record<string, unknown> {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof RunInstancesCommand);
  expect(call).toBeDefined();
  return (call![0] as RunInstancesCommand).input as unknown as Record<string, unknown>;
}

describe('AWS::EC2::Instance NetworkInterfaces mapping (issue #1281)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunInstancesOk();
  });

  it('maps the canonical L2 associatePublicIpAddress shape onto RunInstances', async () => {
    await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', NI_PROPS);

    const input = runInstancesInput();
    expect(input['NetworkInterfaces']).toEqual([
      {
        DeviceIndex: 0, // stringly-typed CFn numeric coerced
        AssociatePublicIpAddress: true,
        SubnetId: 'subnet-1',
        Groups: ['sg-1'], // CFn GroupSet -> SDK Groups
        AssociateCarrierIpAddress: undefined,
        DeleteOnTermination: undefined,
        Description: undefined,
        NetworkInterfaceId: undefined,
        PrivateIpAddress: undefined,
        Ipv6AddressCount: undefined,
        Ipv6Addresses: undefined,
        PrivateIpAddresses: undefined,
        SecondaryPrivateIpAddressCount: undefined,
      },
    ]);
    // The template carries no top-level SubnetId / SecurityGroupIds (CDK
    // dropped them), and cdkd must not synthesize any -- RunInstances rejects
    // the combination.
    expect(input['SubnetId']).toBeUndefined();
    expect(input['SecurityGroupIds']).toBeUndefined();
  });

  it('maps every remaining CFn sub-field (no #1225-class sub-field drop)', async () => {
    await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', {
      ImageId: 'ami-12345678',
      InstanceType: 't3.micro',
      NetworkInterfaces: [
        {
          DeviceIndex: '1',
          AssociatePublicIpAddress: 'false', // stringly-typed CFn boolean
          AssociateCarrierIpAddress: false,
          DeleteOnTermination: 'true',
          Description: 'secondary',
          NetworkInterfaceId: 'eni-abc',
          PrivateIpAddress: '10.0.0.10',
          Ipv6AddressCount: '2',
          Ipv6Addresses: [{ Ipv6Address: '2001:db8::1' }],
          PrivateIpAddresses: [{ Primary: 'true', PrivateIpAddress: '10.0.0.11' }],
          SecondaryPrivateIpAddressCount: '3',
          GroupSet: ['sg-2', 'sg-3'],
          SubnetId: 'subnet-2',
        },
      ],
    });

    const [ni] = runInstancesInput()['NetworkInterfaces'] as Array<Record<string, unknown>>;
    expect(ni).toMatchObject({
      DeviceIndex: 1,
      AssociatePublicIpAddress: false,
      AssociateCarrierIpAddress: false,
      DeleteOnTermination: true,
      Description: 'secondary',
      NetworkInterfaceId: 'eni-abc',
      PrivateIpAddress: '10.0.0.10',
      Ipv6AddressCount: 2,
      Ipv6Addresses: [{ Ipv6Address: '2001:db8::1' }],
      PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: '10.0.0.11' }],
      SecondaryPrivateIpAddressCount: 3,
      Groups: ['sg-2', 'sg-3'],
      SubnetId: 'subnet-2',
    });
  });

  it('omits NetworkInterfaces entirely for the top-level shape (unchanged behavior)', async () => {
    await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', {
      ImageId: 'ami-12345678',
      InstanceType: 't3.micro',
      SubnetId: 'subnet-1',
      SecurityGroupIds: ['sg-1'],
    });

    const input = runInstancesInput();
    expect(input['NetworkInterfaces']).toBeUndefined();
    expect(input['SubnetId']).toBe('subnet-1');
    expect(input['SecurityGroupIds']).toEqual(['sg-1']);
  });

  it('declares NetworkInterfaces as handled so the L2 shape stays on the SDK path', () => {
    const handled = new EC2Provider().handledProperties?.get('AWS::EC2::Instance');
    expect(handled?.has('NetworkInterfaces')).toBe(true);
  });

  it('leaves no actionable silent drop for the associatePublicIpAddress-shaped L2 set', async () => {
    // The property set CDK's L2 emits WITH associatePublicIpAddress (from the
    // #1281 issue's synth capture) -- the routing layer's actual input.
    const { findActionableSilentDrops } = await import(
      '../../../src/provisioning/property-coverage.js'
    );
    const l2Emitted = {
      AvailabilityZone: 'us-east-1a',
      BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 8 } }],
      IamInstanceProfile: 'profile-1',
      ImageId: 'ami-12345678',
      InstanceType: 't3.micro',
      NetworkInterfaces: [
        { DeviceIndex: '0', AssociatePublicIpAddress: true, SubnetId: 'subnet-1', GroupSet: ['sg-1'] },
      ],
      Tags: [{ Key: 'Name', Value: 'Web' }],
      UserData: 'IyEvYmluL2Jhc2g=',
    };

    expect(findActionableSilentDrops('AWS::EC2::Instance', l2Emitted, new Set())).toEqual([]);
  });

  it('classifies a NetworkInterfaces change as replacement (createOnly; update has no ENI path)', async () => {
    const { ReplacementRulesRegistry } = await import('../../../src/analyzer/replacement-rules.js');
    const registry = new ReplacementRulesRegistry();
    expect(
      registry.requiresReplacement('AWS::EC2::Instance', 'NetworkInterfaces', [{}], [{}, {}])
    ).toBe(true);
    expect(registry.isClassified('AWS::EC2::Instance', 'NetworkInterfaces')).toBe(true);
  });

  it('declares NetworkInterfaces drift-unknown (AssociatePublicIpAddress is not readable back)', () => {
    expect(new EC2Provider().getDriftUnknownPaths('AWS::EC2::Instance')).toContain(
      'NetworkInterfaces'
    );
  });
});
