import {
  DescribeVpcAttributeCommand,
  DescribeVpcsCommand,
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeVpnGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeAddressesCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeNetworkAclsCommand,
  type SecurityGroupRule,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound, ReadCurrentStateContext } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { VPC_ENCRYPTION_CONTROL_EXCLUSIONS } from './common.js';
import { readNatZoneAddresses, readbackNatZoneAddresses } from './nat-support.js';
import {
  type CfnSgRule,
  cfnIngressPortValue,
  descriptionKey,
  flattenIpPermissions,
  isDefaultEgressRule,
  reconcileSgRules,
  recordedSgRuleId,
  securityGroupRuleMatchesCfnIngress,
  sgProtocolKey,
  sgRuleKey,
  stackIngressRuleHolder,
  tagListsMatch,
} from './sg-support.js';
import { SUBNET_PRIVATE_DNS_MEMBERS } from './subnet-support.js';
import type { EC2Provider } from '../ec2-provider.js';

export async function readVpcCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [physicalId] }));
  const vpc = resp.Vpcs?.[0];
  if (!vpc) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (vpc.CidrBlock !== undefined) {
    result['CidrBlock'] = vpc.CidrBlock;
    // go-to-k/cdkd#5633: an IPAM allocation's netmask is the CIDR's prefix
    // length, reported only for a bag that declares it. `Ipv4IpamPoolId`
    // has no readback here (getDriftUnknownPaths).
    const prefix = /\/(\d+)$/.exec(vpc.CidrBlock)?.[1];
    if (prefix !== undefined && properties?.['Ipv4NetmaskLength'] !== undefined) {
      result['Ipv4NetmaskLength'] = Number(prefix);
    }
  }
  if (vpc.InstanceTenancy !== undefined) result['InstanceTenancy'] = vpc.InstanceTenancy;
  // go-to-k/cdkd#5633: AWS reports each exclusion as `enabled` / `disabled`
  // (or the `-ing` transition) under `ResourceExclusions.<Resource>.State`,
  // where CloudFormation writes `<Resource>Exclusion: enable | disable`.
  // Measured us-east-1, 2026-11-04: an `enforce` control reports all eight,
  // a `monitor` one none.
  const control = vpc.EncryptionControl;
  if (control?.Mode !== undefined) {
    const out: Record<string, unknown> = { Mode: control.Mode };
    const exclusions = control.ResourceExclusions as
      | Record<string, { State?: string } | undefined>
      | undefined;
    for (const key of VPC_ENCRYPTION_CONTROL_EXCLUSIONS) {
      const state = exclusions?.[key.slice(0, -'Exclusion'.length)]?.State;
      if (state === 'enabled' || state === 'enabling') out[key] = 'enable';
      else if (state === 'disabled' || state === 'disabling') out[key] = 'disable';
    }
    result['VpcEncryptionControl'] = out;
  }

  // EnableDnsHostnames / EnableDnsSupport require separate
  // DescribeVpcAttribute calls.
  try {
    const dnsHost = await this.ec2Client.send(
      new DescribeVpcAttributeCommand({ VpcId: physicalId, Attribute: 'enableDnsHostnames' })
    );
    if (dnsHost.EnableDnsHostnames?.Value !== undefined) {
      result['EnableDnsHostnames'] = dnsHost.EnableDnsHostnames.Value;
    }
  } catch (err) {
    if (!this.isNotFoundError(err)) throw err;
  }
  try {
    const dnsSupp = await this.ec2Client.send(
      new DescribeVpcAttributeCommand({ VpcId: physicalId, Attribute: 'enableDnsSupport' })
    );
    if (dnsSupp.EnableDnsSupport?.Value !== undefined) {
      result['EnableDnsSupport'] = dnsSupp.EnableDnsSupport.Value;
    }
  } catch (err) {
    if (!this.isNotFoundError(err)) throw err;
  }

  return result;
}

