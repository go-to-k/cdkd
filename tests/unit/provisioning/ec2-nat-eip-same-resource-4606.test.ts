import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier NAT gateway or Elastic IP. Only
// `'different'` lets it delete.

const { mockSend, clientRegion, providerLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
  providerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, waitUntilNatGatewayDeleted: vi.fn().mockResolvedValue({}) };
});

import {
  DeleteNatGatewayCommand,
  DescribeAddressesCommand,
  DescribeNatGatewaysCommand,
  ReleaseAddressCommand,
} from '@aws-sdk/client-ec2';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const NAT = 'AWS::EC2::NatGateway';
const EIP = 'AWS::EC2::EIP';
const CTX = { expectedRegion: 'us-east-1' };
const NAT_A = 'nat-0aaaaaaaaaaaaaaa1';
const NAT_B = 'nat-0bbbbbbbbbbbbbbb2';
const ALLOC_A = 'eipalloc-0aaaaaaaaaaaaaaa1';
const ALLOC_B = 'eipalloc-0bbbbbbbbbbbbbbb2';
const eipId = (ip: string, alloc: string): string => `${ip}|${alloc}`;

const awsError = (name: string, message = name): Error => Object.assign(new Error(message), { name });

type Live<T> = Record<string, T | 'gone' | Error>;

/** `DescribeNatGateways` answers per gateway id: its state, or gone. */
function natGateways(live: Live<string>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeNatGatewaysCommand)) throw new Error('unexpected command');
    const id = cmd.input.NatGatewayIds![0]!;
    const entry = live[id];
    if (entry === undefined || entry === 'gone') throw awsError('NatGatewayNotFound');
    if (entry instanceof Error) throw entry;
    return { NatGateways: [{ NatGatewayId: id, State: entry }] };
  });
}

/** `DescribeAddresses` answers per allocation id: present, or gone. */
function addresses(live: Live<'live'>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeAddressesCommand)) throw new Error('unexpected command');
    const id = cmd.input.AllocationIds![0]!;
    const entry = live[id];
    if (entry === undefined || entry === 'gone') throw awsError('InvalidAllocationID.NotFound');
    if (entry instanceof Error) throw entry;
    return { Addresses: [{ AllocationId: id, PublicIp: '203.0.113.10' }] };
  });
}

const readIds = (): unknown[] =>
  mockSend.mock.calls.map(([c]) =>
    c instanceof DescribeNatGatewaysCommand
      ? c.input.NatGatewayIds
      : (c as DescribeAddressesCommand).input.AllocationIds
  );

let provider: EC2Provider;

beforeEach(() => {
  vi.clearAllMocks();
  clientRegion.value = 'us-east-1';
  provider = new EC2Provider();
});

