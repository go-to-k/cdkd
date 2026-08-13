import {
  EC2Client,
  CreateVpcCommand,
  DeleteVpcCommand,
  ModifyVpcAttributeCommand,
  DescribeVpcAttributeCommand,
  DescribeVpcsCommand,
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  CreateSubnetCommand,
  DeleteSubnetCommand,
  CreateInternetGatewayCommand,
  DeleteInternetGatewayCommand,
  AttachInternetGatewayCommand,
  DetachInternetGatewayCommand,
  CreateNatGatewayCommand,
  DeleteNatGatewayCommand,
  DescribeNatGatewaysCommand,
  waitUntilNatGatewayAvailable,
  AllocateAddressCommand,
  ReleaseAddressCommand,
  DescribeAddressesCommand,
  AssociateAddressCommand,
  DisassociateAddressCommand,
  waitUntilNatGatewayDeleted,
  CreateRouteTableCommand,
  DeleteRouteTableCommand,
  CreateRouteCommand,
  DeleteRouteCommand,
  AssociateRouteTableCommand,
  DisassociateRouteTableCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  AuthorizeSecurityGroupEgressCommand,
  RevokeSecurityGroupEgressCommand,
  CreateTagsCommand,
  DeleteTagsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeSecurityGroupRulesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  AssociateIamInstanceProfileCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  ModifyInstanceAttributeCommand,
  ModifyInstanceMetadataOptionsCommand,
  ModifyInstanceCreditSpecificationCommand,
  DescribeInstanceCreditSpecificationsCommand,
  MonitorInstancesCommand,
  UnmonitorInstancesCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceTerminated,
  ModifySubnetAttributeCommand,
  CreateNetworkAclCommand,
  DeleteNetworkAclCommand,
  CreateNetworkAclEntryCommand,
  DeleteNetworkAclEntryCommand,
  ReplaceNetworkAclAssociationCommand,
  DescribeNetworkAclsCommand,
  DescribeNetworkInterfacesCommand,
  DeleteNetworkInterfaceCommand,
  DescribeVolumesCommand,
  DescribeInstanceAttributeCommand,
  type Tenancy,
  type _InstanceType,
  type VolumeType,
  type BlockDeviceMapping,
  type IpPermission,
  type SecurityGroupRule,
  type Volume,
  type InstanceMetadataOptionsRequest,
  type CreditSpecificationRequest,
  type InstanceNetworkInterfaceSpecification,
  type HttpTokensState,
  type InstanceMetadataEndpointState,
  type InstanceMetadataProtocolState,
  type InstanceMetadataTagsState,
} from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import {
  compositeIdFormatMessage,
  compositeIdSeparatorRefusal,
  compositeIdSkipResult,
  packCompositeId,
  type CompositeIdFormat,
  type CompositeIdOptions,
} from '../composite-id.js';
import {
  disableInstanceApiTermination,
  isTerminationProtectionPropagationError,
  TERMINATION_PROTECTION_MAX_ATTEMPTS,
} from '../ec2-termination-protection.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { canonicalizeIpProtocolValue } from '../../utils/ip-protocol.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/** Shapes of the four `AWS::EC2::*` composite physicalIds (issue #1657). */
const EC2_VPC_GATEWAY_ATTACHMENT_ID_FORMAT: CompositeIdFormat = {
  label: 'VPCGatewayAttachment',
  // Matches `createVpcGatewayAttachment`'s packer, which emits the REAL
  // `internetGatewayId`. The pre-#1657 text said `IGW|VpcId`; `IGW` is a token
  // no code path produces, and a user repairing state.json as instructed would
  // have called `DetachInternetGateway(InternetGatewayId: "IGW")`. A
  // Cloud-Control-written record can carry an attachment TYPE here instead
  // (`InternetGateway` / `VPN` — see `export.ts`), which the message does not
  // try to express: the shape it names is the one cdkd's own packer writes.
  segments: ['internetGatewayId', 'vpcId'],
};

const EC2_ROUTE_ID_FORMAT: CompositeIdFormat = {
  label: 'Route',
  segments: ['routeTableId', 'destination'],
};

const EC2_SG_INGRESS_ID_FORMAT: CompositeIdFormat = {
  label: 'SecurityGroupIngress',
  segments: ['groupId', 'ipProtocol', 'fromPort', 'toPort'],
};

const EC2_NETWORK_ACL_ENTRY_ID_FORMAT: CompositeIdFormat = {
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

/** The `AuthorizeSecurityGroupIngress` default protocol: "all protocols". */
const SG_INGRESS_IP_PROTOCOL_DEFAULT = '-1';

/** The refusal path both the create guard and the canonicalizer report under. */
const SG_INGRESS_IP_PROTOCOL_PATH = 'AWS::EC2::SecurityGroupIngress IpProtocol';

/**
 * Resolve the `IpProtocol` an `AWS::EC2::SecurityGroupIngress` rule actually
 * SENDS, plus the bag that describes it (issue #1633).
 *
 * ONE source for a decision three call sites have to agree on, exactly as
 * `narrowRouteDestinations` is for the Route destinations: the create arm
 * (which authorizes the rule), the update arm (which revokes then re-creates
 * it), and the DIFF-side canonicalizer. If those disagreed, state and template
 * would each be normalized to a different protocol and the fix would become
 * the bug — the lesson `.claude/rules/providers.md` records from #1591.
 *
 * Two shapes reach the wire as something other than what the template wrote,
 * and BOTH have to be recorded or they become permanent phantom drift, because
 * `readSecurityGroupIngressCurrentState` can only ever return what AWS holds:
 *
 * - a MALFORMED value (`''` / `{}` / `true` / an explicit `null`), which
 *   `requireConfigString` refuses on the template-path create and — under
 *   `onUnusable` — warn-substitutes the default on the replay-reachable paths;
 * - a finite NUMBER, the accepted-by-design shape from an unquoted YAML
 *   `IpProtocol: -1` (issue #1513), which is stringified before it is sent.
 *
 * The second is not announced by a warning, and does not need to be: unlike a
 * dropped destination key it loses NOTHING — `-1` and `'-1'` name the same
 * protocol — so there is no silent loss for `effectiveProperties` to launder
 * into a clean record, which is the hazard the "already ANNOUNCED" clause of
 * the `effectiveProperties` contract exists to guard against. Recording the
 * string additionally fixes the delete path, which forwards the state record
 * to `buildIpPermission` and would otherwise hand the EC2 API a number.
 *
 * `narrowed` is a FRESH object only when the sent value differs from the
 * declared one, so an ordinary `IpProtocol: 'tcp'` bag is returned untouched
 * and compares byte-for-byte as before.
 *
 * @param onUnusable Passed straight through to `requireConfigString`: absent,
 *   a malformed value THROWS (the template-path create, where the user can fix
 *   the template); supplied, it warns and takes the default. The canonicalizer
 *   passes a no-op — a diff must never throw, and it must never warn either,
 *   since the provisioning path already announces the same substitution.
 */
export function narrowIngressIpProtocol(
  properties: Record<string, unknown>,
  onUnusable?: (message: string) => void
): { ipProtocol: string; narrowed: Record<string, unknown> } {
  const declared = properties['IpProtocol'];
  const ipProtocol = requireConfigString(
    declared,
    SG_INGRESS_IP_PROTOCOL_DEFAULT,
    SG_INGRESS_IP_PROTOCOL_PATH,
    { coerceNumber: true, ...(onUnusable && { onUnusable }) }
  );

  // An ABSENT key stays absent. The drift comparator only descends into keys
  // present in cdkd state, so adding the default here would START comparing a
  // key the template never declared — manufacturing the very drift this helper
  // removes, in the one case that does not have it today.
  if (declared === undefined || declared === ipProtocol) {
    return { ipProtocol, narrowed: properties };
  }
  return { ipProtocol, narrowed: { ...properties, IpProtocol: ipProtocol } };
}

/**
 * Fold a rule bag's `IpProtocol` to the spelling AWS will hold (issue #1648).
 *
 * DIFF-side only — see the call site in `canonicalizeDesiredProperties` for why
 * this is not done inside `narrowIngressIpProtocol`, which also feeds the wire.
 * Returns the original object when nothing changes, so an ordinary rule
 * compares byte-for-byte as before.
 */
function canonicalizeSgRuleProtocol(rule: Record<string, unknown>): Record<string, unknown> {
  if (!('IpProtocol' in rule)) return rule;
  const next = canonicalizeIpProtocolValue(rule['IpProtocol']);
  if (next === rule['IpProtocol']) return rule;
  return { ...rule, IpProtocol: next };
}

/**
 * The `AWS::EC2::SecurityGroup` inline-rule twin of
 * {@link canonicalizeSgRuleProtocol}: fold every element of the two rule lists.
 * Identity-returns when nothing changes, and leaves a non-array list or a
 * non-object element alone so a malformed template still reaches AWS's own
 * validation rather than being reshaped here.
 */
function canonicalizeSgInlineRuleProtocols(
  properties: Record<string, unknown>
): Record<string, unknown> {
  let out = properties;
  for (const key of ['SecurityGroupIngress', 'SecurityGroupEgress'] as const) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    let changed = false;
    const mapped = list.map((el) => {
      if (el === null || typeof el !== 'object' || Array.isArray(el)) return el;
      const next = canonicalizeSgRuleProtocol(el as Record<string, unknown>);
      if (next !== el) changed = true;
      return next;
    });
    if (changed) out = { ...out, [key]: mapped };
  }
  return out;
}

/**
 * AWS EC2 Networking Provider
 *
 * Implements resource provisioning for EC2 networking resources:
 * - AWS::EC2::VPC
 * - AWS::EC2::Subnet
 * - AWS::EC2::InternetGateway
 * - AWS::EC2::VPCGatewayAttachment
 * - AWS::EC2::RouteTable
 * - AWS::EC2::Route
 * - AWS::EC2::SubnetRouteTableAssociation
 * - AWS::EC2::SecurityGroup
 * - AWS::EC2::SecurityGroupIngress
 * - AWS::EC2::Instance
 */
