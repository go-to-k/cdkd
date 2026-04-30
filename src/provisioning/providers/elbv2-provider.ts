import {
  ElasticLoadBalancingV2Client,
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancersCommand,
  CreateTargetGroupCommand,
  DeleteTargetGroupCommand,
  ModifyTargetGroupCommand,
  DescribeTargetGroupsCommand,
  CreateListenerCommand,
  DeleteListenerCommand,
  ModifyListenerCommand,
  type Tag,
  type Action,
  type Certificate,
  type LoadBalancerSchemeEnum,
  type LoadBalancerTypeEnum,
  type IpAddressType,
  type ProtocolEnum,
  type TargetTypeEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS ELBv2 Provider
 *
 * Implements resource provisioning for ELBv2 resources:
 * - AWS::ElasticLoadBalancingV2::LoadBalancer
 * - AWS::ElasticLoadBalancingV2::TargetGroup
 * - AWS::ElasticLoadBalancingV2::Listener
 *
 * WHY: ELBv2 Create* APIs are synchronous - the CC API adds unnecessary polling
 * overhead for operations that complete immediately. This SDK provider eliminates
 * that polling and returns instantly.
 */
export class ELBv2Provider implements ResourceProvider {
  private elbv2Client?: ElasticLoadBalancingV2Client;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ELBv2Provider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      new Set([
        'Name',
        'Subnets',
        'SubnetMappings',
        'SecurityGroups',
        'Scheme',
        'Type',
        'IpAddressType',
        'LoadBalancerAttributes',
        'Tags',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      new Set([
        'Protocol',
        'Port',
        'VpcId',
        'TargetType',
        'ProtocolVersion',
        'HealthCheckProtocol',
        'HealthCheckPort',
        'HealthCheckPath',
        'HealthCheckEnabled',
        'HealthCheckIntervalSeconds',
        'HealthCheckTimeoutSeconds',
        'HealthyThresholdCount',
        'UnhealthyThresholdCount',
        'Matcher',
        'Name',
        'Tags',
      ]),
    ],
    [
      'AWS::ElasticLoadBalancingV2::Listener',
      new Set([
        'LoadBalancerArn',
        'Certificates',
        'DefaultActions',
        'Port',
        'Protocol',
        'SslPolicy',
      ]),
    ],
  ]);

  private getClient(): ElasticLoadBalancingV2Client {
    if (!this.elbv2Client) {
      this.elbv2Client = new ElasticLoadBalancingV2Client(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.elbv2Client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.createLoadBalancer(logicalId, resourceType, properties);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.createTargetGroup(logicalId, resourceType, properties);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.createListener(logicalId, resourceType, properties);
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
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.updateLoadBalancer(logicalId, physicalId, resourceType, properties);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.updateTargetGroup(logicalId, physicalId, resourceType, properties);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.updateListener(logicalId, physicalId, resourceType, properties);
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return this.deleteLoadBalancer(logicalId, physicalId, resourceType, context);
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return this.deleteTargetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::ElasticLoadBalancingV2::Listener':
        return this.deleteListener(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::LoadBalancer ─────────────────────

  private async createLoadBalancer(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating LoadBalancer ${logicalId}`);

    try {
      const tags = this.extractTags(properties);

      const lbName = generateResourceName((properties['Name'] as string | undefined) || logicalId, {
        maxLength: 32,
      });

      const response = await this.getClient().send(
        new CreateLoadBalancerCommand({
          Name: lbName,
          Subnets: properties['Subnets'] as string[] | undefined,
          SubnetMappings: properties['SubnetMappings'] as
            | Array<{ SubnetId: string; AllocationId?: string; PrivateIPv4Address?: string }>
            | undefined,
          SecurityGroups: properties['SecurityGroups'] as string[] | undefined,
          Scheme: properties['Scheme'] as LoadBalancerSchemeEnum | undefined,
          Type: properties['Type'] as LoadBalancerTypeEnum | undefined,
          IpAddressType: properties['IpAddressType'] as IpAddressType | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const lb = response.LoadBalancers?.[0];
      if (!lb || !lb.LoadBalancerArn) {
        throw new Error('CreateLoadBalancer did not return LoadBalancer ARN');
      }

      this.logger.debug(`Successfully created LoadBalancer ${logicalId}: ${lb.LoadBalancerArn}`);

      // Apply LoadBalancerAttributes if specified
      const lbAttributes = properties['LoadBalancerAttributes'] as
        | Array<{ Key: string; Value: string }>
        | undefined;
      if (lbAttributes && lbAttributes.length > 0) {
        const { ModifyLoadBalancerAttributesCommand } =
          await import('@aws-sdk/client-elastic-load-balancing-v2');
        await this.getClient().send(
          new ModifyLoadBalancerAttributesCommand({
            LoadBalancerArn: lb.LoadBalancerArn,
            Attributes: lbAttributes.map((attr) => ({
              Key: attr.Key,
              Value: attr.Value,
            })),
          })
        );
        this.logger.debug(
          `Applied ${lbAttributes.length} LoadBalancer attributes for ${logicalId}`
        );
      }

      return {
        physicalId: lb.LoadBalancerArn,
        attributes: {
          DNSName: lb.DNSName,
          CanonicalHostedZoneID: lb.CanonicalHostedZoneId,
          LoadBalancerArn: lb.LoadBalancerArn,
          LoadBalancerFullName: lb.LoadBalancerArn?.split('/').slice(1).join('/'),
          LoadBalancerName: lb.LoadBalancerName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create LoadBalancer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateLoadBalancer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating LoadBalancer ${logicalId}: ${physicalId}`);

    try {
      // LoadBalancer updates are limited; Name is immutable (requires replacement).
      // For simplicity, describe the current state and return attributes.
      const describeResponse = await this.getClient().send(
        new DescribeLoadBalancersCommand({ LoadBalancerArns: [physicalId] })
      );

      const lb = describeResponse.LoadBalancers?.[0];

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          DNSName: lb?.DNSName,
          CanonicalHostedZoneID: lb?.CanonicalHostedZoneId,
          LoadBalancerArn: physicalId,
          LoadBalancerFullName: physicalId.split('/').slice(1).join('/'),
          LoadBalancerName: lb?.LoadBalancerName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update LoadBalancer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteLoadBalancer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting LoadBalancer ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteLoadBalancerCommand({ LoadBalancerArn: physicalId }));
      this.logger.debug(`Successfully deleted LoadBalancer ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`LoadBalancer ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete LoadBalancer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::TargetGroup ──────────────────────

  private async createTargetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating TargetGroup ${logicalId}`);

    try {
      const tags = this.extractTags(properties);
      const matcher = properties['Matcher'] as { HttpCode?: string; GrpcCode?: string } | undefined;

      const tgName = generateResourceName((properties['Name'] as string | undefined) || logicalId, {
        maxLength: 32,
      });

      const response = await this.getClient().send(
        new CreateTargetGroupCommand({
          Name: tgName,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          VpcId: properties['VpcId'] as string | undefined,
          TargetType: properties['TargetType'] as TargetTypeEnum | undefined,
          ProtocolVersion: properties['ProtocolVersion'] as string | undefined,
          HealthCheckProtocol: properties['HealthCheckProtocol'] as ProtocolEnum | undefined,
          HealthCheckPort: properties['HealthCheckPort'] as string | undefined,
          HealthCheckPath: properties['HealthCheckPath'] as string | undefined,
          HealthCheckEnabled:
            properties['HealthCheckEnabled'] !== undefined
              ? Boolean(properties['HealthCheckEnabled'])
              : undefined,
          HealthCheckIntervalSeconds:
            properties['HealthCheckIntervalSeconds'] !== undefined
              ? Number(properties['HealthCheckIntervalSeconds'])
              : undefined,
          HealthCheckTimeoutSeconds:
            properties['HealthCheckTimeoutSeconds'] !== undefined
              ? Number(properties['HealthCheckTimeoutSeconds'])
              : undefined,
          HealthyThresholdCount:
            properties['HealthyThresholdCount'] !== undefined
              ? Number(properties['HealthyThresholdCount'])
              : undefined,
          UnhealthyThresholdCount:
            properties['UnhealthyThresholdCount'] !== undefined
              ? Number(properties['UnhealthyThresholdCount'])
              : undefined,
          ...(matcher && { Matcher: matcher }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const tg = response.TargetGroups?.[0];
      if (!tg || !tg.TargetGroupArn) {
        throw new Error('CreateTargetGroup did not return TargetGroup ARN');
      }

      this.logger.debug(`Successfully created TargetGroup ${logicalId}: ${tg.TargetGroupArn}`);

      return {
        physicalId: tg.TargetGroupArn,
        attributes: {
          TargetGroupArn: tg.TargetGroupArn,
          TargetGroupFullName: tg.TargetGroupArn?.split(':').pop()?.replace('targetgroup/', ''),
          TargetGroupName: tg.TargetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create TargetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateTargetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating TargetGroup ${logicalId}: ${physicalId}`);

    try {
      const matcher = properties['Matcher'] as { HttpCode?: string; GrpcCode?: string } | undefined;

      await this.getClient().send(
        new ModifyTargetGroupCommand({
          TargetGroupArn: physicalId,
          HealthCheckProtocol: properties['HealthCheckProtocol'] as ProtocolEnum | undefined,
          HealthCheckPort: properties['HealthCheckPort'] as string | undefined,
          HealthCheckPath: properties['HealthCheckPath'] as string | undefined,
          HealthCheckEnabled:
            properties['HealthCheckEnabled'] !== undefined
              ? Boolean(properties['HealthCheckEnabled'])
              : undefined,
          HealthCheckIntervalSeconds:
            properties['HealthCheckIntervalSeconds'] !== undefined
              ? Number(properties['HealthCheckIntervalSeconds'])
              : undefined,
          HealthCheckTimeoutSeconds:
            properties['HealthCheckTimeoutSeconds'] !== undefined
              ? Number(properties['HealthCheckTimeoutSeconds'])
              : undefined,
          HealthyThresholdCount:
            properties['HealthyThresholdCount'] !== undefined
              ? Number(properties['HealthyThresholdCount'])
              : undefined,
          UnhealthyThresholdCount:
            properties['UnhealthyThresholdCount'] !== undefined
              ? Number(properties['UnhealthyThresholdCount'])
              : undefined,
          ...(matcher && { Matcher: matcher }),
        })
      );

      // Describe to get current attributes
      const describeResponse = await this.getClient().send(
        new DescribeTargetGroupsCommand({ TargetGroupArns: [physicalId] })
      );
      const tg = describeResponse.TargetGroups?.[0];

      this.logger.debug(`Successfully updated TargetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          TargetGroupArn: physicalId,
          TargetGroupFullName: physicalId.split(':').pop()?.replace('targetgroup/', ''),
          TargetGroupName: tg?.TargetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update TargetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteTargetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting TargetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteTargetGroupCommand({ TargetGroupArn: physicalId }));
      this.logger.debug(`Successfully deleted TargetGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`TargetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete TargetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::ElasticLoadBalancingV2::Listener ─────────────────────────

  private async createListener(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Listener ${logicalId}`);

    try {
      const tags = this.extractTags(properties);
      const defaultActions = this.convertActions(
        properties['DefaultActions'] as Array<Record<string, unknown>> | undefined
      );
      const certificates = this.convertCertificates(
        properties['Certificates'] as Array<Record<string, unknown>> | undefined
      );

      const response = await this.getClient().send(
        new CreateListenerCommand({
          LoadBalancerArn: properties['LoadBalancerArn'] as string,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          SslPolicy: properties['SslPolicy'] as string | undefined,
          DefaultActions: defaultActions ?? [],
          ...(certificates && { Certificates: certificates }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const listener = response.Listeners?.[0];
      if (!listener || !listener.ListenerArn) {
        throw new Error('CreateListener did not return Listener ARN');
      }

      this.logger.debug(`Successfully created Listener ${logicalId}: ${listener.ListenerArn}`);

      return {
        physicalId: listener.ListenerArn,
        attributes: {
          ListenerArn: listener.ListenerArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Listener ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateListener(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Listener ${logicalId}: ${physicalId}`);

    try {
      const defaultActions = this.convertActions(
        properties['DefaultActions'] as Array<Record<string, unknown>> | undefined
      );
      const certificates = this.convertCertificates(
        properties['Certificates'] as Array<Record<string, unknown>> | undefined
      );

      await this.getClient().send(
        new ModifyListenerCommand({
          ListenerArn: physicalId,
          Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
          Protocol: properties['Protocol'] as ProtocolEnum | undefined,
          SslPolicy: properties['SslPolicy'] as string | undefined,
          ...(defaultActions && { DefaultActions: defaultActions }),
          ...(certificates && { Certificates: certificates }),
        })
      );

      this.logger.debug(`Successfully updated Listener ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          ListenerArn: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Listener ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteListener(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Listener ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteListenerCommand({ ListenerArn: physicalId }));
      this.logger.debug(`Successfully deleted Listener ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Listener ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Listener ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Extract Tags from CDK properties
   * CDK format: Array<{Key: string, Value: string}> — same as ELBv2 API format
   */
  private extractTags(properties: Record<string, unknown>): Tag[] {
    if (!properties['Tags']) return [];
    return properties['Tags'] as Tag[];
  }

  /**
   * Convert CDK DefaultActions to ELBv2 API Action format
   * CDK uses PascalCase property names matching the ELBv2 API, so pass through.
   */
  private convertActions(
    actions: Array<Record<string, unknown>> | undefined
  ): Action[] | undefined {
    if (!actions || actions.length === 0) return undefined;
    return actions as unknown as Action[];
  }

  /**
   * Convert CDK Certificates to ELBv2 API Certificate format
   */
  private convertCertificates(
    certificates: Array<Record<string, unknown>> | undefined
  ): Certificate[] | undefined {
    if (!certificates || certificates.length === 0) return undefined;
    return certificates as unknown as Certificate[];
  }

  /**
   * Check if an error indicates the resource was not found
   */
  private isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = (error.message || '').toLowerCase();
    const name = (error as { name?: string }).name ?? '';
    return (
      message.includes('not found') ||
      message.includes('does not exist') ||
      name === 'LoadBalancerNotFoundException' ||
      name === 'TargetGroupNotFoundException' ||
      name === 'ListenerNotFoundException'
    );
  }
}
