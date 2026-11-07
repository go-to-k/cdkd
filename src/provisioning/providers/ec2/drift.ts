import type { Subnet } from '@aws-sdk/client-ec2';
import { DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import { canonicalizeIpv6Cidr } from '../../../utils/ipv6-cidr.js';
import { coerceCfnBoolean, coerceCfnInteger } from '../../config-shape.js';
import type { ResourceNotFound, ReadCurrentStateContext } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  OWN_WRITE_READ_ATTEMPTS,
  OWN_WRITE_READ_DELAY_MS,
  VPC_ENCRYPTION_CONTROL_EXCLUSIONS,
  isEc2NotFoundCode,
} from './common.js';
import { narrowRouteDestinations } from './network-support.js';
import {
  canonicalizeSgInlineRuleProtocols,
  canonicalizeSgRuleProtocol,
  narrowIngressIpProtocol,
} from './sg-support.js';
import {
  SUBNET_PRIVATE_DNS_MEMBERS,
  subnetPrivateDnsMemberValue,
  subnetPrivateDnsOptionsRefusal,
} from './subnet-support.js';
import type { EC2Provider } from '../ec2-provider.js';

/** Recovery must not mistake an in-flight IPv6 association for absence. */
export function subnetIpv6InTransition(this: EC2Provider, subnet: Subnet): boolean {
  return (subnet.Ipv6CidrBlockAssociationSet ?? []).some((association) => {
    const state = association.Ipv6CidrBlockState?.State;
    return (
      state === undefined ||
      state === 'associating' ||
      state === 'disassociating' ||
      state === 'failing'
    );
  });
}

export async function unsettledInTransition(
  this: EC2Provider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  if (resourceType !== 'AWS::EC2::Subnet' || !names.has('Ipv6CidrBlock')) return new Set();
  try {
    const response = await this.ec2Client.send(
      new DescribeSubnetsCommand({ SubnetIds: [physicalId] })
    );
    const subnet = response.Subnets?.[0];
    return !subnet || this.subnetIpv6InTransition(subnet) ? new Set(['Ipv6CidrBlock']) : new Set();
  } catch {
    return new Set(['Ipv6CidrBlock']);
  }
}

export async function readUnsettled(
  this: EC2Provider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  recordedProperties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // Bypass the ordinary read's not-found-message downgrade: recovery needs a
  // failed read to refuse the update, never to manufacture a removal.
  if (resourceType === 'AWS::EC2::Subnet') {
    return this.readSubnetCurrentState(physicalId, names, recordedProperties);
  }
  return this.readCurrentState(physicalId, logicalId, resourceType, recordedProperties);
}

/** Collapse only proven spelling equivalents; preserve the AWS bag for drift accept. */
export async function canonicalizeDriftPair(
  this: EC2Provider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  const key = 'Ipv6CidrBlock';
  if (resourceType === 'AWS::EC2::Subnet') {
    const old = baseline[key];
    const live = aws[key];
    const canonical = typeof old === 'string' ? canonicalizeIpv6Cidr(old) : undefined;
    if (
      canonical !== undefined &&
      typeof live === 'string' &&
      canonical === canonicalizeIpv6Cidr(live)
    ) {
      return { baseline: { ...baseline, [key]: live }, aws };
    }
  }
  return { baseline, aws };
}

export function canonicalizeUnsettledProperties(
  this: EC2Provider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::EC2::Subnet') return properties;
  const out = this.canonicalizeDesiredProperties(resourceType, properties);
  const key = 'Ipv6CidrBlock';
  const cidr = out[key];
  const canonical = typeof cidr === 'string' ? canonicalizeIpv6Cidr(cidr) : undefined;
  return canonical === undefined ? out : { ...out, [key]: canonical };
}