export async function readSubnetCurrentState(
  this: EC2Provider,
  physicalId: string,
  unsettledNames?: ReadonlySet<string>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(new DescribeSubnetsCommand({ SubnetIds: [physicalId] }));
  const subnet = resp.Subnets?.[0];
  if (!subnet) return RESOURCE_NOT_FOUND;
  if (unsettledNames?.has('Ipv6CidrBlock') && this.subnetIpv6InTransition(subnet)) {
    throw new Error('Subnet IPv6 association is still in transition; retry after it has settled');
  }
  if (unsettledNames?.has('EnableDns64') && typeof subnet.EnableDns64 !== 'boolean') {
    throw new Error('DescribeSubnets did not return EnableDns64; retry the subnet read');
  }

  const result: Record<string, unknown> = {};
  if (subnet.VpcId !== undefined) result['VpcId'] = subnet.VpcId;
  if (subnet.CidrBlock !== undefined) result['CidrBlock'] = subnet.CidrBlock;
  if (subnet.AvailabilityZone !== undefined) {
    result['AvailabilityZone'] = subnet.AvailabilityZone;
  }
  if (subnet.MapPublicIpOnLaunch !== undefined) {
    result['MapPublicIpOnLaunch'] = subnet.MapPublicIpOnLaunch;
  }
  if (subnet.EnableDns64 !== undefined) result['EnableDns64'] = subnet.EnableDns64;
  const ipv6 = subnet.Ipv6CidrBlockAssociationSet?.find(
    (association) => association.Ipv6CidrBlockState?.State === 'associated'
  );
  if (ipv6?.Ipv6CidrBlock !== undefined) result['Ipv6CidrBlock'] = ipv6.Ipv6CidrBlock;
  // go-to-k/cdkd#5632.
  if (subnet.AssignIpv6AddressOnCreation !== undefined) {
    result['AssignIpv6AddressOnCreation'] = subnet.AssignIpv6AddressOnCreation;
  }
  if (subnet.Ipv6Native !== undefined) result['Ipv6Native'] = subnet.Ipv6Native;
  const dns = subnet.PrivateDnsNameOptionsOnLaunch;
  if (dns !== undefined) {
    const block: Record<string, unknown> = {};
    for (const { member } of SUBNET_PRIVATE_DNS_MEMBERS) {
      if (dns[member] !== undefined) block[member] = dns[member];
    }
    result['PrivateDnsNameOptionsOnLaunch'] = block;
  }

  return result;
}

export async function readInternetGatewayCurrentState(
  this: EC2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeInternetGatewaysCommand({ InternetGatewayIds: [physicalId] })
  );
  const igw = resp.InternetGateways?.[0];
  if (!igw) return RESOURCE_NOT_FOUND;

  // The provider only handles `Tags`, which is out of scope for v1 drift.
  // Return an empty object so the comparator marks the resource as
  // `clean` (existence verified) rather than `unsupported`.
  return {};
}

export async function readNatGatewayCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeNatGatewaysCommand({ NatGatewayIds: [physicalId] })
  );
  const gw = resp.NatGateways?.find((g) => g.State !== 'deleted' && g.State !== 'deleting');
  if (!gw) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (gw.SubnetId !== undefined) result['SubnetId'] = gw.SubnetId;
  if (gw.ConnectivityType !== undefined) result['ConnectivityType'] = gw.ConnectivityType;

  // AllocationId / PrivateIpAddress live inside NatGatewayAddresses[0]
  // for single-AZ public NATs.
  // A regional gateway's addresses move between zones (see
  // AvailabilityZoneAddresses below): reading an UNDECLARED one as
  // AllocationId / PrivateIpAddress would record a drift baseline that flips
  // after a swap, which `drift --revert` then sends to an update refusing
  // both create-only keys. So a regional gateway reports each only when the
  // record declares it (CDK's automatic mode with a given Elastic IP).
  const regional = gw.AvailabilityMode === 'regional';
  const primary =
    gw.NatGatewayAddresses?.find((a) => a.IsPrimary === true) ?? gw.NatGatewayAddresses?.[0];
  if (primary?.AllocationId !== undefined && (!regional || properties?.['AllocationId'] != null)) {
    result['AllocationId'] = primary.AllocationId;
  }
  if (primary?.PrivateIp !== undefined && (!regional || properties?.['PrivateIpAddress'] != null)) {
    result['PrivateIpAddress'] = primary.PrivateIp;
  }

  // go-to-k/cdkd#2762: a regional gateway's mode and VPC, and — once it no
  // longer expands to new zones on its own (`AutoProvisionZones: disabled`,
  // what a declared AvailabilityZoneAddresses selects) — its per-zone
  // addresses, spelled the way the recorded entries spell each zone.
  if (gw.AvailabilityMode !== undefined) result['AvailabilityMode'] = gw.AvailabilityMode;
  if (gw.VpcId !== undefined) result['VpcId'] = gw.VpcId;
  if (gw.AvailabilityMode === 'regional' && gw.AutoProvisionZones === 'disabled') {
    const recorded = readNatZoneAddresses(properties?.['AvailabilityZoneAddresses']);
    result['AvailabilityZoneAddresses'] = readbackNatZoneAddresses(
      gw.NatGatewayAddresses ?? [],
      recorded.kind === 'usable' ? recorded.entries : []
    );
  }

  return result;
}

/**
 * `AWS::EC2::EIP` (issue #4447). Read by the allocation id the composite
 * `PublicIp|AllocationId` physicalId carries, or by the public IP when the id
 * holds no allocation segment (the forms `parseEipPhysicalId` tolerates).
 *
 * Gone is EC2's own answer: `InvalidAllocationID.NotFound` /
 * `InvalidAddress.NotFound` (both reach `readCurrentState`'s `.NotFound`
 * catch), or a response that does not list the address asked for.
 *
 * `InstanceId` is emitted only when the template declares it, on EVERY read:
 * an undeclared association belongs to another resource (an
 * `AWS::EC2::EIPAssociation`), and freezing it into this EIP's baseline (by
 * the deploy capture, `cdkd import` or `state refresh-observed`) would make
 * `drift --revert` re-associate the address to whatever instance it named.
 *
 * `Tags` follows the SecurityGroup reader: emitted only when AWS reports at
 * least one non-`aws:` tag. Right after cdkd's own write (`afterOwnWrite`,
 * issue #4112) a read whose tags differ from the declared list keeps the
 * declared one: `CreateTags` / `DeleteTags` run after the address call, and
 * freezing a lagging read (no tags yet, or the OLD tags of an in-place
 * update) into the baseline would report every later read as drift.
 */
