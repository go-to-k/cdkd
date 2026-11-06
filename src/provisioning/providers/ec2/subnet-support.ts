import type { Subnet } from '@aws-sdk/client-ec2';
import { coerceCfnBoolean, configBooleanRefusal, configStringRefusal } from '../../config-shape.js';

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
