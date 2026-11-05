import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  CreateSubnetCommand,
  AssociateSubnetCidrBlockCommand,
  DisassociateSubnetCidrBlockCommand,
  DeleteSubnetCommand,
  DescribeSubnetsCommand,
  ModifySubnetAttributeCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('ap-southeast-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => logger };
});

import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const type = 'AWS::EC2::Subnet';
const props = { VpcId: 'vpc-test', CidrBlock: '10.0.0.0/24' };

describe('subnet EnableDns64 SDK coverage (#5632)', () => {
  let provider: EC2Provider;
  let liveDns64: boolean;

  beforeEach(() => {
    mockSend.mockReset();
    liveDns64 = false;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateSubnetCommand) {
        return { Subnet: { SubnetId: 'subnet-test', AvailabilityZone: 'ap-southeast-1a' } };
      }
      if (command instanceof ModifySubnetAttributeCommand) {
        if (command.input.EnableDns64?.Value !== undefined) {
          liveDns64 = command.input.EnableDns64.Value;
        }
        return {};
      }
      if (command instanceof DescribeSubnetsCommand) {
        return { Subnets: [{ SubnetId: 'subnet-test', EnableDns64: liveDns64 }] };
      }
      return {};
    });
    provider = new EC2Provider();
  });

  const dns64Writes = () =>
    mockSend.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is ModifySubnetAttributeCommand =>
          command instanceof ModifySubnetAttributeCommand && command.input.EnableDns64 !== undefined
      );

  it('enables DNS64 after creating the subnet', async () => {
    await provider.create('Subnet', type, { ...props, EnableDns64: true });

    expect(dns64Writes().map((command) => command.input)).toEqual([
      { SubnetId: 'subnet-test', EnableDns64: { Value: true } },
    ]);
    const createIndex = mockSend.mock.calls.findIndex(([command]) => command instanceof CreateSubnetCommand);
    const modifyIndex = mockSend.mock.calls.findIndex(
      ([command]) => command instanceof ModifySubnetAttributeCommand && command.input.EnableDns64 !== undefined
    );
    expect(modifyIndex).toBeGreaterThan(createIndex);
  });

  it.each([
    [false, true],
    [true, false],
  ])('updates an explicit DNS64 value from %s to %s', async (previous, desired) => {
    liveDns64 = previous;
    await provider.update(
      'Subnet',
      'subnet-test',
      type,
      { ...props, EnableDns64: desired },
      { ...props, EnableDns64: previous }
    );

    expect(dns64Writes().map((command) => command.input)).toEqual([
      { SubnetId: 'subnet-test', EnableDns64: { Value: desired } },
    ]);
  });

  it.each([false, true])('does not rewrite an unchanged DNS64 value of %s', async (value) => {
    await provider.update(
      'Subnet',
      'subnet-test',
      type,
      { ...props, EnableDns64: value },
      { ...props, EnableDns64: value }
    );
    expect(dns64Writes()).toEqual([]);
  });

  it.each([false, true])('retains DNS64 %s when the property is removed', async (previous) => {
    liveDns64 = previous;
    await provider.update(
      'Subnet',
      'subnet-test',
      type,
      props,
      { ...props, EnableDns64: previous }
    );

    expect(dns64Writes()).toEqual([]);
    expect(liveDns64).toBe(previous);
  });

  it.each([false, true])('reads DNS64 %s from DescribeSubnets for drift detection', async (value) => {
    liveDns64 = value;
    const current = await provider.readCurrentState('subnet-test', 'Subnet', type);
    const read = mockSend.mock.calls.find(([command]) => command instanceof DescribeSubnetsCommand);
    expect(read?.[0].input).toEqual({ SubnetIds: ['subnet-test'] });
    expect(current).toEqual({ EnableDns64: value });
  });
});