export async function readEipCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties: Record<string, unknown> | undefined,
  afterOwnWrite: boolean
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const { allocationId, publicIp } = this.parseEipPhysicalId(physicalId);
  if (!allocationId && !publicIp) return undefined;
  const resp = await this.ec2Client.send(
    new DescribeAddressesCommand(
      allocationId ? { AllocationIds: [allocationId] } : { PublicIps: [publicIp!] }
    )
  );
  const addr = resp.Addresses?.find((a) =>
    allocationId ? a.AllocationId === allocationId : a.PublicIp === publicIp
  );
  if (!addr) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (addr.Domain !== undefined) result['Domain'] = addr.Domain;
  if (addr.InstanceId !== undefined && properties?.['InstanceId'] != null) {
    result['InstanceId'] = addr.InstanceId;
  }
  if (addr.NetworkBorderGroup !== undefined) {
    result['NetworkBorderGroup'] = addr.NetworkBorderGroup;
  }
  if (addr.PublicIpv4Pool !== undefined) result['PublicIpv4Pool'] = addr.PublicIpv4Pool;
  const tags = normalizeAwsTagsToCfn(addr.Tags);
  const declared = properties?.['Tags'];
  const bag =
    afterOwnWrite && Array.isArray(declared) && !tagListsMatch(tags, declared) ? declared : tags;
  if (bag.length > 0) result['Tags'] = bag;
  return result;
}

export async function readRouteTableCurrentState(
  this: EC2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeRouteTablesCommand({ RouteTableIds: [physicalId] })
  );
  const rt = resp.RouteTables?.[0];
  if (!rt) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (rt.VpcId !== undefined) result['VpcId'] = rt.VpcId;
  return result;
}

export async function readSecurityGroupCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeSecurityGroupsCommand({ GroupIds: [physicalId] })
  );
  const sg = resp.SecurityGroups?.[0];
  if (!sg) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (sg.GroupName !== undefined) result['GroupName'] = sg.GroupName;
  if (sg.Description !== undefined) result['GroupDescription'] = sg.Description;
  if (sg.VpcId !== undefined) result['VpcId'] = sg.VpcId;

  // Tags (issue #1649). Every SIBLING standalone type — SecurityGroupIngress,
  // Route, VPCGatewayAttachment, SubnetRouteTableAssociation, NetworkAclEntry,
  // SubnetNetworkAclAssociation — declares `Tags` in `getDriftUnknownPaths`
  // because their reads cannot return them. `AWS::EC2::SecurityGroup` was
  // never added to that list AND never read them, so a templated `Tags` block
  // compared against `undefined` and reported permanent phantom drift on the
  // `properties`-fallback baseline (state written before observed-capture, or
  // any resource whose baseline is the raw template).
  //
  // Reading them is the strictly better of the two fixes, and it is available:
  // `DescribeSecurityGroups` returns `Tags` in the CFn `[{Key,Value}]` shape
  // verbatim (measured us-east-1, 2026-08-12), so a REAL tag change becomes
  // detectable rather than being declared unreadable. `normalizeAwsTagsToCfn`
  // strips the reserved `aws:`-prefixed entries AWS attaches on its own, which
  // a template can never declare and which would otherwise be drift on every
  // run; the comparator's `canonicalizeTagListsDeep` handles readback ORDER.
  //
  // Emitted only when AWS reports at least one tag: an untagged group has no
  // `Tags` key, so a template that declares none is not compared against `[]`.
  // Known bound: a template declaring a LITERAL empty `Tags: []` still
  // compares `[]` against an absent key on the properties-fallback baseline.
  // Emitting `[]` unconditionally would trade that for a worse one — a
  // `CreateTags`-vs-`DescribeSecurityGroups` consistency race frozen into a
  // permanent phantom — so the rarer shape is the one left reported.
  const tags = normalizeAwsTagsToCfn(sg.Tags);
  if (tags.length > 0) result['Tags'] = tags;

  // Reverse-map AWS IpPermissions[] → CFn SecurityGroupIngress[].
  // Each AWS IpPermission can produce multiple CFn rules (one per
  // IpRanges / Ipv6Ranges / UserIdGroupPairs / PrefixListIds entry).
  // Order is reconciled against state's templated rules so the
  // comparator's positional array compare doesn't fire false drift on
  // AWS's normalized order.
  const stateIngress = Array.isArray(properties?.['SecurityGroupIngress'])
    ? (properties['SecurityGroupIngress'] as Array<Record<string, unknown>>)
    : undefined;
  const ingressRules = flattenIpPermissions(sg.IpPermissions ?? [], 'ingress');
  result['SecurityGroupIngress'] = reconcileSgRules(ingressRules, stateIngress, 'ingress');

  // Egress: AWS auto-attaches an `allow-all 0.0.0.0/0` rule on creation
  // when the user doesn't template `SecurityGroupEgress`. Filter it out
  // when state didn't template egress so the auto-default doesn't fire
  // false drift; surface it as-is when state DID template egress (the
  // user owns the egress list, AWS-default is just one of the rules).
  const stateEgress = Array.isArray(properties?.['SecurityGroupEgress'])
    ? (properties['SecurityGroupEgress'] as Array<Record<string, unknown>>)
    : undefined;
  let egressRules = flattenIpPermissions(sg.IpPermissionsEgress ?? [], 'egress');
  if (stateEgress === undefined) {
    egressRules = egressRules.filter((r) => !isDefaultEgressRule(r));
  }
  result['SecurityGroupEgress'] = reconcileSgRules(egressRules, stateEgress, 'egress');

  return result;
}

