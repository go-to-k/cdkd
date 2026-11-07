import { EC2Client } from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients, type AwsClients } from '../../utils/aws-clients.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteContext } from '../region-check.js';
import { ProtectionFlipRegistry } from './deletion-protection-compensation.js';
import { maskerOrIdentity } from '../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { withRemovalDefaults } from '../update-removal.js';
import {
  INSTANCE_ID_PATTERN,
  NAT_GATEWAY_ID_PATTERN,
  SECURITY_GROUP_ID_PATTERN,
  SUBNET_ID_PATTERN,
  VPC_ID_PATTERN,
  eipAllocationIdentity,
  generatedIdIdentity,
} from './ec2/common.js';
import type { Logger } from '../../types/config.js';
import { orphansMethods } from './ec2/orphans.js';
import { dispatchMethods } from './ec2/dispatch.js';
import { vpcMethods } from './ec2/vpc.js';
import { subnetMethods } from './ec2/subnet.js';
import { subnetAttributesMethods } from './ec2/subnet-attributes.js';
import { igwEipMethods } from './ec2/igw-eip.js';
import { gatewayAttachmentMethods } from './ec2/gateway-attachment.js';
import { natGatewayMethods } from './ec2/nat-gateway.js';
import { routeMethods } from './ec2/route.js';
import { securityGroupMethods } from './ec2/security-group.js';
import { sgIngressCreateMethods } from './ec2/sg-ingress-create.js';
import { sgIngressUpdateMethods } from './ec2/sg-ingress-update.js';
import { instanceCreateMethods } from './ec2/instance-create.js';
import { instanceUpdateMethods } from './ec2/instance-update.js';
import { instanceApplyMethods } from './ec2/instance-apply.js';
import { instanceLifecycleMethods } from './ec2/instance-lifecycle.js';
import { instanceBuildMethods } from './ec2/instance-build.js';
import { instanceSsmMethods } from './ec2/instance-ssm.js';
import { networkAclMethods } from './ec2/network-acl.js';
import { tagsErrorsMethods } from './ec2/tags-errors.js';
import { driftMethods } from './ec2/drift.js';
import { readStateMethods } from './ec2/read-state.js';
import { readInstanceStateMethods } from './ec2/read-instance-state.js';
import { verifyExplicitMethods } from './ec2/verify-explicit.js';

export { narrowRouteDestinations } from './ec2/network-support.js';
export {
  SG_READBACK_NOT_FOUND_ATTEMPTS,
  SG_READBACK_RETRY_DELAY_MS,
  securityGroupReadbackDelays,
  narrowIngressIpProtocol,
  flattenIpPermissions,
  reconcileSgRules,
  isDefaultEgressRule,
} from './ec2/sg-support.js';
export { describedInstanceAttributes } from './ec2/instance-support.js';
export {
  readNatZoneAddresses,
  natGatewayAttributes,
  planNatZoneAddressUpdate,
  readbackNatZoneAddresses,
} from './ec2/nat-support.js';
export type {
  NatZoneAddressEntry,
  NatZoneAddressRead,
  NatZoneAddressPlan,
} from './ec2/nat-support.js';
export { vpcIpamReleaseWait, resetEc2CreateRetryStateForTests } from './ec2/common.js';

/**
 * The per-resource-type methods live in `./ec2/*.ts` as `this: EC2Provider`
 * functions, installed on the prototype at the bottom of this file, so they are
 * ordinary prototype methods at runtime (a `vi.spyOn(provider, name)` and a
 * `this.name()` call inside another method both still go through the
 * instance). This interface gives them their types. The fields the mixins read
 * (`ec2Client`, `logger`, ...) are therefore not `private`.
 */