/**
 * Read the AWS-current EC2 networking resource configuration in
 * CFn-property shape.
 *
 * Supported types (highest-value drift coverage):
 *  - **AWS::EC2::VPC**: `DescribeVpcs` for `CidrBlock` + `InstanceTenancy`;
 *    `DescribeVpcAttribute(enableDnsHostnames|enableDnsSupport)` for the
 *    DNS booleans (CFn defaults: hostnames=false, support=true — we only
 *    surface them if AWS reports them, so the comparator's "key-absent
 *    never drifts" rule applies cleanly to state without these keys).
 *  - **AWS::EC2::Subnet**: `DescribeSubnets` for `VpcId`, `CidrBlock`,
 *    `AvailabilityZone`, `MapPublicIpOnLaunch`.
 *  - **AWS::EC2::InternetGateway**: `DescribeInternetGateways` for
 *    existence verification. The provider only handles `Tags`, which is
 *    out of scope for v1 drift.
 *  - **AWS::EC2::NatGateway**: `DescribeNatGateways` for `SubnetId`,
 *    `AllocationId`, `ConnectivityType`, `PrivateIpAddress`.
 *  - **AWS::EC2::RouteTable**: `DescribeRouteTables` for `VpcId`.
 *  - **AWS::EC2::SecurityGroup**: `DescribeSecurityGroups` for
 *    `GroupName`, `GroupDescription`, `VpcId`, `Tags` (issue #1649 — the
 *    same call returns them in the CFn `[{Key,Value}]` shape, so they are
 *    read rather than declared unreadable the way every sibling standalone
 *    type declares them; reserved `aws:`-prefixed entries are stripped and
 *    the key is omitted entirely when AWS reports none), plus `SecurityGroupIngress`
 *    and `SecurityGroupEgress` reverse-mapped from AWS's normalized
 *    `IpPermissions[]` / `IpPermissionsEgress[]` form. Each AWS
 *    `IpPermission` is flattened into one CFn rule per `IpRanges` /
 *    `Ipv6Ranges` / `UserIdGroupPairs` / `PrefixListIds` entry; field
 *    names follow CFn direction conventions (`Source*` for ingress,
 *    `Destination*` for egress). When state templates ingress/egress
 *    rules, AWS's response is reordered to match state's positional
 *    order via `reconcileSgRules` so the comparator's array compare
 *    doesn't fire false drift on AWS's normalized ordering. The
 *    AWS-auto-attached "allow-all 0.0.0.0/0" egress rule is filtered
 *    out of `SecurityGroupEgress` when state did not template egress
 *    (the auto-default is invisible to drift). Both arrays are
 *    always emitted (even as `[]`) so the v3 `observedProperties`
 *    baseline catches console-side rule ADDs to a templated SG.
 *  - **AWS::EC2::Instance**: `DescribeInstances` for `ImageId`,
 *    `InstanceType`, `KeyName`, `SubnetId`, `SecurityGroupIds` (sorted
 *    list of `SecurityGroups[].GroupId` for stable positional compare),
 *    `PrivateIpAddress`, `SourceDestCheck`, `Monitoring` (mapped from
 *    AWS `Monitoring.State` to CFn boolean), `Tenancy` (from
 *    `Placement.Tenancy`), `PlacementGroupName` (from
 *    `Placement.GroupName`), `IamInstanceProfile` (ARN form — v2 fallback
 *    state holding a name will fire one-time drift, resolved via
 *    `cdkd state refresh-observed`), `Tags` (filtered `aws:*`). For
 *    `BlockDeviceMappings`, `DescribeInstances` only returns
 *    `(DeviceName, Ebs.VolumeId, Ebs.DeleteOnTermination)`; cdkd
 *    additionally calls `DescribeVolumes` on the attached volume ids to
 *    surface `VolumeType` / `VolumeSize` / `Iops` / `Throughput` /
 *    `Encrypted` / `KmsKeyId` / `SnapshotId`. `DisableApiTermination`
 *    is recovered via a separate `DescribeInstanceAttribute` call (the
 *    `DescribeInstances` response does not include it). Both extra
 *    calls are best-effort — a permissions gap or other failure falls
 *    back to omitting the key. All arrays / scalars that map to
 *    user-controllable CFn properties are always emitted (even as `[]`
 *    or default scalar) so the v3 `observedProperties` baseline
 *    catches console-side ADDs.
 *  - **AWS::EC2::NetworkAcl**: `DescribeNetworkAcls` for `VpcId`.
 *  - **AWS::EC2::EIP**: `DescribeAddresses` by allocation id (a bare
 *    public IP when the physicalId carries no `eipalloc-` segment) for
 *    `Domain`, `InstanceId`, `NetworkBorderGroup`, `PublicIpv4Pool`, `Tags`
 *    (issue #4447).
 *
 * Read through the parent's `Describe*` response:
 *  - **AWS::EC2::VPCGatewayAttachment**: physical id is
 *    `<gatewayId>|<vpcId>`; `DescribeInternetGateways` (an `igw-…` gateway)
 *    or `DescribeVpnGateways` (a `vgw-…` one) proves the attachment still
 *    exists, and the two ids it returns are the only properties.
 *  - **AWS::EC2::Route**, **AWS::EC2::SubnetRouteTableAssociation**,
 *    **AWS::EC2::SecurityGroupIngress**, **AWS::EC2::NetworkAclEntry**,
 *    **AWS::EC2::SubnetNetworkAclAssociation**: rule / association
 *    sub-resources whose AWS API surfaces them inside the parent's
 *    `Describe*` list response, not as standalone `Get*` calls. cdkd
 *    parses the physicalId to recover the parent id + entry-key, then
 *    walks the parent's response to find the matching entry and
 *    reverse-maps it to CFn property shape. `SecurityGroupIngress` uses
 *    state's full rule signature (when passed via the optional
 *    `properties` arg) to disambiguate among multiple AWS rules
 *    sharing the same `(group, protocol, ports)` tuple.
 *
 * Returns `RESOURCE_NOT_FOUND` when the resource is gone (any `*NotFound` /
 * `Invalid*` error from the EC2 SDK matches `isNotFoundError`, or the
 * describe / parent walk no longer carries it); `undefined` for an
 * unsupported type or an unparseable physicalId. Right after cdkd's own
 * write (`afterOwnWrite`) a gone answer is first re-read a few times
 * (`OWN_WRITE_READ_ATTEMPTS`, go-to-k/cdkd#4971).
 */