describe('subnet Ipv6CidrBlock SDK coverage (#5632)', () => {
  const first = '2001:db8:1234:1::/64';
  const second = '2001:db8:1234:2::/64';
  let provider: EC2Provider;
  let associations: import('@aws-sdk/client-ec2').SubnetIpv6CidrBlockAssociation[];
  let failure: 'associate' | 'disassociate' | 'dns64' | undefined;

  const active = (cidr: string, id = 'assoc-old') => ({
    AssociationId: id,
    Ipv6CidrBlock: cidr,
    Ipv6CidrBlockState: { State: 'associated' as const },
  });
  const calls = () => mockSend.mock.calls.map(([command]) => command);

  beforeEach(() => {
    mockSend.mockReset();
    associations = [active(first)];
    failure = undefined;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateSubnetCommand) {
        return { Subnet: { SubnetId: 'subnet-test', AvailabilityZone: 'ap-southeast-1a', Ipv6CidrBlockAssociationSet: associations } };
      }
      if (command instanceof DescribeSubnetsCommand) {
        return { Subnets: [{ SubnetId: 'subnet-test', Ipv6CidrBlockAssociationSet: associations, EnableDns64: true }] };
      }
      if (command instanceof DisassociateSubnetCidrBlockCommand) {
        if (failure === 'disassociate') throw new Error('CIDR in use');
        associations = associations.map((item) => item.AssociationId === command.input.AssociationId
          ? { ...item, Ipv6CidrBlockState: { State: 'disassociated' } } : item);
        return {};
      }
      if (command instanceof AssociateSubnetCidrBlockCommand) {
        if (failure === 'associate') throw new Error('CIDR association refused');
        const association = active(command.input.Ipv6CidrBlock!, `assoc-new-${associations.length}`);
        associations.push(association);
        return { Ipv6CidrBlockAssociation: association };
      }
      if (command instanceof ModifySubnetAttributeCommand && failure === 'dns64') {
        throw new Error('DNS64 refused');
      }
      return {};
    });
    provider = new EC2Provider();
  });

  it('passes the IPv6 block on CreateSubnet before enabling DNS64', async () => {
    await provider.create('Subnet', type, { ...props, Ipv6CidrBlock: first, EnableDns64: true });
    const create = calls().find((command) => command instanceof CreateSubnetCommand);
    expect(create?.input.Ipv6CidrBlock).toBe(first);
    expect(calls().filter((command) => command instanceof AssociateSubnetCidrBlockCommand)).toEqual([]);
    expect(calls().findIndex((command) => command instanceof ModifySubnetAttributeCommand))
      .toBeGreaterThan(calls().indexOf(create));
  });

  it('ignores historical entries and disassociates the active block before associating its replacement', async () => {
    associations.unshift({ ...active(second, 'assoc-stale'), Ipv6CidrBlockState: { State: 'disassociated' } });
    const result = await provider.update('Subnet', 'subnet-test', type,
      { ...props, Ipv6CidrBlock: second }, { ...props, Ipv6CidrBlock: first });
    const writes = calls().filter((command) => command instanceof DisassociateSubnetCidrBlockCommand || command instanceof AssociateSubnetCidrBlockCommand);
    expect(writes.map((command) => command.input)).toEqual([
      { AssociationId: 'assoc-old' }, { SubnetId: 'subnet-test', Ipv6CidrBlock: second },
    ]);
    expect(writes[0]).toBeInstanceOf(DisassociateSubnetCidrBlockCommand);
    expect(associations.filter((item) => item.Ipv6CidrBlockState?.State === 'associated').map((item) => item.Ipv6CidrBlock)).toEqual([second]);
    expect(result).toEqual({ physicalId: 'subnet-test', wasReplaced: false });
  });

  it('disassociates the block when the property is removed', async () => {
    await provider.update('Subnet', 'subnet-test', type, props, { ...props, Ipv6CidrBlock: first });
    expect(calls().filter((command) => command instanceof DisassociateSubnetCidrBlockCommand).map((command) => command.input)).toEqual([{ AssociationId: 'assoc-old' }]);
    expect(calls().filter((command) => command instanceof AssociateSubnetCidrBlockCommand)).toEqual([]);
    expect(associations.some((item) => item.Ipv6CidrBlockState?.State === 'associated')).toBe(false);
  });

  it('associates an added block on a subnet with no active association', async () => {
    associations = [{ ...active(first), Ipv6CidrBlockState: { State: 'disassociated' } }];
    await provider.update('Subnet', 'subnet-test', type, { ...props, Ipv6CidrBlock: second }, props);
    expect(calls().filter((command) => command instanceof AssociateSubnetCidrBlockCommand).map((command) => command.input)).toEqual([{ SubnetId: 'subnet-test', Ipv6CidrBlock: second }]);
    expect(calls().filter((command) => command instanceof DisassociateSubnetCidrBlockCommand)).toEqual([]);
  });

  it.each([undefined, first])('does not read or mutate IPv6 on an unchanged value of %s', async (value) => {
    const unchanged = value === undefined ? props : { ...props, Ipv6CidrBlock: value };
    await provider.update('Subnet', 'subnet-test', type, unchanged, unchanged);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reads only the associated CIDR block for drift detection', async () => {
    associations.unshift({ ...active(second, 'assoc-stale'), Ipv6CidrBlockState: { State: 'disassociated' } });
    expect(await provider.readCurrentState('subnet-test', 'Subnet', type)).toEqual({ Ipv6CidrBlock: first, EnableDns64: true });
  });

  it('omits IPv6 readback when only historical associations remain', async () => {
    associations = [{ ...active(first), Ipv6CidrBlockState: { State: 'disassociated' } }];
    expect(await provider.readCurrentState('subnet-test', 'Subnet', type)).toEqual({ EnableDns64: true });
  });

  it('waits for disassociation to finish before associating the replacement', async () => {
    const send = mockSend.getMockImplementation()!;
    let waiting = false;
    let pendingReads = 0;
    vi.spyOn(provider as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockResolvedValue();
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeSubnetsCommand && waiting) {
        pendingReads++;
        associations[0]!.Ipv6CidrBlockState = {
          State: pendingReads < 3 ? 'disassociating' : 'disassociated',
        };
      }
      if (command instanceof AssociateSubnetCidrBlockCommand) {
        expect(pendingReads).toBe(3);
      }
      const result = await send(command);
      if (command instanceof DisassociateSubnetCidrBlockCommand) {
        waiting = true;
        associations[0]!.Ipv6CidrBlockState = { State: 'disassociating' };
      }
      return result;
    });
    await provider.update('Subnet', 'subnet-test', type,
      { ...props, Ipv6CidrBlock: second }, { ...props, Ipv6CidrBlock: first });
    expect(pendingReads).toBeGreaterThanOrEqual(3);
  });

  it('can replay the previous IPv6 block after an update', async () => {
    await provider.update('Subnet', 'subnet-test', type,
      { ...props, Ipv6CidrBlock: second }, { ...props, Ipv6CidrBlock: first });
    await provider.update('Subnet', 'subnet-test', type,
      { ...props, Ipv6CidrBlock: first }, { ...props, Ipv6CidrBlock: second }, { replayingState: true });
    expect(associations.filter((item) => item.Ipv6CidrBlockState?.State === 'associated').map((item) => item.Ipv6CidrBlock)).toEqual([first]);
  });

  it('surfaces a refused disassociation without associating the new block', async () => {
    failure = 'disassociate';
    await expect(provider.update('Subnet', 'subnet-test', type,
      { ...props, Ipv6CidrBlock: second }, { ...props, Ipv6CidrBlock: first })).rejects.toThrow('CIDR in use');
    expect(calls().filter((command) => command instanceof AssociateSubnetCidrBlockCommand)).toEqual([]);
  });

  it('restores the previous live block if attaching the replacement fails', async () => {
    const send = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof AssociateSubnetCidrBlockCommand && command.input.Ipv6CidrBlock === second) {
        throw new Error('replacement CIDR refused');
      }
      return send(command);
    });
    await expect(provider.update('Subnet', 'subnet-test', type,
      { ...props, Ipv6CidrBlock: second }, { ...props, Ipv6CidrBlock: first })).rejects.toThrow('replacement CIDR refused');
    expect(associations.filter((item) => item.Ipv6CidrBlockState?.State === 'associated').map((item) => item.Ipv6CidrBlock)).toEqual([first]);
  });

  it('surfaces a refused association', async () => {
    failure = 'associate';
    await expect(provider.update('Subnet', 'subnet-test', type,
      { ...props, Ipv6CidrBlock: second }, { ...props, Ipv6CidrBlock: first })).rejects.toThrow('CIDR association refused');
  });

  it('cleans up a new dual-stack subnet if DNS64 wiring fails', async () => {
    failure = 'dns64';
    await expect(provider.create('Subnet', type, { ...props, Ipv6CidrBlock: first, EnableDns64: true })).rejects.toThrow('DNS64 refused');
    expect(calls().filter((command) => command instanceof DeleteSubnetCommand).map((command) => command.input)).toEqual([{ SubnetId: 'subnet-test' }]);
  });
});

