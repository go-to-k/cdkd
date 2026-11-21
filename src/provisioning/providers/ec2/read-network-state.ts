import {
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkAclsCommand,
  DescribeRouteTablesCommand,
  type NatGatewayAddress,
  type Tag,
} from '@aws-sdk/client-ec2';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { inDeclaredOrder } from '../../declared-order.js';
import { readNatZoneAddresses, readbackNatZoneAddresses } from './nat-support.js';
import { tagListsMatch } from './sg-support.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * The `Tags` an EC2 readback reports, from the tags the `Describe*` response
 * carries (go-to-k/cdkd#6754; the SecurityGroup reader's #1649 rule, the EIP
 * reader's #4447 one). `undefined` when AWS reports no tag but the reserved
 * `aws:` ones, which a template cannot declare: an untagged resource has no
 * `Tags` key, so a template declaring none is not compared against `[]`.
 *
 * Right after cdkd's own write (`afterOwnWrite`, go-to-k/cdkd#4112) a read
 * whose tags differ from the declared list keeps the declared one, and a
 * template declaring none records no `Tags`: a create
 * whose `TagSpecifications` were refused tags the resource with a later
 * `CreateTags`, and an update writes them with `CreateTags` / `DeleteTags`, so
 * the capture can read the tags before the write lands. Frozen into the drift
 * baseline, that lagging read would report every later read as drift.
 */
export function readbackEc2Tags(
  awsTags: readonly Tag[] | undefined,
  properties: Record<string, unknown> | undefined,
  afterOwnWrite: boolean
): unknown[] | undefined {
  const tags = normalizeAwsTagsToCfn(awsTags);
  const declared = properties?.['Tags'];
  // A template declaring no tags had its last ones removed by this write
  // (`DeleteTags`), so a read still showing them is the lag too.
  if (afterOwnWrite && properties !== undefined && declared == null) return undefined;
  const bag =
    afterOwnWrite && Array.isArray(declared) && !tagListsMatch(tags, declared) ? declared : tags;
  return bag.length > 0 ? bag : undefined;
}

export async function readInternetGatewayCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties?: Record<string, unknown>,
  afterOwnWrite = false
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeInternetGatewaysCommand({ InternetGatewayIds: [physicalId] })
  );
  const igw = resp.InternetGateways?.[0];
  if (!igw) return RESOURCE_NOT_FOUND;

  // `Tags` is the only property: an untagged gateway reads `{}`, which the
  // comparator marks `clean` (existence verified) rather than `unsupported`.
  const result: Record<string, unknown> = {};
  const tags = readbackEc2Tags(igw.Tags, properties, afterOwnWrite);
  if (tags !== undefined) result['Tags'] = tags;
  return result;
}

export async function readNatGatewayCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties: Record<string, unknown> | undefined,
  afterOwnWrite = false
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
  if (!regional) {
    Object.assign(result, natSecondaryAddresses(gw.NatGatewayAddresses ?? [], primary, properties));
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

  const tags = readbackEc2Tags(gw.Tags, properties, afterOwnWrite);
  if (tags !== undefined) result['Tags'] = tags;
  return result;
}

/** A secondary address on its way out of the gateway, or one AWS failed to add. */
const LEAVING_ADDRESS_STATUSES: ReadonlySet<string> = new Set([
  'unassigning',
  'disassociating',
  'failed',
]);

/**
 * A zonal gateway's secondary addresses (go-to-k/cdkd#6754): every address but
 * the primary, as the three CloudFormation properties spell them. Each key is
 * read only for a record that declares it, in the declared order
 * ({@link inDeclaredOrder}), and is then emitted even when none is live (`[]`,
 * `0`), so an address removed out of band differs from the declared value.
 * An undeclared key is not emitted: CloudFormation's
 * `SecondaryPrivateIpAddresses` and `SecondaryPrivateIpAddressCount` exclude
 * each other, and a public gateway's secondary Elastic IPs carry private
 * addresses AWS picks, so reading the undeclared one would record what the
 * template never set.
 */
function natSecondaryAddresses(
  addresses: readonly NatGatewayAddress[],
  primary: NatGatewayAddress | undefined,
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  const secondary = addresses.filter(
    (a) => a !== primary && !LEAVING_ADDRESS_STATUSES.has(a.Status ?? '')
  );
  const declared = (key: string): readonly unknown[] | undefined => {
    const value = properties?.[key];
    return Array.isArray(value) ? value : undefined;
  };
  const out: Record<string, unknown> = {};
  if (properties?.['SecondaryAllocationIds'] != null) {
    out['SecondaryAllocationIds'] = inDeclaredOrder(
      secondary.flatMap((a) => (a.AllocationId !== undefined ? [a.AllocationId] : [])),
      (id) => id,
      declared('SecondaryAllocationIds')
    );
  }
  if (properties?.['SecondaryPrivateIpAddresses'] != null) {
    out['SecondaryPrivateIpAddresses'] = inDeclaredOrder(
      secondary.flatMap((a) => (a.PrivateIp !== undefined ? [a.PrivateIp] : [])),
      (ip) => ip,
      declared('SecondaryPrivateIpAddresses')
    );
  }
  if (properties?.['SecondaryPrivateIpAddressCount'] != null) {
    out['SecondaryPrivateIpAddressCount'] = secondary.filter(
      (a) => a.PrivateIp !== undefined
    ).length;
  }
  return out;
}

export async function readRouteTableCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties?: Record<string, unknown>,
  afterOwnWrite = false
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeRouteTablesCommand({ RouteTableIds: [physicalId] })
  );
  const rt = resp.RouteTables?.[0];
  if (!rt) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (rt.VpcId !== undefined) result['VpcId'] = rt.VpcId;
  const tags = readbackEc2Tags(rt.Tags, properties, afterOwnWrite);
  if (tags !== undefined) result['Tags'] = tags;
  return result;
}

export async function readNetworkAclCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties?: Record<string, unknown>,
  afterOwnWrite = false
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeNetworkAclsCommand({ NetworkAclIds: [physicalId] })
  );
  const acl = resp.NetworkAcls?.[0];
  if (!acl) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (acl.VpcId !== undefined) result['VpcId'] = acl.VpcId;
  const tags = readbackEc2Tags(acl.Tags, properties, afterOwnWrite);
  if (tags !== undefined) result['Tags'] = tags;
  return result;
}

/** The {@link EC2Provider} methods this module defines. */
export const readNetworkStateMethods = {
  readInternetGatewayCurrentState,
  readNatGatewayCurrentState,
  readRouteTableCurrentState,
  readNetworkAclCurrentState,
};