export async function readNetworkAclCurrentState(
  this: EC2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeNetworkAclsCommand({ NetworkAclIds: [physicalId] })
  );
  const acl = resp.NetworkAcls?.[0];
  if (!acl) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (acl.VpcId !== undefined) result['VpcId'] = acl.VpcId;
  return result;
}

/**
 * AWS::EC2::VPCGatewayAttachment readCurrentState.
 *
 * physicalId format: `<gatewayId>|<vpcId>` (cdkd `createVpcGatewayAttachment`).
 * An `igw-…` gateway reads `DescribeInternetGateways(igwId)`, a `vgw-…` one
 * `DescribeVpnGateways(vgwId)` (issue #2762); either walks the attachments
 * for the matching `VpcId`. Returns `RESOURCE_NOT_FOUND` when the gateway is
 * gone OR is no longer attached to the recorded VPC (a VPN attachment
 * `detaching` / `detached` counts as gone). Both fields are immutable on this
 * resource — drift signal is binary (exists / gone) plus VpcId mismatch.
 */
export async function readVpcGatewayAttachmentCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const parts = physicalId.split('|');
  const [first, vpcId] = parts;
  if (parts.length !== 2 || !first || !vpcId) return undefined;
  // A Cloud-Control type token (`IGW` / `VGW`, go-to-k/cdkd#2762 review) is
  // never sent as a gateway id: the gateway is the one attached to the VPC.
  const token = { IGW: 'igw', InternetGateway: 'igw', VGW: 'vgw', VPN: 'vgw' } as const;
  let gatewayId = first;
  if (Object.hasOwn(token, first)) {
    // Pinned to the id the record's properties name, as delete is: the VPC
    // filter could answer with another stack's gateway, and an empty filter
    // answer cannot be confirmed against the recorded region here, so a
    // record naming no gateway reads as "cannot tell".
    const recorded = this.recordedGatewayIdOf(token[first as keyof typeof token], properties);
    if (recorded === undefined) return undefined;
    gatewayId = recorded;
  } else if (!first.startsWith('igw-') && !first.startsWith('vgw-')) {
    return undefined;
  }

  if (gatewayId.startsWith('vgw-')) {
    const resp = await this.ec2Client.send(
      new DescribeVpnGatewaysCommand({ VpnGatewayIds: [gatewayId] })
    );
    const vgw = resp.VpnGateways?.[0];
    if (!vgw || vgw.State === 'deleted') return RESOURCE_NOT_FOUND;
    const attached = vgw.VpcAttachments?.some(
      (a) => a.VpcId === vpcId && (a.State === 'attached' || a.State === 'attaching')
    );
    if (!attached) return RESOURCE_NOT_FOUND;
    return { VpnGatewayId: gatewayId, VpcId: vpcId };
  }

  const resp = await this.ec2Client.send(
    new DescribeInternetGatewaysCommand({ InternetGatewayIds: [gatewayId] })
  );
  const igw = resp.InternetGateways?.[0];
  if (!igw) return RESOURCE_NOT_FOUND;
  const attached = igw.Attachments?.some((a) => a.VpcId === vpcId);
  if (!attached) return RESOURCE_NOT_FOUND;

  return { InternetGatewayId: gatewayId, VpcId: vpcId };
}