export async function readCurrentState(
  this: EC2Provider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const attempts = context?.afterOwnWrite === true ? OWN_WRITE_READ_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    const read = await this.readCurrentStateOnce(
      physicalId,
      logicalId,
      resourceType,
      properties,
      context
    );
    if (read !== RESOURCE_NOT_FOUND || attempt >= attempts) return read;
    await new Promise((r) => setTimeout(r, OWN_WRITE_READ_DELAY_MS));
  }
}

export async function readCurrentStateOnce(
  this: EC2Provider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  try {
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return await this.readVpcCurrentState(physicalId, properties);
      case 'AWS::EC2::Subnet':
        return await this.readSubnetCurrentState(physicalId, undefined, properties);
      case 'AWS::EC2::InternetGateway':
        return await this.readInternetGatewayCurrentState(physicalId);
      case 'AWS::EC2::NatGateway':
        return await this.readNatGatewayCurrentState(physicalId, properties);
      case 'AWS::EC2::RouteTable':
        return await this.readRouteTableCurrentState(physicalId);
      case 'AWS::EC2::SecurityGroup':
        return await this.readSecurityGroupCurrentState(physicalId, properties);
      case 'AWS::EC2::Instance':
        return await this.readInstanceCurrentState(physicalId, properties);
      case 'AWS::EC2::NetworkAcl':
        return await this.readNetworkAclCurrentState(physicalId);
      case 'AWS::EC2::EIP':
        return await this.readEipCurrentState(
          physicalId,
          properties,
          context?.afterOwnWrite === true
        );
      case 'AWS::EC2::VPCGatewayAttachment':
        return await this.readVpcGatewayAttachmentCurrentState(physicalId, properties);
      case 'AWS::EC2::Route':
        return await this.readRouteCurrentState(physicalId);
      case 'AWS::EC2::SubnetRouteTableAssociation':
        return await this.readSubnetRouteTableAssociationCurrentState(physicalId);
      case 'AWS::EC2::SecurityGroupIngress':
        return await this.readSecurityGroupIngressCurrentState(physicalId, properties, context);
      case 'AWS::EC2::NetworkAclEntry':
        return await this.readNetworkAclEntryCurrentState(physicalId);
      case 'AWS::EC2::SubnetNetworkAclAssociation':
        return await this.readSubnetNetworkAclAssociationCurrentState(physicalId);
      default:
        this.logger.debug(
          `readCurrentState: unsupported resource type ${resourceType} for ${logicalId}`
        );
        return undefined;
    }
  } catch (err) {
    // go-to-k/cdkd#4283: only EC2's own `*.NotFound` code proves the
    // resource is gone. The looser message match (`InvalidParameterValue`,
    // "does not exist" text) keeps its old "cannot tell" answer.
    if (isEc2NotFoundCode(err)) return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err)) return undefined;
    throw err;
  }
}

