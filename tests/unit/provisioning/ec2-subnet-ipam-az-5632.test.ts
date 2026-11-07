import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateSubnetCommand,
  DeleteSubnetCommand,
  DescribeSubnetsCommand,
  GetIpamPoolAllocationsCommand,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#5632: AWS::EC2::Subnet `AvailabilityZoneId`, `Ipv4IpamPoolId`,
// `Ipv4NetmaskLength`, `Ipv6IpamPoolId` and `Ipv6NetmaskLength` on the SDK
// route: what reaches CreateSubnet, what is refused before it, what is
// recorded for `Fn::GetAtt`, what readCurrentState reports, and the delete's
// wait for a pool allocation to be released.

const { mockSend, warn, info } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info,
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

import {
  EC2Provider,
  resetEc2CreateRetryStateForTests,
  vpcIpamReleaseWait,
} from '../../../src/provisioning/providers/ec2-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

const TYPE = 'AWS::EC2::Subnet';
const IPV6_BLOCK = '2600:1f18:aa:bb00::/64';

function sent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

/** A CreateSubnet answer as EC2 gives it: the zone id and an allocated block. */
function answerCreate(): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof CreateSubnetCommand) {
      const input = cmd.input;
      const v6 = input.Ipv6CidrBlock ?? (input.Ipv6IpamPoolId ? IPV6_BLOCK : undefined);
      return Promise.resolve({
        Subnet: {
          SubnetId: 'subnet-new',
          VpcId: input.VpcId,
          AvailabilityZone: 'us-east-1c',
          AvailabilityZoneId: input.AvailabilityZoneId ?? 'use1-az6',
          ...((input.CidrBlock ?? input.Ipv4IpamPoolId) !== undefined && {
            CidrBlock: input.CidrBlock ?? '10.240.5.16/28',
          }),
          ...(v6 !== undefined && {
            Ipv6CidrBlockAssociationSet: [
              {
                AssociationId: 'subnet-cidr-assoc-1',
                Ipv6CidrBlock: v6,
                Ipv6CidrBlockState: { State: 'associating' },
              },
            ],
          }),
        },
      });
    }
    if (cmd instanceof DescribeSubnetsCommand) {
      return Promise.resolve({
        Subnets: [
          {
            SubnetId: 'subnet-new',
            VpcId: 'vpc-1',
            AvailabilityZone: 'us-east-1c',
            AvailabilityZoneId: 'use1-az4',
            CidrBlock: '10.240.5.16/28',
            Ipv6CidrBlockAssociationSet: [
              {
                AssociationId: 'subnet-cidr-assoc-1',
                Ipv6CidrBlock: IPV6_BLOCK,
                Ipv6CidrBlockState: { State: 'associated' },
              },
            ],
          },
        ],
      });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
  info.mockReset();
  answerCreate();
});

