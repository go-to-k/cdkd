import {
  DescribeVpcsCommand,
  DescribeNatGatewaysCommand,
  DescribeAddressesCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import type { UpdateContext, ResourceUpdateResult } from '../../../types/resource.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import {
  EIP_ALLOCATION_NOT_FOUND_NAMES,
  INSTANCE_NOT_FOUND_NAMES,
  SECURITY_GROUP_NOT_FOUND_NAMES,
  SUBNET_NOT_FOUND_NAMES,
  VPC_NOT_FOUND_NAMES,
  isNamedError,
} from './common.js';
import { NAT_GATEWAY_NOT_FOUND_NAMES, natGatewayAttributes } from './nat-support.js';
import type { EC2Provider } from '../ec2-provider.js';

export async function applyUpdate(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  switch (resourceType) {
    case 'AWS::EC2::VPC':
      return this.updateVpc(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::Subnet':
      return this.updateSubnet(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::InternetGateway':
      return this.updateTagsOnly(
        logicalId,
        physicalId,
        resourceType,
        false,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::EIP':
      return this.updateEip(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::VPCGatewayAttachment':
      return this.updateVpcGatewayAttachment(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::NatGateway':
      return this.updateNatGateway(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::RouteTable':
    case 'AWS::EC2::NetworkAcl':
      return this.updateTagsOnly(
        logicalId,
        physicalId,
        resourceType,
        true,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::Route':
      return this.updateRoute(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::SubnetRouteTableAssociation':
      return this.updateSubnetRouteTableAssociation(logicalId, physicalId);
    case 'AWS::EC2::SecurityGroup':
      return this.updateSecurityGroup(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::SecurityGroupIngress':
      return this.updateSecurityGroupIngress(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets,
        context?.replayingState === true,
        context?.recordedAttributes
      );
    case 'AWS::EC2::Instance':
      return this.updateInstance(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::NetworkAclEntry':
      return this.updateNetworkAclEntry(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::EC2::SubnetNetworkAclAssociation':
      // Reject loudly instead of silently no-op'ing on
      // `cdkd drift --revert`. Same rationale as
      // SubnetRouteTableAssociation above. See PR I.
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `AWS provides no in-place Update API for this EC2 sub-resource type; every property change requires Delete + Create. Re-deploy with ${deployReplaceCommand()}, or destroy + redeploy`
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

/** `AWS::EC2::NatGateway` attributes, read live ({@link natGatewayAttributes}). */
export async function getNatGatewayAttribute(
  this: EC2Provider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'NatGatewayId') return physicalId;
  const response = await this.ec2Client.send(
    new DescribeNatGatewaysCommand({ NatGatewayIds: [physicalId] })
  );
  const gateway = response.NatGateways?.find((g) => g.NatGatewayId === physicalId);
  return gateway === undefined ? undefined : natGatewayAttributes(gateway)[attributeName];
}

/**
 * The id `DescribeNatGateways` reports for `natGatewayId` while the gateway
 * is `pending` or `available`; `undefined` when EC2 reports it gone
 * (`NatGatewayNotFound`, or a `failed` / `deleting` / `deleted` gateway).
 * Any other failure, and a response naming no gateway, throws: "could not
 * read" never reads as "gone".
 */
export async function readNatGatewayIdIfLive(
  this: EC2Provider,
  natGatewayId: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.ec2Client.send(
      new DescribeNatGatewaysCommand({ NatGatewayIds: [natGatewayId] })
    );
  } catch (error) {
    if (isNamedError(error, NAT_GATEWAY_NOT_FOUND_NAMES)) return undefined;
    throw error;
  }
  const gateways = response.NatGateways ?? [];
  if (gateways.length !== 1 || typeof gateways[0]?.NatGatewayId !== 'string') {
    throw new Error('DescribeNatGateways did not return exactly the gateway asked for');
  }
  const gateway = gateways[0];
  return gateway.State === 'pending' || gateway.State === 'available'
    ? gateway.NatGatewayId
    : undefined;
}

/**
 * go-to-k/cdkd#4606: the id `DescribeInstances` reports for `instanceId`
 * while the instance is `pending`, `running`, `stopping` or `stopped`;
 * `undefined` when EC2 reports it gone (`InvalidInstanceID.NotFound`, or a
 * `shutting-down` / `terminated` instance). Any other failure, and a
 * response naming anything but exactly that one instance, throws.
 */
export async function readInstanceIdIfLive(
  this: EC2Provider,
  instanceId: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] })
    );
  } catch (error) {
    if (isNamedError(error, INSTANCE_NOT_FOUND_NAMES)) return undefined;
    throw error;
  }
  const instances = (response.Reservations ?? []).flatMap((r) => r.Instances ?? []);
  if (instances.length !== 1 || typeof instances[0]?.InstanceId !== 'string') {
    throw new Error('DescribeInstances did not return exactly the instance asked for');
  }
  const instance = instances[0];
  const state = instance.State?.Name;
  if (state === 'shutting-down' || state === 'terminated') return undefined;
  if (state === 'pending' || state === 'running' || state === 'stopping' || state === 'stopped') {
    return instance.InstanceId;
  }
  throw new Error('DescribeInstances returned an instance in no known state');
}

/**
 * go-to-k/cdkd#4606: the id `DescribeVpcs` reports for `vpcId` while the
 * VPC is `pending` or `available`; `undefined` when EC2 reports it gone
 * (`InvalidVpcID.NotFound`, or a `deleting` VPC). Any other failure, a
 * response naming anything but exactly that one VPC, and an unknown state
 * throw.
 */
export async function readVpcIdIfLive(
  this: EC2Provider,
  vpcId: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
  } catch (error) {
    if (isNamedError(error, VPC_NOT_FOUND_NAMES)) return undefined;
    throw error;
  }
  const vpcs = response.Vpcs ?? [];
  if (vpcs.length !== 1 || typeof vpcs[0]?.VpcId !== 'string') {
    throw new Error('DescribeVpcs did not return exactly the VPC asked for');
  }
  const vpc = vpcs[0];
  if (vpc.State === 'deleting') return undefined;
  if (vpc.State === 'pending' || vpc.State === 'available') return vpc.VpcId;
  throw new Error('DescribeVpcs returned a VPC in no known state');
}

/**
 * go-to-k/cdkd#4606: the id `DescribeSubnets` reports for `subnetId` while
 * the subnet is `pending` or `available`; `undefined` when EC2 reports it
 * gone (`InvalidSubnetID.NotFound`) or in a state no deploy leaves a record
 * in (`failed`, `failed-insufficient-capacity`, `unavailable`). Any other
 * failure, a response naming anything but exactly that one subnet, and an
 * unknown state throw.
 */
export async function readSubnetIdIfLive(
  this: EC2Provider,
  subnetId: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.ec2Client.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }));
  } catch (error) {
    if (isNamedError(error, SUBNET_NOT_FOUND_NAMES)) return undefined;
    throw error;
  }
  const subnets = response.Subnets ?? [];
  if (subnets.length !== 1 || typeof subnets[0]?.SubnetId !== 'string') {
    throw new Error('DescribeSubnets did not return exactly the subnet asked for');
  }
  const subnet = subnets[0];
  const state = subnet.State;
  if (state === 'pending' || state === 'available') return subnet.SubnetId;
  if (state === 'failed' || state === 'failed-insufficient-capacity' || state === 'unavailable') {
    return undefined;
  }
  throw new Error('DescribeSubnets returned a subnet in no known state');
}

/**
 * go-to-k/cdkd#4606: the id `DescribeSecurityGroups` reports for `groupId`,
 * or `undefined` when EC2 reports the group gone (`InvalidGroup.NotFound`).
 * A security group has no state: listed is live. Any other failure, and a
 * response naming anything but exactly that one group, throws.
 */
export async function readSecurityGroupIdIfExists(
  this: EC2Provider,
  groupId: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.ec2Client.send(
      new DescribeSecurityGroupsCommand({ GroupIds: [groupId] })
    );
  } catch (error) {
    if (isNamedError(error, SECURITY_GROUP_NOT_FOUND_NAMES)) return undefined;
    throw error;
  }
  const groups = response.SecurityGroups ?? [];
  if (groups.length !== 1 || typeof groups[0]?.GroupId !== 'string') {
    throw new Error('DescribeSecurityGroups did not return exactly the group asked for');
  }
  return groups[0].GroupId;
}

/**
 * The allocation id `DescribeAddresses` reports for `allocationId`, or
 * `undefined` when EC2 reports the address gone
 * (`InvalidAllocationID.NotFound`). Any other failure, and a response
 * naming no address, throws.
 */
export async function readEipAllocationIdIfExists(
  this: EC2Provider,
  allocationId: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.ec2Client.send(
      new DescribeAddressesCommand({ AllocationIds: [allocationId] })
    );
  } catch (error) {
    if (isNamedError(error, EIP_ALLOCATION_NOT_FOUND_NAMES)) return undefined;
    throw error;
  }
  const addresses = response.Addresses ?? [];
  if (addresses.length !== 1 || typeof addresses[0]?.AllocationId !== 'string') {
    throw new Error('DescribeAddresses did not return exactly the address asked for');
  }
  return addresses[0].AllocationId;
}

/** The {@link EC2Provider} methods this module defines. */
export const dispatchMethods = {
  applyUpdate,
  getNatGatewayAttribute,
  readNatGatewayIdIfLive,
  readInstanceIdIfLive,
  readVpcIdIfLive,
  readSubnetIdIfLive,
  readSecurityGroupIdIfExists,
  readEipAllocationIdIfExists,
};