/**
 * Drift-unknown paths per resource type.
 *
 * The 6 EC2 sub-resource types (`AWS::EC2::Route` /
 * `VPCGatewayAttachment` / `SubnetRouteTableAssociation` /
 * `SecurityGroupIngress` / `NetworkAclEntry` /
 * `SubnetNetworkAclAssociation`) have NO AWS-side `Tags` API — the
 * underlying AWS objects (route entries, NACL entries, route-table
 * associations, NACL associations, IGW attachments) are not
 * tag-bearing on AWS, and the corresponding CFn schemas do not model
 * `Tags` either. Declaring `'Tags'` here is defense-in-depth: if a
 * future CFn schema revision adds `Tags` to one of these types, or
 * cdkd state somehow carries `Tags` for one of them via a custom
 * property override, the drift comparator will skip the path
 * instead of firing guaranteed false-positive drift on every clean
 * run.
 *
 * Other EC2 types (`VPC` / `Subnet` / `InternetGateway` /
 * `NatGateway` / `RouteTable` / `SecurityGroup` / `Instance` /
 * `NetworkAcl`) have first-class Tags support on the WRITE side
 * (create/update tag wiring) and don't need this declaration.
 * NOTE: `readVpcCurrentState` / `readSubnetCurrentState` do NOT
 * currently surface `Tags`, so Tags drift on those types is out of
 * v1 drift scope — `AWS::EC2::Subnet`'s `updateableProperties:
 * Tags` entry serves only the template-update path today.
 */
export function getDriftUnknownPaths(
  this: EC2Provider,
  resourceType: string,
  properties?: Record<string, unknown>
): string[] {
  switch (resourceType) {
    // NetworkInterfaces cannot be read back faithfully: the drift
    // comparator compares arrays WHOLESALE (deepEqual), and
    // `AssociatePublicIpAddress` is launch-time-only input that
    // DescribeInstances never returns -- any reconstruction would fire
    // phantom whole-array drift on every associatePublicIpAddress
    // template (i.e. every template that has the property at all, since
    // it is what routes CDK onto this shape). Declared unreadable, like
    // Lambda's Code (issue #1281).
    // go-to-k/cdkd#5630: `PropagateTagsToVolumeOnCreation` is a
    // CloudFormation-side switch with no EC2 attribute to read back.
    // go-to-k/cdkd#5630: `AdditionalInfo`, `Ipv6AddressCount` and
    // `Ipv6Addresses` are launch inputs the schema declares write-only.
    // go-to-k/cdkd#5630: DescribeInstances names a `LaunchTemplate` only
    // through the `aws:ec2launchtemplate:*` tags (an id and a resolved
    // version number, never a name or `$Latest`), so it is not read back.
    // go-to-k/cdkd#5630: DescribeInstances reports no `Licenses` for a
    // licensed instance (measured: null on every one); only License Manager's
    // ListLicenseSpecificationsForResource reads `LicenseSpecifications`.
    case 'AWS::EC2::Instance':
      return [
        'NetworkInterfaces',
        'PropagateTagsToVolumeOnCreation',
        'AdditionalInfo',
        'Ipv6AddressCount',
        'Ipv6Addresses',
        'LaunchTemplate',
        'LicenseSpecifications',
      ];
    // go-to-k/cdkd#5633: DescribeVpcs names no IPAM pool; the netmask is
    // read back from the CIDR instead. A `monitor` encryption control
    // reports no exclusions at all (measured, us-east-1), so a declared
    // exclusion on one cannot be read back.
    case 'AWS::EC2::VPC': {
      const control = properties?.['VpcEncryptionControl'];
      const monitor =
        control !== null &&
        typeof control === 'object' &&
        (control as Record<string, unknown>)['Mode'] === 'monitor';
      return [
        'Ipv4IpamPoolId',
        ...(monitor
          ? VPC_ENCRYPTION_CONTROL_EXCLUSIONS.map((key) => `VpcEncryptionControl.${key}`)
          : []),
      ];
    }
    // go-to-k/cdkd#5632: DescribeSubnets names no IPAM pool either; each
    // netmask is read back from its block's prefix length.
    case 'AWS::EC2::Subnet':
      return ['Ipv4IpamPoolId', 'Ipv6IpamPoolId'];
    case 'AWS::EC2::Route':
    case 'AWS::EC2::VPCGatewayAttachment':
    case 'AWS::EC2::SubnetRouteTableAssociation':
    case 'AWS::EC2::SecurityGroupIngress':
    case 'AWS::EC2::NetworkAclEntry':
    case 'AWS::EC2::SubnetNetworkAclAssociation':
      return ['Tags'];
    default:
      return [];
  }
}

