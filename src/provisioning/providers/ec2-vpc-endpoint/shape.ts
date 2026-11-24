import type { DnsOptionsSpecification, VpcEndpoint } from '@aws-sdk/client-ec2';
import { definedAttributes } from '../../attribute-map.js';
import { isoTimestampAttribute } from '../../attribute-timestamp.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import { policyDocumentMatchesDeclared } from '../../settle-after-own-write.js';
import { readbackEc2Tags } from '../ec2/read-network-state.js';
import { dnsEntryStrings } from '../../vpc-endpoint-dns-entries.js';

/**
 * The pure halves of `EC2VPCEndpointProvider` (go-to-k/cdkd#6939): reading
 * the template's properties into `CreateVpcEndpoint` / `ModifyVpcEndpoint`
 * members, and an endpoint `DescribeVpcEndpoints` reports back into the
 * record's attributes and the drift readback.
 */

export const VPC_ENDPOINT_TYPE = 'AWS::EC2::VPCEndpoint';

/**
 * `DescribeVpcEndpoints` answers `InvalidVpcEndpointId.NotFound` for an id it
 * does not hold; `DeleteVpcEndpoints` lists it as an `Unsuccessful` item coded
 * `InvalidVpcEndpoint.NotFound` (measured, us-east-1), also for an id of
 * another account.
 */
export const VPC_ENDPOINT_NOT_FOUND_NAMES: ReadonlySet<string> = new Set([
  'InvalidVpcEndpointId.NotFound',
  'InvalidVpcEndpoint.NotFound',
]);

/** The create-only properties (the registry schema's `createOnlyProperties`). */
export const VPC_ENDPOINT_CREATE_ONLY = [
  'VpcId',
  'ServiceName',
  'VpcEndpointType',
  'ServiceNetworkArn',
  'ResourceConfigurationArn',
  'ServiceRegion',
] as const;

/** The nested create-only paths (the schema's `createOnlyPropertyPaths`). */
const VPC_ENDPOINT_CREATE_ONLY_NESTED = [
  ['DnsOptions', 'PrivateDnsPreference'],
  ['DnsOptions', 'PrivateDnsSpecifiedDomains'],
] as const;

/** A property's value with CloudFormation's default filled in for an absent `VpcEndpointType`. */
function createOnlyValue(properties: Record<string, unknown>, key: string): unknown {
  const value = properties[key] ?? null;
  return key === 'VpcEndpointType' && value === null ? 'Gateway' : value;
}

/**
 * The first create-only path whose value differs between the two bags, as
 * `Key` or `Key.Member`, or `undefined` when none does.
 */
export function createOnlyChange(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): string | undefined {
  for (const key of VPC_ENDPOINT_CREATE_ONLY) {
    if (
      JSON.stringify(createOnlyValue(properties, key)) !==
      JSON.stringify(createOnlyValue(previousProperties, key))
    ) {
      return key;
    }
  }
  const member = (bag: Record<string, unknown>, top: string, key: string): unknown => {
    const block = bag[top];
    return block !== null && typeof block === 'object' && !Array.isArray(block)
      ? ((block as Record<string, unknown>)[key] ?? null)
      : null;
  };
  for (const [top, key] of VPC_ENDPOINT_CREATE_ONLY_NESTED) {
    if (
      JSON.stringify(member(properties, top, key)) !==
      JSON.stringify(member(previousProperties, top, key))
    ) {
      return `${top}.${key}`;
    }
  }
  return undefined;
}

/**
 * The endpoint states a wait ends on. `pendingAcceptance` waits on the
 * service OWNER accepting the connection, which no deploy can bring about.
 */
const SETTLED_STATES: ReadonlySet<string> = new Set(['available', 'pendingacceptance']);
/** The states an endpoint never leaves for `available`. */
const FAILED_STATES: ReadonlySet<string> = new Set([
  'failed',
  'rejected',
  'expired',
  'partial',
  'deleting',
  'deleted',
]);

/** The endpoint's state, lower-cased (the API answers `pendingAcceptance`, the SDK enum `PendingAcceptance`). */
export function endpointState(endpoint: VpcEndpoint | undefined): string | undefined {
  const state = endpoint?.State;
  return typeof state === 'string' ? state.toLowerCase() : undefined;
}

/** Whether a wait for the endpoint is over, still running, or failed. */
export function endpointWaitVerdict(
  endpoint: VpcEndpoint | undefined
): 'settled' | 'pending' | 'failed' {
  const state = endpointState(endpoint);
  if (state !== undefined && SETTLED_STATES.has(state)) return 'settled';
  if (state !== undefined && FAILED_STATES.has(state)) return 'failed';
  return 'pending';
}

/** A read of a list of ids: absent, a usable list, or not a list of non-empty strings. */
export type IdListRead =
  | { kind: 'absent' }
  | { kind: 'usable'; ids: string[] }
  | { kind: 'malformed' };