export class EC2Provider implements ResourceProvider {
  private ec2Client: EC2Client;
  private logger = getLogger().child('EC2Provider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EC2::VPC',
      new Set(['CidrBlock', 'InstanceTenancy', 'EnableDnsHostnames', 'EnableDnsSupport', 'Tags']),
    ],
    [
      'AWS::EC2::Subnet',
      new Set(['VpcId', 'CidrBlock', 'AvailabilityZone', 'MapPublicIpOnLaunch', 'Tags']),
    ],
    ['AWS::EC2::InternetGateway', new Set(['Tags'])],
    [
      'AWS::EC2::EIP',
      new Set(['Domain', 'InstanceId', 'NetworkBorderGroup', 'PublicIpv4Pool', 'Tags']),
    ],
    ['AWS::EC2::VPCGatewayAttachment', new Set(['VpcId', 'InternetGatewayId'])],
    [
      'AWS::EC2::NatGateway',
      new Set([
        'AllocationId',
        'SubnetId',
        'ConnectivityType',
        'PrivateIpAddress',
        'SecondaryAllocationIds',
        'SecondaryPrivateIpAddresses',
        'SecondaryPrivateIpAddressCount',
        'Tags',
      ]),
    ],
    ['AWS::EC2::RouteTable', new Set(['VpcId', 'Tags'])],
    [
      'AWS::EC2::Route',
      new Set([
        'RouteTableId',
        'DestinationCidrBlock',
        'DestinationIpv6CidrBlock',
        'DestinationPrefixListId',
        'CarrierGatewayId',
        'CoreNetworkArn',
        'GatewayId',
        'LocalGatewayId',
        'NatGatewayId',
        'EgressOnlyInternetGatewayId',
        'InstanceId',
        'NetworkInterfaceId',
        'TransitGatewayId',
        'VpcEndpointId',
        'VpcPeeringConnectionId',
      ]),
    ],
    ['AWS::EC2::SubnetRouteTableAssociation', new Set(['SubnetId', 'RouteTableId'])],
    [
      'AWS::EC2::SecurityGroup',
      new Set([
        'GroupDescription',
        'GroupName',
        'VpcId',
        'SecurityGroupIngress',
        'SecurityGroupEgress',
        'Tags',
      ]),
    ],
    [
      'AWS::EC2::SecurityGroupIngress',
      new Set([
        'GroupId',
        'IpProtocol',
        'FromPort',
        'ToPort',
        'CidrIp',
        'CidrIpv6',
        'Description',
        'SourceSecurityGroupId',
        'SourceSecurityGroupOwnerId',
        'SourcePrefixListId',
      ]),
    ],
    [
      'AWS::EC2::Instance',
      new Set([
        'ImageId',
        'InstanceType',
        'KeyName',
        'SecurityGroupIds',
        'SecurityGroups',
        'SubnetId',
        'IamInstanceProfile',
        'UserData',
        'BlockDeviceMappings',
        'Tags',
        // Issue #1276: the CDK L2 `ec2.Instance` construct ALWAYS emits
        // AvailabilityZone (from the selected subnet), so leaving it
        // unhandled routed every ordinary CDK-authored instance onto the
        // Cloud Control path via the #614 silent-drop rule -- paying CC's
        // async polling for a resource this provider handles directly, and
        // leaving the whole SDK create/update/readback surface (including
        // the #609 backfill) dead code for L2 users. Maps to
        // RunInstances' `Placement.AvailabilityZone`.
        'AvailabilityZone',
        // Issue #1281: setting `associatePublicIpAddress` (either value) makes
        // the CDK L2 construct DROP SubnetId / SecurityGroupIds and emit
        // NetworkInterfaces instead, so leaving it unhandled routed every
        // public-subnet instance authored the CDK-docs way onto the Cloud
        // Control path. Maps onto RunInstances' `NetworkInterfaces` input;
        // mutually exclusive with top-level SubnetId / SecurityGroupIds at
        // the API (cdkd passes through whichever shape the template carries).
        'NetworkInterfaces',
        // Security-focused backfill (#609): wired into create() + update() +
        // readCurrentState(). All five are mutable in-place (no replacement).
        'DisableApiTermination',
        'MetadataOptions',
        'Monitoring',
        'EbsOptimized',
        'CreditSpecification',
      ]),
    ],
    ['AWS::EC2::NetworkAcl', new Set(['VpcId', 'Tags'])],
    [
      'AWS::EC2::NetworkAclEntry',
      new Set([
        'NetworkAclId',
        'RuleNumber',
        'Protocol',
        'RuleAction',
        'Egress',
        'CidrBlock',
        'Ipv6CidrBlock',
        'PortRange',
        'Icmp',
      ]),
    ],
    ['AWS::EC2::SubnetNetworkAclAssociation', new Set(['SubnetId', 'NetworkAclId'])],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::EC2::Instance',
      new Map<string, string>([
        [
          'ElasticGpuSpecifications',
          'AWS Elastic GPU end-of-life (announced 2023-11); no replacement API',
        ],
        [
          'ElasticInferenceAccelerators',
          'AWS Elastic Inference end-of-life 2024-04; use AWS Inferentia / Trainium accelerator instance families instead',
        ],
      ]),
    ],
    [
      'AWS::EC2::SecurityGroupIngress',
      new Map<string, string>([
        [
          'GroupName',
          'EC2-Classic-only — use GroupId for VPC security groups (EC2-Classic retired 2022-08-15)',
        ],
        [
          'SourceSecurityGroupName',
          'EC2-Classic-only — use SourceSecurityGroupId for VPC peer security groups (EC2-Classic retired 2022-08-15)',
        ],
      ]),
    ],
    [
      'AWS::EC2::NatGateway',
      new Map<string, string>([
        [
          'VpcId',
          'AWS derives the VPC from SubnetId; the ec2:CreateNatGateway API has no VpcId parameter',
        ],
        [
          // Issue #1411. Verified against the installed @aws-sdk/client-ec2:
          // `CreateNatGatewayRequest` (models/models_1.d.ts) has NO
          // `MaxDrainDurationSeconds` member, and EC2 ships no
          // `ModifyNatGateway*` operation at all. The ONLY two SDK inputs
          // carrying the field are `DisassociateNatGatewayAddressRequest`
          // (models/models_5.d.ts) and `UnassignPrivateNatGatewayAddressRequest`
          // (models/models_7.d.ts) — i.e. it is a per-call drain timeout for
          // RELEASING secondary addresses, which is why the CFn registry schema
          // lists it under `writeOnlyProperties` (no read handler can return
          // it). cdkd's NatGateway update path rejects every property change
          // (`ResourceUpdateNotSupportedError`, see `updateNatGateway`), so it
          // never issues those two calls and has nowhere to deliver the value.
          // It is NOT modelled as a replacement trigger either: the registry
          // schema does not list it under `createOnlyProperties`, so recreating
          // the gateway on a drain-timeout change would diverge from
          // CloudFormation and needlessly break the data plane. Declaring the
          // silent drop here routes any template that sets it through the #614
          // Cloud Control fallback, where AWS's own resource handler applies it.
          'MaxDrainDurationSeconds',
          'write-only address-drain timeout with no CreateNatGateway member and no NAT gateway modify API; only ec2:DisassociateNatGatewayAddress / UnassignPrivateNatGatewayAddress accept it, and cdkd rejects NatGateway updates outright — routed via Cloud Control instead',
        ],
      ]),
    ],
    [
      'AWS::EC2::EIP',
      new Map<string, string>([
        [
          'Address',
          'Bring-your-own-IP: allocating a specific address you own is not yet supported; cdkd allocates an Amazon-owned address',
        ],
        ['IpamPoolId', 'Allocation from an IPAM pool is not yet supported'],
        [
          'TransferAddress',
          'Accepting a transferred Elastic IP is not yet supported (out-of-band EIP transfer flow)',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.ec2Client = awsClients.ec2;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return this.createVpc(logicalId, resourceType, properties);
      case 'AWS::EC2::Subnet':
        return this.createSubnet(logicalId, resourceType, properties);
      case 'AWS::EC2::InternetGateway':
        return this.createInternetGateway(logicalId, resourceType, properties);
      case 'AWS::EC2::EIP':
        return this.createEip(logicalId, resourceType, properties, context);
      case 'AWS::EC2::VPCGatewayAttachment':
        return this.createVpcGatewayAttachment(logicalId, resourceType, properties, context);
      case 'AWS::EC2::NatGateway':
        return this.createNatGateway(logicalId, resourceType, properties);
      case 'AWS::EC2::RouteTable':
        return this.createRouteTable(logicalId, resourceType, properties);
      case 'AWS::EC2::Route':
        return this.createRoute(
          logicalId,
          resourceType,
          properties,
          // A reverse-replacement rollback creates from a STATE record, so the
          // refusal downgrades here exactly as it does on the update path.
          context?.replayingState === true ? (message) => this.logger.warn(message) : undefined
        );
      case 'AWS::EC2::SubnetRouteTableAssociation':
        return this.createSubnetRouteTableAssociation(logicalId, resourceType, properties);
      case 'AWS::EC2::SecurityGroup':
        return this.createSecurityGroup(logicalId, resourceType, properties);
      case 'AWS::EC2::SecurityGroupIngress':
        return this.createSecurityGroupIngress(
          logicalId,
          resourceType,
          properties,
          // A reverse-replacement rollback creates from a STATE record, so the
          // refusal downgrades here exactly as it does on the update path.
          context?.replayingState === true ? (message) => this.logger.warn(message) : undefined
        );
      case 'AWS::EC2::Instance':
        return this.createInstance(logicalId, resourceType, properties, context);
      case 'AWS::EC2::NetworkAcl':
        return this.createNetworkAcl(logicalId, resourceType, properties);
      case 'AWS::EC2::NetworkAclEntry':
        return this.createNetworkAclEntry(logicalId, resourceType, properties, context);
      case 'AWS::EC2::SubnetNetworkAclAssociation':
        return this.createSubnetNetworkAclAssociation(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
      // is control flow the deploy engine matches BY CLASS, and an inner
      // ProvisioningError already carries better context than a re-wrap.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update EC2 resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return this.updateVpc(logicalId, physicalId, resourceType, properties, previousProperties);
      case 'AWS::EC2::Subnet':
        return this.updateSubnet(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::EC2::InternetGateway':
        return this.updateInternetGateway(logicalId, physicalId);
      case 'AWS::EC2::EIP':
        return this.updateEip(logicalId, physicalId, properties, previousProperties);
      case 'AWS::EC2::VPCGatewayAttachment':
        return this.updateVpcGatewayAttachment(logicalId, physicalId);
      case 'AWS::EC2::NatGateway':
        return this.updateNatGateway(logicalId, physicalId);
      case 'AWS::EC2::RouteTable':
        return this.updateRouteTable(logicalId, physicalId);
      case 'AWS::EC2::Route':
        return this.updateRoute(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::EC2::SubnetRouteTableAssociation':
        return this.updateSubnetRouteTableAssociation(logicalId, physicalId);
      case 'AWS::EC2::SecurityGroup':
        return this.updateSecurityGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::EC2::SecurityGroupIngress':
        return this.updateSecurityGroupIngress(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::EC2::Instance':
        return this.updateInstance(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::EC2::NetworkAcl':
      case 'AWS::EC2::NetworkAclEntry':
      case 'AWS::EC2::SubnetNetworkAclAssociation':
        // Reject loudly instead of silently no-op'ing on
        // `cdkd drift --revert`. Same rationale as Subnet / IGW /
        // NatGateway / RouteTable above. See PR I.
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          'AWS provides no in-place Update API for this EC2 sub-resource type; every property change requires Delete + Create. Re-deploy with cdkd deploy --replace, or destroy + redeploy.'
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return this.deleteVpc(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::Subnet':
        return this.deleteSubnet(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::InternetGateway':
        return this.deleteInternetGateway(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::EIP':
        return this.deleteEip(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::VPCGatewayAttachment':
        return this.deleteVpcGatewayAttachment(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::NatGateway':
        return this.deleteNatGateway(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::RouteTable':
        return this.deleteRouteTable(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::Route':
        return this.deleteRoute(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::SubnetRouteTableAssociation':
        return this.deleteSubnetRouteTableAssociation(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::SecurityGroup':
        return this.deleteSecurityGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::SecurityGroupIngress':
        return this.deleteSecurityGroupIngress(
          logicalId,
          physicalId,
          resourceType,
          properties,
          context
        );
      case 'AWS::EC2::Instance':
        return this.deleteInstance(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::NetworkAcl':
        return this.deleteNetworkAcl(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::NetworkAclEntry':
        return this.deleteNetworkAclEntry(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::SubnetNetworkAclAssociation':
        // Association replacement is atomic; no explicit delete needed
        this.logger.debug(`SubnetNetworkAclAssociation ${logicalId} delete is a no-op`);
        return;
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return this.getVpcAttribute(physicalId, attributeName);
      case 'AWS::EC2::Subnet':
        return this.getSubnetAttribute(physicalId, attributeName);
      case 'AWS::EC2::SecurityGroup':
        return this.getSecurityGroupAttribute(physicalId, attributeName);
      case 'AWS::EC2::Instance':
        return this.getInstanceAttribute(physicalId, attributeName);
      case 'AWS::EC2::EIP':
        return this.getEipAttribute(physicalId, attributeName);
      default:
        return undefined;
    }
  }

  // ─── AWS::EC2::VPC ────────────────────────────────────────────────

  private async createVpc(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating VPC ${logicalId}`);

    const cidrBlock = properties['CidrBlock'] as string;
    if (!cidrBlock) {
      throw new ProvisioningError(
        `CidrBlock is required for VPC ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.ec2Client.send(
        new CreateVpcCommand({
          CidrBlock: cidrBlock,
          InstanceTenancy: (properties['InstanceTenancy'] as Tenancy) ?? undefined,
        })
      );

      const vpcId = response.Vpc!.VpcId!;

      // CreateVpcCommand has succeeded — AWS has now committed the VPC.
      // If any subsequent ModifyVpcAttribute / tag / read call throws, the
      // VPC exists on AWS but cdkd state will NOT (the throw aborts before
      // the success-return). The next redeploy would then re-try CREATE
      // and a new VPC would be created, leaving the first orphaned (VPCs
      // have no `EntityAlreadyExists` semantics — every CreateVpc returns
      // a fresh VpcId — so the orphan accumulates silently). Wrap the
      // wiring in an inner try/catch that issues a best-effort
      // `DeleteVpcCommand` before re-throwing the original error. A
      // freshly-created VPC has no subnets / SGs (except default which
      // CASCADE-delete with the VPC), so a single DeleteVpc suffices.
      let defaultSgId = '';
      try {
        // Apply DNS settings
        if (
          properties['EnableDnsHostnames'] === true ||
          properties['EnableDnsHostnames'] === 'true'
        ) {
          await this.ec2Client.send(
            new ModifyVpcAttributeCommand({
              VpcId: vpcId,
              EnableDnsHostnames: { Value: true },
            })
          );
        }

        if (
          properties['EnableDnsSupport'] === false ||
          properties['EnableDnsSupport'] === 'false'
        ) {
          await this.ec2Client.send(
            new ModifyVpcAttributeCommand({
              VpcId: vpcId,
              EnableDnsSupport: { Value: false },
            })
          );
        }

        // Apply tags
        await this.applyTags(vpcId, properties, logicalId);

        // Fetch VPC details for attributes
        await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));

        // Fetch default security group for the VPC
        try {
          const sgResponse = await this.ec2Client.send(
            new DescribeSecurityGroupsCommand({
              Filters: [
                { Name: 'vpc-id', Values: [vpcId] },
                { Name: 'group-name', Values: ['default'] },
              ],
            })
          );
          defaultSgId = sgResponse.SecurityGroups?.[0]?.GroupId || '';
        } catch {
          this.logger.debug(`Failed to get default SG for VPC ${vpcId}`);
        }
      } catch (innerError) {
        try {
          await this.ec2Client.send(new DeleteVpcCommand({ VpcId: vpcId }));
          this.logger.debug(
            `Cleaned up partially-created VPC ${logicalId} (${vpcId}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created VPC ${logicalId} (${vpcId}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws ec2 delete-vpc --vpc-id ${vpcId}`
          );
        }
        throw innerError;
      }

      this.logger.debug(`Successfully created VPC ${logicalId}: ${vpcId}`);

      return {
        physicalId: vpcId,
        attributes: {
          VpcId: vpcId,
          CidrBlock: cidrBlock,
          DefaultNetworkAcl: '',
          DefaultSecurityGroup: defaultSgId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create VPC ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateVpc(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating VPC ${logicalId}: ${physicalId}`);

    try {
      // Coerce CFn-string-or-bool ("true" | true) into a real boolean so the
      // diff below treats `"true"` and `true` as the same value.
      const asBool = (v: unknown): boolean | undefined => {
        if (v === undefined) return undefined;
        return v === true || v === 'true';
      };

      // Update DNS settings — diff-based so a no-op round-trip
      // (`update(state, state)` from `cdkd drift --revert`) produces zero
      // ModifyVpcAttribute calls. AWS treats ModifyVpcAttribute as
      // idempotent, but the canonical round-trip guard ("state==AWS
      // produces zero mutating SDK calls") is the structural check that
      // catches future regressions in the diff logic.
      const newDnsHostnames = asBool(properties['EnableDnsHostnames']);
      const oldDnsHostnames = asBool(previousProperties['EnableDnsHostnames']);
      if (newDnsHostnames !== undefined && newDnsHostnames !== oldDnsHostnames) {
        await this.ec2Client.send(
          new ModifyVpcAttributeCommand({
            VpcId: physicalId,
            EnableDnsHostnames: { Value: newDnsHostnames },
          })
        );
      }

      const newDnsSupport = asBool(properties['EnableDnsSupport']);
      const oldDnsSupport = asBool(previousProperties['EnableDnsSupport']);
      if (newDnsSupport !== undefined && newDnsSupport !== oldDnsSupport) {
        await this.ec2Client.send(
          new ModifyVpcAttributeCommand({
            VpcId: physicalId,
            EnableDnsSupport: { Value: newDnsSupport },
          })
        );
      }

      // Update tags (diff add/remove against previousProperties)
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      this.logger.debug(`Successfully updated VPC ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          VpcId: physicalId,
          CidrBlock: properties['CidrBlock'] as string,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update VPC ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteVpc(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting VPC ${logicalId}: ${physicalId}`);

    // Retry with backoff for DependencyViolation (ENI cleanup, SG deletion delay)
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.ec2Client.send(new DeleteVpcCommand({ VpcId: physicalId }));
        this.logger.debug(`Successfully deleted VPC ${logicalId}`);
        return;
      } catch (error) {
        if (this.isNotFoundError(error)) {
          const clientRegion = await this.ec2Client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`VPC ${physicalId} does not exist, skipping deletion`);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        if (
          (msg.includes('DependencyViolation') || msg.includes('has dependencies')) &&
          attempt < maxAttempts
        ) {
          this.logger.debug(
            `VPC ${physicalId} has dependencies (attempt ${attempt}/${maxAttempts}), retrying in ${attempt * 5}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
          continue;
        }
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to delete VPC ${logicalId}: ${msg}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an `AWS::EC2::VPC`.
   *
   * CloudFormation returns `CidrBlock`, `CidrBlockAssociations`,
   * `DefaultNetworkAcl`, `DefaultSecurityGroup`, and `Ipv6CidrBlocks`. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpc.html#aws-resource-ec2-vpc-return-values
   *
   * `DefaultNetworkAcl` and `DefaultSecurityGroup` previously returned wrong
   * values (DHCP options id and `undefined` respectively); the AWS console
   * surfaces these the same way as CFn — by filtering the relevant
   * `Describe*` API on `vpc-id` + the `default` flag.
   */
  private async getVpcAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    try {
      switch (attributeName) {
        case 'DefaultNetworkAcl': {
          const resp = await this.ec2Client.send(
            new DescribeNetworkAclsCommand({
              Filters: [
                { Name: 'vpc-id', Values: [physicalId] },
                { Name: 'default', Values: ['true'] },
              ],
            })
          );
          return resp.NetworkAcls?.[0]?.NetworkAclId;
        }
        case 'DefaultSecurityGroup': {
          const resp = await this.ec2Client.send(
            new DescribeSecurityGroupsCommand({
              Filters: [
                { Name: 'vpc-id', Values: [physicalId] },
                { Name: 'group-name', Values: ['default'] },
              ],
            })
          );
          return resp.SecurityGroups?.[0]?.GroupId;
        }
        default: {
          const response = await this.ec2Client.send(
            new DescribeVpcsCommand({ VpcIds: [physicalId] })
          );
          const vpc = response.Vpcs?.[0];
          if (!vpc) return undefined;

          switch (attributeName) {
            case 'CidrBlock':
              return vpc.CidrBlock;
            case 'Ipv6CidrBlocks':
              // Return array of IPv6 CIDR blocks associated with this VPC
              return (
                vpc.Ipv6CidrBlockAssociationSet?.filter(
                  (a) => a.Ipv6CidrBlockState?.State === 'associated'
                ).map((a) => a.Ipv6CidrBlock) || []
              );
            case 'CidrBlockAssociations':
              return vpc.CidrBlockAssociationSet?.map((a) => a.AssociationId) || [];
            default:
              return undefined;
          }
        }
      }
    } catch {
      return undefined;
    }
  }

  // ─── AWS::EC2::Subnet ─────────────────────────────────────────────

  private async createSubnet(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Subnet ${logicalId}`);

    const vpcId = properties['VpcId'] as string;
    const cidrBlock = properties['CidrBlock'] as string;

    if (!vpcId || !cidrBlock) {
      throw new ProvisioningError(
        `VpcId and CidrBlock are required for Subnet ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.ec2Client.send(
        new CreateSubnetCommand({
          VpcId: vpcId,
          CidrBlock: cidrBlock,
          AvailabilityZone: (properties['AvailabilityZone'] as string) ?? undefined,
        })
      );

      const subnetId = response.Subnet!.SubnetId!;
      const availabilityZone = response.Subnet!.AvailabilityZone!;

      // CreateSubnetCommand has succeeded — AWS has now committed the
      // Subnet. If applyTags / ModifySubnetAttribute throws, the subnet
      // exists on AWS but cdkd state will NOT, and the next redeploy
      // would create a NEW subnet (subnets have no `EntityAlreadyExists`
      // semantics — every CreateSubnet returns a fresh SubnetId) leaving
      // the first orphaned. Wrap wiring in an inner try/catch that issues
      // a best-effort `DeleteSubnetCommand` before re-throwing the
      // original error. A freshly-created subnet has no ENIs / route
      // associations attached, so a single DeleteSubnet suffices.
      try {
        // Apply tags
        await this.applyTags(subnetId, properties, logicalId);

        // Set MapPublicIpOnLaunch if specified
        const mapPublicIp = properties['MapPublicIpOnLaunch'];
        if (mapPublicIp === true || mapPublicIp === 'true') {
          await this.ec2Client.send(
            new ModifySubnetAttributeCommand({
              SubnetId: subnetId,
              MapPublicIpOnLaunch: { Value: true },
            })
          );
          // Issue #1299: don't return until the write is READABLE — the
          // deploy engine's async observed-state capture races this modify
          // and would otherwise persist the stale `false` as the drift
          // baseline (phantom drift on every later `cdkd drift`).
          await this.waitForSubnetMapPublicIp(subnetId, true);
        }
      } catch (innerError) {
        try {
          await this.ec2Client.send(new DeleteSubnetCommand({ SubnetId: subnetId }));
          this.logger.debug(
            `Cleaned up partially-created Subnet ${logicalId} (${subnetId}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created Subnet ${logicalId} (${subnetId}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws ec2 delete-subnet --subnet-id ${subnetId}`
          );
        }
        throw innerError;
      }

      this.logger.debug(`Successfully created Subnet ${logicalId}: ${subnetId}`);

      return {
        physicalId: subnetId,
        attributes: {
          SubnetId: subnetId,
          AvailabilityZone: availabilityZone,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Subnet ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateSubnet(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Subnet ${logicalId}: ${physicalId}`);

    try {
      // VpcId / CidrBlock / AvailabilityZone are CREATE-only. The diff layer
      // normally routes a change on them to replacement (hand rule in
      // `replacement-rules.ts` + the registry-schema createOnly fallback),
      // but `cdkd drift --revert` calls `update()` without that
      // classification, so guard here too rather than silently no-op'ing.
      for (const createOnly of ['VpcId', 'CidrBlock', 'AvailabilityZone']) {
        const next = properties[createOnly];
        const prev = previousProperties[createOnly];
        if (next !== undefined && prev !== undefined && next !== prev) {
          throw new ResourceUpdateNotSupportedError(
            resourceType,
            logicalId,
            `destroy + redeploy the Subnet (and the resources that depend on it). ${createOnly} is immutable in AWS`
          );
        }
      }

      // MapPublicIpOnLaunch IS mutable via ModifySubnetAttribute (issue
      // #1300). Coerce the CFn string-or-bool spelling and treat an absent
      // value as the AWS default `false` (CFn resets a removed property to
      // its default), diff-based so a no-op round-trip (`update(state,
      // state)` from `cdkd drift --revert`) sends zero mutating calls.
      const asBool = (v: unknown): boolean => v === true || v === 'true';
      const newMapPublicIp = asBool(properties['MapPublicIpOnLaunch']);
      const oldMapPublicIp = asBool(previousProperties['MapPublicIpOnLaunch']);
      if (newMapPublicIp !== oldMapPublicIp) {
        await this.ec2Client.send(
          new ModifySubnetAttributeCommand({
            SubnetId: physicalId,
            MapPublicIpOnLaunch: { Value: newMapPublicIp },
          })
        );
        await this.waitForSubnetMapPublicIp(physicalId, newMapPublicIp);
      }

      // Update tags (diff add/remove against previousProperties)
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      this.logger.debug(`Successfully updated Subnet ${logicalId}`);

      // No `attributes` on purpose: an in-place update never invalidates the
      // create-time attributes (SubnetId / AvailabilityZone), and returning a
      // partial set here would REPLACE the stored ones (see the deploy
      // engine's carriedAttributes note — the FSx attribute-wipe incident).
      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Subnet ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read back `MapPublicIpOnLaunch` until AWS reflects the value a
   * `ModifySubnetAttribute` just wrote (issue #1299). EC2 `Describe*` is
   * eventually consistent, so the deploy engine's async observed-state
   * capture (`kickOffObservedCapture` → `readCurrentState` →
   * `DescribeSubnets`), which fires milliseconds after `create()` /
   * `update()` returns, could read the STALE pre-modify value and persist
   * it as the drift baseline — every later `cdkd drift` then reported
   * phantom `MapPublicIpOnLaunch` drift on a resource nothing touched.
   *
   * Bounded and best-effort: the first read usually already reflects the
   * write (zero added latency beyond one DescribeSubnets round trip); on
   * exhaustion we log and return — behavior then degrades to the pre-fix
   * race instead of failing a deploy over a read-side consistency lag.
   */
  private async waitForSubnetMapPublicIp(subnetId: string, expected: boolean): Promise<void> {
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await this.ec2Client.send(
          new DescribeSubnetsCommand({ SubnetIds: [subnetId] })
        );
        if (resp.Subnets?.[0]?.MapPublicIpOnLaunch === expected) return;
      } catch (error) {
        this.logger.debug(
          `MapPublicIpOnLaunch read-back for ${subnetId} failed (attempt ${attempt}/${maxAttempts}): ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
      if (attempt < maxAttempts) {
        await this.sleep(100 * 2 ** (attempt - 1));
      }
    }
    this.logger.debug(
      `MapPublicIpOnLaunch=${expected} not yet visible on ${subnetId} after ${maxAttempts} reads — the observed-state capture may record the stale value (issue #1299)`
    );
  }

  private async deleteSubnet(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Subnet ${logicalId}: ${physicalId}`);

    // Subnet deletes commonly fail with "has dependencies" when Lambda
    // hyperplane ENIs are still attached. The Lambda provider tries to
    // clean those up first, but its budget is finite and AWS's ENI release
    // is asynchronous — by the time we get here, leftover ENIs may still
    // exist. Retry with a side-channel: best-effort delete remaining
    // Lambda-managed ENIs in the subnet, sleep, then retry the subnet.
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.ec2Client.send(new DeleteSubnetCommand({ SubnetId: physicalId }));
        this.logger.debug(`Successfully deleted Subnet ${logicalId}`);
        return;
      } catch (error) {
        if (this.isNotFoundError(error)) {
          const clientRegion = await this.ec2Client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Subnet ${physicalId} does not exist, skipping deletion`);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        const isDependencyError =
          msg.includes('has dependencies') || msg.includes('DependencyViolation');
        if (isDependencyError && attempt < maxAttempts) {
          await this.cleanupSubnetLambdaEnis(physicalId);
          this.logger.debug(
            `Subnet ${physicalId} has dependencies (attempt ${attempt}/${maxAttempts}), retrying in ${attempt * 5}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
          continue;
        }
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to delete Subnet ${logicalId}: ${msg}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }
  }

  /**
   * Best-effort: list Lambda-managed ENIs in the given subnet and try to
   * delete each one. Used as a side-channel cleanup when DeleteSubnet
   * fails with "has dependencies" — the Lambda provider's own ENI cleanup
   * may have run out of budget before AWS finished detaching, so a second
   * attempt from the subnet side typically succeeds a few seconds later
   * once the ENIs flip from `in-use` to `available`.
   */
  private async cleanupSubnetLambdaEnis(subnetId: string): Promise<void> {
    let enis: { id: string; status: string }[];
    try {
      const resp = await this.ec2Client.send(
        new DescribeNetworkInterfacesCommand({
          Filters: [
            { Name: 'subnet-id', Values: [subnetId] },
            // `description` filter is the only reliable way to find Lambda
            // hyperplane ENIs — `requester-id` does not actually contain the
            // string "awslambda" (it is an AROA principal id).
            { Name: 'description', Values: ['AWS Lambda VPC ENI-*'] },
          ],
        })
      );
      enis = (resp.NetworkInterfaces ?? [])
        .filter((ni) => ni.NetworkInterfaceId)
        .map((ni) => ({ id: ni.NetworkInterfaceId!, status: ni.Status ?? 'unknown' }));
    } catch (err) {
      this.logger.debug(
        `cleanupSubnetLambdaEnis: DescribeNetworkInterfaces failed for ${subnetId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    if (enis.length === 0) return;
    await Promise.all(
      enis.map(async (eni) => {
        try {
          await this.ec2Client.send(
            new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eni.id })
          );
          this.logger.debug(
            `cleanupSubnetLambdaEnis: deleted Lambda ENI ${eni.id} in subnet ${subnetId}`
          );
        } catch (err) {
          this.logger.debug(
            `cleanupSubnetLambdaEnis: ENI ${eni.id} (status=${eni.status}) not yet deletable: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      })
    );
  }

  private async getSubnetAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    if (attributeName === 'SubnetId') return physicalId;

    try {
      const response = await this.ec2Client.send(
        new DescribeSubnetsCommand({ SubnetIds: [physicalId] })
      );
      const subnet = response.Subnets?.[0];
      if (!subnet) return undefined;

      if (attributeName === 'AvailabilityZone') return subnet.AvailabilityZone;
      return undefined;
    } catch {
      return undefined;
    }
  }

  // ─── AWS::EC2::InternetGateway ────────────────────────────────────

  private async createInternetGateway(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating InternetGateway ${logicalId}`);

    try {
      const response = await this.ec2Client.send(new CreateInternetGatewayCommand({}));
      const igwId = response.InternetGateway!.InternetGatewayId!;

      // Apply tags
      await this.applyTags(igwId, properties, logicalId);

      this.logger.debug(`Successfully created InternetGateway ${logicalId}: ${igwId}`);

      return {
        physicalId: igwId,
        attributes: {
          InternetGatewayId: igwId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create InternetGateway ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private updateInternetGateway(
    logicalId: string,
    physicalId: string
  ): Promise<ResourceUpdateResult> {
    // IGW has no mutable properties cdkd surfaces (Tags would be the
    // only candidate; not in `readCurrentState`). Reject loudly instead
    // of silently no-op'ing on `cdkd drift --revert`. See PR I.
    void physicalId;
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::EC2::InternetGateway',
        logicalId,
        'destroy + redeploy the InternetGateway. IGW properties are immutable in AWS.'
      )
    );
  }

  private async deleteInternetGateway(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting InternetGateway ${logicalId}: ${physicalId}`);

    try {
      await this.withDependencyViolationRetry(
        () =>
          this.ec2Client.send(new DeleteInternetGatewayCommand({ InternetGatewayId: physicalId })),
        { description: `DeleteInternetGateway ${logicalId} (${physicalId})` }
      );
      this.logger.debug(`Successfully deleted InternetGateway ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`InternetGateway ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete InternetGateway ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::EC2::EIP ────────────────────────────────────────────────
  //
  // Elastic IPs allocate synchronously (AllocateAddress returns the id + IP
  // immediately), so an SDK provider skips the Cloud Control async-polling
  // backoff (~20s for an instant resource) that the CC fallback pays. This
  // matters because an EIP feeds the NAT Gateway on the critical path.
  //
  // physicalId is the composite `PublicIp|AllocationId`, matching the shape the
  // Cloud Control fallback produced (see cloud-control-provider.ts), so Ref /
  // GetAtt resolution and existing state stay byte-compatible.

  /**
   * Both segments are AWS-generated (a dotted-quad address and an
   * `eipalloc-...` id), so neither can carry cdkd's `|` separator and the
   * refusal below is a fence rather than a live guard (issue #1672). It is
   * applied uniformly with the rest of the composite-packing sites so a future
   * id-shape change cannot quietly reintroduce the ambiguity; for the same
   * reason it is safe on BOTH callers — `createEip` (post-`AllocateAddress`)
   * and `import()` (post-`DescribeAddresses`) — even though a throw on either
   * would arrive after the AWS call.
   */
  private eipPhysicalId(
    logicalId: string,
    publicIp: string,
    allocationId: string,
    options?: CompositeIdOptions
  ): string {
    return packCompositeId(
      'AWS::EC2::EIP',
      logicalId,
      [
        { name: 'publicIp', value: publicIp },
        { name: 'allocationId', value: allocationId },
      ],
      options
    );
  }

  private parseEipPhysicalId(physicalId: string): {
    publicIp?: string | undefined;
    allocationId?: string | undefined;
  } {
    if (physicalId.includes('|')) {
      const [publicIp, allocationId] = physicalId.split('|');
      return { publicIp, allocationId };
    }
    // Tolerate a bare allocation id (eipalloc-…) or a bare public IP.
    if (physicalId.startsWith('eipalloc-')) return { allocationId: physicalId };
    return { publicIp: physicalId };
  }

  private async createEip(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating EIP ${logicalId}`);

    let allocationId: string;
    let publicIp: string;
    try {
      const response = await this.ec2Client.send(
        new AllocateAddressCommand({
          Domain: requireConfigString(
            properties['Domain'],
            'vpc',
            'AWS::EC2::EIP Domain',
            replayWarn(this.logger, context)
          ) as 'vpc' | 'standard',
          NetworkBorderGroup: properties['NetworkBorderGroup'] as string | undefined,
          PublicIpv4Pool: properties['PublicIpv4Pool'] as string | undefined,
        })
      );

      allocationId = response.AllocationId!;
      publicIp = response.PublicIp!;

      await this.applyTags(allocationId, properties, logicalId);

      // Associate to an instance on the fast SDK path, keeping EIP+InstanceId
      // off the ~20s Cloud Control async-poll route.
      //
      // This used to lean on "the EIP depends on the instance in the DAG, so
      // it is already running by now". Gating the instance `running` wait on
      // --no-wait falsified that: the dependency only guarantees the instance
      // has been CREATED, and AssociateAddress rejects a `pending` instance
      // with IncorrectInstanceState. That code is not in the retryable table,
      // so the outer withRetry does not absorb it -- the create would throw
      // and roll the stack back. Same failure mode as the instance-profile
      // association (issue #1279), which is the sibling site the wait-gating
      // work already had to fix; this one was missed because no integ
      // exercises --no-wait against an Instance+EIP stack.
      //
      // Handled the same way as #1279: skip under --no-wait and hand the user
      // the exact repair command, rather than silently reintroducing a wait
      // that --no-wait explicitly asked to skip.
      const instanceId = properties['InstanceId'] as string | undefined;
      if (instanceId) {
        if (process.env['CDKD_NO_WAIT'] === 'true') {
          this.logger.warn(
            `EIP ${logicalId} (${allocationId}) was NOT associated with ${instanceId}: --no-wait skips the instance running-state wait, and AssociateAddress rejects an instance that is not yet running. Verify and associate once the instance is running: aws ec2 describe-instances --instance-ids ${instanceId} --query 'Reservations[].Instances[].State.Name' && aws ec2 associate-address --allocation-id ${allocationId} --instance-id ${instanceId}`
          );
        } else {
          await this.ec2Client.send(
            new AssociateAddressCommand({ AllocationId: allocationId, InstanceId: instanceId })
          );
          this.logger.debug(`Associated EIP ${logicalId} (${allocationId}) to ${instanceId}`);
        }
      }

      this.logger.debug(`Successfully created EIP ${logicalId}: ${allocationId} (${publicIp})`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EIP ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }

    // The second of the two sites whose segments only exist after the AWS
    // call, and OUTSIDE the try for the same reason as AppSync's ApiKey (issue
    // #1672): that `catch` re-wraps anything thrown as
    // `ProvisioningError('Failed to create EIP …')`, which would mis-report a
    // refusal as an allocation failure for an address AWS had already handed
    // out. Both segments come from `AllocateAddress`, so the refusal is a
    // fence rather than a live guard.
    return {
      physicalId: this.eipPhysicalId(
        logicalId,
        publicIp,
        allocationId,
        // A reverse-replacement rollback creates from a STATE record, so the
        // refusal downgrades to a warning.
        context?.replayingState === true
          ? { onRefusal: (message) => this.logger.warn(message) }
          : undefined
      ),
      attributes: {
        AllocationId: allocationId,
        PublicIp: publicIp,
      },
    };
  }

  private async updateEip(
    logicalId: string,
    physicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // Tags and InstanceId (association) are mutable in place; Domain / pool /
    // border group are create-only and handled by the replacement path.
    this.logger.debug(`Updating EIP ${logicalId}: ${physicalId}`);
    const { allocationId } = this.parseEipPhysicalId(physicalId);
    if (allocationId) {
      await this.applyTagDiff(
        allocationId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      const oldInstanceId = previousProperties['InstanceId'] as string | undefined;
      const newInstanceId = properties['InstanceId'] as string | undefined;
      if (oldInstanceId !== newInstanceId) {
        if (newInstanceId) {
          // Associate (or re-associate to a different instance). Same
          // pending-instance hazard as createEip's association: under
          // --no-wait a target instance created in this deploy may still be
          // `pending`, and AssociateAddress rejects that with
          // IncorrectInstanceState (not in the retryable table). Unlike the
          // create path, the target here is often an EXISTING running
          // instance (repointing an EIP), so an unconditional skip would
          // break associations that succeed today -- attempt first, and only
          // degrade to the skip-and-warn remedy when AWS actually rejects the
          // not-yet-running instance under --no-wait.
          try {
            await this.ec2Client.send(
              new AssociateAddressCommand({
                AllocationId: allocationId,
                InstanceId: newInstanceId,
                AllowReassociation: true,
              })
            );
          } catch (error) {
            if (
              process.env['CDKD_NO_WAIT'] === 'true' &&
              this.isIncorrectInstanceStateError(error)
            ) {
              this.logger.warn(
                `EIP ${logicalId} (${allocationId}) was NOT associated with ${newInstanceId}: --no-wait skips the instance running-state wait, and AssociateAddress rejects an instance that is not yet running. Verify and associate once the instance is running: aws ec2 describe-instances --instance-ids ${newInstanceId} --query 'Reservations[].Instances[].State.Name' && aws ec2 associate-address --allocation-id ${allocationId} --instance-id ${newInstanceId} --allow-reassociation`
              );
            } else {
              throw error;
            }
          }
        } else {
          // InstanceId removed → disassociate via the current AssociationId.
          const desc = await this.ec2Client.send(
            new DescribeAddressesCommand({ AllocationIds: [allocationId] })
          );
          const associationId = desc.Addresses?.[0]?.AssociationId;
          if (associationId) {
            await this.ec2Client.send(
              new DisassociateAddressCommand({ AssociationId: associationId })
            );
          }
        }
      }
    }
    return { physicalId, wasReplaced: false };
  }

  private async deleteEip(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EIP ${logicalId}: ${physicalId}`);
    const parsed = this.parseEipPhysicalId(physicalId);
    let allocationId = parsed.allocationId;

    // cdkd always stores the composite `IP|AllocationId`, but tolerate a
    // bare-public-IP physical id by resolving its allocation id first —
    // ReleaseAddress requires the allocation id for a VPC EIP.
    if (!allocationId && parsed.publicIp) {
      const lookup = await this.ec2Client.send(
        new DescribeAddressesCommand({ PublicIps: [parsed.publicIp] })
      );
      allocationId = lookup.Addresses?.[0]?.AllocationId;
      if (!allocationId) {
        this.logger.debug(`EIP ${physicalId} not found on lookup, skipping deletion`);
        return;
      }
    }

    try {
      await this.withDependencyViolationRetry(
        () => this.ec2Client.send(new ReleaseAddressCommand({ AllocationId: allocationId })),
        { description: `ReleaseAddress ${logicalId} (${allocationId})` }
      );
      this.logger.debug(`Successfully deleted EIP ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`EIP ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EIP ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async getEipAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    const { publicIp, allocationId } = this.parseEipPhysicalId(physicalId);
    if (attributeName === 'AllocationId' && allocationId) return allocationId;
    if (attributeName === 'PublicIp' && publicIp) return publicIp;

    // Fall back to a live read for anything not encoded in the physical id.
    const filter = allocationId
      ? { AllocationIds: [allocationId] }
      : { PublicIps: publicIp ? [publicIp] : [] };
    const response = await this.ec2Client.send(new DescribeAddressesCommand(filter));
    const addr = response.Addresses?.[0];
    if (!addr) return undefined;
    switch (attributeName) {
      case 'AllocationId':
        return addr.AllocationId;
      case 'PublicIp':
        return addr.PublicIp;
      default:
        return undefined;
    }
  }

  // ─── AWS::EC2::VPCGatewayAttachment ───────────────────────────────

  private async createVpcGatewayAttachment(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating VPCGatewayAttachment ${logicalId}`);

    const vpcId = properties['VpcId'] as string;
    const internetGatewayId = properties['InternetGatewayId'] as string;

    if (!vpcId || !internetGatewayId) {
      throw new ProvisioningError(
        `VpcId and InternetGatewayId are required for VPCGatewayAttachment ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Both segments are AWS-generated (`igw-...` / `vpc-...`), so neither is
    // pipe-capable and this is uniform defense-in-depth (issue #1672).
    // Computed before the AWS call so a refusal cannot leave an attachment AWS
    // has already made without a state record.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'internetGatewayId', value: internetGatewayId },
        { name: 'vpcId', value: vpcId },
      ],
      context?.replayingState === true
        ? { onRefusal: (message) => this.logger.warn(message) }
        : undefined
    );

    try {
      await this.ec2Client.send(
        new AttachInternetGatewayCommand({
          VpcId: vpcId,
          InternetGatewayId: internetGatewayId,
        })
      );

      this.logger.debug(`Successfully created VPCGatewayAttachment ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create VPCGatewayAttachment ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private updateVpcGatewayAttachment(
    logicalId: string,
    physicalId: string
  ): Promise<ResourceUpdateResult> {
    void physicalId;
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::EC2::VPCGatewayAttachment',
        logicalId,
        'destroy + redeploy the VPCGatewayAttachment. The (VpcId, InternetGatewayId) pair is immutable.'
      )
    );
  }

  private async deleteVpcGatewayAttachment(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting VPCGatewayAttachment ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new ProvisioningError(
        compositeIdFormatMessage(EC2_VPC_GATEWAY_ATTACHMENT_ID_FORMAT, logicalId, physicalId),
        resourceType,
        logicalId,
        physicalId
      );
    }

    const [internetGatewayId, vpcId] = parts;

    try {
      await this.withDependencyViolationRetry(
        () =>
          this.ec2Client.send(
            new DetachInternetGatewayCommand({
              InternetGatewayId: internetGatewayId,
              VpcId: vpcId,
            })
          ),
        { description: `DetachInternetGateway ${logicalId} (${internetGatewayId} from ${vpcId})` }
      );
      this.logger.debug(`Successfully deleted VPCGatewayAttachment ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`VPCGatewayAttachment ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete VPCGatewayAttachment ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::EC2::NatGateway ─────────────────────────────────────────
  //
  // CloudFormation parity: by default we wait for the new NAT gateway to
  // reach `available` state before marking the resource created. NAT
  // provisioning takes ~1–2 minutes (often the longest single step in a
  // VPC stack). Pass `--no-wait` to skip the wait — `CreateNatGateway`
  // returns the `NatGatewayId` immediately so dependent Routes /
  // Subnets that only need the ID can proceed against a still-`pending`
  // gateway. Anything that requires actual NAT-routed egress (e.g. a
  // Lambda invocation that hits the internet during deploy) must not
  // rely on the gateway being live; with `--no-wait`, AWS continues
  // provisioning asynchronously after the deploy returns.

  private async createNatGateway(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating NatGateway ${logicalId}`);

    const subnetId = properties['SubnetId'] as string | undefined;
    if (!subnetId) {
      throw new ProvisioningError(
        `SubnetId is required for NatGateway ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.ec2Client.send(
        new CreateNatGatewayCommand({
          SubnetId: subnetId,
          AllocationId: properties['AllocationId'] as string | undefined,
          ConnectivityType:
            (properties['ConnectivityType'] as 'public' | 'private' | undefined) ?? undefined,
          PrivateIpAddress: properties['PrivateIpAddress'] as string | undefined,
          SecondaryAllocationIds: properties['SecondaryAllocationIds'] as string[] | undefined,
          SecondaryPrivateIpAddresses: properties['SecondaryPrivateIpAddresses'] as
            | string[]
            | undefined,
          SecondaryPrivateIpAddressCount: properties['SecondaryPrivateIpAddressCount'] as
            | number
            | undefined,
        })
      );
      const natGatewayId = response.NatGateway!.NatGatewayId!;

      // Apply tags via the post-create CreateTags API to match the
      // pattern used by sibling EC2 helpers (Subnet / IGW / RouteTable).
      // CreateNatGateway also supports inline TagSpecifications, but
      // staying consistent with `applyTags` keeps tag handling in one
      // place — and the extra API call is dwarfed by the optional
      // available-state wait below.
      await this.applyTags(natGatewayId, properties, logicalId);

      // Wait for `available` state unless --no-wait is set. Same gating
      // pattern as CloudFront / RDS / ElastiCache providers (env var
      // `CDKD_NO_WAIT=true` is set by the CLI when --no-wait is passed).
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        this.logger.debug(`Waiting for NatGateway ${natGatewayId} to reach available state...`);
        await waitUntilNatGatewayAvailable(
          // 15-min cap matches AWS's documented worst case for NAT
          // provisioning. Per-resource `--resource-timeout` (default
          // 30 min) still bounds the outer call as a backstop.
          //
          // minDelay/maxDelay override the AWS SDK defaults (15s / 120s). A NAT
          // typically reaches `available` in ~90s, so the default exponential
          // backoff — whose late polls are up to 120s apart — can detect the
          // ready state up to ~2 min late (and with wild variance depending on
          // where the ready moment falls relative to the sparse poll schedule).
          // That made cdkd systematically slower than tools that poll on a
          // tight interval. The delay is
          // `uniform_random(minDelay, min(minDelay * 2^(attempt-1), maxDelay))`,
          // so the mean detection lag settles at about maxDelay/2 -- 5s here,
          // matching the 10s cap the #1177 sweep applied to the ELBv2 and ECS
          // waiters. This pair was missed by that sweep and kept a 15s cap.
          { client: this.ec2Client, maxWaitTime: 15 * 60, minDelay: 5, maxDelay: 10 },
          { NatGatewayIds: [natGatewayId] }
        );
        this.logger.debug(`NatGateway ${natGatewayId} is available`);
      } else {
        this.logger.debug(
          `NatGateway ${natGatewayId} created (skipping available-state wait per --no-wait)`
        );
      }

      this.logger.debug(`Successfully created NatGateway ${logicalId}: ${natGatewayId}`);

      return {
        physicalId: natGatewayId,
        attributes: {
          NatGatewayId: natGatewayId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create NatGateway ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private updateNatGateway(logicalId: string, physicalId: string): Promise<ResourceUpdateResult> {
    // NAT Gateway is immutable on every property cdkd's
    // `readCurrentState` surfaces (SubnetId / ConnectivityType /
    // AllocationId / PrivateIpAddress are all CREATE-only). The deploy
    // engine's replacement detection already routes property changes to
    // DELETE + CREATE upstream of this method — `update()` is reached
    // only via `cdkd drift --revert`, where silently no-op'ing would
    // make the user think drift was reverted while AWS keeps the
    // console-side change. Reject loudly instead. See PR I.
    void physicalId;
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::EC2::NatGateway',
        logicalId,
        'destroy + redeploy the NatGateway (and the dependent Routes). NAT Gateway properties are immutable in AWS.'
      )
    );
  }

  private async deleteNatGateway(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting NatGateway ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DeleteNatGatewayCommand({ NatGatewayId: physicalId }));
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`NatGateway ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete NatGateway ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    // Wait for the gateway to fully release its ENI / EIP / route
    // table associations BEFORE returning. This wait is INTENTIONALLY
    // not gated on `--no-wait`. NAT Gateway is asymmetric:
    //
    //   - On CREATE, the SDK call returns the NatGatewayId
    //     immediately and downstream Routes accept a still-`pending`
    //     gateway as a target. Skipping the available-state wait is
    //     safe — AWS finishes provisioning asynchronously and the
    //     deploy can return early.
    //   - On DELETE, the same asynchronous teardown blocks every
    //     OTHER destroy that lands in the same VPC. While the
    //     gateway is still in `deleting` state, AWS keeps the ENI
    //     attached to the public subnet and the EIP allocated to
    //     the gateway, so DeleteSubnet / DeleteInternetGateway /
    //     DeleteVpc all return `DependencyViolation`. The deploy
    //     engine then enters a retry storm and the destroy can run
    //     for 15+ minutes before either succeeding or failing
    //     partway through (which is what surfaced in the v0.31
    //     follow-up bench).
    //
    // The right answer is to ALWAYS wait on delete, treating
    // `--no-wait` as a deploy-time-only flag for NAT. CloudFront and
    // RDS leaf resources can safely skip their delete waits because
    // nothing in the destroy DAG depends on them being fully gone.
    this.logger.debug(`Waiting for NatGateway ${physicalId} to reach deleted state...`);
    try {
      await waitUntilNatGatewayDeleted(
        // Tighten the poll interval off the AWS SDK defaults (15s / 120s) for
        // the same reason as the available-state wait above: a sparse late poll
        // adds up to ~2 min of dead time detecting the terminal state. Same 10s
        // cap as that wait, and as the #1177-swept siblings.
        { client: this.ec2Client, maxWaitTime: 15 * 60, minDelay: 5, maxDelay: 10 },
        { NatGatewayIds: [physicalId] }
      );
    } catch (error) {
      // The waiter throws on TIMEOUT and on FAILURE (the one
      // FAILURE acceptor is `failed` state). Treat both as soft
      // warnings — the EC2 console will show the gateway, the user
      // can clean it up manually. We do NOT re-throw because doing
      // so would block downstream Subnet / VPC delete from running,
      // which is worse.
      this.logger.warn(
        `Wait for NatGateway ${physicalId} deletion did not complete cleanly: ${
          error instanceof Error ? error.message : String(error)
        } — proceeding with downstream delete steps`
      );
    }

    this.logger.debug(`Successfully deleted NatGateway ${logicalId}`);
  }

  // ─── AWS::EC2::RouteTable ─────────────────────────────────────────

  private async createRouteTable(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating RouteTable ${logicalId}`);

    const vpcId = properties['VpcId'] as string;
    if (!vpcId) {
      throw new ProvisioningError(
        `VpcId is required for RouteTable ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.ec2Client.send(new CreateRouteTableCommand({ VpcId: vpcId }));

      const routeTableId = response.RouteTable!.RouteTableId!;

      // Apply tags
      await this.applyTags(routeTableId, properties, logicalId);

      this.logger.debug(`Successfully created RouteTable ${logicalId}: ${routeTableId}`);

      return {
        physicalId: routeTableId,
        attributes: {
          RouteTableId: routeTableId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create RouteTable ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private updateRouteTable(logicalId: string, physicalId: string): Promise<ResourceUpdateResult> {
    void physicalId;
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::EC2::RouteTable',
        logicalId,
        'destroy + redeploy the RouteTable (and its associated Routes / SubnetRouteTableAssociations). VpcId is immutable.'
      )
    );
  }

  private async deleteRouteTable(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting RouteTable ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DeleteRouteTableCommand({ RouteTableId: physicalId }));
      this.logger.debug(`Successfully deleted RouteTable ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`RouteTable ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete RouteTable ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::EC2::Route ──────────────────────────────────────────────

  private async createRoute(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    onMultipleDestinations?: (message: string) => void
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Route ${logicalId}`);

    const routeTableId = properties['RouteTableId'] as string;
    const destinationCidrBlock = properties['DestinationCidrBlock'] as string | undefined;
    const destinationIpv6CidrBlock = properties['DestinationIpv6CidrBlock'] as string | undefined;
    const destinationPrefixListId = properties['DestinationPrefixListId'] as string | undefined;
    // The destination key doubles as the physicalId's second segment
    // (`<routeTableId>|<destination>`); deleteRoute / readRouteCurrentState
    // discriminate the three forms by shape (':' = IPv6, 'pl-' = prefix list).
    const destination = destinationCidrBlock || destinationIpv6CidrBlock || destinationPrefixListId;

    if (!routeTableId || !destination) {
      throw new ProvisioningError(
        `RouteTableId and one of DestinationCidrBlock/DestinationIpv6CidrBlock/DestinationPrefixListId are required for Route ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // A CFn-invalid template carrying MORE than one destination key would
    // otherwise deploy with only the highest-precedence one and silently drop
    // the rest, while CloudFormation / `CreateRoute` reject the combination
    // (InvalidParameterCombination). Refuse instead of narrowing (issue #1566).
    // `onMultipleDestinations` downgrades this to a warning on the STATE-borne
    // paths (rollback replay / the update path's delete-and-recreate), where a
    // refusal would leave the route unrestorable from a record the user cannot
    // edit; the pre-fix precedence then applies, so behavior there is unchanged.
    // Counted with the SAME predicate the `||` chain above uses (plain
    // truthiness), not a hand-listed `undefined | null | ''` set. The casts on
    // the three reads promise `string | undefined`, but the property bag is
    // `unknown`-valued at runtime, so a numeric `0` from an unquoted YAML
    // scalar is reachable — and under a narrower predicate the guard would
    // count a destination the chain skips, producing a spurious refusal.
    const { declared: declaredDestinations, narrowed: narrowedProperties } =
      narrowRouteDestinations(properties);

    // Set ONLY by the warn arm below, and only to the bag this method actually
    // sends — see the note there (issue #1591).
    let effectiveProperties: Record<string, unknown> | undefined;

    if (declaredDestinations.length > 1) {
      const message =
        `Route ${logicalId} declares more than one destination (${declaredDestinations.join(', ')}). ` +
        'CloudFormation and EC2 accept exactly one of ' +
        'DestinationCidrBlock/DestinationIpv6CidrBlock/DestinationPrefixListId; ' +
        'remove the extra keys from the template.';
      if (onMultipleDestinations) {
        // The message states WHAT happened and nothing about WHY, because the
        // two callers reach it for different reasons: the create arm is a
        // state replay (no prior delete), the update arm is a
        // delete-and-recreate. An earlier draft asserted a cdkd-state origin
        // (false on a template-borne update) and its replacement asserted a
        // just-deleted route (false on the replay create) — each caller's own
        // comment carries the rationale instead.
        //
        // `usedKey` comes from the SAME helper that resolves the wire call's
        // destination, so it always names the key actually sent — see
        // `narrowRouteDestinations` for why the winner is simply the first
        // declared key.
        const usedKey = declaredDestinations[0]!;
        // Hand the engine the bag we actually SEND, so state matches AWS
        // (issue #1591 — the residue #1590 knowingly left behind). Without
        // this the engine records every declared destination key while
        // `readRouteCurrentState` can only ever return the one AWS holds, so
        // the losers become PERMANENT phantom drift: reported by every
        // `cdkd drift`, and "repaired" by `drift --revert` into another
        // `update()` that delete-and-recreates the route and re-emits this
        // same warning, forever.
        //
        // Only the losing DESTINATION keys are dropped — everything else in
        // the bag was sent verbatim. The narrowing is already announced by the
        // warning below, so recording it makes state agree with the message
        // rather than hiding a loss the user was never told about.
        effectiveProperties = narrowedProperties;
        onMultipleDestinations(`${message} Continuing with ${usedKey} and ignoring the rest.`);
      } else {
        throw new ProvisioningError(message, resourceType, logicalId);
      }
    }

    // Refuse a `|` in either segment BEFORE `CreateRoute` runs (issue #1672).
    // Neither is realistically pipe-capable — `RouteTableId` is an AWS-generated
    // `rtb-...` and the destination is a CIDR or a `pl-...` prefix-list id — so
    // this is uniform defense-in-depth. The downgrade is what matters here: the
    // callback is the SAME one `updateRoute` already passes UNCONDITIONALLY,
    // because that path DELETES the route before re-creating it, so a throw
    // would strand a deleted route with no template-side remedy (issue #1566);
    // the create dispatch passes it only on a state replay, so the refusal
    // still stands on a template-borne deploy.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'routeTableId', value: routeTableId },
        { name: 'destination', value: destination },
      ],
      onMultipleDestinations ? { onRefusal: onMultipleDestinations } : undefined
    );

    try {
      await this.ec2Client.send(
        new CreateRouteCommand({
          RouteTableId: routeTableId,
          ...(destinationCidrBlock
            ? { DestinationCidrBlock: destinationCidrBlock }
            : destinationIpv6CidrBlock
              ? { DestinationIpv6CidrBlock: destinationIpv6CidrBlock }
              : { DestinationPrefixListId: destinationPrefixListId }),
          CarrierGatewayId: (properties['CarrierGatewayId'] as string) ?? undefined,
          CoreNetworkArn: (properties['CoreNetworkArn'] as string) ?? undefined,
          GatewayId: (properties['GatewayId'] as string) ?? undefined,
          LocalGatewayId: (properties['LocalGatewayId'] as string) ?? undefined,
          NatGatewayId: (properties['NatGatewayId'] as string) ?? undefined,
          EgressOnlyInternetGatewayId:
            (properties['EgressOnlyInternetGatewayId'] as string) ?? undefined,
          InstanceId: (properties['InstanceId'] as string) ?? undefined,
          NetworkInterfaceId: (properties['NetworkInterfaceId'] as string) ?? undefined,
          TransitGatewayId: (properties['TransitGatewayId'] as string) ?? undefined,
          VpcEndpointId: (properties['VpcEndpointId'] as string) ?? undefined,
          VpcPeeringConnectionId: (properties['VpcPeeringConnectionId'] as string) ?? undefined,
        })
      );

      this.logger.debug(`Successfully created Route ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
        ...(effectiveProperties && { effectiveProperties }),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Route ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateRoute(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Route ${logicalId}: ${physicalId}`);

    // No-op short-circuit: a `cdkd drift --revert` round-trip can call
    // update() with new == old when only sibling resources drifted.
    // Without this guard, the delete + recreate path below would
    // needlessly churn a Route that AWS already has in the right shape.
    if (JSON.stringify(properties) === JSON.stringify(previousProperties)) {
      return { physicalId, wasReplaced: false };
    }

    // Route updates require replacement (DestinationCidrBlock and RouteTableId are immutable)
    // For target changes, we delete and recreate
    try {
      await this.deleteRoute(logicalId, physicalId, resourceType);
      const createResult = await this.createRoute(
        logicalId,
        resourceType,
        properties,
        // NOTE: this downgrades ONLY the multi-destination guard. The
        // required-field check at the top of createRoute is deliberately NOT
        // downgraded and can still throw on this post-delete path (a bag
        // missing RouteTableId or every destination has nothing to create
        // from) — that is pre-existing behavior, not something this callback
        // claims to cover.
        //
        // `rollback-executor.ts`'s revert arm and `cdkd drift --revert` both
        // call update() with a cdkd STATE record as the desired bag, and this
        // method has no context parameter to tell that apart from a template
        // update — so the refusal downgrades to a warning on every update, per
        // the "an UPDATE-path refusal is a replay refusal too" rule. The route
        // was already deleted above; throwing here would strand it.
        (message) => this.logger.warn(message)
      );
      return {
        physicalId: createResult.physicalId,
        wasReplaced: true,
        ...(createResult.attributes && { attributes: createResult.attributes }),
        // Forwarded, not re-derived: the re-create above is the call that
        // narrowed, and this is the path the phantom drift actually reached
        // users on — `update()` is the only entry a multi-destination bag can
        // still get through, since create refuses it outright (issue #1591).
        ...(createResult.effectiveProperties && {
          effectiveProperties: createResult.effectiveProperties,
        }),
      };
    } catch (error) {
      // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
      // ProvisioningError replaces its precise message with this outer one.
      // Accepted trade-off on the delete-then-create replacement path: a failed
      // re-create now surfaces as its own `Failed to create ...` (physicalId
      // undefined) rather than being relabelled `Failed to update ...`. The
      // inner message is the more precise one; nothing reads
      // ProvisioningError.physicalId.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Route ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteRoute(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Route ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new ProvisioningError(
        compositeIdFormatMessage(EC2_ROUTE_ID_FORMAT, logicalId, physicalId),
        resourceType,
        logicalId,
        physicalId
      );
    }

    const [routeTableId, destination] = parts;

    try {
      // The destination segment discriminates by shape: ':' = IPv6 CIDR,
      // 'pl-' = managed prefix list, anything else = IPv4 CIDR.
      const destinationParam = destination?.includes(':')
        ? { DestinationIpv6CidrBlock: destination }
        : destination?.startsWith('pl-')
          ? { DestinationPrefixListId: destination }
          : { DestinationCidrBlock: destination };
      await this.ec2Client.send(
        new DeleteRouteCommand({
          RouteTableId: routeTableId,
          ...destinationParam,
        })
      );
      this.logger.debug(`Successfully deleted Route ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Route ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Route ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::EC2::SubnetRouteTableAssociation ────────────────────────

  private async createSubnetRouteTableAssociation(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SubnetRouteTableAssociation ${logicalId}`);

    const subnetId = properties['SubnetId'] as string;
    const routeTableId = properties['RouteTableId'] as string;

    if (!subnetId || !routeTableId) {
      throw new ProvisioningError(
        `SubnetId and RouteTableId are required for SubnetRouteTableAssociation ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.ec2Client.send(
        new AssociateRouteTableCommand({
          SubnetId: subnetId,
          RouteTableId: routeTableId,
        })
      );

      const associationId = response.AssociationId!;
      this.logger.debug(
        `Successfully created SubnetRouteTableAssociation ${logicalId}: ${associationId}`
      );

      return {
        physicalId: associationId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SubnetRouteTableAssociation ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private updateSubnetRouteTableAssociation(
    logicalId: string,
    physicalId: string
  ): Promise<ResourceUpdateResult> {
    void physicalId;
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::EC2::SubnetRouteTableAssociation',
        logicalId,
        'destroy + redeploy the association. (SubnetId, RouteTableId) is immutable.'
      )
    );
  }

  private async deleteSubnetRouteTableAssociation(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SubnetRouteTableAssociation ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DisassociateRouteTableCommand({ AssociationId: physicalId }));
      this.logger.debug(`Successfully deleted SubnetRouteTableAssociation ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `SubnetRouteTableAssociation ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SubnetRouteTableAssociation ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::EC2::SecurityGroup ──────────────────────────────────────

  private async createSecurityGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SecurityGroup ${logicalId}`);

    const groupDescription = properties['GroupDescription'] as string;
    if (!groupDescription) {
      throw new ProvisioningError(
        `GroupDescription is required for SecurityGroup ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.ec2Client.send(
        new CreateSecurityGroupCommand({
          GroupName: (properties['GroupName'] as string) ?? logicalId,
          Description: groupDescription,
          VpcId: (properties['VpcId'] as string) ?? undefined,
        })
      );

      const groupId = response.GroupId!;

      // CreateSecurityGroupCommand has succeeded — AWS has now committed
      // the SG. If applyTags / Authorize* / Revoke* throws, the SG exists
      // on AWS but cdkd state will NOT. The next redeploy plans CREATE
      // and AWS would reject with `InvalidGroup.Duplicate: The security
      // group '<name>' already exists for VPC ...` (when VpcId+GroupName
      // produces a collision) — or worse, when GroupName is auto-generated
      // from logicalId, a fresh SG would be created leaving the first
      // orphaned. Wrap wiring in an inner try/catch that issues a
      // best-effort `DeleteSecurityGroupCommand` before re-throwing the
      // original error. A freshly-created SG has no ENIs / dependents
      // attached, so a single DeleteSecurityGroup suffices (its inline
      // rules CASCADE-delete with the SG).
      try {
        // Wiring a freshly-created SG used to be a fully serialized chain:
        // CreateTags -> one AuthorizeSecurityGroupIngress PER RULE ->
        // RevokeSecurityGroupEgress -> one AuthorizeSecurityGroupEgress PER
        // RULE. On a typical CDK L2 SG (1 tag set, 1 ingress rule, 1 egress
        // rule) that is 4 sequential round trips on the deploy critical path.
        //
        // Two independent fixes, neither of which changes the end state:
        //   1. Tagging and the two rule DIRECTIONS are mutually independent
        //      (distinct AWS APIs, distinct rule sets on the group), so they
        //      run concurrently. Within the egress branch the revoke still
        //      strictly precedes the authorize (see below).
        //   2. Authorize{Ingress,Egress} accept an `IpPermissions` ARRAY, so
        //      N rules become ONE call instead of N.
        //
        // Failure semantics are unchanged, but ONLY because this is
        // allSettled and not all. `Promise.all` rejects the moment the first
        // branch does, while the other two are still in flight -- so the
        // outer catch would issue DeleteSecurityGroup concurrently with a
        // pending Authorize / Revoke / CreateTags on the same group. That
        // delete comes back DependencyViolation or InvalidGroup.NotFound,
        // the cleanup only warns, and the half-wired SG leaks: exactly the
        // orphan the cleanup exists to prevent. Serially this could not
        // happen, because nothing was in flight at cleanup time.
        //
        // allSettled waits for all three to settle before anything is thrown,
        // so the group is quiescent when the delete goes out. The first
        // rejection is rethrown so the caller sees the original cause; the
        // remaining rejections are already handled by allSettled and cannot
        // surface as unhandled.
        const ingressRules = properties['SecurityGroupIngress'] as
          | Array<Record<string, unknown>>
          | undefined;
        const egressRules = properties['SecurityGroupEgress'] as
          | Array<Record<string, unknown>>
          | undefined;

        const wiring = await Promise.allSettled([
          this.applyTags(groupId, properties, logicalId),
          this.authorizeInlineIngress(groupId, ingressRules),
          this.applyInlineEgress(groupId, egressRules),
        ]);
        const firstRejection = wiring.find((r) => r.status === 'rejected');
        if (firstRejection) {
          throw (firstRejection as PromiseRejectedResult).reason;
        }
      } catch (innerError) {
        try {
          await this.ec2Client.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
          this.logger.debug(
            `Cleaned up partially-created SecurityGroup ${logicalId} (${groupId}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created SecurityGroup ${logicalId} (${groupId}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws ec2 delete-security-group --group-id ${groupId}`
          );
        }
        throw innerError;
      }

      this.logger.debug(`Successfully created SecurityGroup ${logicalId}: ${groupId}`);

      return {
        physicalId: groupId,
        attributes: {
          GroupId: groupId,
          VpcId: (properties['VpcId'] as string) ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SecurityGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Authorize a freshly-created security group's inline
   * `SecurityGroupIngress` rules in a SINGLE `AuthorizeSecurityGroupIngress`
   * call.
   *
   * The API takes an `IpPermissions` ARRAY; the previous per-rule loop paid
   * one round trip per rule for no benefit. AWS applies the whole list
   * atomically, so the resulting rule set is byte-identical — the only
   * behavior difference is that a bad rule now rejects the batch instead of
   * being preceded by its already-applied siblings, and the caller deletes
   * the half-wired group in either case.
   */
  private async authorizeInlineIngress(
    groupId: string,
    ingressRules: Array<Record<string, unknown>> | undefined
  ): Promise<void> {
    if (!Array.isArray(ingressRules) || ingressRules.length === 0) return;
    await this.ec2Client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: ingressRules.map((rule) => this.buildIpPermission(rule)),
      })
    );
  }

  /**
   * Apply a freshly-created security group's inline `SecurityGroupEgress`
   * rules.
   *
   * When a template specifies egress explicitly, CloudFormation replaces the
   * AWS-default "allow all egress" rule (`-1` / `0.0.0.0/0`) with the
   * supplied set, so cdkd revokes the default first and then authorizes the
   * template's rules. Both steps are preserved, including for an EMPTY
   * `SecurityGroupEgress: []` — that is a deliberate "no egress at all",
   * which requires the revoke and no authorize.
   *
   * Two round trips are saved where they are provably redundant:
   *
   *   - The whole revoke+authorize pair is SKIPPED when the templated egress
   *     is exactly the rule AWS already created by default. `isDefaultEgressRule`
   *     is the exact comparator (protocol `-1`, `CidrIp 0.0.0.0/0`, no IPv6
   *     range / peer group / prefix list / description, ports absent or `-1`)
   *     and is the SAME predicate the drift reverse-mapper uses to recognize
   *     the AWS default, so the two cannot disagree about what "default" means.
   *     AWS creates exactly ONE default egress rule and it is IPv4-only (there
   *     is no `::/0` default), which is why a single-element match is the right
   *     shape. NOTE this deliberately does NOT fire for the CDK L2
   *     `allowAllOutbound: true` shape, which stamps
   *     `Description: 'Allow all outbound traffic by default'` — the AWS
   *     default rule carries no description, so skipping there would leave the
   *     group in a state CloudFormation would not produce AND would surface as
   *     permanent phantom drift (`readCurrentState` would report no
   *     Description while state records one).
   *   - The remaining authorize is a SINGLE batched call rather than one per
   *     rule (see {@link authorizeInlineIngress}).
   */
  private async applyInlineEgress(
    groupId: string,
    egressRules: Array<Record<string, unknown>> | undefined
  ): Promise<void> {
    if (!Array.isArray(egressRules)) return;

    if (egressRules.length === 1 && isDefaultEgressRule(egressRules[0]!)) {
      this.logger.debug(
        `SecurityGroup ${groupId} egress equals the AWS default allow-all rule; ` +
          `skipping the redundant revoke + re-authorize`
      );
      return;
    }

    // Revoke the AWS-default "allow all egress" rule so it does not coexist
    // with user-specified rules. Tolerate "not found" if the default is absent.
    try {
      await this.ec2Client.send(
        new RevokeSecurityGroupEgressCommand({
          GroupId: groupId,
          IpPermissions: [
            {
              IpProtocol: '-1',
              IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
          ],
        })
      );
    } catch (error) {
      if (!this.isNotFoundError(error)) {
        throw error;
      }
    }

    if (egressRules.length === 0) return;
    await this.ec2Client.send(
      new AuthorizeSecurityGroupEgressCommand({
        GroupId: groupId,
        IpPermissions: egressRules.map((rule) => this.buildIpPermission(rule, 'egress')),
      })
    );
  }

  private async updateSecurityGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SecurityGroup ${logicalId}: ${physicalId}`);

    try {
      // Update tags (diff add/remove against previousProperties)
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      // Diff and apply ingress rule changes (symmetric with egress below).
      await this.applySecurityGroupRuleDiff(
        physicalId,
        (previousProperties['SecurityGroupIngress'] as Array<Record<string, unknown>>) ?? [],
        (properties['SecurityGroupIngress'] as Array<Record<string, unknown>>) ?? [],
        'ingress'
      );

      // Diff and apply egress rule changes
      await this.applySecurityGroupRuleDiff(
        physicalId,
        (previousProperties['SecurityGroupEgress'] as Array<Record<string, unknown>>) ?? [],
        (properties['SecurityGroupEgress'] as Array<Record<string, unknown>>) ?? [],
        'egress'
      );

      this.logger.debug(`Successfully updated SecurityGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          GroupId: physicalId,
          VpcId: (properties['VpcId'] as string) ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SecurityGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteSecurityGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SecurityGroup ${logicalId}: ${physicalId}`);

    // Retry with backoff for "dependent object" errors (e.g., ECS ENI cleanup delay)
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.ec2Client.send(new DeleteSecurityGroupCommand({ GroupId: physicalId }));
        this.logger.debug(`Successfully deleted SecurityGroup ${logicalId}`);
        return;
      } catch (error) {
        if (this.isNotFoundError(error)) {
          const clientRegion = await this.ec2Client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`SecurityGroup ${physicalId} does not exist, skipping deletion`);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('dependent object') && attempt < maxAttempts) {
          // Same side-channel as deleteSubnet: clean up Lambda-managed
          // ENIs that still reference this SG, then sleep and retry.
          await this.cleanupSecurityGroupLambdaEnis(physicalId);
          this.logger.debug(
            `SecurityGroup ${physicalId} has dependent objects (attempt ${attempt}/${maxAttempts}), retrying in ${attempt * 5}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
          continue;
        }
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to delete SecurityGroup ${logicalId}: ${msg}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }
  }

  /**
   * Best-effort: list Lambda-managed ENIs that reference the given security
   * group and try to delete each one. Mirror of cleanupSubnetLambdaEnis but
   * filtered by `group-id`.
   */
  private async cleanupSecurityGroupLambdaEnis(groupId: string): Promise<void> {
    let enis: { id: string; status: string }[];
    try {
      const resp = await this.ec2Client.send(
        new DescribeNetworkInterfacesCommand({
          Filters: [
            { Name: 'group-id', Values: [groupId] },
            // See cleanupSubnetLambdaEnis: requester-id does not contain
            // "awslambda" — filter on description instead.
            { Name: 'description', Values: ['AWS Lambda VPC ENI-*'] },
          ],
        })
      );
      enis = (resp.NetworkInterfaces ?? [])
        .filter((ni) => ni.NetworkInterfaceId)
        .map((ni) => ({ id: ni.NetworkInterfaceId!, status: ni.Status ?? 'unknown' }));
    } catch (err) {
      this.logger.debug(
        `cleanupSecurityGroupLambdaEnis: DescribeNetworkInterfaces failed for ${groupId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    if (enis.length === 0) return;
    await Promise.all(
      enis.map(async (eni) => {
        try {
          await this.ec2Client.send(
            new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eni.id })
          );
          this.logger.debug(
            `cleanupSecurityGroupLambdaEnis: deleted Lambda ENI ${eni.id} for SG ${groupId}`
          );
        } catch (err) {
          this.logger.debug(
            `cleanupSecurityGroupLambdaEnis: ENI ${eni.id} (status=${eni.status}) not yet deletable: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      })
    );
  }

  private async getSecurityGroupAttribute(
    physicalId: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'GroupId') return physicalId;

    try {
      const response = await this.ec2Client.send(
        new DescribeSecurityGroupsCommand({ GroupIds: [physicalId] })
      );
      const sg = response.SecurityGroups?.[0];
      if (!sg) return undefined;

      if (attributeName === 'VpcId') return sg.VpcId;
      return undefined;
    } catch {
      return undefined;
    }
  }

  // ─── AWS::EC2::SecurityGroupIngress ───────────────────────────────

  /**
   * @param onUnusableProtocol When supplied, a malformed `IpProtocol` WARNS and
   *   defaults instead of throwing. Passed by `updateSecurityGroupIngress`,
   *   which reaches this method as the re-create half of a delete-then-create
   *   replacement: by then `RevokeSecurityGroupIngress` has already committed,
   *   so a refusal would leave the rule deleted from AWS with the op failed —
   *   and on a rollback replay the value comes from a STATE record, which no
   *   template edit can fix. Absent (the plain CREATE dispatch) it throws.
   */
  private async createSecurityGroupIngress(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    onUnusableProtocol?: (message: string) => void
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SecurityGroupIngress ${logicalId}`);

    const groupId = properties['GroupId'] as string;
    if (!groupId) {
      throw new ProvisioningError(
        `GroupId is required for SecurityGroupIngress ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Guarded HERE rather than in `buildIpPermission` (which re-reads the same
    // bag on this path): that helper is also reached from
    // `deleteSecurityGroupIngress` and from the REVOKE half of the inline-rule
    // update diff, both carrying STATE-borne rules, where a refusal would break
    // destroy and rollback. Refusing on the create path stops a malformed value
    // before the helper is ever reached. `coerceNumber` because an unquoted
    // YAML `IpProtocol: -1` is a NUMBER today and deploys fine (issue #1513).
    // `narrowIngressIpProtocol` wraps that guard and ALSO reports the bag that
    // describes what it resolved, so the engine can record the value actually
    // sent instead of the malformed / numeric one the template wrote (issue
    // #1633). The refusal / warn behavior is unchanged — the callback is
    // forwarded verbatim.
    const { ipProtocol, narrowed } = narrowIngressIpProtocol(properties, onUnusableProtocol);
    // Absent unless the resolved protocol differs from the declared one, which
    // is what keeps an ordinary rule's state record byte-identical.
    const effectiveProperties = narrowed === properties ? undefined : narrowed;
    const fromPort = properties['FromPort'] as number | undefined;
    const toPort = properties['ToPort'] as number | undefined;

    // Refuse a `|` in any segment BEFORE `AuthorizeSecurityGroupIngress` runs
    // (issue #1672). `GroupId` is an AWS-generated `sg-...` and the ports are
    // numbers, so the only segment cdkd's own guards would let through as an
    // arbitrary string is `IpProtocol` — `requireConfigString` accepts any
    // non-blank string. AWS itself would reject such a protocol, so this is
    // unverified defense-in-depth rather than a measured hazard; refusing here
    // rather than leaving it to AWS keeps the id from being recorded on the
    // idempotent "already exists" arm below. The downgrade reuses `onUnusableProtocol`,
    // which `updateSecurityGroupIngress` passes UNCONDITIONALLY: that path has
    // already REVOKED the rule, so a throw would leave it deleted from AWS with
    // no template-side remedy — the same constraint the protocol guard above
    // records.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'groupId', value: groupId },
        { name: 'ipProtocol', value: ipProtocol },
        { name: 'fromPort', value: fromPort ?? '-1' },
        { name: 'toPort', value: toPort ?? '-1' },
      ],
      onUnusableProtocol ? { onRefusal: onUnusableProtocol } : undefined
    );

    try {
      const response = await this.ec2Client.send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId: groupId,
          // Override the protocol with the GUARDED value. `buildIpPermission`
          // deliberately re-reads the raw bag (it is shared with the
          // state-borne delete / revoke paths), and its own `?? '-1'` only
          // rescues null/undefined — so without this override a warned-about
          // `''` / `{}` / `true` would reach AWS verbatim, fail the call, and
          // leave the rule revoked on the update path. That is the blocker this
          // guard exists to prevent, one level further along.
          IpPermissions: [{ ...this.buildIpPermission(properties), IpProtocol: ipProtocol }],
        })
      );

      // Issue #1761: the `sgr-...` rule id is read off the response the
      // MUTATING call itself returned — deliberately not from a follow-up
      // `DescribeSecurityGroupRules`. Adding an `await` between the Authorize
      // above and the return below re-creates the issue #1710 orphan class: a
      // throw there leaves the rule live on AWS while the failed CREATE
      // journals no physicalId, so nothing ever revokes it. `singleRuleId`
      // is pure and cannot throw.
      const ruleId = singleSecurityGroupRuleId(response.SecurityGroupRules);

      this.logger.debug(`Successfully created SecurityGroupIngress ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        // Recorded under `Id`, which is BOTH the type's CloudFormation
        // `primaryIdentifier` and its only `Fn::GetAtt` attribute name (live
        // `describe-type`, us-east-1, 2026-08-13: `primaryIdentifier` and
        // `readOnlyProperties` are both exactly `["/properties/Id"]`). cdkd's
        // physicalId for the type is the composite tuple its own revoke call
        // needs, which is NOT the CFn identifier — so without this attribute
        // `cdkd export` has nothing to resolve (issue #1761).
        attributes: ruleId ? { Id: ruleId } : {},
        ...(effectiveProperties && { effectiveProperties }),
      };
    } catch (error) {
      // Treat "already exists" as success (idempotent, like CloudFormation)
      if (error instanceof Error && error.message.includes('already exists')) {
        this.logger.debug(`SecurityGroupIngress ${logicalId} already exists, treating as success`);
        // The Authorize FAILED, so no response carries the rule id — but this
        // arm still reports the rule as provisioned and state is written from
        // it, so the id has to be looked up or `cdkd export` refuses exactly
        // the resources a re-run adopted (issue #1761). Best-effort by
        // construction: `lookupIngressRuleId` swallows its own failures and
        // returns `undefined`, because turning today's idempotent success into
        // a deploy failure over a missing export-time convenience would be a
        // strictly worse trade. Safe to `await` here in a way the success arm
        // is not — this path created nothing, so there is nothing to orphan.
        const existingRuleId = await this.lookupIngressRuleId(logicalId, groupId, {
          ...properties,
          IpProtocol: ipProtocol,
        });
        // The same record the success arm writes: this arm reports the rule as
        // provisioned, so state is written here too and the narrowing has to
        // reach it or the phantom drift survives on the idempotent path.
        return {
          physicalId,
          attributes: existingRuleId ? { Id: existingRuleId } : {},
          ...(effectiveProperties && { effectiveProperties }),
        };
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SecurityGroupIngress ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Best-effort lookup of the `sgr-...` id of an ALREADY-EXISTING ingress rule
   * (issue #1761).
   *
   * Only the idempotent "already exists" arm of {@link createSecurityGroupIngress}
   * calls this: the successful arm reads the id straight off
   * `AuthorizeSecurityGroupIngress`'s own response, which is what keeps the
   * mutating path free of the issue #1710 orphan hazard.
   *
   * **Never throws.** A `DescribeSecurityGroupRules` failure (permissions,
   * throttle, a rule that no longer matches) degrades to `undefined`, which
   * records no attribute — `cdkd export` then refuses that one resource with
   * its own actionable message, which is strictly better than failing a deploy
   * that AWS already considers satisfied.
   *
   * Returns a value only when EXACTLY ONE non-egress rule on the group matches
   * the requested `(protocol, ports, source)` triple. Zero matches means the
   * "already exists" error came from a rule cdkd cannot pin down; two or more
   * means the identifier would be ambiguous, and adopting an ambiguous id is
   * the #1658 failure mode (a state row that looks adopted but names the wrong
   * AWS object).
   */
  private async lookupIngressRuleId(
    logicalId: string,
    groupId: string,
    properties: Record<string, unknown>
  ): Promise<string | undefined> {
    try {
      const resp = await this.ec2Client.send(
        new DescribeSecurityGroupRulesCommand({
          Filters: [{ Name: 'group-id', Values: [groupId] }],
        })
      );
      const matches = (resp.SecurityGroupRules ?? []).filter(
        (rule) => rule.IsEgress !== true && securityGroupRuleMatchesCfnIngress(rule, properties)
      );
      const ids = matches
        .map((rule) => rule.SecurityGroupRuleId)
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '');
      if (ids.length !== 1) {
        this.logger.debug(
          `SecurityGroupIngress ${logicalId}: ${ids.length} existing rule(s) on ${groupId} match ` +
            `the requested protocol/ports/source — not recording an Id attribute`
        );
        return undefined;
      }
      return ids[0];
    } catch (error) {
      this.logger.debug(
        `SecurityGroupIngress ${logicalId}: could not look up the existing rule id on ${groupId} ` +
          `(${error instanceof Error ? error.message : String(error)}) — not recording an Id attribute`
      );
      return undefined;
    }
  }

  private async updateSecurityGroupIngress(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SecurityGroupIngress ${logicalId}: ${physicalId}`);

    // No-op short-circuit (mirrors `updateRoute`): a `cdkd drift --revert`
    // round-trip can call update() with new == old, which without this
    // guard would needlessly revoke + re-authorize the rule.
    if (JSON.stringify(properties) === JSON.stringify(previousProperties)) {
      return { physicalId, wasReplaced: false };
    }

    // SecurityGroupIngress updates require replacement: revoke old, authorize new
    try {
      await this.deleteSecurityGroupIngress(
        logicalId,
        physicalId,
        resourceType,
        previousProperties
      );
      const createResult = await this.createSecurityGroupIngress(
        logicalId,
        resourceType,
        properties,
        // The revoke above has already committed, and on a rollback replay
        // `properties` is a STATE record — so warn and default rather than
        // strand the rule deleted with no template-side remedy.
        (message) => this.logger.warn(message)
      );
      return {
        physicalId: createResult.physicalId,
        wasReplaced: true,
        ...(createResult.attributes && { attributes: createResult.attributes }),
        // Forward the re-create's narrowing (issue #1633). This arm is the one
        // the phantom drift is actually reachable through today — a malformed
        // `IpProtocol` only survives to reach a rule that already exists, and
        // the create arm above ran with the warn callback, so without this the
        // engine records the malformed desired bag and the next `cdkd drift`
        // reports the same difference again.
        ...(createResult.effectiveProperties && {
          effectiveProperties: createResult.effectiveProperties,
        }),
      };
    } catch (error) {
      // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
      // ProvisioningError replaces its precise message with this outer one.
      // Accepted trade-off on the delete-then-create replacement path: a failed
      // re-create now surfaces as its own `Failed to create ...` (physicalId
      // undefined) rather than being relabelled `Failed to update ...`. The
      // inner message is the more precise one; nothing reads
      // ProvisioningError.physicalId.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SecurityGroupIngress ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteSecurityGroupIngress(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SecurityGroupIngress ${logicalId}: ${physicalId}`);

    // Parse composite physicalId: GroupId|Protocol|FromPort|ToPort
    const parts = physicalId.split('|');
    if (parts.length !== 4) {
      throw new ProvisioningError(
        compositeIdFormatMessage(EC2_SG_INGRESS_ID_FORMAT, logicalId, physicalId),
        resourceType,
        logicalId,
        physicalId
      );
    }

    const [groupId, ipProtocol, fromPortStr, toPortStr] = parts;

    // Build IpPermission from properties if available, otherwise from physicalId
    const ipPermission = properties
      ? this.buildIpPermission(properties)
      : {
          IpProtocol: ipProtocol,
          FromPort: fromPortStr !== '-1' ? Number(fromPortStr) : undefined,
          ToPort: toPortStr !== '-1' ? Number(toPortStr) : undefined,
        };

    try {
      await this.ec2Client.send(
        new RevokeSecurityGroupIngressCommand({
          GroupId: groupId,
          IpPermissions: [ipPermission],
        })
      );
      this.logger.debug(`Successfully deleted SecurityGroupIngress ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`SecurityGroupIngress ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SecurityGroupIngress ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::EC2::Instance ──────────────────────────────────────────

  private async createInstance(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating EC2 Instance ${logicalId}`);

    const imageId = properties['ImageId'] as string;
    if (!imageId) {
      throw new ProvisioningError(
        `ImageId is required for EC2 Instance ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // No `coerceNumber`: an instance type is never a bare scalar, so a number
    // here is a template bug rather than YAML's scalar coercion (issue #1513).
    const instanceType = requireConfigString(
      properties['InstanceType'],
      't3.micro',
      'AWS::EC2::Instance InstanceType',
      replayWarn(this.logger, context)
    );

    try {
      const securityGroupIds = properties['SecurityGroupIds'] as string[] | undefined;
      const securityGroups = properties['SecurityGroups'] as string[] | undefined;
      // The CFn `AWS::EC2::Instance.IamInstanceProfile` property is the
      // instance-profile NAME (a plain string) — what `instanceProfile.ref`
      // resolves to in CDK. It is NOT the `{Arn,Name}` object the
      // `RunInstances` SDK input takes (that object shape is what
      // `AWS::EC2::LaunchTemplate` uses). The previous code cast the property
      // to `Record<string, unknown>` and read `['Arn']` / `['Name']` off it —
      // both `undefined` for a string — so `RunInstances` got an empty
      // profile spec, the instance launched with NO profile, and the later
      // associate helper returned early (no arn/name). Normalize all three
      // accepted input shapes (name string / ARN string / `{Arn,Name}` object)
      // into one `{arn?,name?}` here, robust to name-vs-ARN.
      const iamInstanceProfile = this.normalizeIamInstanceProfile(properties['IamInstanceProfile']);

      // Issue #1281: RunInstances rejects NetworkInterfaces[].SubnetId/Groups
      // combined with top-level SubnetId / SecurityGroupIds. CDK emits exactly
      // one shape (setting associatePublicIpAddress swaps the L2 construct
      // from top-level fields to a single NetworkInterfaces entry), so cdkd
      // passes through whichever the template carries rather than merging;
      // a hand-authored template carrying BOTH gets AWS's own rejection,
      // which is the correct error to surface.
      const networkInterfaces = this.buildNetworkInterfaces(properties);

      const response = await this.ec2Client.send(
        new RunInstancesCommand({
          ImageId: imageId,
          InstanceType: instanceType as _InstanceType,
          KeyName: (properties['KeyName'] as string) ?? undefined,
          NetworkInterfaces: networkInterfaces,
          SecurityGroupIds: securityGroupIds ?? undefined,
          SecurityGroups: securityGroups ?? undefined,
          SubnetId: (properties['SubnetId'] as string) ?? undefined,
          UserData: (properties['UserData'] as string) ?? undefined,
          MinCount: 1,
          MaxCount: 1,
          IamInstanceProfile: iamInstanceProfile
            ? { Arn: iamInstanceProfile.arn, Name: iamInstanceProfile.name }
            : undefined,
          BlockDeviceMappings: this.buildBlockDeviceMappings(properties),
          // Security-focused backfill (#609). These all ride on RunInstances
          // input so they take effect at launch (no post-create modify needed):
          //  - DisableApiTermination: termination protection (security: a
          //    silent-drop made the user think the instance was protected
          //    when it wasn't).
          //  - MetadataOptions: IMDSv2 enforcement (HttpTokens=required)
          //    mitigates SSRF credential theft.
          //  - Monitoring.Enabled: detailed CloudWatch monitoring.
          //  - EbsOptimized: dedicated EBS throughput.
          //  - CreditSpecification.CpuCredits: T-family burstable mode.
          DisableApiTermination: this.coerceBool(properties['DisableApiTermination']),
          EbsOptimized: this.coerceBool(properties['EbsOptimized']),
          Monitoring: this.buildRunInstancesMonitoring(properties),
          MetadataOptions: this.buildMetadataOptions(properties),
          CreditSpecification: this.buildCreditSpecification(properties),
          // Issue #1276. `SubnetId` already pins the AZ, so this is usually
          // redundant -- but the CFn property exists, the CDK L2 construct
          // always emits it, and leaving it unhandled is what routed L2
          // instances onto the Cloud Control path. When both are present and
          // DISAGREE, AWS rejects the RunInstances call; that is the correct
          // outcome to surface rather than to paper over by dropping one.
          Placement: this.buildPlacement(properties),
        })
      );

      const instance = response.Instances?.[0];
      if (!instance?.InstanceId) {
        // Theoretical AWS SDK contract violation: RunInstances returned
        // success but with no Instance. Cannot clean up — we have no
        // InstanceId to terminate. This path has never been observed in
        // practice. If it does happen, the orphan must be tracked down via
        // billing console.
        throw new Error('No instance ID returned from RunInstances');
      }

      const instanceId = instance.InstanceId;

      // RunInstancesCommand has succeeded — AWS has now launched the
      // instance and BILLING HAS STARTED. This is the **cost-leak class**
      // of partial-create orphan: a system-generated InstanceId means
      // cdkd's next-deploy diff cannot detect the orphan by name, and
      // the running instance accrues charges until manual cleanup. If a
      // subsequent wiring call (tags / waiter / describe) throws — most
      // commonly the waiter timing out on a slow-boot AMI, or a typo'd
      // huge InstanceType failing capacity — the instance keeps running.
      // Wrap the wiring in an inner try/catch that issues a best-effort
      // `TerminateInstancesCommand` before re-throwing the original
      // error. We do NOT wait for terminate to complete (the deploy is
      // already failing; making the user wait another 30-120s for the
      // error to surface is bad UX, and if the waiter itself was the
      // wiring failure, waiting again would be ironic). The WARN
      // message names the exact InstanceId so the user can verify
      // termination via `aws ec2 describe-instances` if cleanup itself
      // failed.
      try {
        // Apply tags
        await this.applyTags(instanceId, properties, logicalId);

        // Wait for instance to reach running state unless --no-wait is set.
        // Same gating pattern as the NAT Gateway wait above. Before issue
        // #1277 this wait was unconditional, so `--no-wait` silently did
        // nothing on any stack containing an EC2 instance.
        if (process.env['CDKD_NO_WAIT'] !== 'true') {
          this.logger.debug(`Waiting for instance ${instanceId} to be running...`);
          await waitUntilInstanceRunning(
            // Poll cadence matters more here than on any other type, because an
            // instance reaches `running` in ~30-60s — the same order as the poll
            // interval itself, so the interval is a large fraction of the total.
            //
            // The SDK waiter picks each delay as
            //   uniform_random(minDelay, min(minDelay * 2^(attempt-1), maxDelay))
            // so a 5/15 config polls at ~5, ~12.5, ~22.5, ~32.5, ~42.5s and an
            // instance that went `running` at 35s is not SEEN until ~42.5s. The
            // mean detection lag is maxDelay/2 once the backoff saturates, i.e.
            // 7.5s of pure dead time on a ~35s operation, and because each delay
            // is randomized the total swings run to run (measured: 34.9 / 43.5 /
            // 56.6s on one 3-instance stack). 2/5 puts the mean lag at ~1.75s
            // and the cadence in line with what the AWS provider for Terraform
            // does (10s initial delay, then ~3s polls).
            //
            // The extra DescribeInstances calls are cheap and the deploy engine
            // caps concurrency, so the call-volume trade is worth the seconds.
            // Sibling waiters were already tightened to a 10s cap by the #1177
            // sweep; this one and the NAT gateway pair kept the looser 15s.
            { client: this.ec2Client, maxWaitTime: 300, minDelay: 2, maxDelay: 5 },
            { InstanceIds: [instanceId] }
          );
        } else {
          this.logger.debug(
            `Instance ${instanceId} launched (skipping running-state wait per --no-wait)`
          );
        }

        // Ensure the freshly-created IAM instance profile actually bound.
        // cdkd's fast SDK path creates the InstanceProfile only ~1s before
        // RunInstances; an instance profile (and its role membership) takes a
        // few seconds to propagate to EC2's view. RunInstances does NOT
        // synchronously validate the profile against IAM — it accepts the
        // request and associates the profile asynchronously, and when the
        // profile isn't visible yet the launch can complete with NO profile
        // attached and NO error raised (the symptom: the running instance has
        // an empty IamInstanceProfile despite the template requesting one).
        // CloudFormation never hits this because its deployment latency lets
        // the profile settle before launch; cdkd does NOT, so verify the
        // association post-launch and explicitly AssociateIamInstanceProfile
        // (retrying through the propagation window) when it is missing.
        //
        // Under --no-wait the instance is still `pending`, and
        // `AssociateIamInstanceProfile` is rejected outright for any instance
        // not in `running` or `stopped` ("The instance 'i-...' is not in the
        // 'running' or 'stopped' states"). That is not a propagation error the
        // retry loop can absorb — it stays true until the instance reaches
        // `running`, which is exactly the wait --no-wait asked to skip. So the
        // check is skipped and the risk is reported instead: the whole point of
        // --no-wait is that the caller accepts an un-settled resource, but a
        // SILENTLY profile-less instance is a much worse surprise than an
        // unassigned IP, so this warns rather than staying quiet (issue #1279).
        if (iamInstanceProfile) {
          if (process.env['CDKD_NO_WAIT'] === 'true') {
            const profileRef = iamInstanceProfile.arn ?? iamInstanceProfile.name;
            this.logger.warn(
              `Skipped the IAM instance profile association check for ${logicalId} (${instanceId}) ` +
                `because --no-wait leaves the instance in 'pending', where AssociateIamInstanceProfile ` +
                `is rejected. RunInstances associates the profile asynchronously and can complete with ` +
                `NO profile attached when the profile was created moments earlier. Verify with: ` +
                `aws ec2 describe-iam-instance-profile-associations --filters ` +
                `Name=instance-id,Values=${instanceId} — and if it is missing, re-associate with: ` +
                `aws ec2 associate-iam-instance-profile --instance-id ${instanceId} ` +
                `--iam-instance-profile ${iamInstanceProfile.arn ? `Arn=${profileRef}` : `Name=${profileRef}`}`
            );
          } else {
            await this.ensureIamInstanceProfileAssociated(
              instanceId,
              iamInstanceProfile.arn,
              iamInstanceProfile.name,
              logicalId
            );
          }
        }

        // Describe instance to get attributes after running. Under
        // --no-wait the instance can still be `pending` here, so the
        // IP / DNS fields may not be assigned yet — every field below
        // already falls back to '' rather than failing, which is the
        // accepted --no-wait trade-off (same as other gated types).
        const describeResponse = await this.ec2Client.send(
          new DescribeInstancesCommand({ InstanceIds: [instanceId] })
        );
        const runningInstance = describeResponse.Reservations?.[0]?.Instances?.[0];

        const attributes: Record<string, unknown> = {
          InstanceId: instanceId,
          PrivateIp: runningInstance?.PrivateIpAddress ?? '',
          PublicIp: runningInstance?.PublicIpAddress ?? '',
          PrivateDnsName: runningInstance?.PrivateDnsName ?? '',
          PublicDnsName: runningInstance?.PublicDnsName ?? '',
          AvailabilityZone: runningInstance?.Placement?.AvailabilityZone ?? '',
        };

        this.logger.debug(`Successfully created EC2 Instance ${logicalId}: ${instanceId}`);

        return { physicalId: instanceId, attributes };
      } catch (innerError) {
        try {
          await this.ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
          this.logger.debug(
            `Terminate requested for partially-created EC2 Instance ${logicalId} (${instanceId}) after wiring failure (not waiting for terminated state)`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to terminate partially-created EC2 Instance ${logicalId} (${instanceId}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. THE INSTANCE IS STILL RUNNING AND BILLING. Manual termination required: aws ec2 terminate-instances --instance-ids ${instanceId}`
          );
        }
        throw innerError;
      }
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EC2 Instance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Normalize the CFn `AWS::EC2::Instance.IamInstanceProfile` property into a
   * `{ arn?, name? }` pair the `RunInstances` / `AssociateIamInstanceProfile`
   * SDK inputs accept.
   *
   * The CFn-canonical shape is a plain STRING — the instance-profile NAME
   * (what `instanceProfile.ref` resolves to in CDK). cdkd's intrinsic
   * resolver hands us that resolved string. For robustness we ALSO accept an
   * ARN string (classified by the `arn:` prefix) and the `{Arn,Name}` object
   * shape (defensive for hand-written / SDK-shaped templates). Returns
   * `undefined` when no profile is requested.
   */
  private normalizeIamInstanceProfile(raw: unknown): { arn?: string; name?: string } | undefined {
    if (raw == null) return undefined;
    if (typeof raw === 'string') {
      const value = raw.trim();
      if (value === '') return undefined;
      return value.startsWith('arn:') ? { arn: value } : { name: value };
    }
    if (typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const arn = typeof obj['Arn'] === 'string' ? (obj['Arn'] as string) : undefined;
      const name = typeof obj['Name'] === 'string' ? (obj['Name'] as string) : undefined;
      if (!arn && !name) return undefined;
      const normalized: { arn?: string; name?: string } = {};
      if (arn) normalized.arn = arn;
      if (name) normalized.name = name;
      return normalized;
    }
    return undefined;
  }

  /**
   * Guarantee the requested IAM instance profile is actually associated with
   * the just-launched instance, closing the fresh-profile propagation race.
   *
   * cdkd's fast SDK path creates the `AWS::IAM::InstanceProfile` only ~1s
   * before `RunInstances`. The instance profile (and the role membership the
   * `IAMInstanceProfileProvider` attached to it) takes a few seconds to
   * propagate to EC2's view. `RunInstances` does not synchronously validate
   * the supplied `IamInstanceProfile` — when the profile is not yet visible it
   * can launch the instance WITHOUT the profile and return success with no
   * error. The result is a running instance whose `IamInstanceProfile` is
   * empty even though the template requested one (the `propagation-races-2`
   * integ caught exactly this).
   *
   * Strategy (always run when a profile was requested):
   *  - `DescribeIamInstanceProfileAssociations` for the instance. Only a
   *    fully `associated` association counts as bound — an `associating`
   *    state may never complete when the profile wasn't visible at launch, so
   *    we do NOT treat it as done; we fall through and poll.
   *  - When no `associated` association exists, call
   *    `AssociateIamInstanceProfile`, retrying through the IAM propagation
   *    window on the `Invalid IAM Instance Profile ...` / `NoSuchEntity` /
   *    `not authorized` / `InvalidParameterValue` signals AWS raises while the
   *    just-created profile is still propagating.
   *  - After associating, POLL `DescribeIamInstanceProfileAssociations` until
   *    the association reaches `associated` (bounded) so the profile is
   *    genuinely bound by the time `createInstance` returns — the verify.sh
   *    `describe-instances .IamInstanceProfile` check sees it immediately.
   *    This mirrors the settle CloudFormation gets for free via its latency.
   */
  private async ensureIamInstanceProfileAssociated(
    instanceId: string,
    arn: string | undefined,
    name: string | undefined,
    logicalId: string
  ): Promise<void> {
    if (!arn && !name) return;

    // If RunInstances already fully bound the profile, we're done.
    if (await this.isInstanceProfileAssociated(instanceId)) {
      this.logger.debug(
        `IAM instance profile already associated with instance ${instanceId} (${logicalId})`
      );
      return;
    }

    this.logger.debug(
      `IAM instance profile not bound at launch for instance ${instanceId} (${logicalId}); ` +
        `associating ${arn ?? name} explicitly`
    );

    const maxAttempts = 10;
    let associated = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.ec2Client.send(
          new AssociateIamInstanceProfileCommand({
            InstanceId: instanceId,
            IamInstanceProfile: { Arn: arn, Name: name },
          })
        );
        this.logger.debug(
          `AssociateIamInstanceProfile issued for instance ${instanceId} (${logicalId}) ` +
            `on attempt ${attempt}`
        );
        associated = true;
        break;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Already associated (a concurrent RunInstances-side bind landed
        // between our describe and this associate) is success, not failure.
        if (msg.includes('IncorrectState') || msg.includes('already associated')) {
          this.logger.debug(
            `IAM instance profile already associated with instance ${instanceId} (${logicalId})`
          );
          associated = true;
          break;
        }
        if (this.isInstanceProfilePropagationError(msg) && attempt < maxAttempts) {
          this.logger.debug(
            `IAM instance profile not yet propagated for instance ${instanceId} ` +
              `(associate attempt ${attempt}/${maxAttempts}: ${msg}), retrying in ${attempt}s...`
          );
          await this.sleep(attempt * 1000);
          continue;
        }
        throw error;
      }
    }

    if (!associated) return;

    // AssociateIamInstanceProfile returns while the association is still
    // `associating`. Poll until it flips to `associated` so the profile is
    // genuinely bound before createInstance returns.
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (await this.isInstanceProfileAssociated(instanceId)) {
        this.logger.debug(
          `IAM instance profile is now associated with instance ${instanceId} (${logicalId})`
        );
        return;
      }
      if (attempt < maxAttempts) {
        this.logger.debug(
          `Waiting for IAM instance profile association to reach 'associated' for ` +
            `instance ${instanceId} (${logicalId}) (poll ${attempt}/${maxAttempts})...`
        );
        await this.sleep(attempt * 1000);
      }
    }
    this.logger.warn(
      `IAM instance profile association for instance ${instanceId} (${logicalId}) did not ` +
        `reach 'associated' within the propagation window; the instance may still be missing ` +
        `its profile`
    );
  }

  /**
   * True iff the instance currently has a fully-`associated` IAM instance
   * profile association. An `associating` state is intentionally NOT counted —
   * a launch-time association that never completes can sit in `associating`
   * forever, so the caller must poll for the terminal `associated` state.
   * A describe failure is treated as "not yet associated" so the caller falls
   * through to the associate/poll path (the real fix), not a false positive.
   */
  private async isInstanceProfileAssociated(instanceId: string): Promise<boolean> {
    try {
      const assoc = await this.ec2Client.send(
        new DescribeIamInstanceProfileAssociationsCommand({
          Filters: [{ Name: 'instance-id', Values: [instanceId] }],
        })
      );
      return assoc.IamInstanceProfileAssociations?.some((a) => a.State === 'associated') ?? false;
    } catch (err) {
      this.logger.debug(
        `DescribeIamInstanceProfileAssociations failed for ${instanceId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /**
   * Classify an AssociateIamInstanceProfile error as a fresh-profile
   * propagation signal worth retrying (vs a hard failure to surface).
   */
  private isInstanceProfilePropagationError(msg: string): boolean {
    return (
      msg.includes('Invalid IAM Instance Profile') ||
      msg.includes('NoSuchEntity') ||
      msg.includes('not authorized') ||
      (msg.includes('InvalidParameterValue') && msg.includes('instance profile'))
    );
  }

  private async updateInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // Most EC2 Instance property changes require replacement.
    // Immutable properties (ImageId, SubnetId, KeyName) are handled by
    // the deployment engine's replacement detection.
    // Tags plus four of the five security-focused backfill props (#609) —
    // DisableApiTermination / Monitoring / MetadataOptions /
    // CreditSpecification — are mutable in-place, so they are diffed
    // against previousProperties and modified here. The diff guard keeps the
    // `cdkd drift --revert` no-op round-trip (`update(state, state)`) free of
    // any mutating SDK call. The fifth, EbsOptimized, can only be changed on a
    // STOPPED instance, so an EbsOptimized change is routed to replacement via
    // the ReplacementRulesRegistry rather than modified here.
    this.logger.debug(`Updating EC2 Instance ${logicalId}: ${physicalId}`);

    try {
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      await this.updateInstanceSecurityProps(physicalId, properties, previousProperties);

      // Refresh attributes
      const describeResponse = await this.ec2Client.send(
        new DescribeInstancesCommand({ InstanceIds: [physicalId] })
      );
      const instance = describeResponse.Reservations?.[0]?.Instances?.[0];

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          InstanceId: physicalId,
          PrivateIp: instance?.PrivateIpAddress ?? '',
          PublicIp: instance?.PublicIpAddress ?? '',
          PrivateDnsName: instance?.PrivateDnsName ?? '',
          PublicDnsName: instance?.PublicDnsName ?? '',
          AvailabilityZone: instance?.Placement?.AvailabilityZone ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update EC2 Instance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply in-place modifications for four of the five security-focused
   * backfill props (#609). Each is diffed against `previousProperties` so a
   * no-drift round-trip (`update(state, state)`) issues zero mutating calls
   * (the `cdkd drift --revert` invariant). Each maps to a distinct EC2
   * modify API:
   *   - DisableApiTermination -> ModifyInstanceAttribute
   *   - Monitoring            -> MonitorInstances / UnmonitorInstances
   *   - MetadataOptions       -> ModifyInstanceMetadataOptions
   *   - CreditSpecification   -> ModifyInstanceCreditSpecification
   * EbsOptimized is NOT here: it can only be changed on a STOPPED instance, so
   * an EbsOptimized change is routed to replacement (see ReplacementRules).
   */
  private async updateInstanceSecurityProps(
    physicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<void> {
    // DisableApiTermination — ModifyInstanceAttribute.
    const newDisableApiTermination = this.coerceBool(properties['DisableApiTermination']);
    const oldDisableApiTermination = this.coerceBool(previousProperties['DisableApiTermination']);
    if (
      newDisableApiTermination !== undefined &&
      newDisableApiTermination !== oldDisableApiTermination
    ) {
      await this.ec2Client.send(
        new ModifyInstanceAttributeCommand({
          InstanceId: physicalId,
          DisableApiTermination: { Value: newDisableApiTermination },
        })
      );
    }

    // EbsOptimized is intentionally NOT modified here: AWS only accepts
    // `ModifyInstanceAttribute { EbsOptimized }` against a STOPPED instance
    // (a running instance returns IncorrectInstanceState), and cdkd does not
    // stop/start instances. An EbsOptimized change is therefore routed to
    // replacement via the ReplacementRulesRegistry (AWS::EC2::Instance), where
    // the create path sets it correctly on the new instance.

    // Monitoring — MonitorInstances (enable) / UnmonitorInstances (disable).
    const newMonitoring = this.coerceBool(properties['Monitoring']);
    const oldMonitoring = this.coerceBool(previousProperties['Monitoring']);
    if (newMonitoring !== undefined && newMonitoring !== oldMonitoring) {
      if (newMonitoring) {
        await this.ec2Client.send(new MonitorInstancesCommand({ InstanceIds: [physicalId] }));
      } else {
        await this.ec2Client.send(new UnmonitorInstancesCommand({ InstanceIds: [physicalId] }));
      }
    }

    // MetadataOptions — ModifyInstanceMetadataOptions. Diff the built request
    // shape (post-coercion) so a string/number round-trip is not flagged as a
    // change.
    const newMetadata = this.buildMetadataOptions(properties);
    const oldMetadata = this.buildMetadataOptions(previousProperties);
    if (newMetadata !== undefined && !this.shallowEqual(newMetadata, oldMetadata)) {
      await this.ec2Client.send(
        new ModifyInstanceMetadataOptionsCommand({
          InstanceId: physicalId,
          ...newMetadata,
        })
      );
    }

    // CreditSpecification — ModifyInstanceCreditSpecification.
    const newCpuCredits = this.readCpuCredits(properties['CreditSpecification']);
    const oldCpuCredits = this.readCpuCredits(previousProperties['CreditSpecification']);
    if (newCpuCredits !== undefined && newCpuCredits !== oldCpuCredits) {
      await this.ec2Client.send(
        new ModifyInstanceCreditSpecificationCommand({
          InstanceCreditSpecifications: [{ InstanceId: physicalId, CpuCredits: newCpuCredits }],
        })
      );
    }
  }

  /**
   * Shallow value-equality for the small flat MetadataOptions request shape.
   * Treats `undefined` and an absent object as equal so the no-drift
   * round-trip produces zero modify calls.
   */
  private shallowEqual(
    a: InstanceMetadataOptionsRequest,
    b: InstanceMetadataOptionsRequest | undefined
  ): boolean {
    if (b === undefined) return false;
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keysA = Object.keys(ra);
    const keysB = Object.keys(rb);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => ra[k] === rb[k]);
  }

  private async deleteInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Terminating EC2 Instance ${logicalId}: ${physicalId}`);

    const removeProtection = context?.removeProtection === true;

    // `--remove-protection`: flip DisableApiTermination off before
    // TerminateInstances (shared with the Cloud Control delete path — see
    // ec2-termination-protection.ts). The modify WRITE lags the terminate READ,
    // so a terminate immediately after the flip-off 400s "may not be terminated.
    // Modify its 'disableApiTermination' ..." even though we just cleared it.
    // cdkd's fast SDK path outruns the propagation window the way it does for
    // IAM / Route53 elsewhere. This 400 is NOT in the generic retryable set (a
    // protected instance WITHOUT `--remove-protection` must fail fast so the
    // user is told to pass the flag), so retry it locally and ONLY when
    // `--remove-protection` was requested — re-flipping each attempt.
    if (removeProtection) {
      await disableInstanceApiTermination(this.ec2Client, physicalId, this.logger);
    }

    const maxTerminateAttempts = removeProtection ? TERMINATION_PROTECTION_MAX_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [physicalId] }));
        this.logger.debug(`Terminate requested for EC2 Instance ${logicalId}, waiting...`);

        // Wait for instance to reach terminated state so ENIs are released
        await waitUntilInstanceTerminated(
          // Same cadence as the running-state wait above (see that comment for
          // the delay math): termination is also a ~30-60s operation gating ENI
          // release, so a 15s cap spent a mean 7.5s of the destroy just not
          // looking.
          { client: this.ec2Client, maxWaitTime: 300, minDelay: 2, maxDelay: 5 },
          { InstanceIds: [physicalId] }
        );

        this.logger.debug(`EC2 Instance ${logicalId} terminated: ${physicalId}`);
        return;
      } catch (error) {
        if (this.isNotFoundError(error)) {
          const clientRegion = await this.ec2Client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(
            `EC2 Instance ${physicalId} already terminated (not found), treating as success`
          );
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        if (
          removeProtection &&
          isTerminationProtectionPropagationError(msg) &&
          attempt < maxTerminateAttempts
        ) {
          this.logger.debug(
            `Terminate of EC2 Instance ${logicalId} raced the DisableApiTermination flip-off (attempt ${attempt}/${maxTerminateAttempts}); re-flipping and retrying`
          );
          await disableInstanceApiTermination(this.ec2Client, physicalId, this.logger);
          await this.sleep(3000 * attempt);
          continue;
        }
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to terminate EC2 Instance ${logicalId}: ${msg}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }
  }

  private async getInstanceAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    const response = await this.ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [physicalId] })
    );
    const instance = response.Reservations?.[0]?.Instances?.[0];
    if (!instance) return undefined;

    switch (attributeName) {
      case 'InstanceId':
        return instance.InstanceId;
      case 'PrivateIp':
        return instance.PrivateIpAddress;
      case 'PublicIp':
        return instance.PublicIpAddress;
      case 'PrivateDnsName':
        return instance.PrivateDnsName;
      case 'PublicDnsName':
        return instance.PublicDnsName;
      case 'AvailabilityZone':
        return instance.Placement?.AvailabilityZone;
      default:
        return undefined;
    }
  }

  private buildBlockDeviceMappings(
    properties: Record<string, unknown>
  ): BlockDeviceMapping[] | undefined {
    const mappings = properties['BlockDeviceMappings'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (!mappings || !Array.isArray(mappings)) return undefined;

    return mappings.map((m) => {
      const ebs = m['Ebs'] as Record<string, unknown> | undefined;
      const result: BlockDeviceMapping = {
        DeviceName: m['DeviceName'] as string,
      };
      if (ebs) {
        result.Ebs = {
          VolumeSize: ebs['VolumeSize'] as number | undefined,
          VolumeType: ebs['VolumeType'] as VolumeType | undefined,
          DeleteOnTermination: (ebs['DeleteOnTermination'] as boolean) ?? true,
        };
      }
      return result;
    });
  }

  /**
   * Coerce a CFn boolean-ish value (`true` | `false` | `"true"` | `"false"`)
   * into a real boolean, or `undefined` when the property is absent. CFn
   * templates can carry either the JSON boolean or its string form depending
   * on how the value was produced (a literal vs an intrinsic-resolved value),
   * so the wire boundary must normalize both. Returns `undefined` for absent
   * props so the field is omitted from the SDK input (AWS keeps its default)
   * rather than being forced to `false`.
   */
  private coerceBool(value: unknown): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  /**
   * Build the RunInstances `Monitoring` shape from the CFn `Monitoring`
   * boolean. AWS expects `{ Enabled: boolean }`; CFn carries a flat boolean.
   * Returns `undefined` when the prop is absent so the field is omitted.
   */
  private buildRunInstancesMonitoring(
    properties: Record<string, unknown>
  ): { Enabled: boolean } | undefined {
    const enabled = this.coerceBool(properties['Monitoring']);
    if (enabled === undefined) return undefined;
    return { Enabled: enabled };
  }

  /**
   * Build the RunInstances `MetadataOptions` shape from the CFn
   * `MetadataOptions` object. CFn and the SDK share field names
   * (HttpTokens / HttpEndpoint / HttpPutResponseHopLimit / HttpProtocolIpv6 /
   * InstanceMetadataTags). `HttpPutResponseHopLimit` is numeric — CFn may
   * carry it as a string, so coerce at the wire boundary. Only emits keys the
   * template actually set so AWS keeps its defaults for the rest.
   */
  private buildMetadataOptions(
    properties: Record<string, unknown>
  ): InstanceMetadataOptionsRequest | undefined {
    const opts = properties['MetadataOptions'] as Record<string, unknown> | undefined;
    if (!opts || typeof opts !== 'object') return undefined;

    const result: InstanceMetadataOptionsRequest = {};
    if (opts['HttpTokens'] !== undefined) {
      result.HttpTokens = opts['HttpTokens'] as HttpTokensState;
    }
    if (opts['HttpEndpoint'] !== undefined) {
      result.HttpEndpoint = opts['HttpEndpoint'] as InstanceMetadataEndpointState;
    }
    if (opts['HttpProtocolIpv6'] !== undefined) {
      result.HttpProtocolIpv6 = opts['HttpProtocolIpv6'] as InstanceMetadataProtocolState;
    }
    if (opts['InstanceMetadataTags'] !== undefined) {
      result.InstanceMetadataTags = opts['InstanceMetadataTags'] as InstanceMetadataTagsState;
    }
    const hopLimit = opts['HttpPutResponseHopLimit'];
    if (hopLimit !== undefined && hopLimit !== null) {
      result.HttpPutResponseHopLimit = Number(hopLimit);
    }
    // Omit the whole block if the template set MetadataOptions: {} with no
    // recognized keys — there is nothing to send to AWS.
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * Map the CFn `AWS::EC2::Instance.AvailabilityZone` property onto the
   * RunInstances `Placement.AvailabilityZone` input (issue #1276).
   *
   * Returns undefined when the property is absent so the input key is
   * omitted entirely -- an empty `Placement: {}` would be a pointless
   * shape change on every instance that does not set the property.
   *
   * Only AvailabilityZone is mapped. The other `Placement` members
   * (Tenancy, GroupName, HostId, Affinity, PartitionNumber) are separate
   * top-level CFn properties on this type and are deliberately not handled
   * here; adding one means adding it to `handledProperties` too, or the
   * #614 routing rule will keep sending the resource to Cloud Control.
   */
  private buildPlacement(
    properties: Record<string, unknown>
  ): { AvailabilityZone: string } | undefined {
    const az = properties['AvailabilityZone'];
    if (typeof az !== 'string' || az === '') return undefined;
    return { AvailabilityZone: az };
  }

  /**
   * Map the CFn `AWS::EC2::Instance.NetworkInterfaces` list onto
   * RunInstances' `NetworkInterfaces` input (issue #1281). Every CFn
   * sub-field is mapped (dropping a sub-field silently would be the #1225
   * bug class one level down): the two casing/shape divergences are
   * `GroupSet` -> `Groups` and CFn's stringly-typed numerics
   * (`DeviceIndex`, `Ipv6AddressCount`, `SecondaryPrivateIpAddressCount`
   * arrive as strings from CDK) -> numbers.
   */
  private buildNetworkInterfaces(
    properties: Record<string, unknown>
  ): InstanceNetworkInterfaceSpecification[] | undefined {
    const raw = properties['NetworkInterfaces'];
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return raw.map((entry) => {
      const ni = (entry ?? {}) as Record<string, unknown>;
      const spec: InstanceNetworkInterfaceSpecification = {
        DeviceIndex: this.coerceNumber(ni['DeviceIndex']),
        SubnetId: (ni['SubnetId'] as string) ?? undefined,
        Groups: (ni['GroupSet'] as string[]) ?? undefined,
        AssociatePublicIpAddress: this.coerceBool(ni['AssociatePublicIpAddress']),
        AssociateCarrierIpAddress: this.coerceBool(ni['AssociateCarrierIpAddress']),
        DeleteOnTermination: this.coerceBool(ni['DeleteOnTermination']),
        Description: (ni['Description'] as string) ?? undefined,
        NetworkInterfaceId: (ni['NetworkInterfaceId'] as string) ?? undefined,
        PrivateIpAddress: (ni['PrivateIpAddress'] as string) ?? undefined,
        Ipv6AddressCount: this.coerceNumber(ni['Ipv6AddressCount']),
        Ipv6Addresses: Array.isArray(ni['Ipv6Addresses'])
          ? (ni['Ipv6Addresses'] as Array<Record<string, unknown>>).map((a) => ({
              Ipv6Address: (a?.['Ipv6Address'] as string) ?? undefined,
            }))
          : undefined,
        PrivateIpAddresses: Array.isArray(ni['PrivateIpAddresses'])
          ? (ni['PrivateIpAddresses'] as Array<Record<string, unknown>>).map((a) => ({
              Primary: this.coerceBool(a?.['Primary']),
              PrivateIpAddress: (a?.['PrivateIpAddress'] as string) ?? undefined,
            }))
          : undefined,
        SecondaryPrivateIpAddressCount: this.coerceNumber(ni['SecondaryPrivateIpAddressCount']),
      };
      return spec;
    });
  }

  /**
   * CFn numerics are stringly typed on the wire ("0", not 0); RunInstances
   * wants numbers. Tolerate both, return undefined for anything else.
   */
  private coerceNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return undefined;
  }

  /**
   * Build the RunInstances `CreditSpecification` shape from the CFn
   * `CreditSpecification` object. CFn uses `CPUCredits` (capital CPU, the
   * canonical CDK `CfnInstance` emission); accept the SDK-style `CpuCredits`
   * too for hand-authored templates. Returns `undefined` when absent / empty.
   */
  private buildCreditSpecification(
    properties: Record<string, unknown>
  ): CreditSpecificationRequest | undefined {
    const cpuCredits = this.readCpuCredits(properties['CreditSpecification']);
    if (cpuCredits === undefined) return undefined;
    return { CpuCredits: cpuCredits };
  }

  /**
   * Extract the CpuCredits string from a CFn `CreditSpecification` object,
   * tolerating both the canonical `CPUCredits` key and the SDK-style
   * `CpuCredits` key. Shared by create() and update().
   */
  private readCpuCredits(spec: unknown): string | undefined {
    if (!spec || typeof spec !== 'object') return undefined;
    const obj = spec as Record<string, unknown>;
    const raw = obj['CPUCredits'] ?? obj['CpuCredits'];
    return typeof raw === 'string' ? raw : undefined;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Build an IpPermission object from CloudFormation-style properties.
   *
   * The EC2 IpPermission shape is identical for ingress and egress; only the
   * CFn property names that point to the "other" security group differ
   * (SourceSecurityGroupId vs DestinationSecurityGroupId).
   */
  private buildIpPermission(
    properties: Record<string, unknown>,
    direction: 'ingress' | 'egress' = 'ingress'
  ): {
    IpProtocol: string;
    FromPort?: number;
    ToPort?: number;
    IpRanges?: Array<{ CidrIp: string; Description?: string }>;
    Ipv6Ranges?: Array<{ CidrIpv6: string; Description?: string }>;
    UserIdGroupPairs?: Array<{ GroupId: string; UserId?: string; Description?: string }>;
    PrefixListIds?: Array<{ PrefixListId: string; Description?: string }>;
  } {
    const ipProtocol = (properties['IpProtocol'] as string) ?? '-1';
    const fromPort = properties['FromPort'] as number | undefined;
    const toPort = properties['ToPort'] as number | undefined;

    const permission: {
      IpProtocol: string;
      FromPort?: number;
      ToPort?: number;
      IpRanges?: Array<{ CidrIp: string; Description?: string }>;
      Ipv6Ranges?: Array<{ CidrIpv6: string; Description?: string }>;
      UserIdGroupPairs?: Array<{ GroupId: string; UserId?: string; Description?: string }>;
      PrefixListIds?: Array<{ PrefixListId: string; Description?: string }>;
    } = { IpProtocol: ipProtocol };

    if (fromPort !== undefined) permission.FromPort = fromPort;
    if (toPort !== undefined) permission.ToPort = toPort;

    const cidrIp = properties['CidrIp'] as string | undefined;
    const cidrIpv6 = properties['CidrIpv6'] as string | undefined;
    const description = properties['Description'] as string | undefined;
    if (cidrIp) {
      const ipRange: { CidrIp: string; Description?: string } = { CidrIp: cidrIp };
      if (description) ipRange.Description = description;
      permission.IpRanges = [ipRange];
    }
    if (cidrIpv6) {
      const ipv6Range: { CidrIpv6: string; Description?: string } = { CidrIpv6: cidrIpv6 };
      if (description) ipv6Range.Description = description;
      permission.Ipv6Ranges = [ipv6Range];
    }

    // Source SG (ingress) and destination SG (egress) map to the same
    // UserIdGroupPairs slot on the underlying EC2 IpPermission shape.
    const peerGroupId =
      direction === 'egress'
        ? (properties['DestinationSecurityGroupId'] as string | undefined)
        : (properties['SourceSecurityGroupId'] as string | undefined);
    if (peerGroupId) {
      const groupPair: { GroupId: string; UserId?: string; Description?: string } = {
        GroupId: peerGroupId,
      };
      // Cross-account peer reference: CFn supports SourceSecurityGroupOwnerId on
      // ingress rules to point at a security group in another AWS account. Map
      // it to the UserIdGroupPairs[].UserId field on the EC2 API. CFn does not
      // define a Destination*OwnerId counterpart for egress, so this is
      // ingress-only.
      if (direction === 'ingress') {
        const peerOwnerId = properties['SourceSecurityGroupOwnerId'] as string | undefined;
        if (peerOwnerId) groupPair.UserId = peerOwnerId;
      }
      if (description) groupPair.Description = description;
      permission.UserIdGroupPairs = [groupPair];
    }

    // Prefix list (egress only in CFn, but harmless to read for both)
    const prefixListId =
      direction === 'egress'
        ? (properties['DestinationPrefixListId'] as string | undefined)
        : (properties['SourcePrefixListId'] as string | undefined);
    if (prefixListId) {
      const prefixEntry: { PrefixListId: string; Description?: string } = {
        PrefixListId: prefixListId,
      };
      if (description) prefixEntry.Description = description;
      permission.PrefixListIds = [prefixEntry];
    }

    return permission;
  }

  /**
   * Compute the diff between two sets of SecurityGroup rule definitions
   * (ingress or egress) and apply the resulting authorize/revoke calls.
   *
   * Rules are identified by a deterministic key derived from their full
   * shape — protocol, ports, CIDR, peer group, prefix list, description —
   * so updating any of those fields counts as a replacement (revoke + authorize).
   */
  private async applySecurityGroupRuleDiff(
    groupId: string,
    previousRules: Array<Record<string, unknown>>,
    nextRules: Array<Record<string, unknown>>,
    direction: 'ingress' | 'egress'
  ): Promise<void> {
    const ruleKey = (rule: Record<string, unknown>): string => {
      const peerKey =
        direction === 'egress'
          ? (rule['DestinationSecurityGroupId'] as string | undefined)
          : (rule['SourceSecurityGroupId'] as string | undefined);
      const prefixKey =
        direction === 'egress'
          ? (rule['DestinationPrefixListId'] as string | undefined)
          : (rule['SourcePrefixListId'] as string | undefined);
      // Include the cross-account peer owner id (ingress only) so a same-id
      // group in a different account is not collapsed into the same rule.
      const peerOwner =
        direction === 'ingress'
          ? (rule['SourceSecurityGroupOwnerId'] as string | undefined)
          : undefined;
      return JSON.stringify({
        // Same canonicalization as `sgRuleKey` (issue #1643) — the two keys
        // MUST agree, which is what this function's sibling JSDoc promises.
        // Without it a `--revert` of a drifted inline rule set keys the
        // previous side (AWS's `tcp`) differently from the desired side
        // (state's `'6'`), so EVERY rule is revoked and re-authorized instead
        // of only the drifted one — a window with no rules on a live group.
        p: sgProtocolKey(rule['IpProtocol']),
        f: rule['FromPort'] ?? null,
        t: rule['ToPort'] ?? null,
        c4: rule['CidrIp'] ?? null,
        c6: rule['CidrIpv6'] ?? null,
        peer: peerKey ?? null,
        peerOwner: peerOwner ?? null,
        pl: prefixKey ?? null,
        d: rule['Description'] ?? null,
      });
    };

    const prevByKey = new Map<string, Record<string, unknown>>();
    for (const rule of previousRules) prevByKey.set(ruleKey(rule), rule);
    const nextByKey = new Map<string, Record<string, unknown>>();
    for (const rule of nextRules) nextByKey.set(ruleKey(rule), rule);

    const toRevoke: Array<Record<string, unknown>> = [];
    for (const [key, rule] of prevByKey) {
      if (!nextByKey.has(key)) toRevoke.push(rule);
    }
    const toAuthorize: Array<Record<string, unknown>> = [];
    for (const [key, rule] of nextByKey) {
      if (!prevByKey.has(key)) toAuthorize.push(rule);
    }

    for (const rule of toRevoke) {
      try {
        if (direction === 'egress') {
          await this.ec2Client.send(
            new RevokeSecurityGroupEgressCommand({
              GroupId: groupId,
              IpPermissions: [this.buildIpPermission(rule, 'egress')],
            })
          );
        } else {
          await this.ec2Client.send(
            new RevokeSecurityGroupIngressCommand({
              GroupId: groupId,
              IpPermissions: [this.buildIpPermission(rule, 'ingress')],
            })
          );
        }
      } catch (error) {
        if (!this.isNotFoundError(error)) throw error;
      }
    }

    for (const rule of toAuthorize) {
      try {
        if (direction === 'egress') {
          await this.ec2Client.send(
            new AuthorizeSecurityGroupEgressCommand({
              GroupId: groupId,
              IpPermissions: [this.buildIpPermission(rule, 'egress')],
            })
          );
        } else {
          await this.ec2Client.send(
            new AuthorizeSecurityGroupIngressCommand({
              GroupId: groupId,
              IpPermissions: [this.buildIpPermission(rule, 'ingress')],
            })
          );
        }
      } catch (error) {
        // Tolerate "already exists" to keep the diff idempotent across retries.
        if (!(error instanceof Error && error.message.includes('already exists'))) {
          throw error;
        }
      }
    }
  }

  // ─── AWS::EC2::NetworkAcl ────────────────────────────────────────

  private async createNetworkAcl(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating NetworkAcl ${logicalId}`);

    const vpcId = properties['VpcId'] as string;
    if (!vpcId) {
      throw new ProvisioningError(
        `VpcId is required for NetworkAcl ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.ec2Client.send(new CreateNetworkAclCommand({ VpcId: vpcId }));

      const networkAclId = response.NetworkAcl!.NetworkAclId!;

      // Apply tags
      await this.applyTags(networkAclId, properties, logicalId);

      this.logger.debug(`Successfully created NetworkAcl ${logicalId}: ${networkAclId}`);

      return {
        physicalId: networkAclId,
        attributes: {
          Id: networkAclId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create NetworkAcl ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteNetworkAcl(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting NetworkAcl ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DeleteNetworkAclCommand({ NetworkAclId: physicalId }));
      this.logger.debug(`Successfully deleted NetworkAcl ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`NetworkAcl ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete NetworkAcl ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::EC2::NetworkAclEntry ─────────────────────────────────────

  private async createNetworkAclEntry(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating NetworkAclEntry ${logicalId}`);

    const networkAclId = properties['NetworkAclId'] as string;
    const ruleNumber = properties['RuleNumber'] as number;
    const protocol = properties['Protocol'] as number;
    const ruleAction = properties['RuleAction'] as string;
    const egress = (properties['Egress'] as boolean) ?? false;

    if (!networkAclId || ruleNumber === undefined || protocol === undefined || !ruleAction) {
      throw new ProvisioningError(
        `NetworkAclId, RuleNumber, Protocol, and RuleAction are required for NetworkAclEntry ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // No segment here is pipe-capable — an AWS-generated `acl-...`, a number
    // and a boolean — so this is uniform defense-in-depth (issue #1672).
    // Computed before the AWS call so a refusal cannot leave an entry AWS has
    // already created without a state record.
    const physicalId = packCompositeId(
      resourceType,
      logicalId,
      [
        { name: 'networkAclId', value: networkAclId },
        { name: 'ruleNumber', value: ruleNumber },
        { name: 'egress', value: egress },
      ],
      context?.replayingState === true
        ? { onRefusal: (message) => this.logger.warn(message) }
        : undefined
    );

    try {
      const cidrBlock = properties['CidrBlock'] as string | undefined;
      const ipv6CidrBlock = properties['Ipv6CidrBlock'] as string | undefined;
      const portRange = properties['PortRange'] as Record<string, unknown> | undefined;
      // CFn schema spells this property `Icmp`; the AWS API call below
      // takes the same shape under the key `IcmpTypeCode`. Accept both:
      // CFn-canonical (template authors / CDK L1) prefers `Icmp`; legacy
      // state files written by pre-#613-fix cdkd carry `IcmpTypeCode`,
      // so fall back to it for backward compat (e.g. re-deploy after a
      // binary upgrade where state.properties has the legacy key).
      const icmpTypeCode = (properties['Icmp'] ?? properties['IcmpTypeCode']) as
        | Record<string, unknown>
        | undefined;

      await this.ec2Client.send(
        new CreateNetworkAclEntryCommand({
          NetworkAclId: networkAclId,
          RuleNumber: ruleNumber,
          Protocol: String(protocol),
          RuleAction: ruleAction as 'allow' | 'deny',
          Egress: egress,
          CidrBlock: cidrBlock,
          Ipv6CidrBlock: ipv6CidrBlock,
          PortRange: portRange
            ? {
                From: portRange['From'] as number,
                To: portRange['To'] as number,
              }
            : undefined,
          IcmpTypeCode: icmpTypeCode
            ? {
                Code: icmpTypeCode['Code'] as number,
                Type: icmpTypeCode['Type'] as number,
              }
            : undefined,
        })
      );

      this.logger.debug(`Successfully created NetworkAclEntry ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create NetworkAclEntry ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteNetworkAclEntry(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting NetworkAclEntry ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length < 3) {
      this.logger.warn(
        compositeIdFormatMessage(EC2_NETWORK_ACL_ENTRY_ID_FORMAT, logicalId, physicalId, {
          skipping: true,
        })
      );
      // Issue #1752: report the SKIP rather than returning void — a bare
      // `return` was counted as a successful delete by the destroy summary.
      return compositeIdSkipResult();
    }
    const networkAclId = parts[0]!;
    const ruleNumber = parseInt(parts[1]!, 10);
    const egress = parts[2] === 'true';

    try {
      await this.ec2Client.send(
        new DeleteNetworkAclEntryCommand({
          NetworkAclId: networkAclId,
          RuleNumber: ruleNumber,
          Egress: egress,
        })
      );
      this.logger.debug(`Successfully deleted NetworkAclEntry ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`NetworkAclEntry ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete NetworkAclEntry ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::EC2::SubnetNetworkAclAssociation ─────────────────────────

  private async createSubnetNetworkAclAssociation(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SubnetNetworkAclAssociation ${logicalId}`);

    const networkAclId = properties['NetworkAclId'] as string;
    const subnetId = properties['SubnetId'] as string;

    if (!networkAclId || !subnetId) {
      throw new ProvisioningError(
        `NetworkAclId and SubnetId are required for SubnetNetworkAclAssociation ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Find the current NACL association for the subnet
      const describeResponse = await this.ec2Client.send(
        new DescribeNetworkAclsCommand({
          Filters: [{ Name: 'association.subnet-id', Values: [subnetId] }],
        })
      );

      let currentAssociationId: string | undefined;
      for (const nacl of describeResponse.NetworkAcls ?? []) {
        for (const assoc of nacl.Associations ?? []) {
          if (assoc.SubnetId === subnetId) {
            currentAssociationId = assoc.NetworkAclAssociationId;
            break;
          }
        }
        if (currentAssociationId) break;
      }

      if (!currentAssociationId) {
        throw new ProvisioningError(
          `No current NACL association found for subnet ${subnetId}`,
          resourceType,
          logicalId
        );
      }

      // Replace the association
      const response = await this.ec2Client.send(
        new ReplaceNetworkAclAssociationCommand({
          AssociationId: currentAssociationId,
          NetworkAclId: networkAclId,
        })
      );

      const newAssociationId = response.NewAssociationId!;
      this.logger.debug(
        `Successfully created SubnetNetworkAclAssociation ${logicalId}: ${newAssociationId}`
      );

      return {
        physicalId: newAssociationId,
        attributes: {
          AssociationId: newAssociationId,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SubnetNetworkAclAssociation ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Apply tags to an EC2 resource (create-time, no removal).
   *
   * Used by `create*` paths. Update paths should use `applyTagDiff` instead
   * to handle tag removal too.
   */
  private async applyTags(
    resourceId: string,
    properties: Record<string, unknown>,
    logicalId: string
  ): Promise<void> {
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (tags && Array.isArray(tags) && tags.length > 0) {
      try {
        await this.ec2Client.send(
          new CreateTagsCommand({
            Resources: [resourceId],
            Tags: tags.map((t) => ({ Key: t.Key, Value: t.Value })),
          })
        );
        this.logger.debug(`Applied ${tags.length} tag(s) to ${logicalId}`);
      } catch (error) {
        this.logger.warn(
          `Failed to apply tags to ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via EC2's
   * `CreateTags` / `DeleteTags` APIs. Used by `update*` paths so that
   * tag removals reach AWS too. EC2 keys both APIs by a list of resource
   * ids.
   */
  private async applyTagDiff(
    resourceId: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: Array<{ Key: string }> = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push({ Key: k });
    }

    if (tagsToRemove.length > 0) {
      try {
        await this.ec2Client.send(
          new DeleteTagsCommand({
            Resources: [resourceId],
            Tags: tagsToRemove,
          })
        );
        this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from ${resourceId}`);
      } catch (error) {
        this.logger.warn(
          `Failed to remove tags from ${resourceId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (tagsToAdd.length > 0) {
      try {
        await this.ec2Client.send(
          new CreateTagsCommand({
            Resources: [resourceId],
            Tags: tagsToAdd,
          })
        );
        this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on ${resourceId}`);
      } catch (error) {
        this.logger.warn(
          `Failed to add tags on ${resourceId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Retry an operation that AWS may reject with `DependencyViolation`
   * for an extended window — specifically `DeleteInternetGateway` and
   * `DetachInternetGateway` after a sibling EC2 Instance with an
   * auto-assigned public IP was terminated. AWS releases the public-IP
   * → IGW mapping asynchronously (5–10 min lag observed in practice);
   * during that window AWS rejects IGW-detach / -delete with
   * `DependencyViolation: Network has some mapped public address(es).
   * Please unmap those public address(es) before detaching the gateway.`
   * (or similar `has dependencies and cannot be deleted`).
   *
   * cdkd's deploy-engine `withRetry` wrapper caps at ~1 min total
   * (1s/2s/4s/8s × 10 attempts capped at 8s), and the destroy-runner's
   * inner 3-attempt loop adds ~35s on top — neither is enough for
   * AWS's 5–10 min release window. This helper extends the budget to
   * 10 min for the IGW-specific case so `cdkd destroy
   * --remove-protection` is self-healing on the public-IP release lag
   * without operator intervention.
   *
   * Modeled on the Lambda hyperplane ENI cleanup pattern (~30 min
   * budget) and the EC2 Subnet/SG side-channel ENI retry — both wait
   * on AWS-side eventual-consistency that the standard `withRetry`
   * budget cannot cover.
   *
   * Only `DependencyViolation` errors are retried; other errors
   * (NotFound, AccessDenied, throttle, etc.) propagate immediately so
   * the caller's existing error handling is unchanged.
   *
   * Note on retry layering: `DependencyViolation` is also in
   * `RETRYABLE_ERROR_MESSAGE_PATTERNS` (consumed by `withRetry`) and
   * the destroy-runner's inner 3-attempt loop also matches it. After
   * this helper's budget exhausts and re-throws, those outer retry
   * loops will see the error and try a few more times — adding at
   * most ~1 min on top of the 10 min budget, still bounded by the
   * per-resource `--resource-timeout` deadline (default 30 min).
   * That extra is harmless (worst case slightly later failure surface)
   * and avoids threading a per-error-class "already exhausted" flag
   * through every retry layer.
   */
  private async withDependencyViolationRetry<T>(
    operation: () => Promise<T>,
    opts: { description: string; totalBudgetMs?: number }
  ): Promise<T> {
    const totalBudgetMs = opts.totalBudgetMs ?? 600_000; // 10 min default
    const initialDelayMs = 5_000;
    const maxDelayMs = 10_000;
    const startedAt = Date.now();

    let attempt = 0;
    let delay = initialDelayMs;
    // Loop forever — exit conditions are (a) operation succeeds (return),
    // (b) operation throws non-DependencyViolation (re-throw immediately),
    // (c) elapsed >= budget AND operation still throws DependencyViolation
    // (re-throw the last DependencyViolation error).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!this.isDependencyViolationError(error)) {
          throw error;
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= totalBudgetMs) {
          throw error;
        }
        attempt += 1;
        const sleepMs = Math.min(delay, totalBudgetMs - elapsed);
        const message = error instanceof Error ? error.message : String(error);
        this.logger.debug(
          `${opts.description}: dependency still mapped (attempt ${attempt}, retrying in ${sleepMs}ms): ${message}`
        );
        await this.sleep(sleepMs);
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }
  }

  /**
   * Match an AWS `DependencyViolation` error by error code or message.
   * AWS surfaces this as `Code: 'DependencyViolation'` in the parsed SDK
   * error, with a human message like `The internetGateway 'igw-xxx' has
   * dependencies and cannot be deleted.` or `Network has some mapped
   * public address(es). Please unmap those public address(es)`.
   */
  private isDependencyViolationError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { Code?: string; name?: string }).Code ?? '';
    const name = (error as { name?: string }).name ?? '';
    if (code === 'DependencyViolation' || name === 'DependencyViolation') return true;
    const message = error.message ?? '';
    return (
      message.includes('DependencyViolation') ||
      message.includes('has dependencies and cannot be deleted') ||
      message.includes('Network has some mapped public address')
    );
  }

  /**
   * AWS rejects AssociateAddress (and several other instance operations)
   * against an instance that is not `running` / `stopped` with the
   * `IncorrectInstanceState` code. Under --no-wait that is the expected
   * outcome for an instance created in the same deploy, not a transient
   * fault -- it stays true exactly until the wait --no-wait skipped would
   * have completed.
   */
  private isIncorrectInstanceStateError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { Code?: string }).Code ?? '';
    const name = (error as { name?: string }).name ?? '';
    if (code === 'IncorrectInstanceState' || name === 'IncorrectInstanceState') return true;
    return error.message.includes('IncorrectInstanceState');
  }

  /**
   * Indirect sleep so unit tests can swap in a fake-timer-aware
   * implementation via `vi.useFakeTimers()` without monkey-patching
   * `setTimeout` globally.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if an error indicates the resource was not found
   */
  private isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    const name = (error as { name?: string }).name ?? '';
    return (
      message.includes('not found') ||
      message.includes('does not exist') ||
      message.includes('invalidparametervalue') ||
      name === 'InvalidVpcID.NotFound' ||
      name === 'InvalidSubnetID.NotFound' ||
      name === 'InvalidInternetGatewayID.NotFound' ||
      name === 'InvalidRouteTableID.NotFound' ||
      name === 'InvalidGroup.NotFound' ||
      name === 'InvalidAssociationID.NotFound' ||
      name === 'InvalidRoute.NotFound' ||
      name === 'InvalidInstanceID.NotFound' ||
      name === 'InvalidNetworkAclID.NotFound' ||
      name === 'InvalidNetworkAclEntry.NotFound' ||
      name === 'InvalidAllocationID.NotFound' ||
      name === 'InvalidAddressID.NotFound'
    );
  }

  /**
   * Adopt an existing EC2 networking resource into cdkd state.
   *
   * Supported types: `AWS::EC2::VPC`, `AWS::EC2::Subnet`,
   * `AWS::EC2::SecurityGroup`. Other EC2 types this provider creates
   * (RouteTable, Route, InternetGateway, VPCGatewayAttachment,
   * NetworkAcl, Instance) return `null` from import — most have no
   * stable identity to look up by tag (Routes are derived; SGIngress
   * is rule-level), and the typical adoption story is "find the VPC,
   * cdkd reconstructs the rest at deploy time".
   *
   * There is no `aws:cdk:path` tag lookup: AWS rejects `aws:`-prefixed tag
   * writes, so that tag never exists on a real resource and a
   * `Filters: [{Name: 'tag:aws:cdk:path', ...}]` `Describe*` could never
   * match (issue #1134). Auto-mode import resolves ids from
   * CloudFormation's `DescribeStackResources` or the template's
   * physical-name property instead.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    // Explicit override → verify by id and short-circuit.
    if (input.knownPhysicalId) {
      return this.verifyExplicit(input.logicalId, input.resourceType, input.knownPhysicalId);
    }

    // A resource reaching here needs an explicit `--resource` override.
    return null;
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
   *    `Placement.Tenancy`), `IamInstanceProfile` (ARN form — v2 fallback
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
   *
   * Skipped (return `undefined`, falls through to the comparator's
   * "unsupported" outcome):
   *  - **AWS::EC2::VPCGatewayAttachment**: physical id is
   *    `<internetGatewayId>|<vpcId>`. The two ids are immutable inputs to the SDK call;
   *    drift detection on this resource has no useful signal beyond
   *    existence verification (which the user can do via the parent IGW
   *    / VPC drift report).
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
   * Returns `undefined` when the resource is gone (any `*NotFound` /
   * `Invalid*` error from the EC2 SDK matches `isNotFoundError`).
   */
  async readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    try {
      switch (resourceType) {
        case 'AWS::EC2::VPC':
          return await this.readVpcCurrentState(physicalId);
        case 'AWS::EC2::Subnet':
          return await this.readSubnetCurrentState(physicalId);
        case 'AWS::EC2::InternetGateway':
          return await this.readInternetGatewayCurrentState(physicalId);
        case 'AWS::EC2::NatGateway':
          return await this.readNatGatewayCurrentState(physicalId);
        case 'AWS::EC2::RouteTable':
          return await this.readRouteTableCurrentState(physicalId);
        case 'AWS::EC2::SecurityGroup':
          return await this.readSecurityGroupCurrentState(physicalId, properties);
        case 'AWS::EC2::Instance':
          return await this.readInstanceCurrentState(physicalId);
        case 'AWS::EC2::NetworkAcl':
          return await this.readNetworkAclCurrentState(physicalId);
        case 'AWS::EC2::VPCGatewayAttachment':
          return await this.readVpcGatewayAttachmentCurrentState(physicalId);
        case 'AWS::EC2::Route':
          return await this.readRouteCurrentState(physicalId);
        case 'AWS::EC2::SubnetRouteTableAssociation':
          return await this.readSubnetRouteTableAssociationCurrentState(physicalId);
        case 'AWS::EC2::SecurityGroupIngress':
          return await this.readSecurityGroupIngressCurrentState(physicalId, properties);
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
  getDriftUnknownPaths(resourceType: string): string[] {
    switch (resourceType) {
      // NetworkInterfaces cannot be read back faithfully: the drift
      // comparator compares arrays WHOLESALE (deepEqual), and
      // `AssociatePublicIpAddress` is launch-time-only input that
      // DescribeInstances never returns -- any reconstruction would fire
      // phantom whole-array drift on every associatePublicIpAddress
      // template (i.e. every template that has the property at all, since
      // it is what routes CDK onto this shape). Declared unreadable, like
      // Lambda's Code (issue #1281).
      case 'AWS::EC2::Instance':
        return ['NetworkInterfaces'];
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
   * replacement create (which passes no context, and so gets no
   * `onMultipleDestinations` downgrade) would hit the #1566 refusal. A
   * previously-green no-op deploy would start failing.
   *
   * Shares `narrowRouteDestinations` with the provisioning path so the two
   * cannot disagree about which key survives.
   *
   * The SecurityGroupIngress arm is the same shape and needs the same second
   * half for the same reason: `IpProtocol` is create-only on that type in the
   * registry schema, so normalizing state alone would make the template's
   * original value read as a changed immutable property — a REPLACEMENT, whose
   * create passes no context and so gets no `onUnusable` downgrade, turning a
   * previously-green no-op deploy into a hard failure. Normalizing BOTH sides
   * is also what keeps the fix correct for records written BEFORE it existed,
   * which still carry the un-narrowed value.
   */
  canonicalizeDesiredProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
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

  private async readVpcCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const resp = await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [physicalId] }));
    const vpc = resp.Vpcs?.[0];
    if (!vpc) return undefined;

    const result: Record<string, unknown> = {};
    if (vpc.CidrBlock !== undefined) result['CidrBlock'] = vpc.CidrBlock;
    if (vpc.InstanceTenancy !== undefined) result['InstanceTenancy'] = vpc.InstanceTenancy;

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

  private async readSubnetCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const resp = await this.ec2Client.send(new DescribeSubnetsCommand({ SubnetIds: [physicalId] }));
    const subnet = resp.Subnets?.[0];
    if (!subnet) return undefined;

    const result: Record<string, unknown> = {};
    if (subnet.VpcId !== undefined) result['VpcId'] = subnet.VpcId;
    if (subnet.CidrBlock !== undefined) result['CidrBlock'] = subnet.CidrBlock;
    if (subnet.AvailabilityZone !== undefined) {
      result['AvailabilityZone'] = subnet.AvailabilityZone;
    }
    if (subnet.MapPublicIpOnLaunch !== undefined) {
      result['MapPublicIpOnLaunch'] = subnet.MapPublicIpOnLaunch;
    }

    return result;
  }

  private async readInternetGatewayCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const resp = await this.ec2Client.send(
      new DescribeInternetGatewaysCommand({ InternetGatewayIds: [physicalId] })
    );
    const igw = resp.InternetGateways?.[0];
    if (!igw) return undefined;

    // The provider only handles `Tags`, which is out of scope for v1 drift.
    // Return an empty object so the comparator marks the resource as
    // `clean` (existence verified) rather than `unsupported`.
    return {};
  }

  private async readNatGatewayCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const resp = await this.ec2Client.send(
      new DescribeNatGatewaysCommand({ NatGatewayIds: [physicalId] })
    );
    const gw = resp.NatGateways?.find((g) => g.State !== 'deleted' && g.State !== 'deleting');
    if (!gw) return undefined;

    const result: Record<string, unknown> = {};
    if (gw.SubnetId !== undefined) result['SubnetId'] = gw.SubnetId;
    if (gw.ConnectivityType !== undefined) result['ConnectivityType'] = gw.ConnectivityType;

    // AllocationId / PrivateIpAddress live inside NatGatewayAddresses[0]
    // for single-AZ public NATs.
    const primary = gw.NatGatewayAddresses?.[0];
    if (primary?.AllocationId !== undefined) result['AllocationId'] = primary.AllocationId;
    if (primary?.PrivateIp !== undefined) result['PrivateIpAddress'] = primary.PrivateIp;

    return result;
  }

  private async readRouteTableCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const resp = await this.ec2Client.send(
      new DescribeRouteTablesCommand({ RouteTableIds: [physicalId] })
    );
    const rt = resp.RouteTables?.[0];
    if (!rt) return undefined;

    const result: Record<string, unknown> = {};
    if (rt.VpcId !== undefined) result['VpcId'] = rt.VpcId;
    return result;
  }

  private async readSecurityGroupCurrentState(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const resp = await this.ec2Client.send(
      new DescribeSecurityGroupsCommand({ GroupIds: [physicalId] })
    );
    const sg = resp.SecurityGroups?.[0];
    if (!sg) return undefined;

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

  private async readInstanceCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const resp = await this.ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [physicalId] })
    );
    const instance = resp.Reservations?.[0]?.Instances?.[0];
    // Treat terminated/shutting-down as "gone" for drift purposes.
    if (
      !instance ||
      instance.State?.Name === 'terminated' ||
      instance.State?.Name === 'shutting-down'
    ) {
      return undefined;
    }

    const result: Record<string, unknown> = {};
    if (instance.ImageId !== undefined) result['ImageId'] = instance.ImageId;
    if (instance.InstanceType !== undefined) result['InstanceType'] = instance.InstanceType;
    if (instance.KeyName !== undefined) result['KeyName'] = instance.KeyName;
    if (instance.SubnetId !== undefined) result['SubnetId'] = instance.SubnetId;

    // SecurityGroupIds: AWS returns SecurityGroups: [{GroupId, GroupName}].
    // CFn input is the flat id list — sorted for stable positional compare
    // (AWS does not preserve template order across DescribeInstances calls).
    result['SecurityGroupIds'] = (instance.SecurityGroups ?? [])
      .map((g) => g.GroupId)
      .filter((id): id is string => typeof id === 'string')
      .sort();

    // PrivateIpAddress: AWS-assigned for default subnets, user-assigned
    // when CFn templates the property. Always emit so the v3 baseline
    // catches console-side reassignment (rare but possible via Stop +
    // ModifyNetworkInterfaceAttribute).
    if (instance.PrivateIpAddress !== undefined) {
      result['PrivateIpAddress'] = instance.PrivateIpAddress;
    }

    // SourceDestCheck: boolean toggle, returned directly by DescribeInstances.
    if (instance.SourceDestCheck !== undefined) {
      result['SourceDestCheck'] = instance.SourceDestCheck;
    }

    // AvailabilityZone (#1276): the CFn property maps to RunInstances'
    // `Placement.AvailabilityZone`, so the reverse map has to come back out
    // of `Placement` too. Without it, every drift run on an L2-authored
    // instance would report a phantom diff (state has the property, the
    // AWS-current snapshot would not).
    if (instance.Placement?.AvailabilityZone !== undefined) {
      result['AvailabilityZone'] = instance.Placement.AvailabilityZone;
    }

    // Monitoring: AWS returns {State: 'enabled' | 'disabled' | 'pending' | 'disabling'}.
    // CFn input is a boolean. Map enabled-ish → true, disabled-ish → false.
    // Always emit so a console-side toggle is detectable.
    const monitoringState = instance.Monitoring?.State;
    result['Monitoring'] = monitoringState === 'enabled' || monitoringState === 'pending';

    // EbsOptimized (#609): boolean returned directly by DescribeInstances.
    // Emit-when-present so a console-side toggle is detectable without firing
    // spurious drift on instances where AWS omits the field.
    if (instance.EbsOptimized !== undefined) {
      result['EbsOptimized'] = instance.EbsOptimized;
    }

    // MetadataOptions (#609): DescribeInstances returns the resolved IMDS
    // config under instance.MetadataOptions. Reverse-map to the CFn input
    // shape (same field names). Only the four CFn-settable string keys plus
    // the numeric hop limit are surfaced — `State` (provisioning lifecycle)
    // is AWS-managed and not a CFn input, so it is excluded to avoid
    // false-positive drift. Emit-when-present.
    const md = instance.MetadataOptions;
    if (md !== undefined) {
      const out: Record<string, unknown> = {};
      if (md.HttpTokens !== undefined) out['HttpTokens'] = md.HttpTokens;
      if (md.HttpPutResponseHopLimit !== undefined) {
        out['HttpPutResponseHopLimit'] = md.HttpPutResponseHopLimit;
      }
      if (md.HttpEndpoint !== undefined) out['HttpEndpoint'] = md.HttpEndpoint;
      if (md.HttpProtocolIpv6 !== undefined) out['HttpProtocolIpv6'] = md.HttpProtocolIpv6;
      if (md.InstanceMetadataTags !== undefined) {
        out['InstanceMetadataTags'] = md.InstanceMetadataTags;
      }
      if (Object.keys(out).length > 0) result['MetadataOptions'] = out;
    }

    // Tenancy: lives under Placement.Tenancy.
    if (instance.Placement?.Tenancy !== undefined) {
      result['Tenancy'] = instance.Placement.Tenancy;
    }

    // IamInstanceProfile: CFn accepts either a name or an ARN. AWS returns
    // the ARN; we surface that. State that holds a name will fire one-time
    // drift on v2 fallback (resolve via cdkd state refresh-observed); v3
    // observedProperties matches exactly because deploy-time read is the
    // same wire shape.
    if (instance.IamInstanceProfile?.Arn !== undefined) {
      result['IamInstanceProfile'] = instance.IamInstanceProfile.Arn;
    } else if (process.env['CDKD_NO_WAIT'] === 'true' && instance.State?.Name === 'pending') {
      // --no-wait deploy-time observed-capture runs against a `pending`
      // instance whose launch-time profile association may still be
      // `associating`, in which case DescribeInstances does not surface it
      // yet. Recording the field as absent would leave a PERMANENT drift
      // blind spot: the comparator walks the baseline's keys only, so a key
      // missing from observedProperties is never compared again -- a later
      // console-side profile detach would go unreported forever (issue
      // #1291 item 3). One targeted association read closes it; the extra
      // call happens ONLY in this narrow window (--no-wait capture of a
      // still-pending instance), never on `cdkd drift` reads.
      // Best-effort: a transient throttle here must cost only THIS field,
      // not the whole snapshot -- an uncaught throw would make the deploy
      // engine discard the entire observed-properties capture.
      try {
        const assoc = await this.ec2Client.send(
          new DescribeIamInstanceProfileAssociationsCommand({
            Filters: [{ Name: 'instance-id', Values: [physicalId] }],
          })
        );
        const live = assoc.IamInstanceProfileAssociations?.find(
          (a) => a.State === 'associated' || a.State === 'associating'
        );
        if (live?.IamInstanceProfile?.Arn !== undefined) {
          result['IamInstanceProfile'] = live.IamInstanceProfile.Arn;
        }
      } catch (error) {
        this.logger.warn(
          `Could not backfill IamInstanceProfile for ${physicalId} during the --no-wait capture (${error instanceof Error ? error.message : String(error)}); the field is omitted from the observed snapshot`
        );
      }
    }

    // BlockDeviceMappings: AWS DescribeInstances returns (DeviceName, Ebs.{VolumeId,
    // DeleteOnTermination, Status, AttachTime}). VolumeType / Size / Iops /
    // Throughput / Encrypted / KmsKeyId / SnapshotId live on the volume
    // itself — fetch via DescribeVolumes for the attached volumes only when
    // there are EBS-backed mappings.
    const ebsMappings = (instance.BlockDeviceMappings ?? []).filter(
      (m) => m.Ebs?.VolumeId !== undefined
    );
    const volumeIds = ebsMappings.map((m) => m.Ebs!.VolumeId!);
    let volumesById: Map<string, Volume> = new Map();
    if (volumeIds.length > 0) {
      try {
        const volResp = await this.ec2Client.send(
          new DescribeVolumesCommand({ VolumeIds: volumeIds })
        );
        for (const v of volResp.Volumes ?? []) {
          if (v.VolumeId !== undefined) volumesById.set(v.VolumeId, v);
        }
      } catch (err) {
        // Best-effort: if DescribeVolumes fails (rare — maybe a permissions
        // gap), fall back to the partial shape. The DeleteOnTermination
        // field is still surfaced from the DescribeInstances response.
        this.logger.debug(
          `DescribeVolumes(${volumeIds.join(',')}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
        volumesById = new Map();
      }
    }

    const blockMappings: Array<Record<string, unknown>> = [];
    for (const m of instance.BlockDeviceMappings ?? []) {
      const out: Record<string, unknown> = {};
      if (m.DeviceName !== undefined) out['DeviceName'] = m.DeviceName;
      // VirtualName (ephemeral / instance-store) is not returned by
      // DescribeInstances — AWS only surfaces EBS-backed mappings here.
      // Templates that set VirtualName fall back to v2 baseline and may
      // fire one-time drift on the missing key, which `cdkd state
      // refresh-observed` clears.

      if (m.Ebs?.VolumeId !== undefined) {
        const ebs: Record<string, unknown> = {};
        if (m.Ebs.DeleteOnTermination !== undefined) {
          ebs['DeleteOnTermination'] = m.Ebs.DeleteOnTermination;
        }
        const vol = volumesById.get(m.Ebs.VolumeId);
        if (vol !== undefined) {
          if (vol.VolumeType !== undefined) ebs['VolumeType'] = vol.VolumeType;
          if (vol.Size !== undefined) ebs['VolumeSize'] = vol.Size;
          if (vol.Iops !== undefined) ebs['Iops'] = vol.Iops;
          if (vol.Throughput !== undefined) ebs['Throughput'] = vol.Throughput;
          if (vol.Encrypted !== undefined) ebs['Encrypted'] = vol.Encrypted;
          if (vol.KmsKeyId !== undefined) ebs['KmsKeyId'] = vol.KmsKeyId;
          if (vol.SnapshotId !== undefined) ebs['SnapshotId'] = vol.SnapshotId;
        }
        out['Ebs'] = ebs;
      }
      blockMappings.push(out);
    }
    result['BlockDeviceMappings'] = blockMappings;

    // Tags: filter aws:* (CDK-internal metadata) and always emit (even as
    // []). Same pattern as every other tag-aware provider.
    result['Tags'] = normalizeAwsTagsToCfn(instance.Tags);

    // DisableApiTermination: not returned by DescribeInstances; needs a
    // separate DescribeInstanceAttribute call. Best-effort — a permissions
    // gap or other failure falls back to omitting the key (state-keys-only
    // walk skips silently). Always emit when AWS reports a value so the v3
    // baseline catches a console-side toggle.
    try {
      const attrResp = await this.ec2Client.send(
        new DescribeInstanceAttributeCommand({
          InstanceId: physicalId,
          Attribute: 'disableApiTermination',
        })
      );
      if (attrResp.DisableApiTermination?.Value !== undefined) {
        result['DisableApiTermination'] = attrResp.DisableApiTermination.Value;
      }
    } catch (err) {
      this.logger.debug(
        `DescribeInstanceAttribute(disableApiTermination, ${physicalId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // CreditSpecification (#609): not returned by DescribeInstances; needs a
    // separate DescribeInstanceCreditSpecifications call. Best-effort — only
    // T-family burstable instances have a credit spec, and AWS errors for
    // non-burstable families, so a failure / absent value falls back to
    // omitting the key (the state-keys-only drift walk skips it silently).
    // Reverse-map to the CFn input shape ({ CPUCredits } — the canonical CDK
    // emission) so drift compares like-for-like against templated state.
    try {
      const creditResp = await this.ec2Client.send(
        new DescribeInstanceCreditSpecificationsCommand({ InstanceIds: [physicalId] })
      );
      const cpuCredits = creditResp.InstanceCreditSpecifications?.[0]?.CpuCredits;
      if (cpuCredits !== undefined) {
        result['CreditSpecification'] = { CPUCredits: cpuCredits };
      }
    } catch (err) {
      this.logger.debug(
        `DescribeInstanceCreditSpecifications(${physicalId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    return result;
  }

  private async readNetworkAclCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const resp = await this.ec2Client.send(
      new DescribeNetworkAclsCommand({ NetworkAclIds: [physicalId] })
    );
    const acl = resp.NetworkAcls?.[0];
    if (!acl) return undefined;

    const result: Record<string, unknown> = {};
    if (acl.VpcId !== undefined) result['VpcId'] = acl.VpcId;
    return result;
  }

  /**
   * AWS::EC2::VPCGatewayAttachment readCurrentState.
   *
   * physicalId format: `<igwId>|<vpcId>` (cdkd `createVpcGatewayAttachment`).
   * AWS API: `DescribeInternetGateways(igwId)` → walk `Attachments[]` for
   * the matching `VpcId`. Returns `undefined` when the IGW is gone OR is no
   * longer attached to the recorded VPC. Both fields are immutable on this
   * resource — drift signal is binary (exists / gone) plus VpcId mismatch.
   */
  private async readVpcGatewayAttachmentCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const [igwId, vpcId] = physicalId.split('|');
    if (!igwId || !vpcId) return undefined;

    const resp = await this.ec2Client.send(
      new DescribeInternetGatewaysCommand({ InternetGatewayIds: [igwId] })
    );
    const igw = resp.InternetGateways?.[0];
    if (!igw) return undefined;
    const attached = igw.Attachments?.some((a) => a.VpcId === vpcId);
    if (!attached) return undefined;

    return { InternetGatewayId: igwId, VpcId: vpcId };
  }

  /**
   * AWS::EC2::Route readCurrentState.
   *
   * physicalId format: `<routeTableId>|<destination>` where destination is a
   * v4 CIDR, a v6 CIDR, or a managed prefix list id (`pl-...`).
   * AWS API: `DescribeRouteTables(routeTableId)` → walk `Routes[]` for the
   * entry whose `DestinationCidrBlock`, `DestinationIpv6CidrBlock`, or
   * `DestinationPrefixListId` matches the destination. Returns `undefined`
   * when the route table is gone or the route has been removed.
   *
   * Surfaces the target field (`GatewayId` / `NatGatewayId` / `InstanceId` /
   * `NetworkInterfaceId` / `VpcPeeringConnectionId` / `EgressOnlyInternetGatewayId` /
   * `TransitGatewayId` / `LocalGatewayId` / `CarrierGatewayId` / `CoreNetworkArn` /
   * `VpcEndpointId`) AWS reports for that route. Drift signal: route target changed.
   */
  private async readRouteCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const [rtbId, destination] = physicalId.split('|');
    if (!rtbId || !destination) return undefined;

    const resp = await this.ec2Client.send(
      new DescribeRouteTablesCommand({ RouteTableIds: [rtbId] })
    );
    const rtb = resp.RouteTables?.[0];
    if (!rtb) return undefined;
    const route = rtb.Routes?.find(
      (r) =>
        r.DestinationCidrBlock === destination ||
        r.DestinationIpv6CidrBlock === destination ||
        r.DestinationPrefixListId === destination
    );
    if (!route) return undefined;

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
    return result;
  }

  /**
   * AWS::EC2::SubnetRouteTableAssociation readCurrentState.
   *
   * physicalId format: `<rtbassoc-xxx>` (returned by `AssociateRouteTable`).
   * AWS API: `DescribeRouteTables` filtered by `association.route-table-association-id`,
   * then walk `Associations[]` for the matching entry. Returns `undefined`
   * when no route table carries the association id.
   *
   * Both `SubnetId` and `RouteTableId` are immutable on this resource —
   * drift signal is binary (exists / gone).
   */
  private async readSubnetRouteTableAssociationCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
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
    return undefined;
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
   * description). Returns `undefined` when the parent SG is gone or no
   * matching rule exists.
   */
  private async readSecurityGroupIngressCurrentState(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
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
    if (!sg) return undefined;

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
    const candidates = (sg.IpPermissions ?? []).filter(
      (p) =>
        sgProtocolKey(p.IpProtocol) === wantedProtocol &&
        (p.FromPort ?? undefined) === fromPort &&
        (p.ToPort ?? undefined) === toPort
    );
    if (candidates.length === 0) return undefined;

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
      // No exact match — return undefined so the comparator marks the
      // resource as `gone` rather than fire false drift on a different
      // rule that happens to share the (protocol, ports) tuple.
      return undefined;
    }

    return { GroupId: groupId, ...flat[0]! };
  }

  /**
   * AWS::EC2::NetworkAclEntry readCurrentState.
   *
   * physicalId format: `<aclId>|<ruleNumber>|<egress>` (cdkd
   * `createNetworkAclEntry`).
   *
   * AWS API: `DescribeNetworkAcls(aclId)` → walk `Entries[]` for the entry
   * matching `(RuleNumber, Egress)`. Returns `undefined` when the parent
   * ACL is gone or the rule has been removed.
   *
   * Surfaces every user-controllable CFn property (`Protocol`, `RuleAction`,
   * `CidrBlock`, `Ipv6CidrBlock`, `PortRange`, `IcmpTypeCode`). `Protocol`
   * is normalized to a number to match CFn input shape (AWS returns it as
   * a string).
   */
  private async readNetworkAclEntryCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const parts = physicalId.split('|');
    if (parts.length < 3) return undefined;
    const aclId = parts[0]!;
    const ruleNumber = parseInt(parts[1]!, 10);
    const egress = parts[2] === 'true';

    const resp = await this.ec2Client.send(
      new DescribeNetworkAclsCommand({ NetworkAclIds: [aclId] })
    );
    const acl = resp.NetworkAcls?.[0];
    if (!acl) return undefined;
    const entry = acl.Entries?.find(
      (e) => e.RuleNumber === ruleNumber && (e.Egress ?? false) === egress
    );
    if (!entry) return undefined;

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
        // the silent-drop pre-flight by using the AWS API name).
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
   * then walk `Associations[]` for the matching entry. Returns `undefined`
   * when no NACL carries the association id.
   *
   * Surfaces `NetworkAclId` + `SubnetId`. Drift signal: NetworkAclId
   * changed (subnet was reassigned to a different NACL via console).
   */
  private async readSubnetNetworkAclAssociationCurrentState(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
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
    return undefined;
  }

  private async verifyExplicit(
    logicalId: string,
    resourceType: string,
    physicalId: string
  ): Promise<ResourceImportResult | null> {
    try {
      switch (resourceType) {
        case 'AWS::EC2::VPC': {
          const resp = await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [physicalId] }));
          return resp.Vpcs?.[0] ? { physicalId, attributes: {} } : null;
        }
        case 'AWS::EC2::Subnet': {
          const resp = await this.ec2Client.send(
            new DescribeSubnetsCommand({ SubnetIds: [physicalId] })
          );
          return resp.Subnets?.[0] ? { physicalId, attributes: {} } : null;
        }
        case 'AWS::EC2::SecurityGroup': {
          const resp = await this.ec2Client.send(
            new DescribeSecurityGroupsCommand({ GroupIds: [physicalId] })
          );
          return resp.SecurityGroups?.[0] ? { physicalId, attributes: {} } : null;
        }
        case 'AWS::EC2::SecurityGroupIngress': {
          // Only the `sgr-...` rule id is accepted: it is CloudFormation's own
          // `primaryIdentifier` for the type and the id the EC2 console shows,
          // while cdkd's composite `<groupId>|<ipProtocol>|<fromPort>|<toPort>`
          // is an internal shape a user cannot read off AWS (and one the same
          // tuple can share with several rules). The composite is still what
          // gets RECORDED — the revoke path needs the tuple — alongside the
          // `Id` attribute `cdkd export` resolves from (issue #1761).
          if (!physicalId.startsWith('sgr-')) return null;
          const resp = await this.ec2Client.send(
            new DescribeSecurityGroupRulesCommand({ SecurityGroupRuleIds: [physicalId] })
          );
          const rule = resp.SecurityGroupRules?.[0];
          // An EGRESS rule id is a different CFn type
          // (`AWS::EC2::SecurityGroupEgress`); adopting it here would record a
          // row whose delete calls `RevokeSecurityGroupIngress` and silently
          // does nothing.
          if (!rule || rule.IsEgress === true) return null;
          if (!rule.GroupId || !rule.IpProtocol || !rule.SecurityGroupRuleId) return null;
          const segments = [
            { name: 'groupId', value: rule.GroupId },
            { name: 'ipProtocol', value: rule.IpProtocol },
            { name: 'fromPort', value: rule.FromPort ?? '-1' },
            { name: 'toPort', value: rule.ToPort ?? '-1' },
          ];
          // Warn-and-SKIP, matching the `AWS::EC2::EIP` arm below: an
          // `import()` may decline a row, but it must never ADOPT an id it
          // knows decodes ambiguously (#1658). Unreachable in practice — every
          // segment comes from `DescribeSecurityGroupRules`.
          const refusal = compositeIdSeparatorRefusal(
            'AWS::EC2::SecurityGroupIngress',
            logicalId,
            segments
          );
          if (refusal !== undefined) {
            this.logger.warn(`${refusal} Skipping import.`);
            return null;
          }
          return {
            physicalId: packCompositeId('AWS::EC2::SecurityGroupIngress', logicalId, segments),
            attributes: { Id: rule.SecurityGroupRuleId },
          };
        }
        case 'AWS::EC2::NatGateway': {
          const resp = await this.ec2Client.send(
            new DescribeNatGatewaysCommand({ NatGatewayIds: [physicalId] })
          );
          const gw = resp.NatGateways?.find((g) => g.State !== 'deleted' && g.State !== 'deleting');
          return gw ? { physicalId, attributes: {} } : null;
        }
        case 'AWS::EC2::EIP': {
          // Accept an allocation id, a public IP, or the composite `IP|alloc`.
          const { allocationId, publicIp } = this.parseEipPhysicalId(physicalId);
          const filter = allocationId
            ? { AllocationIds: [allocationId] }
            : { PublicIps: publicIp ? [publicIp] : [] };
          const resp = await this.ec2Client.send(new DescribeAddressesCommand(filter));
          const addr = resp.Addresses?.[0];
          if (!addr?.AllocationId || !addr.PublicIp) return null;
          // Warn-and-SKIP, matching the `AWS::S3Tables::*` import arms: an
          // `import()` never throws over one row where it can decline, but it
          // must not ADOPT an id it knows to be ambiguous either — recording
          // one is the #1658 failure mode (a state row that looks adopted and
          // makes the stack undestroyable), which is strictly worse than the
          // loud not-found a skip produces. Unreachable in practice (both
          // segments come from `DescribeAddresses`); see `eipPhysicalId`.
          const eipRefusal = compositeIdSeparatorRefusal('AWS::EC2::EIP', logicalId, [
            { name: 'publicIp', value: addr.PublicIp },
            { name: 'allocationId', value: addr.AllocationId },
          ]);
          if (eipRefusal !== undefined) {
            this.logger.warn(`${eipRefusal} Skipping import.`);
            return null;
          }
          return {
            physicalId: this.eipPhysicalId(logicalId, addr.PublicIp, addr.AllocationId),
            attributes: { AllocationId: addr.AllocationId, PublicIp: addr.PublicIp },
          };
        }
        default:
          return null;
      }
    } catch (error) {
      if (this.isNotFoundError(error)) return null;
      throw error;
    }
  }
}

// ─── SecurityGroup rule helpers ──────────────────────────────────────
//
// `IpPermissions` reverse-mapping: AWS returns SG rules in normalized
// `IpPermissions[]` form where each permission can carry multiple
// `IpRanges`, `Ipv6Ranges`, `UserIdGroupPairs`, and `PrefixListIds`
// entries. The CFn `SecurityGroupIngress` / `SecurityGroupEgress` shape
// is rule-list-style — one entry per `(protocol, ports, source-or-dest)`
// tuple. The reverse-map produces one CFn rule per source/dest entry
// inside each AWS permission, matching the field naming the
// in-place SG update path (`applySecurityGroupRuleDiff`) expects so
// `cdkd drift --revert` can round-trip cleanly.

type SgDirection = 'ingress' | 'egress';
type CfnSgRule = Record<string, unknown>;

/**
 * Flatten AWS `IpPermission[]` (the `DescribeSecurityGroups` shape) into
 * a flat list of CFn-shaped rules. Each `IpRanges` / `Ipv6Ranges` /
 * `UserIdGroupPairs` / `PrefixListIds` entry inside a permission becomes
 * its own CFn rule, so the resulting list aligns 1:1 with the way users
 * template `SecurityGroupIngress` / `SecurityGroupEgress`.
 *
 * Field names follow CFn direction conventions:
 *  - ingress: `SourceSecurityGroupId`, `SourceSecurityGroupOwnerId`, `SourcePrefixListId`
 *  - egress:  `DestinationSecurityGroupId`, `DestinationPrefixListId`
 *    (AWS does not return a peer-owner id for egress, matching CFn.)
 *
 * `Description` is surfaced when AWS returns it on the source/dest entry
 * (per-rule descriptions are stored on the entry, not the parent
 * permission).
 */
export function flattenIpPermissions(perms: IpPermission[], direction: SgDirection): CfnSgRule[] {
  const out: CfnSgRule[] = [];
  for (const p of perms) {
    const base: CfnSgRule = {};
    if (p.IpProtocol !== undefined) base['IpProtocol'] = p.IpProtocol;
    if (p.FromPort !== undefined) base['FromPort'] = p.FromPort;
    if (p.ToPort !== undefined) base['ToPort'] = p.ToPort;

    for (const ip of p.IpRanges ?? []) {
      const rule: CfnSgRule = { ...base };
      if (ip.CidrIp !== undefined) rule['CidrIp'] = ip.CidrIp;
      if (ip.Description !== undefined) rule['Description'] = ip.Description;
      out.push(rule);
    }
    for (const ipv6 of p.Ipv6Ranges ?? []) {
      const rule: CfnSgRule = { ...base };
      if (ipv6.CidrIpv6 !== undefined) rule['CidrIpv6'] = ipv6.CidrIpv6;
      if (ipv6.Description !== undefined) rule['Description'] = ipv6.Description;
      out.push(rule);
    }
    for (const grp of p.UserIdGroupPairs ?? []) {
      const rule: CfnSgRule = { ...base };
      if (direction === 'ingress') {
        if (grp.GroupId !== undefined) rule['SourceSecurityGroupId'] = grp.GroupId;
        if (grp.UserId !== undefined) rule['SourceSecurityGroupOwnerId'] = grp.UserId;
      } else {
        if (grp.GroupId !== undefined) rule['DestinationSecurityGroupId'] = grp.GroupId;
      }
      if (grp.Description !== undefined) rule['Description'] = grp.Description;
      out.push(rule);
    }
    for (const pl of p.PrefixListIds ?? []) {
      const rule: CfnSgRule = { ...base };
      if (direction === 'ingress') {
        if (pl.PrefixListId !== undefined) rule['SourcePrefixListId'] = pl.PrefixListId;
      } else {
        if (pl.PrefixListId !== undefined) rule['DestinationPrefixListId'] = pl.PrefixListId;
      }
      if (pl.Description !== undefined) rule['Description'] = pl.Description;
      out.push(rule);
    }

    // Empty-source permission (rare but legal — e.g. a permission with
    // only `IpRanges: []`). Emit the bare protocol/port shell so the
    // shape isn't lost; the comparator may still fire drift, which is
    // correct because the user templated nothing here.
    if (
      (p.IpRanges?.length ?? 0) === 0 &&
      (p.Ipv6Ranges?.length ?? 0) === 0 &&
      (p.UserIdGroupPairs?.length ?? 0) === 0 &&
      (p.PrefixListIds?.length ?? 0) === 0
    ) {
      out.push({ ...base });
    }
  }
  return out;
}

/**
 * Identity-key for a CFn SG rule. Matches the diff key used by
 * `applySecurityGroupRuleDiff` so the read-side reverse-mapping and the
 * write-side rule diff agree on rule identity for `cdkd drift --revert`.
 *
 * Direction-sensitive: ingress uses `Source*` fields, egress uses
 * `Destination*`.
 */
/**
 * The `IpProtocol` component of a security-group rule identity key.
 *
 * A NUMBER is stringified so a record written BEFORE issue #1633 still matches:
 * AWS always reports the protocol as a string, so a legacy record holding the
 * number `-1` keyed as `{"p":-1}` against AWS's `{"p":"-1"}` and matched
 * nothing — `readSecurityGroupIngressCurrentState` returned `undefined` and
 * `cdkd drift` reported the rule as GONE, forever. The canonicalizer makes such
 * a record's diff NO_CHANGE, so no deploy ever rewrites it either; normalizing
 * at the KEY is what heals the existing population with no migration.
 *
 * Anything that is neither a string nor a number is passed through UNCHANGED
 * rather than blanket-`String()`-ed: a malformed object would otherwise key as
 * the useless `'[object Object]'`, silently collapsing every malformed record
 * onto one bucket. Such a rule matches nothing either way — this keeps the
 * non-match honest instead of manufacturing a fake identity.
 */
function sgProtocolKey(value: unknown): unknown {
  // Issue #1643 extends the #1633 normalization from the value's TYPE to its
  // SPELLING, for the same reason and at the same place. AWS not only always
  // reports the protocol as a string, it also substitutes the canonical NAME
  // for the four numbers it has one for (`1`/`6`/`17`/`58` ->
  // `icmp`/`tcp`/`udp`/`icmpv6`, measured us-east-1 2026-08-12) and lower-cases
  // a name it is given. So a record holding `'6'` keyed as `{"p":"6"}` against
  // AWS's `{"p":"tcp"}` and matched nothing — exactly the failure the comment
  // below describes for the legacy numeric `-1`, one value-mapping deeper.
  // Normalizing at the KEY heals the existing population with no migration
  // here too, and keeps the standalone lookup and the inline-rule reconcile
  // reading ONE definition of protocol identity.
  return canonicalizeIpProtocolValue(value ?? '-1');
}

/**
 * The single `sgr-...` id an `AuthorizeSecurityGroupIngress` response reports
 * for a standalone `AWS::EC2::SecurityGroupIngress` (issue #1761).
 *
 * Pure by design: {@link EC2Provider.createSecurityGroupIngress} calls it
 * between the mutating Authorize and its return, where an `await` of anything
 * that can throw would re-create the issue #1710 orphan class.
 *
 * `undefined` unless the response carries EXACTLY ONE rule id. AWS mints one
 * rule per source entry, and cdkd sends one `IpPermission` per CFn resource —
 * but a template declaring both `CidrIp` and `CidrIpv6` on the same ingress
 * resource makes `buildIpPermission` emit two sources and AWS answers with two
 * rules. Neither is "the" CloudFormation identifier for the resource, so
 * recording nothing (and letting `cdkd export` refuse with its own message) is
 * the only answer that cannot silently name the wrong rule.
 */
function singleSecurityGroupRuleId(rules: SecurityGroupRule[] | undefined): string | undefined {
  const ids = (rules ?? [])
    .map((rule) => rule.SecurityGroupRuleId)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Does a `DescribeSecurityGroupRules` rule describe the same ingress rule the
 * given CFn `AWS::EC2::SecurityGroupIngress` properties ask for?
 *
 * Deliberately NOT expressed via {@link sgRuleKey}: that key includes
 * `SourceSecurityGroupOwnerId` and `Description`, both of which AWS fills in on
 * the read side even when the template omits them, so a whole-key compare
 * would report "no match" for the ordinary same-account SG-to-SG rule this
 * lookup exists to find. Matching the fields the template actually pins —
 * protocol, port range, and whichever ONE source key it declares — is what
 * makes the comparison decidable from a partial template.
 *
 * Ports are compared with AWS's own `-1` ("all") spelling on both sides, since
 * an omitted `FromPort` / `ToPort` reads back as `-1`.
 */
function securityGroupRuleMatchesCfnIngress(
  rule: SecurityGroupRule,
  properties: Record<string, unknown>
): boolean {
  if (sgProtocolKey(rule.IpProtocol) !== sgProtocolKey(properties['IpProtocol'])) return false;
  if ((rule.FromPort ?? -1) !== ((properties['FromPort'] as number | undefined) ?? -1))
    return false;
  if ((rule.ToPort ?? -1) !== ((properties['ToPort'] as number | undefined) ?? -1)) return false;

  // One source key per CFn ingress resource. When the template declares none
  // (legal — an all-sources rule is rejected by AWS, so this is the degenerate
  // case), protocol + ports alone decide, and the caller's "exactly one match"
  // rule still refuses an ambiguous answer.
  const sources: Array<[unknown, unknown]> = [
    [properties['CidrIp'], rule.CidrIpv4],
    [properties['CidrIpv6'], rule.CidrIpv6],
    [properties['SourceSecurityGroupId'], rule.ReferencedGroupInfo?.GroupId],
    [properties['SourcePrefixListId'], rule.PrefixListId],
  ];
  for (const [declared, actual] of sources) {
    if (declared !== undefined && declared !== null && declared !== actual) return false;
  }
  return true;
}

function sgRuleKey(rule: CfnSgRule, direction: SgDirection): string {
  const peerKey =
    direction === 'egress' ? rule['DestinationSecurityGroupId'] : rule['SourceSecurityGroupId'];
  const prefixKey =
    direction === 'egress' ? rule['DestinationPrefixListId'] : rule['SourcePrefixListId'];
  const peerOwner = direction === 'ingress' ? rule['SourceSecurityGroupOwnerId'] : undefined;
  return JSON.stringify({
    // STRINGIFIED so a record written BEFORE issue #1633 still matches. AWS
    // always reports the protocol as a string, so a legacy record holding the
    // NUMBER `-1` keyed as `{"p":-1}` against AWS's `{"p":"-1"}` and matched
    // nothing — `readSecurityGroupIngressCurrentState` returned `undefined`
    // and `cdkd drift` reported the rule as gone, forever. The canonicalizer
    // makes such a record's diff NO_CHANGE, so no deploy ever rewrites it
    // either; normalizing at the KEY is what heals the existing population
    // with no migration.
    p: sgProtocolKey(rule['IpProtocol']),
    f: rule['FromPort'] ?? null,
    t: rule['ToPort'] ?? null,
    c4: rule['CidrIp'] ?? null,
    c6: rule['CidrIpv6'] ?? null,
    peer: peerKey ?? null,
    peerOwner: peerOwner ?? null,
    pl: prefixKey ?? null,
    d: rule['Description'] ?? null,
  });
}

/**
 * Reorder AWS-returned rules to match state's templated order so the
 * drift comparator's positional array compare doesn't fire false drift
 * on AWS's normalized order.
 *
 * For each state rule, find a matching AWS rule by `sgRuleKey`. Output
 * matched rules in state's order; any AWS rules without a state match
 * (console-side adds, or rules state has but AWS doesn't) go at the end
 * preserving AWS's original order.
 *
 * If state didn't template rules at all, returns AWS rules unchanged.
 */
export function reconcileSgRules(
  awsRules: CfnSgRule[],
  stateRules: Array<Record<string, unknown>> | undefined,
  direction: SgDirection
): CfnSgRule[] {
  if (!stateRules || stateRules.length === 0) return awsRules;

  const remaining = [...awsRules];
  const reordered: CfnSgRule[] = [];
  for (const sr of stateRules) {
    const key = sgRuleKey(sr, direction);
    const idx = remaining.findIndex((ar) => sgRuleKey(ar, direction) === key);
    if (idx >= 0) {
      reordered.push(remaining.splice(idx, 1)[0]!);
    }
  }
  return [...reordered, ...remaining];
}

/**
 * Detect AWS's auto-attached "allow-all egress" rule that is created
 * with the SecurityGroup when the user does not template
 * `SecurityGroupEgress`. Filter signature is intentionally narrow — only
 * the exact AWS-default tuple (`-1` protocol, `0.0.0.0/0` CIDR, no
 * description, no per-rule ports). A user-defined rule that happens to
 * match the same tuple wouldn't be filtered if state templates egress
 * (the caller checks `stateEgress === undefined` before invoking).
 */
export function isDefaultEgressRule(rule: CfnSgRule): boolean {
  if (rule['IpProtocol'] !== '-1') return false;
  if (rule['CidrIp'] !== '0.0.0.0/0') return false;
  if (rule['CidrIpv6'] !== undefined) return false;
  if (rule['DestinationSecurityGroupId'] !== undefined) return false;
  if (rule['DestinationPrefixListId'] !== undefined) return false;
  if (rule['Description'] !== undefined) return false;
  // FromPort / ToPort: AWS returns them as -1 for the all-protocols
  // default, but some legacy responses omit them. Accept both.
  if (rule['FromPort'] !== undefined && rule['FromPort'] !== -1) return false;
  if (rule['ToPort'] !== undefined && rule['ToPort'] !== -1) return false;
  return true;
}
