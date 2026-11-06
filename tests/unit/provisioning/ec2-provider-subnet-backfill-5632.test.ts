import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AssociateSubnetCidrBlockCommand,
  CreateSubnetCommand,
  DescribeSubnetsCommand,
  DisassociateSubnetCidrBlockCommand,
  ModifySubnetAttributeCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  logger.child.mockReturnValue(logger);
  return { getLogger: () => logger };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#5632: `AssignIpv6AddressOnCreation`, `Ipv6Native` and
 * `PrivateDnsNameOptionsOnLaunch` on the SDK route.
 */
const type = 'AWS::EC2::Subnet';
const base = { VpcId: 'vpc-test', CidrBlock: '10.0.0.0/24' };
const BLOCK = '2600:1f18:1::/64';

interface Live {
  AssignIpv6AddressOnCreation: boolean;
  Ipv6Native: boolean;
  PrivateDnsNameOptionsOnLaunch: Record<string, unknown>;
  ipv6?: string;
  EnableDns64?: boolean;
}

describe('subnet IPv6 / private DNS backfill (#5632)', () => {
  let provider: EC2Provider;
  let live: Live;

  beforeEach(() => {
    mockSend.mockReset();
    logger.warn.mockClear();
    live = {
      AssignIpv6AddressOnCreation: false,
      Ipv6Native: false,
      PrivateDnsNameOptionsOnLaunch: {
        HostnameType: 'ip-name',
        EnableResourceNameDnsARecord: false,
        EnableResourceNameDnsAAAARecord: false,
      },
      ipv6: BLOCK,
      EnableDns64: false,
    };
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateSubnetCommand) {
        const ipv6 = command.input.Ipv6CidrBlock;
        live.ipv6 = ipv6;
        live.Ipv6Native = command.input.Ipv6Native === true;
        // An IPv6-only subnet starts with auto-assign on.
        live.AssignIpv6AddressOnCreation = live.Ipv6Native;
        return {
          Subnet: {
            SubnetId: 'subnet-test',
            AvailabilityZone: 'us-east-1a',
            AssignIpv6AddressOnCreation: live.AssignIpv6AddressOnCreation,
            ...(ipv6 && {
              Ipv6CidrBlockAssociationSet: [
                { AssociationId: 'assoc-1', Ipv6CidrBlock: ipv6, Ipv6CidrBlockState: { State: 'associating' } },
              ],
            }),
          },
        };
      }
      if (command instanceof ModifySubnetAttributeCommand) {
        const input = command.input;
        // Measured: one attribute per call.
        if (Object.keys(input).filter((key) => key !== 'SubnetId').length !== 1) {
          throw Object.assign(new Error('Only one subnet attribute can be modified at a time'), {
            name: 'InvalidParameterCombination',
          });
        }
        if (input.EnableDns64) live.EnableDns64 = input.EnableDns64.Value!;
        if (input.AssignIpv6AddressOnCreation) {
          live.AssignIpv6AddressOnCreation = input.AssignIpv6AddressOnCreation.Value!;
        }
        const dns = live.PrivateDnsNameOptionsOnLaunch;
        if (input.PrivateDnsHostnameTypeOnLaunch) dns['HostnameType'] = input.PrivateDnsHostnameTypeOnLaunch;
        if (input.EnableResourceNameDnsARecordOnLaunch) {
          dns['EnableResourceNameDnsARecord'] = input.EnableResourceNameDnsARecordOnLaunch.Value;
        }
        if (input.EnableResourceNameDnsAAAARecordOnLaunch) {
          dns['EnableResourceNameDnsAAAARecord'] = input.EnableResourceNameDnsAAAARecordOnLaunch.Value;
        }
        return {};
      }
      if (command instanceof DisassociateSubnetCidrBlockCommand) {
        // Measured: EC2 refuses the detach while auto-assign or the AAAA
        // record is on — the state the ModifySubnetAttribute calls left.
        if (live.EnableDns64) {
          throw Object.assign(new Error('may not be disassociated, because its subnet has enable-dns64 set to true'), {
            name: 'InvalidCidrBlock.InUse',
          });
        }
        if (live.AssignIpv6AddressOnCreation) {
          throw Object.assign(new Error('may not be disassociated, because its subnet has assign-ipv6-address-on-creation set to true'), {
            name: 'InvalidCidrBlock.InUse',
          });
        }
        if (live.PrivateDnsNameOptionsOnLaunch['EnableResourceNameDnsAAAARecord'] === true) {
          throw Object.assign(new Error('may not be disassociated, because its subnet has enable-resource-name-dns-aaaa-record-on-launch set to true'), {
            name: 'InvalidCidrBlock.InUse',
          });
        }
        live.ipv6 = undefined;
        return {};
      }
      if (command instanceof AssociateSubnetCidrBlockCommand) {
        live.ipv6 = command.input.Ipv6CidrBlock;
        return { Ipv6CidrBlockAssociation: { AssociationId: live.ipv6 === BLOCK ? 'assoc-1' : 'assoc-2' } };
      }
      if (command instanceof DescribeSubnetsCommand) {
        return {
          Subnets: [
            {
              SubnetId: 'subnet-test',
              VpcId: 'vpc-test',
              CidrBlock: base.CidrBlock,
              EnableDns64: live.EnableDns64 ?? false,
              AssignIpv6AddressOnCreation: live.AssignIpv6AddressOnCreation,
              Ipv6Native: live.Ipv6Native,
              PrivateDnsNameOptionsOnLaunch: { ...live.PrivateDnsNameOptionsOnLaunch },
              Ipv6CidrBlockAssociationSet: live.ipv6
                ? [
                    {
                      AssociationId: live.ipv6 === BLOCK ? 'assoc-1' : 'assoc-2',
                      Ipv6CidrBlock: live.ipv6,
                      Ipv6CidrBlockState: { State: 'associated' },
                    },
                  ]
                : [],
            },
          ],
        };
      }
      return {};
    });
    provider = new EC2Provider();
  });

  const commands = () => mockSend.mock.calls.map(([command]) => command as { input: Record<string, unknown> });
  const modifies = () =>
    commands()
      .filter((command) => command instanceof ModifySubnetAttributeCommand)
      .map((command) => command.input);
  const indexOf = (predicate: (command: unknown) => boolean) => commands().findIndex(predicate);

  describe('create', () => {
    it('sends Ipv6Native to CreateSubnet and omits the absent IPv4 block', async () => {
      await provider.create('Subnet', type, { VpcId: 'vpc-test', Ipv6Native: true, Ipv6CidrBlock: BLOCK });

      const create = commands().find((command) => command instanceof CreateSubnetCommand)!;
      expect(create.input).toMatchObject({ VpcId: 'vpc-test', Ipv6Native: true, Ipv6CidrBlock: BLOCK });
      expect(create.input['CidrBlock']).toBeUndefined();
    });

    it('accepts the CFn string spelling of Ipv6Native', async () => {
      await provider.create('Subnet', type, { VpcId: 'vpc-test', Ipv6Native: 'true', Ipv6CidrBlock: BLOCK });
      const create = commands().find((command) => command instanceof CreateSubnetCommand)!;
      expect(create.input['Ipv6Native']).toBe(true);
    });

    it('still requires CidrBlock unless Ipv6Native is true', async () => {
      await expect(
        provider.create('Subnet', type, { VpcId: 'vpc-test', Ipv6Native: false, Ipv6CidrBlock: BLOCK })
      ).rejects.toThrow(/CidrBlock may be omitted only when Ipv6Native is true/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a malformed Ipv6Native before any call', async () => {
      await expect(
        provider.create('Subnet', type, { ...base, Ipv6Native: 'yes' })
      ).rejects.toThrow(/Subnet\.Ipv6Native must be a boolean/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('enables AssignIpv6AddressOnCreation after the IPv6 block is associated', async () => {
      await provider.create('Subnet', type, { ...base, Ipv6CidrBlock: BLOCK, AssignIpv6AddressOnCreation: true });

      expect(modifies()).toEqual([{ SubnetId: 'subnet-test', AssignIpv6AddressOnCreation: { Value: true } }]);
      const create = indexOf((command) => command instanceof CreateSubnetCommand);
      const firstRead = indexOf((command) => command instanceof DescribeSubnetsCommand);
      const modify = indexOf((command) => command instanceof ModifySubnetAttributeCommand);
      expect(firstRead).toBeGreaterThan(create);
      expect(modify).toBeGreaterThan(firstRead);
      expect(live.AssignIpv6AddressOnCreation).toBe(true);
    });

    it('turns off the auto-assign an IPv6-only subnet starts with when the template says false', async () => {
      await provider.create('Subnet', type, {
        VpcId: 'vpc-test',
        Ipv6Native: true,
        Ipv6CidrBlock: BLOCK,
        AssignIpv6AddressOnCreation: false,
      });
      expect(modifies()).toEqual([{ SubnetId: 'subnet-test', AssignIpv6AddressOnCreation: { Value: false } }]);
    });

    it('does not assume an IPv6-only subnet starts with auto-assign off when CreateSubnet omits it', async () => {
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (command: unknown) => {
        const out = await inner(command);
        if (command instanceof CreateSubnetCommand) delete out.Subnet.AssignIpv6AddressOnCreation;
        return out;
      });
      await provider.create('Subnet', type, {
        VpcId: 'vpc-test',
        Ipv6Native: true,
        Ipv6CidrBlock: BLOCK,
        AssignIpv6AddressOnCreation: false,
      });
      expect(modifies()).toEqual([{ SubnetId: 'subnet-test', AssignIpv6AddressOnCreation: { Value: false } }]);
    });

    it('sends nothing when an IPv6-only subnet already holds the declared true', async () => {
      await provider.create('Subnet', type, {
        VpcId: 'vpc-test',
        Ipv6Native: true,
        Ipv6CidrBlock: BLOCK,
        AssignIpv6AddressOnCreation: true,
      });
      expect(modifies()).toEqual([]);
    });

    it('sends no write for AssignIpv6AddressOnCreation false, the AWS default', async () => {
      await provider.create('Subnet', type, { ...base, AssignIpv6AddressOnCreation: false });
      expect(modifies()).toEqual([]);
    });

    it('writes each declared PrivateDnsNameOptionsOnLaunch member, one per call', async () => {
      await provider.create('Subnet', type, {
        ...base,
        PrivateDnsNameOptionsOnLaunch: { HostnameType: 'resource-name', EnableResourceNameDnsAAAARecord: 'true' },
      });

      expect(modifies()).toEqual([
        { SubnetId: 'subnet-test', PrivateDnsHostnameTypeOnLaunch: 'resource-name' },
        { SubnetId: 'subnet-test', EnableResourceNameDnsAAAARecordOnLaunch: { Value: true } },
      ]);
    });

    it.each([
      ['a non-object block', 'resource-name', /PrivateDnsNameOptionsOnLaunch must be an object/],
      ['a malformed boolean member', { EnableResourceNameDnsARecord: 'yes' }, /EnableResourceNameDnsARecord must be a boolean/],
      ['a non-string HostnameType', { HostnameType: 1 }, /HostnameType must be/],
    ])('refuses %s before any call', async (_label, block, message) => {
      await expect(
        provider.create('Subnet', type, { ...base, PrivateDnsNameOptionsOnLaunch: block })
      ).rejects.toThrow(message);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const previous = {
      ...base,
      Ipv6CidrBlock: BLOCK,
      AssignIpv6AddressOnCreation: true,
      PrivateDnsNameOptionsOnLaunch: { HostnameType: 'resource-name', EnableResourceNameDnsARecord: true },
    };

    it('sends nothing for an unchanged record (the drift --revert round trip)', async () => {
      await provider.update('Subnet', 'subnet-test', type, previous, previous);
      expect(modifies()).toEqual([]);
    });

    it('leaves the live values alone when both properties are removed', async () => {
      const { AssignIpv6AddressOnCreation: _a, PrivateDnsNameOptionsOnLaunch: _p, ...removed } = previous;
      await provider.update('Subnet', 'subnet-test', type, removed, previous);
      expect(modifies()).toEqual([]);
    });

    it('writes only the changed member, and none for a removed member', async () => {
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...previous, PrivateDnsNameOptionsOnLaunch: { HostnameType: 'ip-name' } },
        previous
      );
      expect(modifies()).toEqual([{ SubnetId: 'subnet-test', PrivateDnsHostnameTypeOnLaunch: 'ip-name' }]);
    });

    it('disables AssignIpv6AddressOnCreation before detaching the IPv6 block', async () => {
      const { Ipv6CidrBlock: _b, ...withoutBlock } = previous;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...withoutBlock, AssignIpv6AddressOnCreation: false },
        previous
      );
      const modify = indexOf((command) => command instanceof ModifySubnetAttributeCommand);
      const detach = indexOf((command) => command instanceof DisassociateSubnetCidrBlockCommand);
      expect(modifies()).toEqual([{ SubnetId: 'subnet-test', AssignIpv6AddressOnCreation: { Value: false } }]);
      expect(detach).toBeGreaterThan(modify);
    });

    it('disables a private DNS record before detaching the IPv6 block, and sets the rest after', async () => {
      const { Ipv6CidrBlock: _b, ...withoutBlock } = previous;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        {
          ...withoutBlock,
          PrivateDnsNameOptionsOnLaunch: { HostnameType: 'ip-name', EnableResourceNameDnsARecord: false },
        },
        previous
      );
      const calls = commands();
      const detach = calls.findIndex((command) => command instanceof DisassociateSubnetCidrBlockCommand);
      const disableA = calls.findIndex(
        (command) =>
          command instanceof ModifySubnetAttributeCommand &&
          command.input['EnableResourceNameDnsARecordOnLaunch'] !== undefined
      );
      const hostname = calls.findIndex(
        (command) =>
          command instanceof ModifySubnetAttributeCommand &&
          command.input['PrivateDnsHostnameTypeOnLaunch'] !== undefined
      );
      expect(detach).toBeGreaterThan(-1);
      expect(disableA).toBeGreaterThan(-1);
      expect(disableA).toBeLessThan(detach);
      expect(hostname).toBeGreaterThan(detach);
    });

    it('enables AssignIpv6AddressOnCreation after attaching the IPv6 block', async () => {
      const { Ipv6CidrBlock: _b, ...withoutBlock } = previous;
      const before = { ...withoutBlock, AssignIpv6AddressOnCreation: false };
      live.ipv6 = undefined;
      live.AssignIpv6AddressOnCreation = false;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...before, Ipv6CidrBlock: '2600:1f18:1:1::/64', AssignIpv6AddressOnCreation: true },
        before
      );
      const attach = indexOf((command) => command instanceof AssociateSubnetCidrBlockCommand);
      const modify = indexOf((command) => command instanceof ModifySubnetAttributeCommand);
      expect(attach).toBeGreaterThan(-1);
      expect(modify).toBeGreaterThan(attach);
      expect(modifies()).toEqual([{ SubnetId: 'subnet-test', AssignIpv6AddressOnCreation: { Value: true } }]);
    });

    const assignWrites = () =>
      modifies()
        .filter((input) => input['AssignIpv6AddressOnCreation'] !== undefined)
        .map((input) => (input['AssignIpv6AddressOnCreation'] as { Value: boolean }).Value);

    it('turns auto-assign off for a block change and back on after the new block attaches', async () => {
      live.AssignIpv6AddressOnCreation = true;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...previous, Ipv6CidrBlock: '2600:1f18:1:1::/64' },
        previous
      );
      const calls = commands();
      const off = calls.findIndex(
        (command) =>
          command instanceof ModifySubnetAttributeCommand &&
          (command.input['AssignIpv6AddressOnCreation'] as { Value: boolean } | undefined)?.Value === false
      );
      const detach = calls.findIndex((command) => command instanceof DisassociateSubnetCidrBlockCommand);
      const attach = calls.findIndex((command) => command instanceof AssociateSubnetCidrBlockCommand);
      expect(assignWrites()).toEqual([false, true]);
      expect(off).toBeLessThan(detach);
      expect(attach).toBeGreaterThan(detach);
      expect(live).toMatchObject({ AssignIpv6AddressOnCreation: true, ipv6: '2600:1f18:1:1::/64' });
    });

    it('restores an undeclared auto-assign that was on after a block change', async () => {
      live.AssignIpv6AddressOnCreation = true;
      const { AssignIpv6AddressOnCreation: _a, ...undeclared } = previous;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...undeclared, Ipv6CidrBlock: '2600:1f18:1:1::/64' },
        undeclared
      );
      expect(assignWrites()).toEqual([false, true]);
    });

    it('leaves auto-assign off when the block goes away (a rollback replay without either key)', async () => {
      live.AssignIpv6AddressOnCreation = true;
      const { AssignIpv6AddressOnCreation: _a, Ipv6CidrBlock: _b, ...replayed } = previous;
      await provider.update('Subnet', 'subnet-test', type, replayed, previous, { replayingState: true });
      expect(assignWrites()).toEqual([false]);
      expect(live).toMatchObject({ AssignIpv6AddressOnCreation: false, ipv6: undefined });
    });

    it('restores an undeclared auto-assign an interrupted earlier attempt left off', async () => {
      // Attempt 1 turned auto-assign off and detached, then was interrupted.
      live.AssignIpv6AddressOnCreation = false;
      live.ipv6 = undefined;
      const { AssignIpv6AddressOnCreation: _a, ...undeclared } = previous;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...undeclared, Ipv6CidrBlock: '2600:1f18:1:1::/64' },
        undeclared,
        { unsettledProperties: new Set(['AssignIpv6AddressOnCreation', 'Ipv6CidrBlock']) }
      );
      const attach = indexOf((command) => command instanceof AssociateSubnetCidrBlockCommand);
      const on = indexOf(
        (command) =>
          command instanceof ModifySubnetAttributeCommand &&
          (command as ModifySubnetAttributeCommand).input.AssignIpv6AddressOnCreation?.Value === true
      );
      expect(assignWrites()).toEqual([true]);
      expect(on).toBeGreaterThan(attach);
    });

    it('keeps an undeclared auto-assign off after an interrupted attempt when the record said false', async () => {
      live.AssignIpv6AddressOnCreation = false;
      const { AssignIpv6AddressOnCreation: _a, ...undeclared } = previous;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        undeclared,
        { ...undeclared, AssignIpv6AddressOnCreation: false },
        { unsettledProperties: new Set(['AssignIpv6AddressOnCreation']) }
      );
      expect(assignWrites()).toEqual([]);
    });

    it('warns when the block is removed while the template still declares auto-assign true', async () => {
      live.AssignIpv6AddressOnCreation = true;
      const { Ipv6CidrBlock: _b, ...withoutBlock } = previous;
      await provider.update('Subnet', 'subnet-test', type, withoutBlock, previous);
      expect(assignWrites()).toEqual([false]);
      expect(logger.warn.mock.calls.flat().join('\n')).toContain('has no IPv6 block');
    });

    it.each([
      ['a declared change to true', { AssignIpv6AddressOnCreation: false }, undefined],
      ['an unsettled re-send', { AssignIpv6AddressOnCreation: true }, new Set(['AssignIpv6AddressOnCreation'])],
    ])('skips the true write to a subnet with no IPv6 block on %s, and warns', async (_label, before, unsettled) => {
      live.ipv6 = undefined;
      live.AssignIpv6AddressOnCreation = false;
      const { Ipv6CidrBlock: _b, ...withoutBlock } = previous;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...withoutBlock, AssignIpv6AddressOnCreation: true },
        { ...withoutBlock, ...before },
        unsettled ? { unsettledProperties: unsettled } : undefined
      );
      expect(assignWrites()).toEqual([]);
      expect(logger.warn.mock.calls.flat().join('\n')).toContain('has no IPv6 block');
    });

    it('moves the block with auto-assign and the AAAA record on (the fixture move-dns-block phase)', async () => {
      const dns = { HostnameType: 'resource-name', EnableResourceNameDnsARecord: false, EnableResourceNameDnsAAAARecord: true };
      live.AssignIpv6AddressOnCreation = true;
      live.PrivateDnsNameOptionsOnLaunch = { ...dns };
      const before = { ...base, Ipv6CidrBlock: BLOCK, AssignIpv6AddressOnCreation: true, PrivateDnsNameOptionsOnLaunch: dns };
      await provider.update('Subnet', 'subnet-test', type, { ...before, Ipv6CidrBlock: '2600:1f18:1:4::/64' }, before);
      expect(live).toMatchObject({
        ipv6: '2600:1f18:1:4::/64',
        AssignIpv6AddressOnCreation: true,
        PrivateDnsNameOptionsOnLaunch: dns,
      });
      const aaaaWrites = modifies()
        .filter((input) => input['EnableResourceNameDnsAAAARecordOnLaunch'] !== undefined)
        .map((input) => (input['EnableResourceNameDnsAAAARecordOnLaunch'] as { Value: boolean }).Value);
      expect(aaaaWrites).toEqual([false, true]);
      expect(assignWrites()).toEqual([false, true]);
    });

    it('leaves the AAAA record off, with a warning, when the block is removed', async () => {
      const dns = { HostnameType: 'resource-name', EnableResourceNameDnsAAAARecord: true };
      live.PrivateDnsNameOptionsOnLaunch = { ...live.PrivateDnsNameOptionsOnLaunch, ...dns };
      live.AssignIpv6AddressOnCreation = false;
      const before = { ...base, Ipv6CidrBlock: BLOCK, PrivateDnsNameOptionsOnLaunch: dns };
      const { Ipv6CidrBlock: _b, ...after } = before;
      await provider.update('Subnet', 'subnet-test', type, after, before, {
        unsettledProperties: new Set(['PrivateDnsNameOptionsOnLaunch']),
      });
      expect(live.ipv6).toBeUndefined();
      expect(live.PrivateDnsNameOptionsOnLaunch['EnableResourceNameDnsAAAARecord']).toBe(false);
      expect(logger.warn.mock.calls.flat().join('\n')).toContain('EnableResourceNameDnsAAAARecord is true but the subnet has no IPv6 block');
    });

    it('moves the block with DNS64 on: off for the detach, back on after', async () => {
      live.EnableDns64 = true;
      live.AssignIpv6AddressOnCreation = true;
      const before = { ...previous, EnableDns64: true };
      await provider.update('Subnet', 'subnet-test', type, { ...before, Ipv6CidrBlock: '2600:1f18:1:5::/64' }, before);
      const dnsWrites = modifies()
        .filter((input) => input['EnableDns64'] !== undefined)
        .map((input) => (input['EnableDns64'] as { Value: boolean }).Value);
      expect(dnsWrites).toEqual([false, true]);
      expect(live).toMatchObject({ ipv6: '2600:1f18:1:5::/64', EnableDns64: true, AssignIpv6AddressOnCreation: true });
    });

    it('leaves DNS64 off when the block goes away, and restores an undeclared one after an interrupted attempt', async () => {
      live.EnableDns64 = true;
      const { Ipv6CidrBlock: _b, ...withoutBlock } = previous;
      await provider.update('Subnet', 'subnet-test', type, withoutBlock, previous);
      expect(live).toMatchObject({ ipv6: undefined, EnableDns64: false });
      mockSend.mockClear();
      // Interrupted after the clear and the detach: the retry attaches and restores.
      await provider.update('Subnet', 'subnet-test', type, previous, previous, {
        unsettledProperties: new Set(['EnableDns64', 'Ipv6CidrBlock']),
      });
      expect(live).toMatchObject({ ipv6: BLOCK, EnableDns64: true });
    });

    it.each([
      ['the block removed while DNS64 stays declared true', { EnableDns64: true }, undefined],
      ['an unsettled re-send with no block', { EnableDns64: false }, new Set(['EnableDns64'])],
    ])('never writes DNS64 on to a subnet with no IPv6 block: %s, and warns', async (_label, before, unsettled) => {
      const { Ipv6CidrBlock: _b, ...withoutBlock } = previous;
      const hadBlock = unsettled === undefined;
      live.EnableDns64 = hadBlock;
      if (!hadBlock) live.ipv6 = undefined;
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...withoutBlock, EnableDns64: true },
        hadBlock ? { ...previous, ...before } : { ...withoutBlock, ...before },
        unsettled ? { unsettledProperties: unsettled } : undefined
      );
      const dnsOn = modifies().filter(
        (input) => (input['EnableDns64'] as { Value: boolean } | undefined)?.Value === true
      );
      expect(dnsOn).toEqual([]);
      expect(live.EnableDns64).toBe(false);
      expect(logger.warn.mock.calls.flat().join('\n')).toContain('EnableDns64 is true but the subnet has no IPv6 block');
    });

    it('writes auto-assign and DNS64 on when the block comes from outside the template', async () => {
      // An AWS::EC2::SubnetCidrBlock attached the live block; the template has no Ipv6CidrBlock.
      const v4 = { ...base, AssignIpv6AddressOnCreation: false, EnableDns64: false };
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...base, AssignIpv6AddressOnCreation: true, EnableDns64: true },
        v4
      );
      expect(live).toMatchObject({ ipv6: BLOCK, AssignIpv6AddressOnCreation: true, EnableDns64: true });
      expect(logger.warn.mock.calls.flat().join('\n')).not.toContain('has no IPv6 block');
    });

    it('refuses an IPv6-native subnet block change before any call', async () => {
      const native = { VpcId: 'vpc-test', Ipv6Native: true, Ipv6CidrBlock: BLOCK };
      await expect(
        provider.update('Subnet', 'subnet-test', type, { ...native, Ipv6CidrBlock: '2600:1f18:1:6::/64' }, native)
      ).rejects.toThrow(/IPv6-only \(Ipv6Native\) subnet cannot change its Ipv6CidrBlock in place/);
      expect(modifies()).toEqual([]);
      expect(commands().some((command) => command instanceof DisassociateSubnetCidrBlockCommand)).toBe(false);
    });

    it('keeps an IPv6-native subnet block on a state replay, with a warning', async () => {
      const native = { VpcId: 'vpc-test', Ipv6Native: true, Ipv6CidrBlock: BLOCK };
      const result = await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...native, Ipv6CidrBlock: '2600:1f18:1:6::/64' },
        native,
        { replayingState: true }
      );
      expect(commands().some((command) => command instanceof DisassociateSubnetCidrBlockCommand)).toBe(false);
      expect(result.effectiveProperties?.['Ipv6CidrBlock']).toBe(BLOCK);
      expect(logger.warn.mock.calls.flat().join('\n')).toContain('cannot change its Ipv6CidrBlock in place');
    });

    it('warns and skips an AAAA record turned on for an IPv4-only subnet', async () => {
      live.ipv6 = undefined;
      const v4 = { ...base, PrivateDnsNameOptionsOnLaunch: { EnableResourceNameDnsAAAARecord: false } };
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...base, PrivateDnsNameOptionsOnLaunch: { EnableResourceNameDnsAAAARecord: true } },
        v4
      );
      expect(modifies()).toEqual([]);
      expect(logger.warn.mock.calls.flat().join('\n')).toContain('EnableResourceNameDnsAAAARecord is true but the subnet has no IPv6 block');
    });

    it('restores the old block and auto-assign when the new block fails to attach', async () => {
      live.AssignIpv6AddressOnCreation = true;
      const inner = mockSend.getMockImplementation()!;
      let attaches = 0;
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof AssociateSubnetCidrBlockCommand && attaches++ === 0) {
          throw Object.assign(new Error('bad block'), { name: 'InvalidSubnet.Range' });
        }
        return inner(command);
      });
      await expect(
        provider.update('Subnet', 'subnet-test', type, { ...previous, Ipv6CidrBlock: '2600:1f18:1:1::/64' }, previous)
      ).rejects.toThrow();
      expect(live).toMatchObject({ AssignIpv6AddressOnCreation: true, ipv6: BLOCK });
    });

    it('re-sends declared values a failed earlier attempt left unsettled', async () => {
      const marks: string[] = [];
      await provider.update('Subnet', 'subnet-test', type, previous, previous, {
        unsettledProperties: new Set(['AssignIpv6AddressOnCreation', 'PrivateDnsNameOptionsOnLaunch']),
        markUnsettled: (name) => marks.push(name),
      });
      expect(modifies()).toEqual([
        { SubnetId: 'subnet-test', AssignIpv6AddressOnCreation: { Value: true } },
        { SubnetId: 'subnet-test', PrivateDnsHostnameTypeOnLaunch: 'resource-name' },
        { SubnetId: 'subnet-test', EnableResourceNameDnsARecordOnLaunch: { Value: true } },
      ]);
      expect(new Set(marks)).toEqual(new Set(['AssignIpv6AddressOnCreation', 'PrivateDnsNameOptionsOnLaunch']));
    });

    it('marks a property unsettled before its write', async () => {
      const marks: string[] = [];
      await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...previous, AssignIpv6AddressOnCreation: false },
        previous,
        { markUnsettled: (name) => marks.push(name) }
      );
      expect(marks).toEqual(['AssignIpv6AddressOnCreation']);
    });

    it('refuses an Ipv6Native change in place, comparing the CFn spellings as booleans', async () => {
      await expect(
        provider.update('Subnet', 'subnet-test', type, { ...base, Ipv6Native: true }, { ...base, Ipv6Native: false })
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
      await expect(
        provider.update('Subnet', 'subnet-test', type, { ...base, Ipv6Native: 'true' }, { ...base, Ipv6Native: true })
      ).resolves.toMatchObject({ wasReplaced: false });
    });

    it('keeps the recorded block on a state replay with a malformed one, without a write', async () => {
      const result = await provider.update(
        'Subnet',
        'subnet-test',
        type,
        { ...previous, PrivateDnsNameOptionsOnLaunch: 'junk' },
        previous,
        { replayingState: true }
      );
      expect(modifies()).toEqual([]);
      expect(result.effectiveProperties?.['PrivateDnsNameOptionsOnLaunch']).toEqual(
        previous.PrivateDnsNameOptionsOnLaunch
      );
      expect(logger.warn.mock.calls.flat().join('\n')).toContain('leaving PrivateDnsNameOptionsOnLaunch unchanged');
    });
  });

  it('takes the live block as the baseline when the record is malformed too, without a write', async () => {
    live.PrivateDnsNameOptionsOnLaunch['HostnameType'] = 'resource-name';
    const result = await provider.update(
      'Subnet',
      'subnet-test',
      type,
      { ...base, PrivateDnsNameOptionsOnLaunch: 'junk' },
      { ...base, PrivateDnsNameOptionsOnLaunch: 'junk' },
      { replayingState: true }
    );
    expect(modifies()).toEqual([]);
    expect(result.effectiveProperties?.['PrivateDnsNameOptionsOnLaunch']).toEqual({
      HostnameType: 'resource-name',
      EnableResourceNameDnsARecord: false,
      EnableResourceNameDnsAAAARecord: false,
    });
  });

  it('keeps a live-read AssignIpv6AddressOnCreation baseline on a replay without a write', async () => {
    live.AssignIpv6AddressOnCreation = true;
    const result = await provider.update(
      'Subnet',
      'subnet-test',
      type,
      { ...base, AssignIpv6AddressOnCreation: 'junk' },
      { ...base, AssignIpv6AddressOnCreation: 'junk' },
      { replayingState: true }
    );
    expect(modifies()).toEqual([]);
    expect(result.effectiveProperties?.['AssignIpv6AddressOnCreation']).toBe(true);
  });

  it('reads all three back for drift', async () => {
    live.AssignIpv6AddressOnCreation = true;
    live.Ipv6Native = true;
    const state = await provider.readCurrentState('subnet-test', 'Subnet', type, {});
    expect(state).toMatchObject({
      AssignIpv6AddressOnCreation: true,
      Ipv6Native: true,
      PrivateDnsNameOptionsOnLaunch: {
        HostnameType: 'ip-name',
        EnableResourceNameDnsARecord: false,
        EnableResourceNameDnsAAAARecord: false,
      },
    });
  });

  it('keys an IPv6-only subnet orphan lookup on its IPv6 block', async () => {
    const found: Array<string | undefined> = [];
    const spy = vi
      .spyOn(provider as unknown as { reportPossibleEc2Orphans: (...a: unknown[]) => Promise<void> }, 'reportPossibleEc2Orphans')
      .mockImplementation(async (...args: unknown[]) => {
        const spec = args[3] as { list: () => Promise<{ ids: string[] }> };
        found.push(...(await spec.list()).ids);
      });
    mockSend.mockImplementation(async () => ({
      Subnets: [
        {
          SubnetId: 'subnet-holder',
          Tags: [],
          Ipv6CidrBlockAssociationSet: [{ Ipv6CidrBlock: '2600:1f18:0001::/64', Ipv6CidrBlockState: { State: 'associated' } }],
        },
        {
          SubnetId: 'subnet-releasing',
          Tags: [],
          Ipv6CidrBlockAssociationSet: [{ Ipv6CidrBlock: BLOCK, Ipv6CidrBlockState: { State: 'disassociating' } }],
        },
        {
          SubnetId: 'subnet-released',
          Tags: [],
          Ipv6CidrBlockAssociationSet: [{ Ipv6CidrBlock: BLOCK, Ipv6CidrBlockState: { State: 'disassociated' } }],
        },
        { SubnetId: 'subnet-v4', Tags: [], CidrBlock: '10.0.0.0/24' },
      ],
    }));
    await (
      provider as unknown as {
        reportPossibleOrphanSubnets: (...a: unknown[]) => Promise<void>;
      }
    ).reportPossibleOrphanSubnets(
      'Subnet',
      'vpc-test',
      { cidr: BLOCK, family: 'ipv6' },
      [],
      { floorMs: 0, ceilingMs: Date.now() },
      undefined
    );
    expect(spy).toHaveBeenCalled();
    expect(found).toEqual(['subnet-holder']);
  });
});

describe('subnet boolean spellings fold on both diff sides (#5632)', () => {
  const provider = new EC2Provider();

  it('folds the CFn string spellings of each boolean the provider coerces', () => {
    expect(
      provider.canonicalizeDesiredProperties(type, {
        ...base,
        Ipv6Native: 'true',
        AssignIpv6AddressOnCreation: 'False',
        EnableDns64: 'true',
        PrivateDnsNameOptionsOnLaunch: { HostnameType: 'ip-name', EnableResourceNameDnsAAAARecord: 'true' },
      })
    ).toEqual({
      ...base,
      Ipv6Native: true,
      AssignIpv6AddressOnCreation: false,
      EnableDns64: true,
      PrivateDnsNameOptionsOnLaunch: { HostnameType: 'ip-name', EnableResourceNameDnsAAAARecord: true },
    });
  });

  it('leaves an unusable value as declared', () => {
    const bag = { ...base, Ipv6Native: 'yes', PrivateDnsNameOptionsOnLaunch: { EnableResourceNameDnsARecord: 'yes' } };
    expect(provider.canonicalizeDesiredProperties(type, bag)).toEqual(bag);
  });
});