/**
 * AWS::EC2::Route readCurrentState.
 *
 * physicalId format: `<routeTableId>|<destination>` where destination is a
 * v4 CIDR, a v6 CIDR, or a managed prefix list id (`pl-...`).
 * AWS API: `DescribeRouteTables(routeTableId)` → walk `Routes[]` for the
 * entry whose `DestinationCidrBlock`, `DestinationIpv6CidrBlock`, or
 * `DestinationPrefixListId` matches the destination. Returns `RESOURCE_NOT_FOUND`
 * when the route table is gone or the route has been removed.
 *
 * Surfaces the target field (`GatewayId` / `NatGatewayId` / `InstanceId` /
 * `NetworkInterfaceId` / `VpcPeeringConnectionId` / `EgressOnlyInternetGatewayId` /
 * `TransitGatewayId` / `LocalGatewayId` / `CarrierGatewayId` / `CoreNetworkArn` /
 * `OdbNetworkArn` / `VpcEndpointId`) AWS reports for that route. Drift signal: route target changed.
 */
export async function readRouteCurrentState(
  this: EC2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const [rtbId, destination] = physicalId.split('|');
  if (!rtbId || !destination) return undefined;

  const resp = await this.ec2Client.send(
    new DescribeRouteTablesCommand({ RouteTableIds: [rtbId] })
  );
  const rtb = resp.RouteTables?.[0];
  if (!rtb) return RESOURCE_NOT_FOUND;
  const route = rtb.Routes?.find(
    (r) =>
      r.DestinationCidrBlock === destination ||
      r.DestinationIpv6CidrBlock === destination ||
      r.DestinationPrefixListId === destination
  );
  if (!route) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = { RouteTableId: rtbId };
  if (route.DestinationCidrBlock !== undefined) {
    result['DestinationCidrBlock'] = route.DestinationCidrBlock;
  } else if (route.DestinationIpv6CidrBlock !== undefined) {
    result['DestinationIpv6CidrBlock'] = route.DestinationIpv6CidrBlock;
  } else if (route.DestinationPrefixListId !== undefined) {
    result['DestinationPrefixListId'] = route.DestinationPrefixListId;
  }
  // Target fields: only one is set on a given route. Surface whichever
  // AWS reports so a console-side target swap (NAT GW → IGW etc.)
  // shows as drift.
  if (route.GatewayId !== undefined) {
    // DescribeRouteTables has no VpcEndpointId output member: a route
    // created with VpcEndpointId (Gateway Load Balancer endpoint) is
    // reported back as `GatewayId: vpce-...`. CFn's GatewayId is only ever
    // an igw-/vgw- id, so a vpce- value here is unambiguously the
    // VpcEndpointId route target — map it back to the CFn key so the
    // drift baseline (which recorded VpcEndpointId) compares clean.
    if (route.GatewayId.startsWith('vpce-')) {
      result['VpcEndpointId'] = route.GatewayId;
    } else {
      result['GatewayId'] = route.GatewayId;
    }
  }
  if (route.NatGatewayId !== undefined) result['NatGatewayId'] = route.NatGatewayId;
  if (route.InstanceId !== undefined) result['InstanceId'] = route.InstanceId;
  if (route.NetworkInterfaceId !== undefined) {
    result['NetworkInterfaceId'] = route.NetworkInterfaceId;
  }
  if (route.VpcPeeringConnectionId !== undefined) {
    result['VpcPeeringConnectionId'] = route.VpcPeeringConnectionId;
  }
  if (route.EgressOnlyInternetGatewayId !== undefined) {
    result['EgressOnlyInternetGatewayId'] = route.EgressOnlyInternetGatewayId;
  }
  if (route.TransitGatewayId !== undefined) {
    result['TransitGatewayId'] = route.TransitGatewayId;
  }
  if (route.LocalGatewayId !== undefined) {
    result['LocalGatewayId'] = route.LocalGatewayId;
  }
  if (route.CarrierGatewayId !== undefined) {
    result['CarrierGatewayId'] = route.CarrierGatewayId;
  }
  if (route.CoreNetworkArn !== undefined) {
    result['CoreNetworkArn'] = route.CoreNetworkArn;
  }
  if (route.OdbNetworkArn !== undefined) {
    result['OdbNetworkArn'] = route.OdbNetworkArn;
  }
  return result;
}

/**
 * AWS::EC2::SubnetRouteTableAssociation readCurrentState.
 *
 * physicalId format: `<rtbassoc-xxx>` (returned by `AssociateRouteTable`).
 * AWS API: `DescribeRouteTables` filtered by `association.route-table-association-id`,
 * then walk `Associations[]` for the matching entry. Returns `RESOURCE_NOT_FOUND`
 * when no route table carries the association id.
 *
 * Both `SubnetId` and `RouteTableId` are immutable on this resource —
 * drift signal is binary (exists / gone).
 */
export async function readSubnetRouteTableAssociationCurrentState(
  this: EC2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeRouteTablesCommand({
      Filters: [{ Name: 'association.route-table-association-id', Values: [physicalId] }],
    })
  );
  for (const rtb of resp.RouteTables ?? []) {
    const assoc = rtb.Associations?.find((a) => a.RouteTableAssociationId === physicalId);
    if (assoc) {
      const result: Record<string, unknown> = {};
      if (assoc.SubnetId !== undefined) result['SubnetId'] = assoc.SubnetId;
      if (assoc.RouteTableId !== undefined) result['RouteTableId'] = assoc.RouteTableId;
      return result;
    }
  }
  return RESOURCE_NOT_FOUND;
}

