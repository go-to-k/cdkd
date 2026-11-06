import { type CompositeIdFormat } from '../../composite-id.js';

/** Shapes of the four `AWS::EC2::*` composite physicalIds (issue #1657). */
export const EC2_VPC_GATEWAY_ATTACHMENT_ID_FORMAT: CompositeIdFormat = {
  label: 'VPCGatewayAttachment',
  // Matches `createVpcGatewayAttachment`'s packer, which emits the REAL gateway
  // id: an internet gateway's `igw-…` or a VPN gateway's `vgw-…` (issue #2762),
  // the prefix being what `delete` / `readCurrentState` branch on. The
  // pre-#1657 text said `IGW|VpcId`; `IGW` is a token no code path produces,
  // and a user repairing state.json as instructed would have called
  // `DetachInternetGateway(InternetGatewayId: "IGW")`. A Cloud-Control-written
  // record carries an attachment TYPE here instead (`IGW` / `VGW` — see
  // `export.ts`), which the message does not try to express: the shape it
  // names is the one cdkd's own packer writes.
  segments: ['gatewayId', 'vpcId'],
};

/**
 * How long a VPN gateway attachment may take to reach `attached` / `detached`
 * (issue #2762). Both transitions are asynchronous on AWS's side; the outer
 * per-resource `--resource-timeout` still bounds the whole call.
 */
export const VPN_GATEWAY_ATTACHMENT_WAIT_MS = 10 * 60 * 1000;

/** `DetachVpnGateway`'s answer for an attachment that is not `attached` right now. */
export const VPN_DETACH_IN_PROGRESS_ERRORS: ReadonlySet<string> = new Set(['IncorrectState']);

export const EC2_ROUTE_ID_FORMAT: CompositeIdFormat = {
  label: 'Route',
  segments: ['routeTableId', 'destination'],
};

export const EC2_SG_INGRESS_ID_FORMAT: CompositeIdFormat = {
  label: 'SecurityGroupIngress',
  segments: ['groupId', 'ipProtocol', 'fromPort', 'toPort'],
};

export const EC2_NETWORK_ACL_ENTRY_ID_FORMAT: CompositeIdFormat = {
  label: 'NetworkAclEntry',
  segments: ['networkAclId', 'ruleNumber', 'egress'],
};

/**
 * The `AWS::EC2::Route` destination keys, in CloudFormation's own precedence
 * order — which is also the order `createRoute`'s
 * `DestinationCidrBlock || DestinationIpv6CidrBlock || DestinationPrefixListId`
 * chain resolves them.
 */
const ROUTE_DESTINATION_KEYS = [
  'DestinationCidrBlock',
  'DestinationIpv6CidrBlock',
  'DestinationPrefixListId',
] as const;

/**
 * Split a Route property bag into the destination keys it DECLARES and the bag
 * carrying only the one that would actually be sent (issue #1591).
 *
 * ONE source for a decision two very different call sites have to agree on: the
 * provisioning path (`createRoute`, which narrows and warns) and the DIFF path
 * (the engine's canonicalizer, which must not report the losers as a change).
 * If those two disagreed the fix would be worse than the bug — state and
 * template would each be narrowed to a different key.
 *
 * The winner is simply `declared[0]`. That is not a shortcut: the list is built
 * in the same order and with the same truthiness predicate as the `||` chain,
 * so the first declared key IS what the chain resolves to. The predicate is
 * `Boolean`, not a hand-listed `undefined | null | ''` set, because the bag is
 * `unknown`-valued at runtime — an unquoted YAML `0` must be skipped by the
 * narrowing exactly as the chain skips it, or the two disagree on which key
 * was sent.
 *
 * `narrowed` is always a fresh object: the caller's bag is the engine's
 * `resolvedProps`, which it records for every resource that does NOT narrow.
 */
export function narrowRouteDestinations(properties: Record<string, unknown>): {
  declared: string[];
  narrowed: Record<string, unknown>;
} {
  const declared = ROUTE_DESTINATION_KEYS.filter((key) => Boolean(properties[key]));
  const narrowed = { ...properties };
  for (const losingKey of declared.slice(1)) delete narrowed[losingKey];
  return { declared, narrowed };
}