export function readIdList(value: unknown): IdListRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v !== '')) {
    return { kind: 'malformed' };
  }
  return { kind: 'usable', ids: [...new Set(value as string[])] };
}

/** A read of `PolicyDocument`: an object is sent as its JSON text, a string as it is. */
export type PolicyRead =
  | { kind: 'absent' }
  | { kind: 'usable'; text: string }
  | { kind: 'malformed' };

export function readPolicyDocument(value: unknown): PolicyRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value === 'string') {
    return value === '' ? { kind: 'malformed' } : { kind: 'usable', text: value };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { kind: 'usable', text: JSON.stringify(value) };
  }
  return { kind: 'malformed' };
}

/** A read of a boolean property: absent, a boolean, or a value that is neither. */
export type BooleanRead =
  | { kind: 'absent' }
  | { kind: 'usable'; value: boolean }
  | { kind: 'malformed' };

export function readBoolean(value: unknown): BooleanRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  const flag = coerceCfnBoolean(value);
  return flag === undefined ? { kind: 'malformed' } : { kind: 'usable', value: flag };
}

/**
 * CloudFormation's `DnsOptions.PrivateDnsOnlyForInboundResolverEndpoint` is an
 * enum; the SDK member is a boolean. `NotSpecified` sends nothing.
 */
const INBOUND_RESOLVER_TO_SDK: Readonly<Record<string, boolean | undefined>> = {
  OnlyInboundResolver: true,
  AllResolvers: false,
  NotSpecified: undefined,
};

const DNS_OPTIONS_MEMBERS: ReadonlySet<string> = new Set([
  'DnsRecordIpType',
  'PrivateDnsOnlyForInboundResolverEndpoint',
  'PrivateDnsPreference',
  'PrivateDnsSpecifiedDomains',
]);

export type DnsOptionsRead =
  | { kind: 'absent' }
  | { kind: 'usable'; spec: DnsOptionsSpecification }
  | { kind: 'malformed'; reason: string };

/** `DnsOptions` as the SDK's `DnsOptionsSpecification`, every member converted by name. */
export function readDnsOptions(value: unknown): DnsOptionsRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'malformed', reason: 'must be an object' };
  }
  const block = value as Record<string, unknown>;
  const unknown = Object.keys(block).filter((k) => !DNS_OPTIONS_MEMBERS.has(k));
  if (unknown.length > 0) {
    return {
      kind: 'malformed',
      reason: `names members the type does not have: ${unknown.join(', ')}`,
    };
  }
  const spec: DnsOptionsSpecification = {};
  for (const key of ['DnsRecordIpType', 'PrivateDnsPreference'] as const) {
    const member = block[key];
    if (member === undefined || member === null) continue;
    if (typeof member !== 'string' || member === '') {
      return { kind: 'malformed', reason: `${key} must be a non-empty string` };
    }
    (spec as Record<string, unknown>)[key] = member;
  }
  const inbound = block['PrivateDnsOnlyForInboundResolverEndpoint'];
  if (inbound !== undefined && inbound !== null) {
    if (typeof inbound === 'string' && Object.hasOwn(INBOUND_RESOLVER_TO_SDK, inbound)) {
      const flag = INBOUND_RESOLVER_TO_SDK[inbound];
      if (flag !== undefined) spec.PrivateDnsOnlyForInboundResolverEndpoint = flag;
    } else if (typeof inbound === 'boolean') {
      spec.PrivateDnsOnlyForInboundResolverEndpoint = inbound;
    } else {
      return {
        kind: 'malformed',
        reason:
          'PrivateDnsOnlyForInboundResolverEndpoint must be OnlyInboundResolver, AllResolvers or NotSpecified',
      };
    }
  }
  const domains = block['PrivateDnsSpecifiedDomains'];
  if (domains !== undefined && domains !== null) {
    if (!Array.isArray(domains) || !domains.every((d) => typeof d === 'string' && d !== '')) {
      return {
        kind: 'malformed',
        reason: 'PrivateDnsSpecifiedDomains must be a list of domain names',
      };
    }
    spec.PrivateDnsSpecifiedDomains = [...(domains as string[])];
  }
  return { kind: 'usable', spec };
}

/** An optional string property: absent, a non-empty string, or anything else. */
export function readOptionalString(
  value: unknown
): { kind: 'absent' } | { kind: 'usable'; value: string } | { kind: 'malformed' } {
  if (value === undefined || value === null) return { kind: 'absent' };
  return typeof value === 'string' && value !== ''
    ? { kind: 'usable', value }
    : { kind: 'malformed' };
}

/**
 * The record's attributes from one `DescribeVpcEndpoints` (or
 * `CreateVpcEndpoint`) answer. `withNetwork: false` leaves out `DnsEntries`
 * and `NetworkInterfaceIds`, so an `Fn::GetAtt` of either reads the endpoint
 * live (`getatt-construct-core.ts`) instead of a value taken mid-change.
 */