describe('AWS::EC2::Subnet create (#5632)', () => {
  it('sends AvailabilityZoneId and the IPv4 IPAM inputs without a CidrBlock, recording the allocated CIDR', async () => {
    const result = await new EC2Provider().create('Subnet', TYPE, {
      VpcId: 'vpc-1',
      AvailabilityZoneId: 'use1-az4',
      Ipv4IpamPoolId: 'ipam-pool-1',
      Ipv4NetmaskLength: '28',
    });
    expect(sent(CreateSubnetCommand)).toEqual([
      {
        VpcId: 'vpc-1',
        CidrBlock: undefined,
        Ipv6CidrBlock: undefined,
        Ipv6Native: undefined,
        AvailabilityZone: undefined,
        AvailabilityZoneId: 'use1-az4',
        Ipv4IpamPoolId: 'ipam-pool-1',
        // A string netmask goes out as the integer CreateSubnet takes.
        Ipv4NetmaskLength: 28,
      },
    ]);
    expect(result.attributes).toEqual({
      SubnetId: 'subnet-new',
      AvailabilityZone: 'us-east-1c',
      AvailabilityZoneId: 'use1-az4',
      CidrBlock: '10.240.5.16/28',
      VpcId: 'vpc-1',
    });
  });

  it('sends the IPv6 IPAM inputs and waits for the allocated block to associate', async () => {
    await new EC2Provider().create('Subnet', TYPE, {
      VpcId: 'vpc-1',
      CidrBlock: '10.0.1.0/24',
      Ipv6IpamPoolId: 'ipam-pool-6',
      Ipv6NetmaskLength: 64,
    });
    expect(sent(CreateSubnetCommand)[0]).toMatchObject({
      CidrBlock: '10.0.1.0/24',
      Ipv6IpamPoolId: 'ipam-pool-6',
      Ipv6NetmaskLength: 64,
    });
    expect(sent(CreateSubnetCommand)[0]).not.toHaveProperty('Ipv4IpamPoolId');
    // The association wait read the subnet before the create returned.
    expect(sent(DescribeSubnetsCommand).length).toBeGreaterThan(0);
  });

  it('looks the association up when CreateSubnet names none for a pool-allocated IPv6 block', async () => {
    const answer = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof CreateSubnetCommand
        ? Promise.resolve({ Subnet: { SubnetId: 'subnet-new', AvailabilityZone: 'us-east-1c' } })
        : answer(cmd)
    );
    await new EC2Provider().create('Subnet', TYPE, {
      VpcId: 'vpc-1',
      CidrBlock: '10.0.1.0/24',
      Ipv6IpamPoolId: 'ipam-pool-6',
    });
    expect(sent(DeleteSubnetCommand)).toEqual([]);
    expect(sent(DescribeSubnetsCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('rides out a not-found read of the just-created subnet while looking the association up', async () => {
    const answer = mockSend.getMockImplementation()!;
    let reads = 0;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand) {
        return Promise.resolve({ Subnet: { SubnetId: 'subnet-new', AvailabilityZone: 'us-east-1c' } });
      }
      if (cmd instanceof DescribeSubnetsCommand && reads++ === 0) {
        return Promise.reject(
          Object.assign(new Error('The subnet ID does not exist'), { name: 'InvalidSubnetID.NotFound' })
        );
      }
      return answer(cmd);
    });
    const provider = new EC2Provider();
    (provider as unknown as { sleep: () => Promise<void> }).sleep = () => Promise.resolve();
    await provider.create('Subnet', TYPE, {
      VpcId: 'vpc-1',
      CidrBlock: '10.0.1.0/24',
      Ipv6IpamPoolId: 'ipam-pool-6',
    });
    expect(sent(DeleteSubnetCommand)).toEqual([]);
  });

  it('a declared IPv6 block still fails a create whose response names no association', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof CreateSubnetCommand
          ? { Subnet: { SubnetId: 'subnet-new', AvailabilityZone: 'us-east-1c' } }
          : {}
      )
    );
    await expect(
      new EC2Provider().create('Subnet', TYPE, {
        VpcId: 'vpc-1',
        CidrBlock: '10.0.1.0/24',
        Ipv6CidrBlock: IPV6_BLOCK,
      })
    ).rejects.toThrow(/CreateSubnet returned no IPv6 association ID/);
    expect(sent(DescribeSubnetsCommand)).toEqual([]);
  });

  it('sends none of the new inputs when the template declares none', async () => {
    const result = await new EC2Provider().create('Subnet', TYPE, {
      VpcId: 'vpc-1',
      CidrBlock: '10.0.1.0/24',
    });
    const input = sent(CreateSubnetCommand)[0]!;
    for (const key of [
      'AvailabilityZoneId',
      'Ipv4IpamPoolId',
      'Ipv4NetmaskLength',
      'Ipv6IpamPoolId',
      'Ipv6NetmaskLength',
    ]) {
      expect(input).not.toHaveProperty(key);
    }
    // The zone id EC2 picked is still recorded for Fn::GetAtt.
    expect(result.attributes).toMatchObject({ AvailabilityZoneId: 'use1-az6', CidrBlock: '10.0.1.0/24' });
  });

  it('records the declared CIDR and VPC when the create response omits them', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof CreateSubnetCommand
          ? { Subnet: { SubnetId: 'subnet-new', AvailabilityZone: 'us-east-1c' } }
          : {}
      )
    );
    const result = await new EC2Provider().create('Subnet', TYPE, {
      VpcId: 'vpc-1',
      CidrBlock: '10.0.1.0/24',
    });
    expect(result.attributes).toEqual({
      SubnetId: 'subnet-new',
      AvailabilityZone: 'us-east-1c',
      CidrBlock: '10.0.1.0/24',
      VpcId: 'vpc-1',
    });
  });

  it('still refuses a subnet with no IPv4 source unless Ipv6Native is true', async () => {
    await expect(
      new EC2Provider().create('Subnet', TYPE, { VpcId: 'vpc-1', Ipv4NetmaskLength: 28 })
    ).rejects.toThrow(/CidrBlock may be omitted only when Ipv6Native is true or Ipv4IpamPoolId is set/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    [{ AvailabilityZoneId: '' }, /AWS::EC2::Subnet\.AvailabilityZoneId must not be blank/],
    [{ AvailabilityZoneId: 4 }, /AvailabilityZoneId/],
    [{ Ipv4IpamPoolId: '' }, /AWS::EC2::Subnet\.Ipv4IpamPoolId must not be blank/],
    [{ Ipv4IpamPoolId: 'ipam-pool-1', Ipv4NetmaskLength: 33 }, /Ipv4NetmaskLength/],
    [{ Ipv4IpamPoolId: 'ipam-pool-1', Ipv4NetmaskLength: 'big' }, /Ipv4NetmaskLength/],
    [{ CidrBlock: '10.0.1.0/24', Ipv6IpamPoolId: ['ipam-pool-6'] }, /Ipv6IpamPoolId/],
    [{ CidrBlock: '10.0.1.0/24', Ipv6NetmaskLength: 129 }, /Ipv6NetmaskLength/],
  ])('refuses malformed %j before any call, non-retryable', async (extra, says) => {
    const error = await new EC2Provider()
      .create('Subnet', TYPE, { VpcId: 'vpc-1', ...extra })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(says);
    expect((error as Error).message).toContain('The Subnet Subnet was not created.');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a malformed value on a rollback replay too, naming the state record', async () => {
    await expect(
      new EC2Provider().create(
        'Subnet',
        TYPE,
        { VpcId: 'vpc-1', Ipv4IpamPoolId: 'ipam-pool-1', Ipv4NetmaskLength: -1 },
        { replayingState: true }
      )
    ).rejects.toThrow(/The value comes from the state record being restored/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports the pool\'s subnets in the VPC when a pool-allocated CreateSubnet ended ambiguously', async () => {
    resetEc2CreateRetryStateForTests();
    let first = true;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand) {
        if (first) {
          first = false;
          return Promise.reject(
            Object.assign(new Error('We encountered an internal error. Please try again.'), {
              name: 'InternalError',
              $fault: 'server',
              $metadata: { httpStatusCode: 500 },
            })
          );
        }
        return Promise.resolve({
          Subnet: { SubnetId: 'subnet-second', AvailabilityZone: 'us-east-1c', CidrBlock: '10.240.5.32/28' },
        });
      }
      if (cmd instanceof GetIpamPoolAllocationsCommand) {
        return Promise.resolve({
          IpamPoolAllocations: [
            { ResourceType: 'subnet', ResourceId: 'subnet-lost' },
            { ResourceType: 'subnet', ResourceId: 'subnet-tagged' },
            { ResourceType: 'vpc', ResourceId: 'vpc-1' },
            // Not a subnet allocation, though its id names one in the VPC.
            { ResourceType: 'ipam-pool', ResourceId: 'subnet-wrongtype' },
          ],
        });
      }
      if (cmd instanceof DescribeSubnetsCommand) {
        return Promise.resolve({
          Subnets: [
            { SubnetId: 'subnet-lost', CidrBlock: '10.240.5.16/28' },
            { SubnetId: 'subnet-tagged', CidrBlock: '10.240.5.48/28', Tags: [{ Key: 'k', Value: 'v' }] },
            { SubnetId: 'subnet-unpooled', CidrBlock: '10.240.5.64/28' },
            { SubnetId: 'subnet-wrongtype', CidrBlock: '10.240.5.80/28' },
          ],
        });
      }
      return Promise.resolve({});
    });
    const provider = new EC2Provider();
    const props = { VpcId: 'vpc-1', Ipv4IpamPoolId: 'ipam-pool-1', Ipv4NetmaskLength: 28 };
    await expect(provider.create('Subnet', TYPE, props)).rejects.toThrow();
    await provider.create('Subnet', TYPE, props);
    expect(sent(GetIpamPoolAllocationsCommand)[0]).toMatchObject({ IpamPoolId: 'ipam-pool-1' });
    expect(sent(DescribeSubnetsCommand)[0]).toMatchObject({
      Filters: [{ Name: 'vpc-id', Values: ['vpc-1'] }],
    });
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('a subnet allocated from IPAM pool ipam-pool-1 in VPC vpc-1');
    expect(line).toContain('subnet-lost');
    expect(line).not.toContain('subnet-tagged');
    expect(line).not.toContain('subnet-unpooled');
    expect(line).not.toContain('subnet-wrongtype');
    // No CIDR collides with a pool-allocated subnet, so the conflict sentence is not said.
    expect(line).not.toContain('InvalidSubnet.Conflict');
    resetEc2CreateRetryStateForTests();
  });
});

