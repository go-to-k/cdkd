import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { RunInstancesCommand } from '@aws-sdk/client-ec2';

// Issue #5445: `buildBlockDeviceMappings` sent only DeviceName and
// Ebs.{VolumeSize,VolumeType,DeleteOnTermination}, so a volume declared
// `Encrypted: true` / with a `KmsKeyId` (and Iops / SnapshotId, VirtualName,
// NoDevice) reached RunInstances without it -- an encryption-at-rest gap.
// `NetworkInterfaces[].EnaSrdSpecification` was dropped the same way. These
// cases pin every member CFn's AWS::EC2::Instance schema declares.

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

const KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555';

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

async function createWith(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  await new EC2Provider().create('MyInstance', 'AWS::EC2::Instance', {
    ImageId: 'ami-12345678',
    InstanceType: 't3.micro',
    ...extra,
  });
  return runInstancesInput();
}

describe('AWS::EC2::Instance BlockDeviceMappings mapping (issue #5445)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunInstancesOk();
  });

  it('sends every Ebs member CFn declares, with the exact values', async () => {
    const input = await createWith({
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            Encrypted: true,
            KmsKeyId: KEY_ARN,
            Iops: 4000,
            SnapshotId: 'snap-0123456789abcdef0',
            VolumeSize: 20,
            VolumeType: 'gp3',
            DeleteOnTermination: false,
          },
        },
      ],
    });
    expect(input['BlockDeviceMappings']).toStrictEqual([
      {
        DeviceName: '/dev/xvda',
        Ebs: {
          Encrypted: true,
          KmsKeyId: KEY_ARN,
          Iops: 4000,
          SnapshotId: 'snap-0123456789abcdef0',
          VolumeSize: 20,
          VolumeType: 'gp3',
          DeleteOnTermination: false,
        },
      },
    ]);
  });

  it('coerces stringly-typed CFn booleans and integers', async () => {
    const input = await createWith({
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/sdf',
          Ebs: {
            Encrypted: 'true',
            Iops: '3000',
            VolumeSize: '8',
            VolumeType: 'gp3',
            DeleteOnTermination: 'false',
          },
        },
      ],
    });
    const ebs = (input['BlockDeviceMappings'] as Array<Record<string, unknown>>)[0]!['Ebs'] as Record<
      string,
      unknown
    >;
    expect(ebs['Encrypted']).toBe(true);
    expect(ebs['Iops']).toBe(3000);
    expect(ebs['VolumeSize']).toBe(8);
    expect(ebs['DeleteOnTermination']).toBe(false);
  });

  it('sends Encrypted: false as false, not as an omission', async () => {
    const input = await createWith({
      BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { Encrypted: false, VolumeSize: 8 } }],
    });
    const ebs = (input['BlockDeviceMappings'] as Array<Record<string, unknown>>)[0]!['Ebs'] as Record<
      string,
      unknown
    >;
    expect(ebs['Encrypted']).toBe(false);
  });

  it('omits the Ebs members the template does not set, and defaults DeleteOnTermination to true', async () => {
    const input = await createWith({
      BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { VolumeSize: 8 } }],
    });
    const ebs = (input['BlockDeviceMappings'] as Array<Record<string, unknown>>)[0]!['Ebs'] as Record<
      string,
      unknown
    >;
    expect(ebs['DeleteOnTermination']).toBe(true);
    for (const k of ['Encrypted', 'KmsKeyId', 'Iops', 'SnapshotId', 'Throughput']) {
      expect(Object.prototype.hasOwnProperty.call(ebs, k)).toBe(false);
    }
  });

  it('maps VirtualName and NoDevice ({} in CFn -> "" on the wire)', async () => {
    const input = await createWith({
      BlockDeviceMappings: [
        { DeviceName: '/dev/sdb', VirtualName: 'ephemeral0' },
        { DeviceName: '/dev/sdc', NoDevice: {} },
      ],
    });
    expect(input['BlockDeviceMappings']).toStrictEqual([
      { DeviceName: '/dev/sdb', VirtualName: 'ephemeral0' },
      { DeviceName: '/dev/sdc', NoDevice: '' },
    ]);
  });

  it('treats NoDevice: null as absent', async () => {
    const input = await createWith({
      BlockDeviceMappings: [{ DeviceName: '/dev/sdc', NoDevice: null }],
    });
    expect(input['BlockDeviceMappings']).toStrictEqual([{ DeviceName: '/dev/sdc' }]);
  });
});

describe('AWS::EC2::Instance NetworkInterfaces[].EnaSrdSpecification (issue #5445)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunInstancesOk();
  });

  it('maps EnaSrdEnabled and EnaSrdUdpSpecification.EnaSrdUdpEnabled', async () => {
    const input = await createWith({
      NetworkInterfaces: [
        {
          DeviceIndex: '0',
          SubnetId: 'subnet-1',
          EnaSrdSpecification: {
            EnaSrdEnabled: true,
            EnaSrdUdpSpecification: { EnaSrdUdpEnabled: 'true' },
          },
        },
      ],
    });
    const ni = (input['NetworkInterfaces'] as Array<Record<string, unknown>>)[0]!;
    expect(ni['EnaSrdSpecification']).toStrictEqual({
      EnaSrdEnabled: true,
      EnaSrdUdpSpecification: { EnaSrdUdpEnabled: true },
    });
  });

  it('sends EnaSrdEnabled: false as false', async () => {
    const input = await createWith({
      NetworkInterfaces: [
        { DeviceIndex: '0', SubnetId: 'subnet-1', EnaSrdSpecification: { EnaSrdEnabled: 'false' } },
      ],
    });
    const ni = (input['NetworkInterfaces'] as Array<Record<string, unknown>>)[0]!;
    expect(ni['EnaSrdSpecification']).toStrictEqual({ EnaSrdEnabled: false });
  });

  it('omits an EnaSrdSpecification that sets nothing', async () => {
    const input = await createWith({
      NetworkInterfaces: [
        { DeviceIndex: '0', SubnetId: 'subnet-1', EnaSrdSpecification: {} },
        {
          DeviceIndex: '1',
          SubnetId: 'subnet-1',
          EnaSrdSpecification: { EnaSrdUdpSpecification: {} },
        },
      ],
    });
    for (const ni of input['NetworkInterfaces'] as Array<Record<string, unknown>>) {
      expect(Object.prototype.hasOwnProperty.call(ni, 'EnaSrdSpecification')).toBe(false);
    }
  });

  it('omits EnaSrdSpecification when the template does not set it', async () => {
    const input = await createWith({
      NetworkInterfaces: [{ DeviceIndex: '0', SubnetId: 'subnet-1' }],
    });
    const ni = (input['NetworkInterfaces'] as Array<Record<string, unknown>>)[0]!;
    expect(Object.prototype.hasOwnProperty.call(ni, 'EnaSrdSpecification')).toBe(false);
  });
});
