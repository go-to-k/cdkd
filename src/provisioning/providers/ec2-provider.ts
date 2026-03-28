import {
  EC2Client,
  CreateVpcCommand,
  DeleteVpcCommand,
  ModifyVpcAttributeCommand,
  DescribeVpcsCommand,
  CreateSubnetCommand,
  DeleteSubnetCommand,
  CreateInternetGatewayCommand,
  DeleteInternetGatewayCommand,
  AttachInternetGatewayCommand,
  DetachInternetGatewayCommand,
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
  CreateTagsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceTerminated,
  CreateNetworkAclCommand,
  DeleteNetworkAclCommand,
  CreateNetworkAclEntryCommand,
  DeleteNetworkAclEntryCommand,
  ReplaceNetworkAclAssociationCommand,
  DescribeNetworkAclsCommand,
  type Tenancy,
  type _InstanceType,
  type VolumeType,
  type BlockDeviceMapping,
} from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

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

  constructor() {
    const awsClients = getAwsClients();
    this.ec2Client = awsClients.ec2;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return this.createVpc(logicalId, resourceType, properties);
      case 'AWS::EC2::Subnet':
        return this.createSubnet(logicalId, resourceType, properties);
      case 'AWS::EC2::InternetGateway':
        return this.createInternetGateway(logicalId, resourceType, properties);
      case 'AWS::EC2::VPCGatewayAttachment':
        return this.createVpcGatewayAttachment(logicalId, resourceType, properties);
      case 'AWS::EC2::RouteTable':
        return this.createRouteTable(logicalId, resourceType, properties);
      case 'AWS::EC2::Route':
        return this.createRoute(logicalId, resourceType, properties);
      case 'AWS::EC2::SubnetRouteTableAssociation':
        return this.createSubnetRouteTableAssociation(logicalId, resourceType, properties);
      case 'AWS::EC2::SecurityGroup':
        return this.createSecurityGroup(logicalId, resourceType, properties);
      case 'AWS::EC2::SecurityGroupIngress':
        return this.createSecurityGroupIngress(logicalId, resourceType, properties);
      case 'AWS::EC2::Instance':
        return this.createInstance(logicalId, resourceType, properties);
      case 'AWS::EC2::NetworkAcl':
        return this.createNetworkAcl(logicalId, resourceType, properties);
      case 'AWS::EC2::NetworkAclEntry':
        return this.createNetworkAclEntry(logicalId, resourceType, properties);
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
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return this.updateVpc(logicalId, physicalId, resourceType, properties);
      case 'AWS::EC2::Subnet':
        return this.updateSubnet(logicalId, physicalId);
      case 'AWS::EC2::InternetGateway':
        return this.updateInternetGateway(logicalId, physicalId);
      case 'AWS::EC2::VPCGatewayAttachment':
        return this.updateVpcGatewayAttachment(logicalId, physicalId);
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
        return this.updateSecurityGroup(logicalId, physicalId, resourceType, properties);
      case 'AWS::EC2::SecurityGroupIngress':
        return this.updateSecurityGroupIngress(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::EC2::Instance':
        return this.updateInstance(logicalId, physicalId, resourceType, properties);
      case 'AWS::EC2::NetworkAcl':
      case 'AWS::EC2::NetworkAclEntry':
      case 'AWS::EC2::SubnetNetworkAclAssociation':
        return { physicalId, wasReplaced: false };
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
    properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::EC2::VPC':
        return this.deleteVpc(logicalId, physicalId, resourceType);
      case 'AWS::EC2::Subnet':
        return this.deleteSubnet(logicalId, physicalId, resourceType);
      case 'AWS::EC2::InternetGateway':
        return this.deleteInternetGateway(logicalId, physicalId, resourceType);
      case 'AWS::EC2::VPCGatewayAttachment':
        return this.deleteVpcGatewayAttachment(logicalId, physicalId, resourceType);
      case 'AWS::EC2::RouteTable':
        return this.deleteRouteTable(logicalId, physicalId, resourceType);
      case 'AWS::EC2::Route':
        return this.deleteRoute(logicalId, physicalId, resourceType);
      case 'AWS::EC2::SubnetRouteTableAssociation':
        return this.deleteSubnetRouteTableAssociation(logicalId, physicalId, resourceType);
      case 'AWS::EC2::SecurityGroup':
        return this.deleteSecurityGroup(logicalId, physicalId, resourceType);
      case 'AWS::EC2::SecurityGroupIngress':
        return this.deleteSecurityGroupIngress(logicalId, physicalId, resourceType, properties);
      case 'AWS::EC2::Instance':
        return this.deleteInstance(logicalId, physicalId, resourceType);
      case 'AWS::EC2::NetworkAcl':
        return this.deleteNetworkAcl(logicalId, physicalId, resourceType);
      case 'AWS::EC2::NetworkAclEntry':
        return this.deleteNetworkAclEntry(logicalId, physicalId, resourceType);
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

      if (properties['EnableDnsSupport'] === false || properties['EnableDnsSupport'] === 'false') {
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
      await this.ec2Client.send(
        new DescribeVpcsCommand({ VpcIds: [vpcId] })
      );

      // Fetch default security group for the VPC
      let defaultSgId = '';
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
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating VPC ${logicalId}: ${physicalId}`);

    try {
      // Update DNS settings
      if (properties['EnableDnsHostnames'] !== undefined) {
        const value =
          properties['EnableDnsHostnames'] === true || properties['EnableDnsHostnames'] === 'true';
        await this.ec2Client.send(
          new ModifyVpcAttributeCommand({
            VpcId: physicalId,
            EnableDnsHostnames: { Value: value },
          })
        );
      }

      if (properties['EnableDnsSupport'] !== undefined) {
        const value =
          properties['EnableDnsSupport'] === true || properties['EnableDnsSupport'] === 'true';
        await this.ec2Client.send(
          new ModifyVpcAttributeCommand({
            VpcId: physicalId,
            EnableDnsSupport: { Value: value },
          })
        );
      }

      // Update tags
      await this.applyTags(physicalId, properties, logicalId);

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
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting VPC ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DeleteVpcCommand({ VpcId: physicalId }));
      this.logger.debug(`Successfully deleted VPC ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(`VPC ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete VPC ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async getVpcAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    if (attributeName === 'VpcId') return physicalId;

    try {
      const response = await this.ec2Client.send(new DescribeVpcsCommand({ VpcIds: [physicalId] }));
      const vpc = response.Vpcs?.[0];
      if (!vpc) return undefined;

      switch (attributeName) {
        case 'CidrBlock':
          return vpc.CidrBlock;
        case 'DefaultNetworkAcl':
          return vpc.DhcpOptionsId; // Placeholder - need separate API call for NACL
        case 'DefaultSecurityGroup':
          return undefined; // Requires DescribeSecurityGroups filter
        default:
          return undefined;
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

      // Apply tags
      await this.applyTags(subnetId, properties, logicalId);

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

  private updateSubnet(logicalId: string, physicalId: string): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Subnet ${logicalId}: ${physicalId} (no-op, immutable properties)`);
    return Promise.resolve({ physicalId, wasReplaced: false });
  }

  private async deleteSubnet(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting Subnet ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DeleteSubnetCommand({ SubnetId: physicalId }));
      this.logger.debug(`Successfully deleted Subnet ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(`Subnet ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Subnet ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
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
    this.logger.debug(`Updating InternetGateway ${logicalId}: ${physicalId} (no-op)`);
    return Promise.resolve({ physicalId, wasReplaced: false });
  }

  private async deleteInternetGateway(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting InternetGateway ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(
        new DeleteInternetGatewayCommand({ InternetGatewayId: physicalId })
      );
      this.logger.debug(`Successfully deleted InternetGateway ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
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

  // ─── AWS::EC2::VPCGatewayAttachment ───────────────────────────────

  private async createVpcGatewayAttachment(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
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

    try {
      await this.ec2Client.send(
        new AttachInternetGatewayCommand({
          VpcId: vpcId,
          InternetGatewayId: internetGatewayId,
        })
      );

      const physicalId = `${internetGatewayId}|${vpcId}`;
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
    this.logger.debug(`Updating VPCGatewayAttachment ${logicalId}: ${physicalId} (no-op)`);
    return Promise.resolve({ physicalId, wasReplaced: false });
  }

  private async deleteVpcGatewayAttachment(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting VPCGatewayAttachment ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new ProvisioningError(
        `Invalid physicalId format for VPCGatewayAttachment ${logicalId}: expected "IGW|VpcId", got "${physicalId}"`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const [internetGatewayId, vpcId] = parts;

    try {
      await this.ec2Client.send(
        new DetachInternetGatewayCommand({
          InternetGatewayId: internetGatewayId,
          VpcId: vpcId,
        })
      );
      this.logger.debug(`Successfully deleted VPCGatewayAttachment ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
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
    this.logger.debug(`Updating RouteTable ${logicalId}: ${physicalId} (no-op)`);
    return Promise.resolve({ physicalId, wasReplaced: false });
  }

  private async deleteRouteTable(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting RouteTable ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DeleteRouteTableCommand({ RouteTableId: physicalId }));
      this.logger.debug(`Successfully deleted RouteTable ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
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
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Route ${logicalId}`);

    const routeTableId = properties['RouteTableId'] as string;
    const destinationCidrBlock = properties['DestinationCidrBlock'] as string;

    if (!routeTableId || !destinationCidrBlock) {
      throw new ProvisioningError(
        `RouteTableId and DestinationCidrBlock are required for Route ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.ec2Client.send(
        new CreateRouteCommand({
          RouteTableId: routeTableId,
          DestinationCidrBlock: destinationCidrBlock,
          GatewayId: (properties['GatewayId'] as string) ?? undefined,
          NatGatewayId: (properties['NatGatewayId'] as string) ?? undefined,
          InstanceId: (properties['InstanceId'] as string) ?? undefined,
          NetworkInterfaceId: (properties['NetworkInterfaceId'] as string) ?? undefined,
          VpcPeeringConnectionId: (properties['VpcPeeringConnectionId'] as string) ?? undefined,
        })
      );

      const physicalId = `${routeTableId}|${destinationCidrBlock}`;
      this.logger.debug(`Successfully created Route ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
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
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Route ${logicalId}: ${physicalId}`);

    // Route updates require replacement (DestinationCidrBlock and RouteTableId are immutable)
    // For target changes, we delete and recreate
    try {
      await this.deleteRoute(logicalId, physicalId, resourceType);
      const createResult = await this.createRoute(logicalId, resourceType, properties);
      return {
        physicalId: createResult.physicalId,
        wasReplaced: true,
        ...(createResult.attributes && { attributes: createResult.attributes }),
      };
    } catch (error) {
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
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting Route ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new ProvisioningError(
        `Invalid physicalId format for Route ${logicalId}: expected "RouteTableId|DestinationCidrBlock", got "${physicalId}"`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const [routeTableId, destinationCidrBlock] = parts;

    try {
      await this.ec2Client.send(
        new DeleteRouteCommand({
          RouteTableId: routeTableId,
          DestinationCidrBlock: destinationCidrBlock,
        })
      );
      this.logger.debug(`Successfully deleted Route ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
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
    this.logger.debug(
      `Updating SubnetRouteTableAssociation ${logicalId}: ${physicalId} (no-op, requires replacement)`
    );
    return Promise.resolve({ physicalId, wasReplaced: false });
  }

  private async deleteSubnetRouteTableAssociation(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting SubnetRouteTableAssociation ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DisassociateRouteTableCommand({ AssociationId: physicalId }));
      this.logger.debug(`Successfully deleted SubnetRouteTableAssociation ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
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

      // Apply tags
      await this.applyTags(groupId, properties, logicalId);

      // Add ingress rules if specified inline
      const ingressRules = properties['SecurityGroupIngress'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (ingressRules && Array.isArray(ingressRules)) {
        for (const rule of ingressRules) {
          await this.ec2Client.send(
            new AuthorizeSecurityGroupIngressCommand({
              GroupId: groupId,
              IpPermissions: [this.buildIpPermission(rule)],
            })
          );
        }
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

  private async updateSecurityGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SecurityGroup ${logicalId}: ${physicalId}`);

    try {
      // Update tags
      await this.applyTags(physicalId, properties, logicalId);

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
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting SecurityGroup ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DeleteSecurityGroupCommand({ GroupId: physicalId }));
      this.logger.debug(`Successfully deleted SecurityGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(`SecurityGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SecurityGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
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

  private async createSecurityGroupIngress(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
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

    const ipProtocol = (properties['IpProtocol'] as string) ?? '-1';
    const fromPort = properties['FromPort'] as number | undefined;
    const toPort = properties['ToPort'] as number | undefined;

    try {
      await this.ec2Client.send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId: groupId,
          IpPermissions: [this.buildIpPermission(properties)],
        })
      );

      const physicalId = `${groupId}|${ipProtocol}|${fromPort ?? '-1'}|${toPort ?? '-1'}`;
      this.logger.debug(`Successfully created SecurityGroupIngress ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      // Treat "already exists" as success (idempotent, like CloudFormation)
      if (error instanceof Error && error.message.includes('already exists')) {
        const physicalId = `${groupId}|${ipProtocol}|${fromPort ?? '-1'}|${toPort ?? '-1'}`;
        this.logger.debug(`SecurityGroupIngress ${logicalId} already exists, treating as success`);
        return { physicalId, attributes: {} };
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

  private async updateSecurityGroupIngress(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SecurityGroupIngress ${logicalId}: ${physicalId}`);

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
        properties
      );
      return {
        physicalId: createResult.physicalId,
        wasReplaced: true,
        ...(createResult.attributes && { attributes: createResult.attributes }),
      };
    } catch (error) {
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
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting SecurityGroupIngress ${logicalId}: ${physicalId}`);

    // Parse composite physicalId: GroupId|Protocol|FromPort|ToPort
    const parts = physicalId.split('|');
    if (parts.length !== 4) {
      throw new ProvisioningError(
        `Invalid physicalId format for SecurityGroupIngress ${logicalId}: expected "GroupId|Protocol|FromPort|ToPort", got "${physicalId}"`,
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
    properties: Record<string, unknown>
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

    const instanceType = (properties['InstanceType'] as string) ?? 't3.micro';

    try {
      const securityGroupIds = properties['SecurityGroupIds'] as string[] | undefined;
      const securityGroups = properties['SecurityGroups'] as string[] | undefined;
      const iamInstanceProfile = properties['IamInstanceProfile'] as
        | Record<string, unknown>
        | undefined;

      const response = await this.ec2Client.send(
        new RunInstancesCommand({
          ImageId: imageId,
          InstanceType: instanceType as _InstanceType,
          KeyName: (properties['KeyName'] as string) ?? undefined,
          SecurityGroupIds: securityGroupIds ?? undefined,
          SecurityGroups: securityGroups ?? undefined,
          SubnetId: (properties['SubnetId'] as string) ?? undefined,
          UserData: (properties['UserData'] as string) ?? undefined,
          MinCount: 1,
          MaxCount: 1,
          IamInstanceProfile: iamInstanceProfile
            ? {
                Arn: iamInstanceProfile['Arn'] as string | undefined,
                Name: iamInstanceProfile['Name'] as string | undefined,
              }
            : undefined,
          BlockDeviceMappings: this.buildBlockDeviceMappings(properties),
        })
      );

      const instance = response.Instances?.[0];
      if (!instance?.InstanceId) {
        throw new Error('No instance ID returned from RunInstances');
      }

      const instanceId = instance.InstanceId;

      // Apply tags
      await this.applyTags(instanceId, properties, logicalId);

      // Wait for instance to reach running state
      this.logger.debug(`Waiting for instance ${instanceId} to be running...`);
      await waitUntilInstanceRunning(
        { client: this.ec2Client, maxWaitTime: 300 },
        { InstanceIds: [instanceId] }
      );

      // Describe instance to get attributes after running
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

  private async updateInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // Most EC2 Instance property changes require replacement.
    // Immutable properties (ImageId, SubnetId, KeyName) are handled by
    // the deployment engine's replacement detection.
    // For simplicity, tags-only updates are supported here.
    this.logger.debug(`Updating EC2 Instance ${logicalId}: ${physicalId}`);

    try {
      await this.applyTags(physicalId, _properties, logicalId);

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

  private async deleteInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Terminating EC2 Instance ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [physicalId] }));
      this.logger.debug(`Terminate requested for EC2 Instance ${logicalId}, waiting...`);

      // Wait for instance to reach terminated state so ENIs are released
      await waitUntilInstanceTerminated(
        { client: this.ec2Client, maxWaitTime: 300 },
        { InstanceIds: [physicalId] }
      );

      this.logger.debug(`EC2 Instance ${logicalId} terminated: ${physicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(
          `EC2 Instance ${physicalId} already terminated (not found), treating as success`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to terminate EC2 Instance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
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

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Build an IpPermission object from CloudFormation-style properties
   */
  private buildIpPermission(properties: Record<string, unknown>): {
    IpProtocol: string;
    FromPort?: number;
    ToPort?: number;
    IpRanges?: Array<{ CidrIp: string; Description?: string }>;
    UserIdGroupPairs?: Array<{ GroupId: string; Description?: string }>;
  } {
    const ipProtocol = (properties['IpProtocol'] as string) ?? '-1';
    const fromPort = properties['FromPort'] as number | undefined;
    const toPort = properties['ToPort'] as number | undefined;

    const permission: {
      IpProtocol: string;
      FromPort?: number;
      ToPort?: number;
      IpRanges?: Array<{ CidrIp: string; Description?: string }>;
      UserIdGroupPairs?: Array<{ GroupId: string; Description?: string }>;
    } = { IpProtocol: ipProtocol };

    if (fromPort !== undefined) permission.FromPort = fromPort;
    if (toPort !== undefined) permission.ToPort = toPort;

    const cidrIp = properties['CidrIp'] as string | undefined;
    const description = properties['Description'] as string | undefined;
    if (cidrIp) {
      const ipRange: { CidrIp: string; Description?: string } = { CidrIp: cidrIp };
      if (description) ipRange.Description = description;
      permission.IpRanges = [ipRange];
    }

    const sourceSecurityGroupId = properties['SourceSecurityGroupId'] as string | undefined;
    if (sourceSecurityGroupId) {
      const groupPair: { GroupId: string; Description?: string } = {
        GroupId: sourceSecurityGroupId,
      };
      if (description) groupPair.Description = description;
      permission.UserIdGroupPairs = [groupPair];
    }

    return permission;
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
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting NetworkAcl ${logicalId}: ${physicalId}`);

    try {
      await this.ec2Client.send(new DeleteNetworkAclCommand({ NetworkAclId: physicalId }));
      this.logger.debug(`Successfully deleted NetworkAcl ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
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
    properties: Record<string, unknown>
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

    try {
      const cidrBlock = properties['CidrBlock'] as string | undefined;
      const ipv6CidrBlock = properties['Ipv6CidrBlock'] as string | undefined;
      const portRange = properties['PortRange'] as Record<string, unknown> | undefined;
      const icmpTypeCode = properties['IcmpTypeCode'] as Record<string, unknown> | undefined;

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

      const physicalId = `${networkAclId}|${ruleNumber}|${egress}`;
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
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting NetworkAclEntry ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length < 3) {
      this.logger.warn(`Invalid NetworkAclEntry physical ID format: ${physicalId}, skipping`);
      return;
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
   * Apply tags to an EC2 resource
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
      name === 'InvalidNetworkAclEntry.NotFound'
    );
  }
}