describe('an IPv6-only subnet allocated from an IPv6 pool (#5632)', () => {
  const NATIVE = {
    VpcId: 'vpc-1',
    Ipv6Native: true,
    Ipv6IpamPoolId: 'ipam-pool-6',
    Ipv6NetmaskLength: 64,
  };

  it('reports the IPv6 pool\'s subnets when its CreateSubnet ended ambiguously', async () => {
    resetEc2CreateRetryStateForTests();
    let first = true;
    const answer = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand && first) {
        first = false;
        return Promise.reject(
          Object.assign(new Error('We encountered an internal error. Please try again.'), {
            name: 'InternalError',
            $fault: 'server',
            $metadata: { httpStatusCode: 500 },
          })
        );
      }
      if (cmd instanceof GetIpamPoolAllocationsCommand) {
        return Promise.resolve({
          IpamPoolAllocations: [{ ResourceType: 'subnet', ResourceId: 'subnet-lost' }],
        });
      }
      if (cmd instanceof DescribeSubnetsCommand && (cmd.input.Filters ?? []).length > 0) {
        return Promise.resolve({ Subnets: [{ SubnetId: 'subnet-lost' }] });
      }
      return answer(cmd);
    });
    const provider = new EC2Provider();
    await expect(provider.create('Subnet', TYPE, NATIVE)).rejects.toThrow();
    await provider.create('Subnet', TYPE, NATIVE);
    expect(sent(GetIpamPoolAllocationsCommand)[0]).toMatchObject({ IpamPoolId: 'ipam-pool-6' });
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('a subnet allocated from IPAM pool ipam-pool-6 in VPC vpc-1');
    expect(line).toContain('subnet-lost');
    resetEc2CreateRetryStateForTests();
  });

  it('is terminal when its wiring cleanup failed', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand) {
        return Promise.resolve({ Subnet: { SubnetId: 'subnet-new', AvailabilityZone: 'us-east-1c' } });
      }
      if (cmd instanceof DeleteSubnetCommand) {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }));
      }
      // No association anywhere, so the create's IPv6 wiring fails.
      return Promise.resolve({ Subnets: [{ SubnetId: 'subnet-new' }] });
    });
    const provider = new EC2Provider();
    // The association lookup's pauses are not under test.
    (provider as unknown as { sleep: () => Promise<void> }).sleep = () => Promise.resolve();
    const error = await provider.create('Subnet', TYPE, NATIVE).catch((e: unknown) => e);
    expect(String(error)).toContain('CreateSubnet returned no IPv6 association ID');
    expect(isMarkedNonRetryable(error)).toBe(true);
    // The lookup gives up after its tenth read.
    expect(sent(DescribeSubnetsCommand)).toHaveLength(10);
  });
});