type EC2ProviderMixins = typeof orphansMethods &
  typeof dispatchMethods &
  typeof vpcMethods &
  typeof subnetMethods &
  typeof subnetAttributesMethods &
  typeof igwEipMethods &
  typeof gatewayAttachmentMethods &
  typeof natGatewayMethods &
  typeof routeMethods &
  typeof securityGroupMethods &
  typeof sgIngressCreateMethods &
  typeof sgIngressUpdateMethods &
  typeof instanceCreateMethods &
  typeof instanceUpdateMethods &
  typeof instanceApplyMethods &
  typeof instanceLifecycleMethods &
  typeof instanceBuildMethods &
  typeof instanceSsmMethods &
  typeof networkAclMethods &
  typeof tagsErrorsMethods &
  typeof driftMethods &
  typeof readStateMethods &
  typeof readInstanceStateMethods &
  typeof verifyExplicitMethods;
// The merge is the point: the prototype loop below supplies every member.
// eslint-disable-next-line typescript/no-unsafe-declaration-merging
export interface EC2Provider extends EC2ProviderMixins {}

export class EC2Provider implements ResourceProvider {
  ec2Client: EC2Client;
  /** The standalone-ingress Authorize's client: one send per call (#4355). */
  ec2AuthorizeClient: EC2Client;
  logger: Logger = getLogger().child('EC2Provider');
  /** `--remove-protection` flips, keyed so a re-entered instance delete keeps them (#2204). */
  readonly protectionFlips = new ProtectionFlipRegistry();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EC2::VPC',
      new Set([
        'CidrBlock',
        'InstanceTenancy',
        'EnableDnsHostnames',
        'EnableDnsSupport',
        'Tags',
        // go-to-k/cdkd#5633: CreateVpc inputs, all create-only.
        'Ipv4IpamPoolId',
        'Ipv4NetmaskLength',
        'VpcEncryptionControl',
      ]),
    ],
    [
      'AWS::EC2::Subnet',
      new Set([
        'VpcId',
        'CidrBlock',
        'AvailabilityZone',
        'MapPublicIpOnLaunch',
        'EnableDns64',
        'Ipv6CidrBlock',
        'Tags',
        // go-to-k/cdkd#5632: Ipv6Native is a create-only CreateSubnet input;
        // the other two are ModifySubnetAttribute writes.
        'AssignIpv6AddressOnCreation',
        'Ipv6Native',
        'PrivateDnsNameOptionsOnLaunch',
        // go-to-k/cdkd#5632: create-only CreateSubnet inputs.
        'AvailabilityZoneId',
        'Ipv4IpamPoolId',
        'Ipv4NetmaskLength',
        'Ipv6IpamPoolId',
        'Ipv6NetmaskLength',
      ]),
    ],
    ['AWS::EC2::InternetGateway', new Set(['Tags'])],
    [
      'AWS::EC2::EIP',
      new Set(['Domain', 'InstanceId', 'NetworkBorderGroup', 'PublicIpv4Pool', 'Tags']),
    ],
    ['AWS::EC2::VPCGatewayAttachment', new Set(['VpcId', 'InternetGatewayId', 'VpnGatewayId'])],
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
        // go-to-k/cdkd#2762: a regional NAT gateway.
        'AvailabilityMode',
        'VpcId',
        'AvailabilityZoneAddresses',
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
        'OdbNetworkArn',
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
        // Cloud Control path via the #614 sdkUnwired rule -- paying CC's
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
        // go-to-k/cdkd#5630: RunInstances inputs (buildLaunchOnlyInstanceOptions).
        'CpuOptions',
        'HibernationOptions',
        'InstanceInitiatedShutdownBehavior',
        // go-to-k/cdkd#5630: `PrivateIpAddress` and `Placement.Tenancy` /
        // `.GroupName` ride on RunInstances; `SourceDestCheck` is a
        // ModifyInstanceAttribute after launch and on update;
        // `PropagateTagsToVolumeOnCreation` adds a `volume` TagSpecification.
        'SourceDestCheck',
        'Tenancy',
        'PlacementGroupName',
        'PrivateIpAddress',
        'PropagateTagsToVolumeOnCreation',
        // go-to-k/cdkd#5630: RunInstances inputs (buildLaunchOnlyInstanceOptions).
        // `PrivateDnsNameOptions` also changes in place
        // (ModifyPrivateDnsNameOptions, planInstanceMemberUpdates).
        'AdditionalInfo',
        'Ipv6AddressCount',
        'Ipv6Addresses',
        'PrivateDnsNameOptions',
        // go-to-k/cdkd#5630: `LaunchTemplate` is a RunInstances input
        // (create-only); `Volumes` are attached after the launch and
        // attached / detached in place on update (AttachVolume / DetachVolume).
        'LaunchTemplate',
        'Volumes',
        // go-to-k/cdkd#5630: `LicenseSpecifications` is a RunInstances input
        // (create-only); `SsmAssociations` is a Systems Manager
        // CreateAssociation after the launch, deleted and re-created in place
        // on update (instance-ssm.ts).
        'LicenseSpecifications',
        'SsmAssociations',
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

  /**
   * Issue #1160: `ModifyVpcAttribute` changes only the attribute it is sent,
   * so a VPC update that skips a removed DNS attribute keeps its live value,
   * while a CloudFormation update that removes one resets it to the VPC
   * default (real A/B, us-east-1: `EnableDnsHostnames` true -> false and
   * `EnableDnsSupport` false -> true after the removal). `updateVpc` diffs
   * each value against the previous template, so a removed attribute that
   * already held its default sends nothing.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::EC2::VPC',
      new Map<string, unknown>([
        ['EnableDnsHostnames', false],
        ['EnableDnsSupport', true],
      ]),
    ],
    // Issue #1160: a CloudFormation update that removes `Monitoring` turns
    // detailed monitoring off (real A/B, us-east-1: `Monitoring.State`
    // `enabled` -> `disabled`). `updateInstanceSecurityProps` diffs it against
    // the previous template, so the injected `false` calls UnmonitorInstances
    // only when monitoring was on. MetadataOptions / CreditSpecification get
    // no reset (see that method); a removed UserData / IamInstanceProfile /
    // SecurityGroupIds is read from `removedProperties` instead, because its
    // CloudFormation reset is a call (clear, disassociate, the VPC's default
    // group), not a value (issue #5446, see planInstanceMemberUpdates).
    //
    // go-to-k/cdkd#5630: a CloudFormation update that removes `SourceDestCheck`
    // sets it back to `true`, the EC2 default, in place (measured us-east-1,
    // 2026-11-04, a t3.nano: `false` -> removed read back `true`, same instance).
    [
      'AWS::EC2::Instance',
      new Map<string, unknown>([
        ['Monitoring', false],
        ['SourceDestCheck', true],
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      // go-to-k/cdkd#5632: both need an AWS Outposts rack, which no integ
      // account can provision to verify a wiring against; a template
      // declaring either still routes the subnet through Cloud Control.
      'AWS::EC2::Subnet',
      new Map<string, string>([
        ['EnableLniAtDeviceIndex', 'AWS Outposts-only subnet attribute; Cloud Control applies it'],
        ['OutpostArn', 'AWS Outposts-only create input; Cloud Control applies it'],
      ]),
    ],
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
          // Issue #1411. Verified against the installed @aws-sdk/client-ec2:
          // `CreateNatGatewayRequest` (models/models_1.d.ts) has NO
          // `MaxDrainDurationSeconds` member, and EC2 ships no
          // `ModifyNatGateway*` operation at all. The ONLY two SDK inputs
          // carrying the field are `DisassociateNatGatewayAddressRequest`
          // (models/models_5.d.ts) and `UnassignPrivateNatGatewayAddressRequest`
          // (models/models_7.d.ts) — i.e. it is a per-call drain timeout for
          // RELEASING secondary addresses, which is why the CFn registry schema
          // lists it under `writeOnlyProperties` (no read handler can return
          // it). cdkd's NatGateway update path releases a regional gateway's
          // `AvailabilityZoneAddresses` (go-to-k/cdkd#2762) but rejects every
          // change to a zonal gateway's secondary addresses
          // (`ResourceUpdateNotSupportedError`, see `updateNatGateway`), so
          // wiring the value would deliver it on one release path of three
          // while moving a gateway that declares it off Cloud Control, where
          // every address update works today.
          // It is NOT modelled as a replacement trigger either: the registry
          // schema does not list it under `createOnlyProperties`, so recreating
          // the gateway on a drain-timeout change would diverge from
          // CloudFormation and needlessly break the data plane. Declaring it
          // sdkUnwired here routes any template that sets it through the #614
          // Cloud Control fallback, where AWS's own resource handler applies it.
          'MaxDrainDurationSeconds',
          'write-only address-drain timeout with no CreateNatGateway member and no NAT gateway modify API; only ec2:DisassociateNatGatewayAddress / UnassignPrivateNatGatewayAddress accept it, and the cdkd NatGateway update releases only the AvailabilityZoneAddresses of a regional gateway, never the secondary addresses of a zonal one — routed via Cloud Control instead',
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

  /**
   * go-to-k/cdkd#5630: the `AWS::EC2::Instance SsmAssociations` calls read
   * `awsClients.ssm` on use, so an instance with none builds no SSM client.
   */
  readonly awsClients: AwsClients;

  constructor() {
    const awsClients = getAwsClients();
    this.awsClients = awsClients;
    this.ec2Client = awsClients.ec2;
    // `?? ec2` only for a test double that provides no `ec2SingleSend`;
    // `AwsClients` always does.
    this.ec2AuthorizeClient = awsClients.ec2SingleSend ?? awsClients.ec2;
  }

  createClient: Promise<EC2Client> | undefined;

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return this.createVpc(logicalId, resourceType, properties, context);
      case 'AWS::EC2::Subnet':
        return this.createSubnet(logicalId, resourceType, properties, context);
      case 'AWS::EC2::InternetGateway':
        return this.createInternetGateway(logicalId, resourceType, properties, context);
      case 'AWS::EC2::EIP':
        return this.createEip(logicalId, resourceType, properties, context);
      case 'AWS::EC2::VPCGatewayAttachment':
        return this.createVpcGatewayAttachment(logicalId, resourceType, properties, context);
      case 'AWS::EC2::NatGateway':
        return this.createNatGateway(logicalId, resourceType, properties, context);
      case 'AWS::EC2::RouteTable':
        return this.createRouteTable(logicalId, resourceType, properties, context);
      case 'AWS::EC2::Route':
        return this.createRoute(
          logicalId,
          resourceType,
          properties,
          // A reverse-replacement rollback creates from a STATE record, so the
          // refusal downgrades here exactly as it does on the update path.
          context?.replayingState === true ? (message) => this.logger.warn(message) : undefined,
          context?.maskSecrets
        );
      case 'AWS::EC2::SubnetRouteTableAssociation':
        return this.createSubnetRouteTableAssociation(logicalId, resourceType, properties, context);
      case 'AWS::EC2::SecurityGroup':
        return this.createSecurityGroup(logicalId, resourceType, properties, context);
      case 'AWS::EC2::SecurityGroupIngress':
        return this.createSecurityGroupIngress(
          logicalId,
          resourceType,
          properties,
          // A reverse-replacement rollback creates from a STATE record, so the
          // refusal downgrades here exactly as it does on the update path.
          context?.replayingState === true ? (message) => this.logger.warn(message) : undefined,
          context?.maskSecrets,
          context?.replayingState === true
        );
      case 'AWS::EC2::Instance':
        return this.createInstance(logicalId, resourceType, properties, context);
      case 'AWS::EC2::NetworkAcl':
        return this.createNetworkAcl(logicalId, resourceType, properties, context);
      case 'AWS::EC2::NetworkAclEntry':
        return this.createNetworkAclEntry(logicalId, resourceType, properties, context);
      case 'AWS::EC2::SubnetNetworkAclAssociation':
        return this.createSubnetNetworkAclAssociation(logicalId, resourceType, properties, context);
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
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    properties = withRemovalDefaults(
      this.removalDefaults,
      resourceType,
      properties,
      previousProperties,
      context
    );
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
      // is control flow the deploy engine matches BY CLASS, and an inner
      // ProvisioningError already carries better context than a re-wrap.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update EC2 resource ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
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
        return this.deleteVpc(logicalId, physicalId, resourceType, context, properties);
      case 'AWS::EC2::Subnet':
        return this.deleteSubnet(logicalId, physicalId, resourceType, context, properties);
      case 'AWS::EC2::InternetGateway':
        return this.deleteInternetGateway(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::EIP':
        return this.deleteEip(logicalId, physicalId, resourceType, context);
      case 'AWS::EC2::VPCGatewayAttachment':
        return this.deleteVpcGatewayAttachment(
          logicalId,
          physicalId,
          resourceType,
          properties,
          context
        );
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
        return this.deleteInstance(logicalId, physicalId, resourceType, context, properties);
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
      case 'AWS::EC2::NatGateway':
        return this.getNatGatewayAttribute(physicalId, attributeName);
      default:
        return undefined;
    }
  }

  /**
   * go-to-k/cdkd#4606: whether the NAT gateway, Elastic IP, EC2 instance,
   * VPC, subnet or security group a failed CREATE journaled is the one the
   * record under the same logical id holds (a fix-forward that created a new
   * one there). Every other type this provider serves is `'unknown'`.
   *
   * The identity is the AWS-generated id: a NAT gateway's `nat-…` id, an
   * instance's `i-…` id (the physical id both the SDK create and Cloud
   * Control record; an instance the create left behind is one whose
   * wiring failed and whose cleanup terminate failed too), a VPC's `vpc-…`,
   * a subnet's `subnet-…` and a security group's `sg-…` id (likewise
   * journaled only when the wiring after the create AND the cleanup delete
   * both failed), and an
   * Elastic IP's `eipalloc-…` allocation id (carried by the composite
   * `PublicIp|AllocationId` physical id or as a bare id, the fallback the
   * create journals only when the composite fence refused; a bare journaled
   * id is only ever `'same'` or `'unknown'`, since the settle's holder checks
   * compare the id string and cannot be trusted with that spelling).
   * Each is unique per account and region and never
   * reassigned, so two distinct ids in the stack's region name two distinct
   * resources. A public IP is NOT an identity (a released address can be
   * handed out again), so an id without an allocation segment, and anything
   * else, is `'unknown'`. Equal ids are `'same'` without a read. After the
   * region check, the record's resource must read back live under its own id
   * (a NAT gateway `pending` or `available`; a `failed`, `deleting` or
   * `deleted` one is gone; an instance in any state short of
   * `shutting-down` / `terminated`, which EC2 keeps listing for about an
   * hour; a VPC or subnet `pending` or `available`; a security group, which
   * has no state, whenever EC2 lists it), else `'unknown'`; the journaled one is then
   * `'different'` whether it reads back under its own id or AWS reports it
   * gone. A journaled NAT gateway left `failed` by its create is
   * `'different'` too: the settle's delete removes it.
   *
   * SDK-routed resources only: the settle asks the provider the journaled
   * operation was provisioned by, so a Cloud Control-routed resource of these
   * types (e.g. a NAT gateway setting
   * `MaxDrainDurationSeconds`) never reaches this method and keeps the
   * warning.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    let read: (id: string) => Promise<string | undefined>;
    let identity: (physicalId: string) => string | undefined;
    if (resourceType === 'AWS::EC2::NatGateway') {
      identity = (id) => generatedIdIdentity(NAT_GATEWAY_ID_PATTERN, id);
      read = (id) => this.readNatGatewayIdIfLive(id);
    } else if (resourceType === 'AWS::EC2::EIP') {
      identity = eipAllocationIdentity;
      read = (id) => this.readEipAllocationIdIfExists(id);
    } else if (resourceType === 'AWS::EC2::Instance') {
      identity = (id) => generatedIdIdentity(INSTANCE_ID_PATTERN, id);
      read = (id) => this.readInstanceIdIfLive(id);
    } else if (resourceType === 'AWS::EC2::VPC') {
      identity = (id) => generatedIdIdentity(VPC_ID_PATTERN, id);
      read = (id) => this.readVpcIdIfLive(id);
    } else if (resourceType === 'AWS::EC2::Subnet') {
      identity = (id) => generatedIdIdentity(SUBNET_ID_PATTERN, id);
      read = (id) => this.readSubnetIdIfLive(id);
    } else if (resourceType === 'AWS::EC2::SecurityGroup') {
      identity = (id) => generatedIdIdentity(SECURITY_GROUP_ID_PATTERN, id);
      read = (id) => this.readSecurityGroupIdIfExists(id);
    } else {
      return 'unknown';
    }
    const journaledId = identity(journaledPhysicalId);
    const recordId = identity(record.physicalId);
    if (journaledId === undefined || recordId === undefined) return 'unknown';
    if (journaledId === recordId) return 'same';
    // A bare journaled allocation id is never `'different'`. The bare form
    // exists only as the create's fallback when the composite fence refused,
    // so it is a spelling no record holds: the settle's holder checks compare
    // the physical id STRING and cannot be trusted with it in either
    // direction (a record of either spelling of that address goes unseen).
    if (resourceType === 'AWS::EC2::EIP' && journaledPhysicalId === journaledId) return 'unknown';
    const clientRegion = await this.ec2Client.config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    if ((await read(recordId)) !== recordId) return 'unknown';
    const journaledLive = await read(journaledId);
    return journaledLive === recordId ? 'same' : 'different';
  }

  /**
   * Adopt an existing EC2 networking resource into cdkd state.
   *
   * Every arm here is OVERRIDE-ONLY: `import()` returns `null` unless the
   * caller passed `--resource <logicalId>=<physicalId>`, and `verifyExplicit`
   * then confirms that id against AWS. Supported types:
   *
   * - `AWS::EC2::VPC`, `AWS::EC2::Subnet`, `AWS::EC2::SecurityGroup` — verified
   *   by id, recorded verbatim with no attributes.
   * - `AWS::EC2::NatGateway` — verified by id, ignoring a gateway already in
   *   `deleted` / `deleting` state.
   * - `AWS::EC2::EIP` — accepts an allocation id, a public IP, or the composite
   *   `<publicIp>|<allocationId>`, and records the composite plus the
   *   `AllocationId` / `PublicIp` attributes.
   * - `AWS::EC2::SecurityGroupIngress` — accepts the `sgr-...` rule id
   *   (CloudFormation's own identifier for the type), declines an EGRESS rule
   *   id, and records cdkd's composite `<groupId>|<ipProtocol>|<fromPort>|<toPort>`
   *   plus the rule id as the `Id` attribute (issue #1761).
   *
   * - RouteTable, Route, InternetGateway, VPCGatewayAttachment, NetworkAcl,
   *   NetworkAclEntry, SubnetRouteTableAssociation, SubnetNetworkAclAssociation,
   *   Instance (issue #3661) — they used to return `null` on the premise that
   *   cdkd reconstructs them at deploy time, which `--migrate-from-cloudformation`
   *   breaks: the CloudFormation stack is retired with them live, and the
   *   re-create duplicates or conflicts. VPCGatewayAttachment and
   *   NetworkAclEntry rebuild cdkd's composite from the template, since
   *   CloudFormation's id for them does not carry it.
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
      return this.verifyExplicit(
        input.logicalId,
        input.resourceType,
        input.knownPhysicalId,
        input.properties ?? {}
      );
    }

    // A resource reaching here needs an explicit `--resource` override.
    return null;
  }
}

// Installed like class methods: non-enumerable, writable, configurable.
for (const methods of [
  orphansMethods,
  dispatchMethods,
  vpcMethods,
  subnetMethods,
  subnetAttributesMethods,
  igwEipMethods,
  gatewayAttachmentMethods,
  natGatewayMethods,
  routeMethods,
  securityGroupMethods,
  sgIngressCreateMethods,
  sgIngressUpdateMethods,
  instanceCreateMethods,
  instanceUpdateMethods,
  instanceApplyMethods,
  instanceLifecycleMethods,
  instanceBuildMethods,
  instanceSsmMethods,
  networkAclMethods,
  tagsErrorsMethods,
  driftMethods,
  readStateMethods,
  readInstanceStateMethods,
  verifyExplicitMethods,
]) {
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(EC2Provider.prototype, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