/**
 * AWS::EC2::SecurityGroupIngress (standalone) readCurrentState.
 *
 * physicalId format: `<groupId>|<protocol>|<fromPort>|<toPort>` (cdkd
 * `createSecurityGroupIngress`). The same tuple can identify multiple
 * AWS rules (one per `IpRanges` / `Ipv6Ranges` / `UserIdGroupPairs` /
 * `PrefixListIds` entry). State's full rule signature (passed via the
 * optional `properties` arg) is used to find the exact matching rule.
 *
 * AWS API: `DescribeSecurityGroups(groupId)` → walk `IpPermissions[]`
 * filtered by protocol+ports → flatten via `flattenIpPermissions` →
 * find the entry matching state's full signature (CIDR / peer / prefix /
 * description). Returns `RESOURCE_NOT_FOUND` when the parent SG is gone or no
 * matching rule exists.
 */
export async function readSecurityGroupIngressCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties?: Record<string, unknown>,
  context?: ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const parts = physicalId.split('|');
  if (parts.length < 4) return undefined;
  const groupId = parts[0]!;
  const protocol = parts[1]!;
  const fromPort = parts[2] === '-1' ? undefined : parseInt(parts[2]!, 10);
  const toPort = parts[3] === '-1' ? undefined : parseInt(parts[3]!, 10);

  const resp = await this.ec2Client.send(
    new DescribeSecurityGroupsCommand({ GroupIds: [groupId] })
  );
  const sg = resp.SecurityGroups?.[0];
  if (!sg) return RESOURCE_NOT_FOUND;

  // Issue #1643: the physicalId's protocol segment is what cdkd SENT (a
  // template `IpProtocol: 6` is recorded as `'6'`, post-#1633), while AWS
  // stores and reports the canonical NAME for the four protocols it has one
  // for. A raw `===` therefore matched NOTHING for a numeric protocol, this
  // method returned `undefined`, and `cdkd drift` reported the rule as
  // "drift unknown" forever — one layer BELOW the phantom drift #1643 is
  // about, and invisible to a comparison-side fix because no AWS-side bag is
  // ever produced. Measured live 2026-08-12: `IpProtocol: '6'` -> physicalId
  // `sg-…|6|9443|9443` vs an AWS `IpPermissions[].IpProtocol` of `tcp`.
  // Canonicalizing BOTH sides is what makes the tuple comparable again.
  const wantedProtocol = sgProtocolKey(protocol);
  // `-1` and absent are the same port bound on both sides: the physical id
  // decodes `-1` to `undefined`, while AWS reports an ICMP rule's `-1`
  // explicitly (`Port.icmpPing()` is 8 / -1, `Port.allIcmp()` -1 / -1).
  // Comparing them raw read a live ICMP rule as gone (go-to-k/cdkd#4283).
  const portBound = (port: number | undefined): number | undefined =>
    port === -1 ? undefined : port;
  const candidates = (sg.IpPermissions ?? []).filter(
    (p) =>
      sgProtocolKey(p.IpProtocol) === wantedProtocol &&
      portBound(p.FromPort) === fromPort &&
      portBound(p.ToPort) === toPort
  );
  if (candidates.length === 0) return RESOURCE_NOT_FOUND;

  const flat = flattenIpPermissions(candidates, 'ingress');

  // If state passed full rule properties, disambiguate by the full
  // identity-key. Otherwise return the first candidate (best effort —
  // unique tuple → unambiguous).
  if (properties && Object.keys(properties).length > 0) {
    const stateKey = sgRuleKey(properties, 'ingress');
    const match = flat.find((r) => sgRuleKey(r, 'ingress') === stateKey);
    if (match) {
      // Re-attach the parent group id so the caller sees the full CFn
      // shape (the standalone resource type carries GroupId at the top
      // level, unlike the inline-rule case).
      return { GroupId: groupId, ...match };
    }
    // No exact match: the identity fallback (issue #4447).
    const fallback = await this.readSgIngressByIdentity(groupId, flat, properties, context);
    return fallback === undefined ? undefined : { GroupId: groupId, ...fallback };
  }

  return { GroupId: groupId, ...flat[0]! };
}