describe('the pool-allocated subnet orphan search (#5632)', () => {
  it('says the search was cut when the pool allocations do not end', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetIpamPoolAllocationsCommand) {
        return Promise.resolve({ IpamPoolAllocations: [], NextToken: 'more' });
      }
      if (cmd instanceof DescribeSubnetsCommand) return Promise.resolve({ Subnets: [] });
      return Promise.resolve({});
    });
    const provider = new EC2Provider() as unknown as {
      reportPossibleOrphanSubnets: (
        logicalId: string,
        vpcId: string,
        match: { ipamPoolId: string },
        sent: unknown[],
        window: { floorMs: number; ceilingMs: number },
        context: undefined
      ) => Promise<void>;
    };
    await provider.reportPossibleOrphanSubnets(
      'Subnet',
      'vpc-1',
      { ipamPoolId: 'ipam-pool-1' },
      [],
      { floorMs: 0, ceilingMs: 1 },
      undefined
    );
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'The search was incomplete'
    );
  });
});

describe('AWS::EC2::Subnet update / readback (#5632)', () => {
  const PREV = {
    VpcId: 'vpc-1',
    AvailabilityZoneId: 'use1-az4',
    Ipv4IpamPoolId: 'ipam-pool-1',
    Ipv4NetmaskLength: 28,
    Ipv6IpamPoolId: 'ipam-pool-6',
    Ipv6NetmaskLength: 64,
  };

  it.each([
    ['AvailabilityZoneId', 'use1-az1'],
    ['Ipv4IpamPoolId', 'ipam-pool-2'],
    ['Ipv4NetmaskLength', 27],
    ['Ipv6IpamPoolId', 'ipam-pool-7'],
    ['Ipv6NetmaskLength', 60],
  ])('refuses a changed %s before any call (drift --revert reaches update with it)', async (key, value) => {
    await expect(
      new EC2Provider().update('Subnet', 'subnet-new', TYPE, { ...PREV, [key]: value }, PREV)
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('compares a netmask by value and a pool id only when both sides carry it', async () => {
    const { Ipv4IpamPoolId: _a, Ipv6IpamPoolId: _b, ...readback } = PREV;
    await new EC2Provider().update(
      'Subnet',
      'subnet-new',
      TYPE,
      { ...readback, Ipv4NetmaskLength: '28', Ipv6NetmaskLength: '64' },
      PREV
    );
    expect(sent(CreateSubnetCommand)).toEqual([]);
  });

  it('reads back the zone id always, and each netmask from its block only when declared', async () => {
    const provider = new EC2Provider();
    const declared = await provider.readCurrentState('subnet-new', 'Subnet', TYPE, PREV);
    expect(declared).toMatchObject({
      AvailabilityZoneId: 'use1-az4',
      Ipv4NetmaskLength: 28,
      Ipv6NetmaskLength: 64,
    });
    const plain = await provider.readCurrentState('subnet-new', 'Subnet', TYPE, {
      VpcId: 'vpc-1',
      CidrBlock: '10.240.5.16/28',
    });
    expect(plain).toMatchObject({ AvailabilityZoneId: 'use1-az4' });
    expect(plain).not.toHaveProperty('Ipv4NetmaskLength');
    expect(plain).not.toHaveProperty('Ipv6NetmaskLength');
  });

  it('getAttribute() reads the create-only members create() records', async () => {
    const provider = new EC2Provider();
    expect(await provider.getAttribute('subnet-new', TYPE, 'AvailabilityZoneId')).toBe('use1-az4');
    expect(await provider.getAttribute('subnet-new', TYPE, 'CidrBlock')).toBe('10.240.5.16/28');
    expect(await provider.getAttribute('subnet-new', TYPE, 'VpcId')).toBe('vpc-1');
  });

  it('names each create-only key in the hand replacement rule, so a DescribeType failure still replaces', () => {
    const registry = new ReplacementRulesRegistry();
    for (const prop of [
      'AvailabilityZoneId',
      'Ipv4IpamPoolId',
      'Ipv4NetmaskLength',
      'Ipv6IpamPoolId',
      'Ipv6NetmaskLength',
      'Ipv6Native',
    ]) {
      expect(registry.isClassified(TYPE, prop)).toBe(true);
      expect(registry.requiresReplacement(TYPE, prop, 'a', 'b')).toBe(true);
    }
  });

  it('the unsettled-recovery read reports a declared netmask too', async () => {
    const read = await new EC2Provider().readUnsettled(
      'subnet-new',
      'Subnet',
      TYPE,
      new Set(['Ipv6CidrBlock']),
      { VpcId: 'vpc-1', Ipv4IpamPoolId: 'ipam-pool-1', Ipv4NetmaskLength: 28 }
    );
    expect(read).toMatchObject({ Ipv4NetmaskLength: 28, AvailabilityZoneId: 'use1-az4' });
  });

  it('declares both pool ids unreadable for drift', () => {
    expect(new EC2Provider().getDriftUnknownPaths(TYPE)).toEqual([
      'Ipv4IpamPoolId',
      'Ipv6IpamPoolId',
    ]);
  });

  it('folds a string netmask to the integer on both diff sides, the VPC\'s too', () => {
    const provider = new EC2Provider();
    expect(
      provider.canonicalizeDesiredProperties(TYPE, {
        Ipv4NetmaskLength: '28',
        Ipv6NetmaskLength: '64',
        Ipv4IpamPoolId: 'ipam-pool-1',
      })
    ).toEqual({ Ipv4NetmaskLength: 28, Ipv6NetmaskLength: 64, Ipv4IpamPoolId: 'ipam-pool-1' });
    expect(
      provider.canonicalizeDesiredProperties('AWS::EC2::VPC', { Ipv4NetmaskLength: '24' })
    ).toEqual({ Ipv4NetmaskLength: 24 });
    // An unusable value is left for the create to refuse.
    expect(provider.canonicalizeDesiredProperties(TYPE, { Ipv4NetmaskLength: 'big' })).toEqual({
      Ipv4NetmaskLength: 'big',
    });
  });

  it('import() records the attributes create() does, for an older record\'s heal', async () => {
    const result = await new EC2Provider().import({
      logicalId: 'Subnet',
      resourceType: TYPE,
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'subnet-new',
    });
    expect(result?.attributes).toEqual({
      SubnetId: 'subnet-new',
      AvailabilityZone: 'us-east-1c',
      AvailabilityZoneId: 'use1-az4',
      CidrBlock: '10.240.5.16/28',
      VpcId: 'vpc-1',
    });
  });
});

describe('a pool-allocated subnet delete waits for the allocation to be released (#5632)', () => {
  const defaults = { ...vpcIpamReleaseWait };
  beforeEach(() => {
    vpcIpamReleaseWait.pollIntervalMs = 1;
    vpcIpamReleaseWait.maxWaitMs = 50;
  });
  afterEach(() => Object.assign(vpcIpamReleaseWait, defaults));

  it('polls each declared pool until it no longer lists the deleted subnet', async () => {
    const answers: Record<string, string[][]> = {
      'ipam-pool-1': [['subnet-1'], []],
      'ipam-pool-6': [['subnet-1', 'subnet-other'], ['subnet-other']],
    };
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetIpamPoolAllocationsCommand) {
        const queue = answers[cmd.input.IpamPoolId!]!;
        const ids = queue.length > 1 ? queue.shift()! : queue[0]!;
        return Promise.resolve({
          IpamPoolAllocations: ids.map((id) => ({ ResourceType: 'subnet', ResourceId: id })),
        });
      }
      return Promise.resolve({});
    });
    await new EC2Provider().delete('Subnet', 'subnet-1', TYPE, {
      VpcId: 'vpc-1',
      Ipv4IpamPoolId: 'ipam-pool-1',
      Ipv6IpamPoolId: 'ipam-pool-6',
    });
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DeleteSubnetCommand);
    expect(sent(GetIpamPoolAllocationsCommand).map((i) => i['IpamPoolId'])).toEqual([
      'ipam-pool-1',
      'ipam-pool-1',
      'ipam-pool-6',
      'ipam-pool-6',
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Waiting for IPAM pools ipam-pool-1 and ipam-pool-6 to release the allocations of deleted subnet subnet-1'
    );
  });

  it('keeps the VPC wait\'s wording, measured duration included', async () => {
    mockSend.mockImplementation(() => Promise.resolve({ IpamPoolAllocations: [] }));
    await new EC2Provider().delete('Vpc', 'vpc-1', 'AWS::EC2::VPC', {
      Ipv4IpamPoolId: 'ipam-pool-0abc',
    });
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Waiting for IPAM pool ipam-pool-0abc to release the allocation of deleted VPC vpc-1; AWS can take about 18 minutes, and the pool CIDR cannot be deprovisioned before then'
    );
  });

  it('waits for nothing when the subnet names no pool, or one cdkd cannot send', async () => {
    await new EC2Provider().delete('Subnet', 'subnet-1', TYPE, {
      VpcId: 'vpc-1',
      CidrBlock: '10.0.1.0/24',
    });
    await new EC2Provider().delete('Subnet', 'subnet-1', TYPE, {
      VpcId: 'vpc-1',
      Ipv4IpamPoolId: '***',
    });
    expect(sent(GetIpamPoolAllocationsCommand)).toEqual([]);
    expect(sent(DeleteSubnetCommand)).toHaveLength(2);
  });

  it('caps an IPv4 and an IPv6 pool by ONE wait budget, not one each', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof GetIpamPoolAllocationsCommand
          ? { IpamPoolAllocations: [{ ResourceType: 'subnet', ResourceId: 'subnet-1' }] }
          : {}
      )
    );
    vpcIpamReleaseWait.maxWaitMs = 200;
    vpcIpamReleaseWait.pollIntervalMs = 20;
    await new EC2Provider().delete('Subnet', 'subnet-1', TYPE, {
      VpcId: 'vpc-1',
      Ipv4IpamPoolId: 'ipam-pool-1',
      Ipv6IpamPoolId: 'ipam-pool-6',
    });
    // A wait per pool would give up twice and take two budgets.
    const stops = warn.mock.calls.filter((c) => String(c[0]).includes('stopped waiting'));
    expect(stops).toHaveLength(1);
    expect(String(stops[0]![0])).toContain(
      'AWS releases the allocations on its side; until it does, each pool refuses to deprovision its CIDR'
    );
  });

  it('warns and returns when the allocation outlives the cap', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof GetIpamPoolAllocationsCommand
          ? { IpamPoolAllocations: [{ ResourceType: 'subnet', ResourceId: 'subnet-1' }] }
          : {}
      )
    );
    await new EC2Provider().delete('Subnet', 'subnet-1', TYPE, {
      VpcId: 'vpc-1',
      Ipv4IpamPoolId: 'ipam-pool-1',
    });
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('stopped waiting');
    expect(line).toContain('The CIDR has one or more allocations');
  });
});

