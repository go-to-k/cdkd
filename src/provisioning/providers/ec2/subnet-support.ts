import type { Subnet } from '@aws-sdk/client-ec2';
import {
  coerceCfnBoolean,
  coerceCfnInteger,
  configBooleanRefusal,
  configIntegerRefusal,
  configStringRefusal,
} from '../../config-shape.js';

/**
 * go-to-k/cdkd#5632: each `PrivateDnsNameOptionsOnLaunch` member and the
 * `ModifySubnetAttribute` field that writes it, one attribute per call.
 */
export const SUBNET_PRIVATE_DNS_MEMBERS = [
  { member: 'HostnameType', field: 'PrivateDnsHostnameTypeOnLaunch', kind: 'string' },
  {
    member: 'EnableResourceNameDnsARecord',
    field: 'EnableResourceNameDnsARecordOnLaunch',
    kind: 'boolean',
  },
  {
    member: 'EnableResourceNameDnsAAAARecord',
    field: 'EnableResourceNameDnsAAAARecordOnLaunch',
    kind: 'boolean',
  },
] as const;

export const AAAA_MEMBER = SUBNET_PRIVATE_DNS_MEMBERS[2];

/**
 * go-to-k/cdkd#5632: the attributes while any of which EC2 refuses
 * DisassociateSubnetCidrBlock (`InvalidCidrBlock.InUse ... because its subnet
 * has <attribute> set to true`, each measured us-east-1), in the order they
 * are turned off; each is one ModifySubnetAttribute call, the only shape EC2
 * accepts (`Only one subnet attribute can be modified at a time`).
 */
export const SUBNET_DETACH_BLOCKERS = [
  { attribute: 'EnableDns64', unsettledKey: 'EnableDns64', live: (s: Subnet) => s.EnableDns64 },
  {
    attribute: 'AssignIpv6AddressOnCreation',
    unsettledKey: 'AssignIpv6AddressOnCreation',
    live: (s: Subnet) => s.AssignIpv6AddressOnCreation,
  },
  {
    attribute: 'EnableResourceNameDnsAAAARecordOnLaunch',
    unsettledKey: 'PrivateDnsNameOptionsOnLaunch',
    live: (s: Subnet) => s.PrivateDnsNameOptionsOnLaunch?.EnableResourceNameDnsAAAARecord,
  },
] as const;

export type SubnetDetachAttribute = (typeof SUBNET_DETACH_BLOCKERS)[number]['attribute'];

export type SubnetPrivateDnsField = (typeof SUBNET_PRIVATE_DNS_MEMBERS)[number]['field'];

/** The refusal for a malformed `PrivateDnsNameOptionsOnLaunch`; absent is usable. */
export function subnetPrivateDnsOptionsRefusal(block: unknown): string | undefined {
  const path = 'Subnet.PrivateDnsNameOptionsOnLaunch';
  for (const { member, kind } of SUBNET_PRIVATE_DNS_MEMBERS) {
    const message =
      kind === 'string'
        ? configStringRefusal(block, member, '<unset>', path)
        : configBooleanRefusal(block, member, path);
    if (message !== undefined) return message;
  }
  return undefined;
}

/** go-to-k/cdkd#5632: the CreateSubnet placement and IPAM inputs a template declared. */
export interface SubnetCreateInputs {
  availabilityZoneId?: string;
  ipv4PoolId?: string;
  ipv4NetmaskLength?: number;
  ipv6PoolId?: string;
  ipv6NetmaskLength?: number;
}

/**
 * go-to-k/cdkd#5632: `AvailabilityZoneId` and the four IPAM inputs, all
 * create-only, read for CreateSubnet. Answers the refusal for a malformed
 * value (a non-string, a BLANK string, or a netmask that is no integer in
 * its family's range) or the inputs to send. A blank value reads as a
 * value: dropping it would place or allocate the subnet somewhere the
 * template never named.
 */
export function readSubnetCreateInputs(
  properties: Record<string, unknown>,
  resourceType: string
): { refusal: string } | { inputs: SubnetCreateInputs } {
  const stringRefusal = (key: string): string | undefined =>
    configStringRefusal(properties, key, '', resourceType) ??
    (properties[key] === '' ? `${resourceType}.${key} must not be blank` : undefined);
  const refusal =
    stringRefusal('AvailabilityZoneId') ??
    stringRefusal('Ipv4IpamPoolId') ??
    configIntegerRefusal(properties, 'Ipv4NetmaskLength', resourceType, 0, 32) ??
    stringRefusal('Ipv6IpamPoolId') ??
    configIntegerRefusal(properties, 'Ipv6NetmaskLength', resourceType, 0, 128);
  if (refusal !== undefined) return { refusal };
  const text = (key: string): string | undefined =>
    typeof properties[key] === 'string' ? (properties[key] as string) : undefined;
  const inputs: SubnetCreateInputs = {};
  const availabilityZoneId = text('AvailabilityZoneId');
  if (availabilityZoneId !== undefined) inputs.availabilityZoneId = availabilityZoneId;
  const ipv4PoolId = text('Ipv4IpamPoolId');
  if (ipv4PoolId !== undefined) inputs.ipv4PoolId = ipv4PoolId;
  const ipv4NetmaskLength = coerceCfnInteger(properties['Ipv4NetmaskLength']);
  if (ipv4NetmaskLength !== undefined) inputs.ipv4NetmaskLength = ipv4NetmaskLength;
  const ipv6PoolId = text('Ipv6IpamPoolId');
  if (ipv6PoolId !== undefined) inputs.ipv6PoolId = ipv6PoolId;
  const ipv6NetmaskLength = coerceCfnInteger(properties['Ipv6NetmaskLength']);
  if (ipv6NetmaskLength !== undefined) inputs.ipv6NetmaskLength = ipv6NetmaskLength;
  return { inputs };
}

/**
 * go-to-k/cdkd#5632: the prefix length of a CIDR, the readback of a
 * declared `Ipv4NetmaskLength` / `Ipv6NetmaskLength`.
 */
export function cidrPrefixLength(cidr: string | undefined): number | undefined {
  const prefix = cidr === undefined ? undefined : /\/(\d+)$/.exec(cidr)?.[1];
  return prefix === undefined ? undefined : Number(prefix);
}

/** A usable member's wire value; `undefined` when the block does not declare it. */
export function subnetPrivateDnsMemberValue(
  block: unknown,
  member: (typeof SUBNET_PRIVATE_DNS_MEMBERS)[number]
): string | boolean | undefined {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const value = (block as Record<string, unknown>)[member.member];
  return member.kind === 'string'
    ? typeof value === 'string'
      ? value
      : undefined
    : coerceCfnBoolean(value);
}