export function vpcEndpointAttributes(
  endpoint: VpcEndpoint | undefined,
  physicalId: string,
  withNetwork: boolean
): Record<string, unknown> {
  return definedAttributes({
    Id: physicalId,
    CreationTimestamp: isoTimestampAttribute(endpoint?.CreationTimestamp),
    DnsEntries: withNetwork && endpoint !== undefined ? dnsEntryStrings(endpoint) : undefined,
    NetworkInterfaceIds:
      withNetwork && endpoint !== undefined ? [...(endpoint.NetworkInterfaceIds ?? [])] : undefined,
  });
}

/** The CFn spelling of a live `PrivateDnsOnlyForInboundResolverEndpoint`, in the declared form. */
function inboundResolverReadback(live: boolean | undefined, declared: unknown): unknown {
  if (typeof declared === 'boolean') return live;
  if (declared === 'NotSpecified' && live !== true) return 'NotSpecified';
  if (live === undefined) return undefined;
  return live ? 'OnlyInboundResolver' : 'AllResolvers';
}

/**
 * The live endpoint as the CloudFormation properties the record holds. Ids
 * are read back whenever any is live or the record declares the list;
 * `PolicyDocument`, `DnsOptions` and `ServiceRegion` only when the record
 * declares them, since EC2 fills each with a default the template never set.
 * A declared policy equal in content to the live one reads back as declared.
 */
export function readbackVpcEndpoint(
  endpoint: VpcEndpoint,
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (endpoint.VpcId !== undefined) result['VpcId'] = endpoint.VpcId;
  if (endpoint.ServiceName !== undefined) result['ServiceName'] = endpoint.ServiceName;
  if (endpoint.VpcEndpointType !== undefined) result['VpcEndpointType'] = endpoint.VpcEndpointType;
  const lists: ReadonlyArray<[string, string[]]> = [
    ['SubnetIds', endpoint.SubnetIds ?? []],
    ['SecurityGroupIds', (endpoint.Groups ?? []).flatMap((g) => (g.GroupId ? [g.GroupId] : []))],
    ['RouteTableIds', endpoint.RouteTableIds ?? []],
  ];
  for (const [key, ids] of lists) {
    if (ids.length > 0 || properties?.[key] != null) result[key] = ids;
  }
  if (typeof endpoint.PrivateDnsEnabled === 'boolean') {
    result['PrivateDnsEnabled'] = endpoint.PrivateDnsEnabled;
  }
  if (endpoint.IpAddressType !== undefined) result['IpAddressType'] = endpoint.IpAddressType;
  const declaredPolicy = properties?.['PolicyDocument'];
  if (declaredPolicy != null && typeof endpoint.PolicyDocument === 'string') {
    result['PolicyDocument'] = policyDocumentMatchesDeclared(
      endpoint.PolicyDocument,
      declaredPolicy
    )
      ? declaredPolicy
      : parsedPolicy(endpoint.PolicyDocument);
  }
  const declaredDns = properties?.['DnsOptions'];
  if (declaredDns !== null && typeof declaredDns === 'object' && !Array.isArray(declaredDns)) {
    const declared = declaredDns as Record<string, unknown>;
    const live = endpoint.DnsOptions ?? {};
    const out: Record<string, unknown> = {};
    if ('DnsRecordIpType' in declared && live.DnsRecordIpType !== undefined) {
      out['DnsRecordIpType'] = live.DnsRecordIpType;
    }
    if ('PrivateDnsOnlyForInboundResolverEndpoint' in declared) {
      const value = inboundResolverReadback(
        live.PrivateDnsOnlyForInboundResolverEndpoint,
        declared['PrivateDnsOnlyForInboundResolverEndpoint']
      );
      if (value !== undefined) out['PrivateDnsOnlyForInboundResolverEndpoint'] = value;
    }
    if ('PrivateDnsPreference' in declared && live.PrivateDnsPreference !== undefined) {
      out['PrivateDnsPreference'] = live.PrivateDnsPreference;
    }
    if ('PrivateDnsSpecifiedDomains' in declared && live.PrivateDnsSpecifiedDomains !== undefined) {
      out['PrivateDnsSpecifiedDomains'] = [...live.PrivateDnsSpecifiedDomains];
    }
    result['DnsOptions'] = out;
  }
  if (properties?.['ServiceRegion'] != null && endpoint.ServiceRegion !== undefined) {
    result['ServiceRegion'] = endpoint.ServiceRegion;
  }
  if (endpoint.ServiceNetworkArn) result['ServiceNetworkArn'] = endpoint.ServiceNetworkArn;
  if (endpoint.ResourceConfigurationArn) {
    result['ResourceConfigurationArn'] = endpoint.ResourceConfigurationArn;
  }
  const tags = readbackEc2Tags(endpoint.Tags, properties, false);
  if (tags !== undefined) result['Tags'] = tags;
  return result;
}

function parsedPolicy(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