/**
 * The diff-side half of the two EC2 narrowings that report
 * `effectiveProperties` — Route multi-destination (issue #1591) and
 * SecurityGroupIngress `IpProtocol` (issue #1633).
 *
 * `createRoute` sends exactly one destination key and reports the narrowed
 * bag via `effectiveProperties`, so state carries one key. Without the same
 * narrowing here the template's extra keys read as an ADDED property on the
 * next deploy — and every destination key is create-only in the registry
 * schema, so the diff would classify a REPLACEMENT and the engine's
 * replacement create (whose context carries a `maskSecrets` capability but
 * never `replayingState`, and so gets no `onMultipleDestinations`
 * downgrade) would hit the #1566 refusal. A previously-green no-op deploy
 * would start failing.
 *
 * Shares `narrowRouteDestinations` with the provisioning path so the two
 * cannot disagree about which key survives.
 *
 * The SecurityGroupIngress arm is the same shape and needs the same second
 * half for the same reason: `IpProtocol` is create-only on that type in the
 * registry schema, so normalizing state alone would make the template's
 * original value read as a changed immutable property — a REPLACEMENT, whose
 * create never sets `replayingState` and so gets no `onUnusable` downgrade,
 * turning a previously-green no-op deploy into a hard failure. Normalizing BOTH sides
 * is also what keeps the fix correct for records written BEFORE it existed,
 * which still carry the un-narrowed value.
 */