/**
 * The identity fallback of {@link readSecurityGroupIngressCurrentState}
 * (issue #4447), for a rule the whole-rule key did not match: AWS keys a rule
 * by its permission, so `Description` is a mutable attribute of it, and an
 * out-of-band description edit should read back as drift on THIS rule rather
 * than as "cannot tell" (which also kept `drift --revert` from restoring it).
 * The peer owner AWS always reports is dropped when the template does not
 * declare it (the ordinary same-account SG-to-SG rule), and ports compare
 * numerically, so a token-resolved `FromPort: "3306"` matches AWS's `3306`.
 *
 * A rule matching only by identity may not be OURS: a stranger can re-add the
 * same permission after cdkd's rule was revoked, and `drift --revert`'s
 * revoke would then remove the stranger's rule. So the fallback answers only
 * with ownership evidence, and `undefined` ("cannot tell") otherwise:
 * - never on the deploy capture (`afterOwnWrite`): a lagging read must not
 *   freeze a stale description into the baseline (#4112);
 * - the record's own recorded `sgr-` `Id` (`context.attributes`) names, per
 *   `DescribeSecurityGroupRules`, an ingress rule of this group matching the
 *   template's identity and carrying the SAME description as the one live
 *   identity match. A stale id (the rule was re-created) answers nothing;
 * - no sibling `AWS::EC2::SecurityGroupIngress` declares the same rule or
 *   records the same rule id, and no inline rule of the group's own
 *   `AWS::EC2::SecurityGroup` record declares it
 *   (go-to-k/cdkd#4492): AWS keeps one rule for both, with the first
 *   description, so the other record would read false drift and its revert
 *   would revoke the shared rule.
 *
 * The by-id call has its own catch: `readCurrentState`'s maps
 * `InvalidSecurityGroupRuleId.NotFound` to GONE, which a stale id is not.
 */
export async function readSgIngressByIdentity(
  this: EC2Provider,
  groupId: string,
  flat: CfnSgRule[],
  properties: Record<string, unknown>,
  context: ReadCurrentStateContext | undefined
): Promise<CfnSgRule | undefined> {
  if (context?.afterOwnWrite === true) return undefined;
  const recordedId = recordedSgRuleId(context?.attributes);
  if (recordedId === undefined) return undefined;
  if (
    !Number.isFinite(cfnIngressPortValue(properties['FromPort'])) ||
    !Number.isFinite(cfnIngressPortValue(properties['ToPort']))
  ) {
    return undefined;
  }
  const identity = (rule: CfnSgRule): string => {
    const key = JSON.parse(sgRuleKey(rule, 'ingress')) as Record<string, unknown>;
    delete key['d'];
    if (properties['SourceSecurityGroupOwnerId'] == null) delete key['peerOwner'];
    key['f'] = cfnIngressPortValue(rule['FromPort']);
    key['t'] = cfnIngressPortValue(rule['ToPort']);
    return JSON.stringify(key);
  };
  const wanted = identity(properties);
  const matches = flat.filter((r) => identity(r) === wanted);
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const siblings = Object.entries(context?.siblings ?? {});
  if (
    stackIngressRuleHolder(siblings, '', groupId, properties) !== undefined ||
    // The same rule spelled another way (a group name for its id, a CIDR
    // written differently) does not pair by identity, but a record sharing
    // it recorded the same rule id.
    siblings.some(
      ([, sibling]) =>
        sibling.resourceType === 'AWS::EC2::SecurityGroupIngress' &&
        recordedSgRuleId(sibling.attributes) === recordedId
    )
  ) {
    return undefined;
  }
  let owned: SecurityGroupRule | undefined;
  try {
    const resp = await this.ec2Client.send(
      new DescribeSecurityGroupRulesCommand({ SecurityGroupRuleIds: [recordedId] })
    );
    owned = resp.SecurityGroupRules?.find((r) => r.SecurityGroupRuleId === recordedId);
  } catch (err) {
    this.logger.debug(
      safeMsg`readCurrentState: recorded rule ${recordedId} could not be read (${describeAwsFailure(err).summary}); the ingress rule stays unknown`
    );
    return undefined;
  }
  if (
    owned === undefined ||
    owned.IsEgress === true ||
    owned.GroupId !== groupId ||
    !securityGroupRuleMatchesCfnIngress(owned, properties) ||
    descriptionKey(owned.Description) !== descriptionKey(match['Description'])
  ) {
    return undefined;
  }
  // The ports matched NUMERICALLY, so a template port AWS reports as a
  // number but the record holds as a string (a token-resolved `"3306"`) is
  // echoed in the TEMPLATE's spelling: the drift comparison is type-strict,
  // and AWS's `3306` against the record's `"3306"` would read as port drift
  // on every run, with `--revert` re-authorizing the same rule each time.
  // (`IpProtocol` needs no echo: `canonicalizeIpProtocols` folds both sides.)
  return {
    ...match,
    ...(properties['FromPort'] != null && { FromPort: properties['FromPort'] }),
    ...(properties['ToPort'] != null && { ToPort: properties['ToPort'] }),
  };
}

/**
 * AWS::EC2::NetworkAclEntry readCurrentState.
 *
 * physicalId format: `<aclId>|<ruleNumber>|<egress>` (cdkd
 * `createNetworkAclEntry`).
 *
 * AWS API: `DescribeNetworkAcls(aclId)` → walk `Entries[]` for the entry
 * matching `(RuleNumber, Egress)`. Returns `RESOURCE_NOT_FOUND` when the parent
 * ACL is gone or the rule has been removed.
 *
 * Surfaces every user-controllable CFn property (`Protocol`, `RuleAction`,
 * `CidrBlock`, `Ipv6CidrBlock`, `PortRange`, `IcmpTypeCode`). `Protocol`
 * is normalized to a number to match CFn input shape (AWS returns it as
 * a string).
 */