/**
 * The route TARGET keys `createRoute` and `updateRoute`'s `ReplaceRoute` arm
 * send (issue #5068), read from one list so the two calls cannot disagree on
 * which targets they carry. Every one is an "Update requires: No interruption"
 * property in the CloudFormation schema and a field of both `CreateRouteRequest`
 * and `ReplaceRouteRequest`, `OdbNetworkArn` (an Oracle Database@AWS network,
 * issue #5631) included.
 */
export function routeTargetParams(properties: Record<string, unknown>) {
  return {
    CarrierGatewayId: (properties['CarrierGatewayId'] as string) ?? undefined,
    CoreNetworkArn: (properties['CoreNetworkArn'] as string) ?? undefined,
    GatewayId: (properties['GatewayId'] as string) ?? undefined,
    LocalGatewayId: (properties['LocalGatewayId'] as string) ?? undefined,
    NatGatewayId: (properties['NatGatewayId'] as string) ?? undefined,
    EgressOnlyInternetGatewayId: (properties['EgressOnlyInternetGatewayId'] as string) ?? undefined,
    InstanceId: (properties['InstanceId'] as string) ?? undefined,
    NetworkInterfaceId: (properties['NetworkInterfaceId'] as string) ?? undefined,
    OdbNetworkArn: (properties['OdbNetworkArn'] as string) ?? undefined,
    TransitGatewayId: (properties['TransitGatewayId'] as string) ?? undefined,
    VpcEndpointId: (properties['VpcEndpointId'] as string) ?? undefined,
    VpcPeeringConnectionId: (properties['VpcPeeringConnectionId'] as string) ?? undefined,
  };
}

/**
 * The rule fields `createNetworkAclEntry` and `updateNetworkAclEntry`'s
 * `ReplaceNetworkAclEntry` send (issue #5070), from one place so the two calls
 * cannot disagree. Every one is "Update requires: No interruption" in the
 * CloudFormation schema; the entry's identity (`NetworkAclId`, `RuleNumber`,
 * `Egress`) is createOnly and set by each caller.
 */
export function networkAclEntryRuleParams(
  properties: Record<string, unknown>,
  preferLegacyIcmp = false
) {
  const portRange = properties['PortRange'] as Record<string, unknown> | undefined;
  // CFn schema spells this property `Icmp`; the AWS API takes the same shape
  // under the key `IcmpTypeCode`. Accept both: CFn-canonical (template authors
  // / CDK L1) prefers `Icmp`; legacy state files written by pre-#613-fix cdkd
  // carry `IcmpTypeCode`, so fall back to it for backward compat (e.g. a
  // re-deploy after a binary upgrade where state.properties has the legacy key).
  // `preferLegacyIcmp`: the caller saw only `IcmpTypeCode` change while both
  // keys are present (see `updateNetworkAclEntry`).
  const icmpTypeCode = (
    preferLegacyIcmp
      ? properties['IcmpTypeCode']
      : (properties['Icmp'] ?? properties['IcmpTypeCode'])
  ) as Record<string, unknown> | undefined;
  return {
    Protocol: String(properties['Protocol']),
    RuleAction: properties['RuleAction'] as 'allow' | 'deny',
    CidrBlock: properties['CidrBlock'] as string | undefined,
    Ipv6CidrBlock: properties['Ipv6CidrBlock'] as string | undefined,
    PortRange: portRange
      ? { From: portRange['From'] as number, To: portRange['To'] as number }
      : undefined,
    IcmpTypeCode: icmpTypeCode
      ? { Code: icmpTypeCode['Code'] as number, Type: icmpTypeCode['Type'] as number }
      : undefined,
  };
}

/**
 * The multi-destination refusal sentence, shared by `createRoute`'s guard and
 * `updateRoute`'s template-path pre-flight (issue #3728) so the two cannot
 * word the same fault differently.
 */
export function routeMultipleDestinationsMessage(logicalId: string, declared: string[]): string {
  return (
    `Route ${logicalId} declares more than one destination (${declared.join(', ')}). ` +
    'CloudFormation and EC2 accept exactly one of ' +
    'DestinationCidrBlock/DestinationIpv6CidrBlock/DestinationPrefixListId; ' +
    'remove the extra keys from the template.'
  );
}