describe('EC2Provider.isSameResource for AWS::EC2::NatGateway (go-to-k/cdkd#4606)', () => {
  it('another live gateway is different, after reading the record first, then the journaled one', async () => {
    natGateways({ [NAT_A]: 'available', [NAT_B]: 'available' });
    expect(await provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).toBe('different');
    expect(readIds()).toEqual([[NAT_B], [NAT_A]]);
  });

  it.each(['failed', 'deleting', 'deleted', 'gone'])(
    'a journaled gateway %s is different once the record reads back live',
    async (journaled) => {
      natGateways({ [NAT_A]: journaled, [NAT_B]: 'available' });
      expect(await provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).toBe(
        'different'
      );
    }
  );

  it('a record gateway still pending counts as live', async () => {
    natGateways({ [NAT_A]: 'failed', [NAT_B]: 'pending' });
    expect(await provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).toBe('different');
  });

  it.each(['failed', 'deleting', 'deleted', 'gone'])(
    'the record gateway %s is unknown, not different, and the journaled one is not read',
    async (recorded) => {
      natGateways({ [NAT_A]: 'available', [NAT_B]: recorded });
      expect(await provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).toBe('unknown');
      expect(readIds()).toEqual([[NAT_B]]);
    }
  );

  it('equal ids are the same without a read (the id now names the record gateway)', async () => {
    natGateways({});
    expect(await provider.isSameResource(NAT_A, { physicalId: NAT_A }, NAT, CTX)).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Defensive: EC2 cannot answer one gateway id with another; the branch
  // exists so a read naming the record's gateway never reads as 'different'.
  it('a journaled id reading back as the record gateway is the same', async () => {
    mockSend.mockResolvedValue({ NatGateways: [{ NatGatewayId: NAT_B, State: 'available' }] });
    expect(await provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).toBe('same');
  });

  it('a read that fails other than not-found throws (the caller reads it as unknown)', async () => {
    natGateways({ [NAT_A]: awsError('UnauthorizedOperation', 'denied'), [NAT_B]: 'available' });
    await expect(provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).rejects.toThrow(
      'denied'
    );
  });

  it('a not-found error of another resource kind is not read as gone', async () => {
    natGateways({ [NAT_A]: 'available', [NAT_B]: awsError('InvalidSubnetID.NotFound') });
    await expect(provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).rejects.toThrow(
      'InvalidSubnetID.NotFound'
    );
  });

  it.each([
    ['no gateway', { NatGateways: [] }],
    ['two gateways', { NatGateways: [{ NatGatewayId: NAT_B }, { NatGatewayId: NAT_A }] }],
    ['a gateway without an id', { NatGateways: [{ State: 'available' }] }],
  ])('a response naming %s throws rather than reading as gone', async (_label, response) => {
    mockSend.mockResolvedValue(response);
    await expect(provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).rejects.toThrow(
      'did not return exactly the gateway asked for'
    );
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    natGateways({ [NAT_A]: 'gone', [NAT_B]: 'available' });
    expect(await provider.isSameResource(NAT_A, { physicalId: NAT_B }, NAT, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an id that is not a NAT gateway id is unknown, with no read', async () => {
    natGateways({ [NAT_A]: 'gone', [NAT_B]: 'available' });
    for (const [journaled, recorded] of [
      ['', NAT_B],
      [NAT_A, ''],
      [`arn:aws:ec2:us-east-1:123456789012:natgateway/${NAT_A}`, NAT_B],
      [NAT_A, NAT_B.toUpperCase()],
      [`${NAT_A}|x`, NAT_B],
    ] as const) {
      expect(await provider.isSameResource(journaled, { physicalId: recorded }, NAT, CTX)).toBe(
        'unknown'
      );
    }
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EC2Provider.isSameResource for AWS::EC2::EIP (go-to-k/cdkd#4606)', () => {
  it('another live address is different, after reading the record first, then the journaled one', async () => {
    addresses({ [ALLOC_A]: 'live', [ALLOC_B]: 'live' });
    expect(
      await provider.isSameResource(
        eipId('203.0.113.1', ALLOC_A),
        { physicalId: eipId('203.0.113.2', ALLOC_B) },
        EIP,
        CTX
      )
    ).toBe('different');
    expect(readIds()).toEqual([[ALLOC_B], [ALLOC_A]]);
  });

  it('a journaled address AWS reports gone is different once the record reads back', async () => {
    addresses({ [ALLOC_A]: 'gone', [ALLOC_B]: 'live' });
    expect(
      await provider.isSameResource(eipId('203.0.113.1', ALLOC_A), { physicalId: eipId('203.0.113.2', ALLOC_B) }, EIP, CTX)
    ).toBe('different');
  });

  it('the record address gone is unknown, not different', async () => {
    addresses({ [ALLOC_A]: 'live', [ALLOC_B]: 'gone' });
    expect(
      await provider.isSameResource(eipId('203.0.113.1', ALLOC_A), { physicalId: eipId('203.0.113.2', ALLOC_B) }, EIP, CTX)
    ).toBe('unknown');
    expect(readIds()).toEqual([[ALLOC_B]]);
  });

  it('the composite and the bare form of one allocation id are the same, without a read', async () => {
    addresses({});
    // The create journals the bare id only when the composite fence refused.
    expect(
      await provider.isSameResource(ALLOC_A, { physicalId: eipId('203.0.113.1', ALLOC_A) }, EIP, CTX)
    ).toBe('same');
    expect(
      await provider.isSameResource(eipId('203.0.113.1', ALLOC_A), { physicalId: ALLOC_A }, EIP, CTX)
    ).toBe('same');
    // The allocation id is the identity, not the public IP segment.
    expect(
      await provider.isSameResource(
        eipId('203.0.113.1', ALLOC_A),
        { physicalId: eipId('203.0.113.9', ALLOC_A) },
        EIP,
        CTX
      )
    ).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a shared public IP with distinct allocation ids is not the same', async () => {
    addresses({ [ALLOC_A]: 'gone', [ALLOC_B]: 'live' });
    expect(
      await provider.isSameResource(
        eipId('203.0.113.1', ALLOC_A),
        { physicalId: eipId('203.0.113.1', ALLOC_B) },
        EIP,
        CTX
      )
    ).toBe('different');
  });

  it('a read that fails other than not-found throws (the caller reads it as unknown)', async () => {
    addresses({ [ALLOC_A]: awsError('UnauthorizedOperation', 'denied'), [ALLOC_B]: 'live' });
    await expect(provider.isSameResource(eipId('203.0.113.1', ALLOC_A), { physicalId: ALLOC_B }, EIP, CTX)).rejects.toThrow(
      'denied'
    );
  });

  it.each([
    ['no address', { Addresses: [] }],
    ['two addresses', { Addresses: [{ AllocationId: ALLOC_B }, { AllocationId: ALLOC_A }] }],
    ['an address without an allocation id', { Addresses: [{ PublicIp: '203.0.113.1' }] }],
  ])('a response naming %s throws rather than reading as gone', async (_label, response) => {
    mockSend.mockResolvedValue(response);
    await expect(provider.isSameResource(eipId('203.0.113.1', ALLOC_A), { physicalId: ALLOC_B }, EIP, CTX)).rejects.toThrow(
      'did not return exactly the address asked for'
    );
  });

  it('a not-found error of another resource kind is not read as gone', async () => {
    addresses({ [ALLOC_A]: awsError('InvalidAddress.NotFound'), [ALLOC_B]: 'live' });
    await expect(
      provider.isSameResource(eipId('203.0.113.1', ALLOC_A), { physicalId: ALLOC_B }, EIP, CTX)
    ).rejects.toThrow('InvalidAddress.NotFound');
  });

  // Defensive, as for the NAT gateway: a read naming the record's address
  // never reads as 'different'.
  it('a journaled id reading back as the record address is the same', async () => {
    mockSend.mockResolvedValue({ Addresses: [{ AllocationId: ALLOC_B }] });
    expect(
      await provider.isSameResource(eipId('203.0.113.1', ALLOC_A), { physicalId: ALLOC_B }, EIP, CTX)
    ).toBe('same');
  });

  // The settle's holder checks compare the physical id STRING, so a bare
  // journaled id could miss a record elsewhere holding its composite spelling.
  it('a bare journaled allocation id is never different, with no read', async () => {
    addresses({ [ALLOC_A]: 'gone', [ALLOC_B]: 'live' });
    expect(
      await provider.isSameResource(ALLOC_A, { physicalId: eipId('203.0.113.2', ALLOC_B) }, EIP, CTX)
    ).toBe('unknown');
    expect(await provider.isSameResource(ALLOC_A, { physicalId: ALLOC_B }, EIP, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    addresses({ [ALLOC_A]: 'gone', [ALLOC_B]: 'live' });
    expect(await provider.isSameResource(eipId('203.0.113.1', ALLOC_A), { physicalId: ALLOC_B }, EIP, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an id carrying no allocation id (a bare public IP, three segments) is unknown, with no read', async () => {
    addresses({ [ALLOC_A]: 'gone', [ALLOC_B]: 'live' });
    for (const [journaled, recorded] of [
      ['203.0.113.1', ALLOC_B],
      [ALLOC_A, '203.0.113.2'],
      ['', ALLOC_B],
      [`203.0.113.1|${ALLOC_A}|x`, ALLOC_B],
      [`x|203.0.113.1|${ALLOC_A}`, ALLOC_B],
      [`${ALLOC_A}|203.0.113.1`, ALLOC_B],
    ] as const) {
      expect(await provider.isSameResource(journaled, { physicalId: recorded }, EIP, CTX)).toBe(
        'unknown'
      );
    }
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EC2Provider.isSameResource for the other EC2 types (go-to-k/cdkd#4606)', () => {
  it.each(['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::InternetGateway', 'AWS::EC2::Instance'])(
    '%s is unknown, with no read, even for distinct NAT-shaped ids',
    async (type) => {
      natGateways({ [NAT_A]: 'gone', [NAT_B]: 'available' });
      expect(await provider.isSameResource(NAT_A, { physicalId: NAT_B }, type, CTX)).toBe('unknown');
      expect(await provider.isSameResource(ALLOC_A, { physicalId: ALLOC_B }, type, CTX)).toBe(
        'unknown'
      );
      expect(await provider.isSameResource(NAT_A, { physicalId: NAT_A }, type, CTX)).toBe('unknown');
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});

describe('EC2Provider.delete of a journaled NAT gateway / Elastic IP already gone (go-to-k/cdkd#4606)', () => {
  it.each([
    [NAT, NAT_A, DeleteNatGatewayCommand, awsError('NatGatewayNotFound', 'NAT gateway not found')],
    [
      EIP,
      eipId('203.0.113.1', ALLOC_A),
      ReleaseAddressCommand,
      awsError('InvalidAllocationID.NotFound', 'allocation not found'),
    ],
  ])('%s names it once at info, since the settle then exits 0', async (type, id, cmdClass, error) => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof cmdClass) throw error;
      throw new Error('unexpected command');
    });
    await provider.delete('Orphan', id, type, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(id);
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line.
    providerLogger.info.mockClear();
    await provider.delete('Orphan', id, type, {}, { expectedRegion: 'us-east-1' });
    expect(providerLogger.info).not.toHaveBeenCalled();
  });
});