export async function readNetworkAclEntryCurrentState(
  this: EC2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const parts = physicalId.split('|');
  if (parts.length < 3) return undefined;
  const aclId = parts[0]!;
  const ruleNumber = parseInt(parts[1]!, 10);
  const egress = parts[2] === 'true';

  const resp = await this.ec2Client.send(
    new DescribeNetworkAclsCommand({ NetworkAclIds: [aclId] })
  );
  const acl = resp.NetworkAcls?.[0];
  if (!acl) return RESOURCE_NOT_FOUND;
  const entry = acl.Entries?.find(
    (e) => e.RuleNumber === ruleNumber && (e.Egress ?? false) === egress
  );
  if (!entry) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {
    NetworkAclId: aclId,
    RuleNumber: ruleNumber,
    Egress: egress,
  };
  if (entry.Protocol !== undefined) {
    // CFn input shape uses number; AWS returns string. Normalize.
    const n = parseInt(entry.Protocol, 10);
    result['Protocol'] = Number.isNaN(n) ? entry.Protocol : n;
  }
  if (entry.RuleAction !== undefined) result['RuleAction'] = entry.RuleAction;
  if (entry.CidrBlock !== undefined) result['CidrBlock'] = entry.CidrBlock;
  if (entry.Ipv6CidrBlock !== undefined) result['Ipv6CidrBlock'] = entry.Ipv6CidrBlock;
  if (entry.PortRange) {
    const pr: Record<string, unknown> = {};
    if (entry.PortRange.From !== undefined) pr['From'] = entry.PortRange.From;
    if (entry.PortRange.To !== undefined) pr['To'] = entry.PortRange.To;
    if (Object.keys(pr).length > 0) result['PortRange'] = pr;
  }
  if (entry.IcmpTypeCode) {
    const icmp: Record<string, unknown> = {};
    if (entry.IcmpTypeCode.Type !== undefined) icmp['Type'] = entry.IcmpTypeCode.Type;
    if (entry.IcmpTypeCode.Code !== undefined) icmp['Code'] = entry.IcmpTypeCode.Code;
    if (Object.keys(icmp).length > 0) {
      // CFn schema spells this property `Icmp`; AWS API spells it
      // `IcmpTypeCode`. Emit BOTH names so drift comparison works for
      // state files written by both the post-#613-fix code (which
      // uses CFn-canonical `Icmp`) AND any pre-fix state files that
      // stored `IcmpTypeCode` directly (template authors bypassed
      // the sdkUnwired pre-flight by using the AWS API name).
      result['Icmp'] = icmp;
      result['IcmpTypeCode'] = icmp;
    }
  }
  return result;
}

/**
 * AWS::EC2::SubnetNetworkAclAssociation readCurrentState.
 *
 * physicalId format: `<aclassoc-xxx>` (returned by
 * `ReplaceNetworkAclAssociation`).
 *
 * AWS API: `DescribeNetworkAcls` filtered by `association.association-id`,
 * then walk `Associations[]` for the matching entry. Returns `RESOURCE_NOT_FOUND`
 * when no NACL carries the association id.
 *
 * Surfaces `NetworkAclId` + `SubnetId`. Drift signal: NetworkAclId
 * changed (subnet was reassigned to a different NACL via console).
 */
export async function readSubnetNetworkAclAssociationCurrentState(
  this: EC2Provider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeNetworkAclsCommand({
      Filters: [{ Name: 'association.association-id', Values: [physicalId] }],
    })
  );
  for (const acl of resp.NetworkAcls ?? []) {
    const assoc = acl.Associations?.find((a) => a.NetworkAclAssociationId === physicalId);
    if (assoc) {
      const result: Record<string, unknown> = {};
      if (assoc.NetworkAclId !== undefined) result['NetworkAclId'] = assoc.NetworkAclId;
      if (assoc.SubnetId !== undefined) result['SubnetId'] = assoc.SubnetId;
      return result;
    }
  }
  return RESOURCE_NOT_FOUND;
}

/** The {@link EC2Provider} methods this module defines. */
export const readStateMethods = {
  readVpcCurrentState,
  readSubnetCurrentState,
  readInternetGatewayCurrentState,
  readNatGatewayCurrentState,
  readEipCurrentState,
  readRouteTableCurrentState,
  readSecurityGroupCurrentState,
  readNetworkAclCurrentState,
  readVpcGatewayAttachmentCurrentState,
  readRouteCurrentState,
  readSubnetRouteTableAssociationCurrentState,
  readSecurityGroupIngressCurrentState,
  readSgIngressByIdentity,
  readNetworkAclEntryCurrentState,
  readSubnetNetworkAclAssociationCurrentState,
};