describe('subnet configuration guards and replay (#5632)', () => {
  const first = '2001:db8:1234:1::/64';
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateSubnetCommand) {
        return { Subnet: { SubnetId: 'subnet-test' } };
      }
      if (command instanceof DescribeSubnetsCommand) {
        return { Subnets: [{ EnableDns64: true, Ipv6CidrBlockAssociationSet: [{
          AssociationId: 'assoc-live', Ipv6CidrBlock: first,
          Ipv6CidrBlockState: { State: 'associated' },
        }] }] };
      }
      return {};
    });
    provider = new EC2Provider();
  });

  it.each([
    { EnableDns64: null }, { EnableDns64: 'yes' }, { EnableDns64: { Ref: 'Unresolved' } },
    { Ipv6CidrBlock: null }, { Ipv6CidrBlock: '' }, { Ipv6CidrBlock: { Ref: 'Unresolved' } },
  ])('refuses malformed desired configuration before any AWS call: %j', async (bad) => {
    await expect(provider.create('Subnet', type, { ...props, ...bad })).rejects.toThrow(/must be/);
    expect(mockSend).not.toHaveBeenCalled();
    await expect(provider.update('Subnet', 'subnet-test', type, { ...props, ...bad }, props)).rejects.toThrow(/must be/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps valid previous configuration when replay skips malformed desired values', async () => {
    const previous = { ...props, EnableDns64: true, Ipv6CidrBlock: first };
    const result = await provider.update('Subnet', 'subnet-test', type,
      { ...props, EnableDns64: 'bad', Ipv6CidrBlock: null }, previous, { replayingState: true });
    expect(result.effectiveProperties).toEqual(previous);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not manufacture absent previous configuration during replay', async () => {
    const result = await provider.update('Subnet', 'subnet-test', type,
      { ...props, EnableDns64: 'bad', Ipv6CidrBlock: null }, props, { replayingState: true });
    expect(result.effectiveProperties).toEqual(props);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uses live values when both replayed and previous values are malformed', async () => {
    const malformed = { ...props, EnableDns64: 'bad', Ipv6CidrBlock: null };
    const result = await provider.update('Subnet', 'subnet-test', type, malformed, malformed, { replayingState: true });
    expect(result.effectiveProperties).toEqual({ ...props, EnableDns64: true, Ipv6CidrBlock: first });
    expect(mockSend.mock.calls.every(([command]) => command instanceof DescribeSubnetsCommand)).toBe(true);
    expect(mockSend.mock.calls.filter(([command]) => command instanceof DisassociateSubnetCidrBlockCommand || command instanceof AssociateSubnetCidrBlockCommand)).toEqual([]);
  });

  it('drops malformed replay-create properties from the recorded bag', async () => {
    const result = await provider.create('Subnet', type,
      { ...props, EnableDns64: 'bad', Ipv6CidrBlock: null }, { replayingState: true });
    expect(result.effectiveProperties).toEqual(props);
    expect(mockSend.mock.calls.filter(([command]) => command instanceof ModifySubnetAttributeCommand)).toEqual([]);
  });

  it.each(['true', 'TRUE', true])('uses one boolean interpretation on the wire and in the diff: %s', async (value) => {
    const desired = { ...props, EnableDns64: value };
    await provider.create('Subnet', type, desired);
    const writes = mockSend.mock.calls.filter(([command]) => command instanceof ModifySubnetAttributeCommand);
    expect(writes.map(([command]) => command.input)).toEqual([{ SubnetId: 'subnet-test', EnableDns64: { Value: true } }]);
    expect(provider.canonicalizeDesiredProperties(type, desired)).toEqual({ ...props, EnableDns64: true });
  });
});


describe('subnet in-place classification (#5632)', () => {
  it.each(['EnableDns64', 'Ipv6CidrBlock'])('classifies %s as updateable, including removal', (property) => {
    const rules = new ReplacementRulesRegistry();
    expect(rules.isClassified(type, property)).toBe(true);
    expect(rules.requiresReplacement(type, property, 'old', 'new')).toBe(false);
    expect(rules.requiresReplacement(type, property, 'old', undefined)).toBe(false);
  });
});