describe('a pool-allocated subnet whose wiring cleanup failed (#5632)', () => {
  it('is terminal, since a retry would allocate another subnet', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand) {
        return Promise.resolve({
          Subnet: { SubnetId: 'subnet-new', AvailabilityZone: 'us-east-1c', CidrBlock: '10.240.5.16/28' },
        });
      }
      if (cmd instanceof DeleteSubnetCommand) {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }));
      }
      // The MapPublicIpOnLaunch write fails, so the subnet is cleaned up.
      return Promise.reject(Object.assign(new Error('boom'), { name: 'InvalidParameterValue' }));
    });
    const error = await new EC2Provider()
      .create('Subnet', TYPE, {
        VpcId: 'vpc-1',
        Ipv4IpamPoolId: 'ipam-pool-1',
        MapPublicIpOnLaunch: true,
      })
      .catch((e: unknown) => e);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('a declared-CIDR subnet stays retryable: its replay collides instead', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof CreateSubnetCommand) {
        return Promise.resolve({ Subnet: { SubnetId: 'subnet-new', AvailabilityZone: 'us-east-1c' } });
      }
      if (cmd instanceof DeleteSubnetCommand) {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }));
      }
      return Promise.reject(Object.assign(new Error('boom'), { name: 'InvalidParameterValue' }));
    });
    const error = await new EC2Provider()
      .create('Subnet', TYPE, { VpcId: 'vpc-1', CidrBlock: '10.0.1.0/24', MapPublicIpOnLaunch: true })
      .catch((e: unknown) => e);
    expect(isMarkedNonRetryable(error)).toBe(false);
  });
});