export function canonicalizeDesiredProperties(
  this: EC2Provider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType === 'AWS::EC2::Subnet') {
    // go-to-k/cdkd#5632: every boolean the provider coerces folds the same
    // way, so a `"true"` / `true` spelling flip is no change (for the
    // create-only `Ipv6Native`, no replacement). An unusable value stays.
    let out = properties;
    for (const key of ['EnableDns64', 'AssignIpv6AddressOnCreation', 'Ipv6Native']) {
      const value = coerceCfnBoolean(properties[key]);
      if (value !== undefined && value !== properties[key]) out = { ...out, [key]: value };
    }
    // go-to-k/cdkd#5632: each create-only netmask is sent as the integer, so
    // a `"28"` / `28` spelling flip is no replacement.
    out = foldNetmaskSpellings(out, ['Ipv4NetmaskLength', 'Ipv6NetmaskLength']);
    const dnsKey = 'PrivateDnsNameOptionsOnLaunch';
    const dns = properties[dnsKey];
    if (
      subnetPrivateDnsOptionsRefusal(dns) === undefined &&
      dns !== null &&
      typeof dns === 'object'
    ) {
      let folded = dns as Record<string, unknown>;
      for (const member of SUBNET_PRIVATE_DNS_MEMBERS) {
        const value = subnetPrivateDnsMemberValue(dns, member);
        if (value !== undefined && value !== folded[member.member]) {
          folded = { ...folded, [member.member]: value };
        }
      }
      if (folded !== dns) out = { ...out, [dnsKey]: folded };
    }
    return out;
  }
  // go-to-k/cdkd#5632: the VPC's create-only netmask folds the same way.
  if (resourceType === 'AWS::EC2::VPC') {
    return foldNetmaskSpellings(properties, ['Ipv4NetmaskLength']);
  }
  if (resourceType === 'AWS::EC2::SecurityGroupIngress') {
    // A no-op `onUnusable` rather than the logger: a diff must not throw, and
    // must not warn either — the provisioning path announces the identical
    // substitution, and `cdkd diff` / the deploy's own diff pass would
    // otherwise emit it a second time for a resource nothing is changing.
    // Issue #1648: #1633's narrowing folds the protocol's TYPE, and #1643
    // measured that AWS ALSO substitutes a canonical NAME for four of the
    // numbers. Both sides of the diff get the name fold here, so a template
    // edit rewriting `IpProtocol: 6` to `'tcp'` compares equal instead of
    // classifying as a change — which for this create-only property meant a
    // REPLACEMENT, deleting and re-creating a rule AWS already holds exactly.
    //
    // The fold is applied HERE and not inside `narrowIngressIpProtocol`
    // deliberately: that helper also feeds the CREATE path, so folding there
    // would change what cdkd puts on the WIRE (and what `effectiveProperties`
    // records) rather than only how the diff classifies it. The wire value is
    // not the defect — AWS accepts either spelling and stores `tcp` for both.
    const { narrowed } = narrowIngressIpProtocol(properties, () => {});
    return canonicalizeSgRuleProtocol(narrowed);
  }
  // NOTE the analyzer's `IP_PROTOCOL_PATHS` covers a THIRD type,
  // `AWS::EC2::SecurityGroupEgress`, which is deliberately absent here:
  // `canonicalizeDesiredProperties` is only reached for a type with an SDK
  // provider, and that one has none (it is Cloud-Control-routed), so a branch
  // for it would be dead code. The drift comparator's table is broader
  // because it runs against whatever a state record holds, regardless of
  // route. If an SDK provider is ever added for it, add the branch here too.
  //
  // The INLINE shape (issue #1648). A SecurityGroup's own rule lists are not
  // create-only, so the stakes are lower than the standalone type's — the
  // diff would report a change and call `update()`, which since #1643 keys
  // both spellings identically and issues no revoke/authorize. Canonicalizing
  // here makes the diff report NO_CHANGE instead of a change that does
  // nothing, so `cdkd diff` stops previewing an update that cannot happen.
  if (resourceType === 'AWS::EC2::SecurityGroup') {
    return canonicalizeSgInlineRuleProtocols(properties);
  }
  if (resourceType !== 'AWS::EC2::Route') return properties;
  const { declared, narrowed } = narrowRouteDestinations(properties);
  // Untouched unless the CFn-invalid multi-destination shape is present, so
  // an ordinary single-destination route compares byte-for-byte as before.
  return declared.length > 1 ? narrowed : properties;
}

/** Each integer-valued `keys` member as the integer the create sends; an unusable value stays. */
function foldNetmaskSpellings(
  properties: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  let out = properties;
  for (const key of keys) {
    const value = coerceCfnInteger(properties[key]);
    if (value !== undefined && value !== properties[key]) out = { ...out, [key]: value };
  }
  return out;
}

/** The {@link EC2Provider} methods this module defines. */
export const driftMethods = {
  subnetIpv6InTransition,
  unsettledInTransition,
  readUnsettled,
  canonicalizeDriftPair,
  canonicalizeUnsettledProperties,
  readCurrentState,
  readCurrentStateOnce,
  getDriftUnknownPaths,
  canonicalizeDesiredProperties,
};
