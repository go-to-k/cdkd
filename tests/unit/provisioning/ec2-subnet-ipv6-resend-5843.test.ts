import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { DescribeSubnetsCommand, ModifySubnetAttributeCommand } from '@aws-sdk/client-ec2';

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

/**
 * go-to-k/cdkd#5843: the subnet's template declares no Ipv6CidrBlock; its
 * block comes from an AWS::EC2::SubnetCidrBlock, which depends on the subnet
 * and so attaches only AFTER the subnet update. A declared true skipped while
 * the block was missing must reach AWS on a later deploy.
 */
const type = 'AWS::EC2::Subnet';
const base = { VpcId: 'vpc-test', CidrBlock: '10.0.0.0/24' };
const BLOCK = '2600:1f18:1::/64';
const dnsOn = { HostnameType: 'resource-name', EnableResourceNameDnsAAAARecord: true };
const template = {
  ...base,
  AssignIpv6AddressOnCreation: true,
  EnableDns64: true,
  PrivateDnsNameOptionsOnLaunch: dnsOn,
};

describe('subnet IPv6 attributes re-sent once a block arrives (#5843)', () => {
  let provider: EC2Provider;
  let live: {
    ipv6: string | undefined;
    AssignIpv6AddressOnCreation: boolean;
    EnableDns64: boolean;
    dns: Record<string, unknown>;
  };

  beforeEach(() => {
    mockSend.mockReset();
    logger.warn.mockClear();
    logger.debug.mockClear();
    live = {
      ipv6: undefined,
      AssignIpv6AddressOnCreation: false,
      EnableDns64: false,
      dns: { HostnameType: 'ip-name', EnableResourceNameDnsAAAARecord: false },
    };
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof ModifySubnetAttributeCommand) {
        const input = command.input;
        // Measured (us-east-1): EC2 refuses each of the three on without a block.
        const on =
          input.AssignIpv6AddressOnCreation?.Value === true ||
          input.EnableDns64?.Value === true ||
          input.EnableResourceNameDnsAAAARecordOnLaunch?.Value === true;
        if (on && live.ipv6 === undefined) {
          throw Object.assign(new Error('unless the subnet has an IPv6 CIDR block associated with it'), {
            name: 'InvalidParameterValue',
          });
        }
        if (input.AssignIpv6AddressOnCreation) {
          live.AssignIpv6AddressOnCreation = input.AssignIpv6AddressOnCreation.Value!;
        }
        if (input.EnableDns64) live.EnableDns64 = input.EnableDns64.Value!;
        if (input.PrivateDnsHostnameTypeOnLaunch) live.dns['HostnameType'] = input.PrivateDnsHostnameTypeOnLaunch;
        if (input.EnableResourceNameDnsAAAARecordOnLaunch) {
          live.dns['EnableResourceNameDnsAAAARecord'] = input.EnableResourceNameDnsAAAARecordOnLaunch.Value;
        }
        return {};
      }
      if (command instanceof DescribeSubnetsCommand) {
        return {
          Subnets: [
            {
              SubnetId: 'subnet-test',
              AssignIpv6AddressOnCreation: live.AssignIpv6AddressOnCreation,
              EnableDns64: live.EnableDns64,
              PrivateDnsNameOptionsOnLaunch: { ...live.dns },
              Ipv6CidrBlockAssociationSet: live.ipv6
                ? [{ AssociationId: 'assoc-1', Ipv6CidrBlock: live.ipv6, Ipv6CidrBlockState: { State: 'associated' } }]
                : [],
            },
          ],
        };
      }
      return {};
    });
    provider = new EC2Provider();
  });

  const onWrites = () =>
    mockSend.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof ModifySubnetAttributeCommand)
      .map((command) => (command as ModifySubnetAttributeCommand).input)
      .filter(
        (input) =>
          input.AssignIpv6AddressOnCreation?.Value === true ||
          input.EnableDns64?.Value === true ||
          input.EnableResourceNameDnsAAAARecordOnLaunch?.Value === true
      );
  const warnings = () => logger.warn.mock.calls.flat().join('\n');

  it('declared true, no block: warns, writes nothing, and records the false AWS holds', async () => {
    const result = await provider.update('Subnet', 'subnet-test', type, template, base);

    expect(onWrites()).toEqual([]);
    for (const name of [
      'AssignIpv6AddressOnCreation is true',
      'EnableDns64 is true',
      'EnableResourceNameDnsAAAARecord is true',
    ]) {
      expect(warnings()).toContain(`${name} but the subnet has no IPv6 block`);
    }
    expect(result.effectiveProperties).toEqual({
      ...base,
      AssignIpv6AddressOnCreation: false,
      EnableDns64: false,
      PrivateDnsNameOptionsOnLaunch: { ...dnsOn, EnableResourceNameDnsAAAARecord: false },
    });
  });

  it('the next deploy after a SubnetCidrBlock attached sends all three on', async () => {
    // Deploy 1: the subnet update runs before the SubnetCidrBlock attaches.
    const first = await provider.update('Subnet', 'subnet-test', type, template, base);
    expect(onWrites()).toEqual([]);
    // The SubnetCidrBlock attaches; deploy 2 re-deploys the same template
    // against what deploy 1 recorded.
    live.ipv6 = BLOCK;
    mockSend.mockClear();
    logger.warn.mockClear();
    logger.debug.mockClear();
    const second = await provider.update(
      'Subnet',
      'subnet-test',
      type,
      template,
      first.effectiveProperties!
    );

    expect(live).toMatchObject({ AssignIpv6AddressOnCreation: true, EnableDns64: true });
    expect(live.dns['EnableResourceNameDnsAAAARecord']).toBe(true);
    // One write each: the AAAA record changed against the record, so the
    // live-off re-send must not write it a second time.
    expect(onWrites()).toEqual([
      { SubnetId: 'subnet-test', EnableDns64: { Value: true } },
      { SubnetId: 'subnet-test', AssignIpv6AddressOnCreation: { Value: true } },
      { SubnetId: 'subnet-test', EnableResourceNameDnsAAAARecordOnLaunch: { Value: true } },
    ]);
    expect(warnings()).not.toContain('has no IPv6 block');
    expect(second.effectiveProperties).toBeUndefined();
    // These went on from the record diff, not the live-off re-send.
    expect(logger.debug.mock.calls.flat().join('\n')).not.toContain('the live subnet holds it off');
  });

  it.each([
    ['AssignIpv6AddressOnCreation', 'yes', true],
    ['EnableDns64', 'yes', true],
    ['PrivateDnsNameOptionsOnLaunch', { EnableResourceNameDnsAAAARecord: 'yes' }, { EnableResourceNameDnsAAAARecord: true }],
  ])('a state replay keeping the recorded %s for a malformed one sends nothing, even with it live off', async (key, malformed, recordedValue) => {
    live.ipv6 = BLOCK;
    await provider.update(
      'Subnet',
      'subnet-test',
      type,
      { ...base, [key]: malformed },
      { ...base, [key]: recordedValue },
      { replayingState: true }
    );
    expect(onWrites()).toEqual([]);
  });

  it('declared true, record true, live off, block now present: re-sends each one (a record from before the fix)', async () => {
    live.ipv6 = BLOCK;
    const result = await provider.update('Subnet', 'subnet-test', type, { ...template, Tags: [{ Key: 'k', Value: 'v' }] }, template);

    expect(onWrites()).toEqual([
      { SubnetId: 'subnet-test', EnableDns64: { Value: true } },
      { SubnetId: 'subnet-test', AssignIpv6AddressOnCreation: { Value: true } },
      { SubnetId: 'subnet-test', EnableResourceNameDnsAAAARecordOnLaunch: { Value: true } },
    ]);
    expect(live).toMatchObject({ AssignIpv6AddressOnCreation: true, EnableDns64: true });
    expect(warnings()).not.toContain('has no IPv6 block');
    expect(result.effectiveProperties).toBeUndefined();
    // A live-off re-send (also an out-of-band disable) is logged, naming each.
    const debug = logger.debug.mock.calls.flat().join('\n');
    for (const member of ['EnableDns64', 'AssignIpv6AddressOnCreation', 'PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord']) {
      expect(debug).toContain(`Subnet Subnet: ${member} is declared true but the live subnet holds it off`);
    }
  });

  it('sends nothing when the live subnet already holds each declared true', async () => {
    live = {
      ipv6: BLOCK,
      AssignIpv6AddressOnCreation: true,
      EnableDns64: true,
      dns: { ...dnsOn },
    };
    await provider.update('Subnet', 'subnet-test', type, { ...template, Tags: [{ Key: 'k', Value: 'v' }] }, template);
    expect(onWrites()).toEqual([]);
  });

  it('reads nothing live when none of the three is declared true', async () => {
    await provider.update('Subnet', 'subnet-test', type, { ...base, Tags: [{ Key: 'k', Value: 'v' }] }, base);
    expect(mockSend.mock.calls.some(([command]) => command instanceof DescribeSubnetsCommand)).toBe(false);
  });
});
