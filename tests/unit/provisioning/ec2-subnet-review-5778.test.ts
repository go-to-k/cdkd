import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AssociateSubnetCidrBlockCommand, CreateSubnetCommand, DeleteSubnetCommand, DescribeSubnetsCommand, DisassociateSubnetCidrBlockCommand, ModifySubnetAttributeCommand } from '@aws-sdk/client-ec2';
import type { SubnetIpv6CidrBlockAssociation } from '@aws-sdk/client-ec2';

const { send, warn } = vi.hoisted(() => ({ send: vi.fn(), warn: vi.fn() }));
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => ({ ec2: { send, config: { region: async () => 'ap-southeast-1' } } }) }));
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn().mockReturnThis() }) }));
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { makeCanonicalizePropertiesFn } from '../../../src/provisioning/canonicalize-properties.js';
import type { StackState } from '../../../src/types/state.js';
import { unsettledAfterUpdate } from '../../../src/deployment/unsettled-convergence.js';

const type = 'AWS::EC2::Subnet';
const first = '2001:db8:1234:1::/64';
const second = '2001:db8:1234:2::/64';
const props = { VpcId: 'vpc-test', CidrBlock: '10.0.0.0/24' };

describe('Subnet maintainer review (#5778)', () => {
  let provider: EC2Provider;
  let associations: SubnetIpv6CidrBlockAssociation[];
  let dns64: boolean;
  const active = (cidr: string, id = 'assoc-old'): SubnetIpv6CidrBlockAssociation => ({ AssociationId: id, Ipv6CidrBlock: cidr, Ipv6CidrBlockState: { State: 'associated' } });
  const writes = () => send.mock.calls.map(([command]) => command).filter(command => command instanceof ModifySubnetAttributeCommand || command instanceof AssociateSubnetCidrBlockCommand || command instanceof DisassociateSubnetCidrBlockCommand);

  beforeEach(() => {
    send.mockReset();
    warn.mockReset();
    associations = [active(first)];
    dns64 = true;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateSubnetCommand) {
        associations = [active(command.input.Ipv6CidrBlock!, 'assoc-created')];
        return { Subnet: { SubnetId: 'subnet-test', AvailabilityZone: 'ap-southeast-1a', Ipv6CidrBlockAssociationSet: associations } };
      }
      if (command instanceof DescribeSubnetsCommand) return { Subnets: [{ SubnetId: 'subnet-test', EnableDns64: dns64, Ipv6CidrBlockAssociationSet: associations }] };
      if (command instanceof ModifySubnetAttributeCommand) {
        if (command.input.EnableDns64?.Value === true && !associations.some(a => a.Ipv6CidrBlockState?.State === 'associated')) throw new Error('IPv6 not ready');
        dns64 = command.input.EnableDns64?.Value ?? dns64;
      }
      if (command instanceof DisassociateSubnetCidrBlockCommand) {
        associations.find(a => a.AssociationId === command.input.AssociationId)!.Ipv6CidrBlockState = { State: 'disassociated' };
      }
      if (command instanceof AssociateSubnetCidrBlockCommand) {
        const association = active(command.input.Ipv6CidrBlock!, `assoc-${associations.length}`);
        associations.push(association);
        return { Ipv6CidrBlockAssociation: association };
      }
      return {};
    });
    provider = new EC2Provider();
    vi.spyOn(provider as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockResolvedValue();
  });

  it('disables DNS64 before removing IPv6 in the same update (M1)', async () => {
    await provider.update('Subnet', 'subnet-test', type, { ...props, EnableDns64: false }, { ...props, EnableDns64: true, Ipv6CidrBlock: first });
    expect(writes().map(command => command.input)).toEqual([
      { SubnetId: 'subnet-test', EnableDns64: { Value: false } },
      { AssociationId: 'assoc-old' },
    ]);
    expect(dns64).toBe(false);
    expect(associations.some(a => a.Ipv6CidrBlockState?.State === 'associated')).toBe(false);
  });

  it('does not start IPv6 removal if disabling DNS64 fails (M1)', async () => {
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof ModifySubnetAttributeCommand) throw new Error('disable refused');
      return implementation(command);
    });
    await expect(provider.update('Subnet', 'subnet-test', type, { ...props, EnableDns64: false }, { ...props, EnableDns64: true, Ipv6CidrBlock: first })).rejects.toThrow('disable refused');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toBeInstanceOf(ModifySubnetAttributeCommand);
    expect(associations[0]!.Ipv6CidrBlockState?.State).toBe('associated');
  });

  it('enables DNS64 after adding IPv6 in the same update (M1)', async () => {
    associations = [];
    dns64 = false;
    await provider.update('Subnet', 'subnet-test', type, { ...props, EnableDns64: true, Ipv6CidrBlock: second }, { ...props, EnableDns64: false });
    expect(writes().map(command => command.input)).toEqual([
      { SubnetId: 'subnet-test', Ipv6CidrBlock: second },
      { SubnetId: 'subnet-test', EnableDns64: { Value: true } },
    ]);
    expect(dns64).toBe(true);
  });

  it.each([undefined, true])('waits for the create association before return and DNS64 wiring: %s (M2)', async value => {
    const implementation = send.getMockImplementation()!;
    let reads = 0;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeSubnetsCommand) {
        associations[0]!.Ipv6CidrBlockState = { State: ++reads >= 3 ? 'associated' : 'associating' };
      }
      const result = await implementation(command);
      if (command instanceof CreateSubnetCommand) associations[0]!.Ipv6CidrBlockState = { State: 'associating' };
      return result;
    });
    await provider.create('Subnet', type, { ...props, Ipv6CidrBlock: first, ...(value !== undefined && { EnableDns64: value }) });
    // This is the observed-state capture immediately after create returns.
    expect(await provider.readCurrentState('subnet-test', 'Subnet', type)).toMatchObject({ Ipv6CidrBlock: first });
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('cleans up if a requested create association has no response ID (M2)', async () => {
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (command: unknown) => command instanceof CreateSubnetCommand ? { Subnet: { SubnetId: 'subnet-test' } } : implementation(command));
    await expect(provider.create('Subnet', type, { ...props, Ipv6CidrBlock: first })).rejects.toThrow(/association ID/);
    expect(send.mock.calls.filter(([command]) => command instanceof DeleteSubnetCommand)).toHaveLength(1);
  });

  it('cleans up if the create association fails before DNS64 wiring (M2)', async () => {
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (command: unknown) => {
      const result = await implementation(command);
      if (command instanceof CreateSubnetCommand) associations[0]!.Ipv6CidrBlockState = { State: 'failed' };
      return result;
    });
    await expect(provider.create('Subnet', type, { ...props, Ipv6CidrBlock: first })).rejects.toThrow('IPv6 association change failed');
    expect(send.mock.calls.filter(([command]) => command instanceof DeleteSubnetCommand)).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it('bounds a create association that never settles and cleans up before DNS64 wiring (M2)', async () => {
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (command: unknown) => {
      const result = await implementation(command);
      if (command instanceof CreateSubnetCommand) associations[0]!.Ipv6CidrBlockState = { State: 'associating' };
      return result;
    });
    await expect(provider.create('Subnet', type, { ...props, Ipv6CidrBlock: first, EnableDns64: true })).rejects.toThrow('Timed out waiting');
    expect(send.mock.calls.filter(([command]) => command instanceof DescribeSubnetsCommand)).toHaveLength(30);
    expect(send.mock.calls.filter(([command]) => command instanceof DeleteSubnetCommand)).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it.each(['associating', 'disassociating'] as const)('settles an earlier %s association before choosing what to detach (m3)', async state => {
    dns64 = false;
    associations[0]!.Ipv6CidrBlockState = { State: state };
    const implementation = send.getMockImplementation()!;
    let pendingReads = 0;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeSubnetsCommand && associations[0]!.Ipv6CidrBlockState?.State === state) {
        if (++pendingReads === 3) associations[0]!.Ipv6CidrBlockState = { State: state === 'associating' ? 'associated' : 'disassociated' };
      }
      if (command instanceof DisassociateSubnetCidrBlockCommand) expect(pendingReads).toBe(3);
      return implementation(command);
    });
    await provider.update('Subnet', 'subnet-test', type, { ...props, Ipv6CidrBlock: second }, { ...props, Ipv6CidrBlock: first });
    expect(pendingReads).toBe(3);
    expect(writes().map(command => command.input)).toEqual([...(state === 'associating' ? [{ AssociationId: 'assoc-old' }] : []), { SubnetId: 'subnet-test', Ipv6CidrBlock: second }]);
  });

  it('warns on failed compensation and rethrows the original failure (m3)', async () => {
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof AssociateSubnetCidrBlockCommand) throw new Error(command.input.Ipv6CidrBlock === second ? 'replacement refused' : 'recovery refused');
      return implementation(command);
    });
    await expect(provider.update('Subnet', 'subnet-test', type, { ...props, Ipv6CidrBlock: second }, { ...props, Ipv6CidrBlock: first })).rejects.toThrow('replacement refused');
    expect(warn.mock.calls.map(([line]) => String(line)).join(' ')).toContain('IPv6 association recovery failed');
    expect(send.mock.calls.filter(([command]) => command instanceof AssociateSubnetCidrBlockCommand).map(([command]) => command.input.Ipv6CidrBlock)).toEqual([second, first]);
  });

  it('refuses an unsettled DNS64 update when the subnet cannot be found (m3)', async () => {
    send.mockImplementation(async () => ({ Subnets: [] }));
    await expect(provider.update('Subnet', 'subnet-test', type, { ...props, EnableDns64: false }, { ...props, EnableDns64: false }, { unsettledProperties: new Set(['EnableDns64']) })).rejects.toThrow('Subnet was not returned');
    expect(writes()).toEqual([]);
  });

  const expanded = '2001:db8:1234:1:0:0:0:0/64';
  it.each([false, true])('does not detach an equivalent compressed live block on retry=%s (M4)', async retry => {
    const markUnsettled = vi.fn();
    await provider.update('Subnet', 'subnet-test', type, { ...props, Ipv6CidrBlock: expanded }, { ...props, Ipv6CidrBlock: retry ? expanded : first }, { markUnsettled, ...(retry && { unsettledProperties: new Set(['Ipv6CidrBlock']) }) });
    expect(writes()).toEqual([]);
    expect(markUnsettled).not.toHaveBeenCalled();
    expect(associations[0]!.AssociationId).toBe('assoc-old');
  });

  it('sends an expanded CIDR on create exactly as declared (M4)', async () => {
    await provider.create('Subnet', type, { ...props, Ipv6CidrBlock: expanded });
    const create = send.mock.calls.find(([command]) => command instanceof CreateSubnetCommand)![0];
    expect(create.input.Ipv6CidrBlock).toBe(expanded);
  });

  it('sends a genuinely changed expanded CIDR exactly as declared (M4)', async () => {
    const changed = '2001:db8:1234:2:0:0:0:0/64';
    await provider.update('Subnet', 'subnet-test', type, { ...props, Ipv6CidrBlock: changed }, { ...props, Ipv6CidrBlock: first });
    expect(writes().map(command => command.input)).toEqual([{ AssociationId: 'assoc-old' }, { SubnetId: 'subnet-test', Ipv6CidrBlock: changed }]);
  });

  it('keeps an unchanged expanded Cloud Control record a no-op (M4)', async () => {
    const properties = { ...props, Ipv6CidrBlock: expanded };
    const state = { version: 3, region: 'ap-southeast-1', stackName: 'subnet-stack', resources: { Subnet: { physicalId: 'subnet-test', resourceType: type, properties, attributes: {}, provisionedBy: 'cc-api' } }, outputs: {}, lastModified: 0 } as unknown as StackState;
    const canonicalize = makeCanonicalizePropertiesFn({ hasProvider: (t: string) => t === type, getProvider: () => provider });
    const changes = await new DiffCalculator().calculateDiff(state, { Resources: { Subnet: { Type: type, Properties: { ...properties } } } }, undefined, canonicalize);
    expect(changes.get('Subnet')?.changeType).toBe('NO_CHANGE');
    expect(changes.get('Subnet')?.propertyChanges ?? []).toEqual([]);
  });

  it('compares spelling-only changes equally for unsettled proof without modifying either input (M4)', () => {
    const declared = { ...props, Ipv6CidrBlock: expanded };
    const observed = { ...props, Ipv6CidrBlock: first };
    expect(provider.canonicalizeUnsettledProperties(type, declared)).toEqual(provider.canonicalizeUnsettledProperties(type, observed));
    expect(declared.Ipv6CidrBlock).toBe(expanded);
    expect(observed.Ipv6CidrBlock).toBe(first);
  });

  it.each([[expanded, []], [second, ['Ipv6CidrBlock']]] as const)('proves only equivalent desired CIDRs settled: %s (M4)', async (desired, expected) => {
    expect(await unsettledAfterUpdate({ provider, logicalId: 'Subnet', physicalId: 'subnet-test', resourceType: type, recordedProperties: { ...props, Ipv6CidrBlock: expanded }, names: new Set(['Ipv6CidrBlock']), desired: { ...props, Ipv6CidrBlock: desired } })).toEqual(expected);
  });

  const driftPair = async (baseline: Record<string, unknown>, aws: Record<string, unknown>, resourceType = type) =>
    (await (provider as ResourceProvider).canonicalizeDriftPair?.(resourceType, baseline, aws)) ?? { baseline, aws };

  it('compares legacy expanded drift baselines without rewriting the AWS bag (M4)', async () => {
    const baseline = Object.freeze({ Ipv6CidrBlock: expanded });
    const aws = Object.freeze({ Ipv6CidrBlock: first });
    const pair = await driftPair(baseline, aws);
    expect(calculateResourceDrift(pair.baseline, pair.aws)).toEqual([]);
    expect(pair.aws).toBe(aws);
    expect(baseline.Ipv6CidrBlock).toBe(expanded);
  });

  it.each([
    [{ Ipv6CidrBlock: first }, { Ipv6CidrBlock: second }],
    [{ Ipv6CidrBlock: first }, { Ipv6CidrBlock: '2001:db8:1234:1::/65' }],
    [{ Ipv6CidrBlock: 'invalid-a' }, { Ipv6CidrBlock: 'invalid-b' }],
    [{}, { Ipv6CidrBlock: first }],
  ])('does not fold different, malformed or absent drift CIDRs: %j', async (baseline, aws) => {
    Object.freeze(baseline);
    Object.freeze(aws);
    const pair = await driftPair(baseline, aws);
    expect(pair.baseline).toBe(baseline);
    expect(pair.aws).toBe(aws);
  });

  it('does not apply the Subnet drift fold to another EC2 type (M4)', async () => {
    const baseline = Object.freeze({ Ipv6CidrBlock: expanded });
    const aws = Object.freeze({ Ipv6CidrBlock: first });
    const pair = await driftPair(baseline, aws, 'AWS::EC2::NetworkAclEntry');
    expect(pair.baseline).toBe(baseline);
    expect(pair.aws).toBe(aws);
  });

});
