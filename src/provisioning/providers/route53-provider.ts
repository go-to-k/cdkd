import {
  Route53Client,
  CreateHostedZoneCommand,
  DeleteHostedZoneCommand,
  GetHostedZoneCommand,
  ChangeResourceRecordSetsCommand,
  UpdateHostedZoneCommentCommand,
  ChangeTagsForResourceCommand,
  AssociateVPCWithHostedZoneCommand,
  DisassociateVPCFromHostedZoneCommand,
  CreateQueryLoggingConfigCommand,
  DeleteQueryLoggingConfigCommand,
  ListQueryLoggingConfigsCommand,
  ListHostedZonesByNameCommand,
  ListHostedZonesCommand,
  ListTagsForResourceCommand,
  type ResourceRecordSet,
  type RRType,
  type VPCRegion,
} from '@aws-sdk/client-route-53';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS Route 53 Provider
 *
 * Implements resource provisioning for Route 53 resources:
 * - AWS::Route53::HostedZone
 * - AWS::Route53::RecordSet
 *
 * WHY: Route 53 operations are synchronous - the CC API adds unnecessary polling
 * overhead for operations that complete immediately. This SDK provider eliminates
 * that polling and returns instantly.
 */
export class Route53Provider implements ResourceProvider {
  private route53Client?: Route53Client;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('Route53Provider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Route53::HostedZone',
      new Set(['Name', 'HostedZoneConfig', 'HostedZoneTags', 'VPCs', 'QueryLoggingConfig']),
    ],
    [
      'AWS::Route53::RecordSet',
      new Set([
        'HostedZoneId',
        'HostedZoneName',
        'Name',
        'Type',
        'TTL',
        'ResourceRecords',
        'AliasTarget',
        'SetIdentifier',
        'Weight',
        'Region',
        'Failover',
        'MultiValueAnswer',
        'HealthCheckId',
        'Comment',
        'GeoLocation',
      ]),
    ],
  ]);

  private getClient(): Route53Client {
    if (!this.route53Client) {
      this.route53Client = new Route53Client(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.route53Client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.createHostedZone(logicalId, resourceType, properties);
      case 'AWS::Route53::RecordSet':
        return this.createRecordSet(logicalId, resourceType, properties);
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
      case 'AWS::Route53::HostedZone':
        return this.updateHostedZone(logicalId, physicalId, resourceType, properties);
      case 'AWS::Route53::RecordSet':
        return this.updateRecordSet(logicalId, physicalId, resourceType, properties);
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
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.deleteHostedZone(logicalId, physicalId, resourceType, context);
      case 'AWS::Route53::RecordSet':
        return this.deleteRecordSet(logicalId, physicalId, resourceType, properties, context);
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
      case 'AWS::Route53::HostedZone':
        return this.getHostedZoneAttribute(physicalId, attributeName);
      default:
        return undefined;
    }
  }

  // ─── AWS::Route53::HostedZone ──────────────────────────────────────

  private async createHostedZone(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Route 53 hosted zone ${logicalId}`);

    const name = properties['Name'] as string;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for hosted zone ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const hostedZoneConfig = properties['HostedZoneConfig'] as
        | Record<string, unknown>
        | undefined;

      // VPCs property (for private hosted zones)
      const vpcs = properties['VPCs'] as Array<Record<string, unknown>> | undefined;
      // For CreateHostedZone, only one VPC can be specified; additional VPCs are associated after creation
      const firstVpc = vpcs && vpcs.length > 0 ? vpcs[0] : undefined;

      const response = await this.getClient().send(
        new CreateHostedZoneCommand({
          Name: name,
          CallerReference: `${logicalId}-${Date.now()}`,
          ...(hostedZoneConfig && hostedZoneConfig['Comment']
            ? {
                HostedZoneConfig: {
                  Comment: hostedZoneConfig['Comment'] as string,
                  // When VPCs are specified, this is a private hosted zone
                  ...(firstVpc ? { PrivateZone: true } : {}),
                },
              }
            : firstVpc
              ? { HostedZoneConfig: { PrivateZone: true } }
              : {}),
          ...(firstVpc
            ? {
                VPC: {
                  VPCId: firstVpc['VPCId'] as string,
                  VPCRegion: firstVpc['VPCRegion'] as VPCRegion | undefined,
                },
              }
            : {}),
        })
      );

      const hostedZone = response.HostedZone;
      if (!hostedZone?.Id) {
        throw new Error('CreateHostedZone did not return HostedZone.Id');
      }

      // Extract zone ID without /hostedzone/ prefix
      const zoneId = hostedZone.Id.replace('/hostedzone/', '');

      // Associate additional VPCs (index 1+) after creation
      if (vpcs && vpcs.length > 1) {
        for (let i = 1; i < vpcs.length; i++) {
          const additionalVpc = vpcs[i]!;
          this.logger.debug(
            `Associating additional VPC ${String(additionalVpc['VPCId'])} with hosted zone ${zoneId}`
          );
          await this.getClient().send(
            new AssociateVPCWithHostedZoneCommand({
              HostedZoneId: zoneId,
              VPC: {
                VPCId: additionalVpc['VPCId'] as string,
                VPCRegion: additionalVpc['VPCRegion'] as VPCRegion | undefined,
              },
            })
          );
        }
      }

      // Apply tags (HostedZoneTags)
      await this.applyHostedZoneTags(zoneId, properties, logicalId);

      // Configure query logging
      await this.applyQueryLoggingConfig(zoneId, properties, logicalId);

      // Collect name servers
      const nameServers = response.DelegationSet?.NameServers ?? [];

      this.logger.debug(`Successfully created hosted zone ${logicalId}: ${zoneId}`);

      return {
        physicalId: zoneId,
        attributes: {
          Id: zoneId,
          NameServers: nameServers.join(','),
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateHostedZone(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Route 53 hosted zone ${logicalId}: ${physicalId}`);

    try {
      const hostedZoneConfig = properties['HostedZoneConfig'] as
        | Record<string, unknown>
        | undefined;
      const comment = (hostedZoneConfig?.['Comment'] as string) ?? '';

      await this.getClient().send(
        new UpdateHostedZoneCommentCommand({
          Id: physicalId,
          Comment: comment,
        })
      );

      // Update tags (replace all tags)
      await this.applyHostedZoneTags(physicalId, properties, logicalId);

      // Update query logging config
      await this.applyQueryLoggingConfig(physicalId, properties, logicalId);

      // Note: VPC associations on update are complex (need to diff current vs desired).
      // For now, we handle VPCs that need to be added. Full diff requires GetHostedZone
      // to compare current VPCs, which we'll do here.
      await this.syncVPCAssociations(physicalId, properties, logicalId);

      // Retrieve name servers
      const getResponse = await this.getClient().send(new GetHostedZoneCommand({ Id: physicalId }));
      const nameServers = getResponse.DelegationSet?.NameServers ?? [];

      this.logger.debug(`Successfully updated hosted zone ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Id: physicalId,
          NameServers: nameServers.join(','),
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteHostedZone(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Route 53 hosted zone ${logicalId}: ${physicalId}`);

    try {
      // Delete query logging config before deleting hosted zone
      await this.deleteQueryLoggingConfigForZone(physicalId, logicalId);

      await this.getClient().send(new DeleteHostedZoneCommand({ Id: physicalId }));
      this.logger.debug(`Successfully deleted hosted zone ${logicalId}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchHostedZone') {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Hosted zone ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async getHostedZoneAttribute(
    physicalId: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'Id':
        return physicalId;
      case 'NameServers': {
        const response = await this.getClient().send(new GetHostedZoneCommand({ Id: physicalId }));
        return (response.DelegationSet?.NameServers ?? []).join(',');
      }
      default:
        return undefined;
    }
  }

  // ─── AWS::Route53::RecordSet ───────────────────────────────────────

  private async createRecordSet(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Route 53 record set ${logicalId}`);

    const hostedZoneId = await this.resolveHostedZoneId(properties, logicalId, resourceType);

    const recordName = properties['Name'] as string;
    const recordType = properties['Type'] as string;

    try {
      const resourceRecordSet = this.buildResourceRecordSet(properties);

      const comment = properties['Comment'] as string | undefined;

      await this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            ...(comment ? { Comment: comment } : {}),
            Changes: [
              {
                Action: 'CREATE',
                ResourceRecordSet: resourceRecordSet,
              },
            ],
          },
        })
      );

      const compositeId = `${hostedZoneId}|${recordName}|${recordType}`;
      this.logger.debug(`Successfully created record set ${logicalId}: ${compositeId}`);

      return {
        physicalId: compositeId,
        attributes: {},
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create record set ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateRecordSet(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Route 53 record set ${logicalId}: ${physicalId}`);

    const hostedZoneId = await this.resolveHostedZoneId(
      properties,
      logicalId,
      resourceType,
      physicalId
    );

    const recordName = properties['Name'] as string;
    const recordType = properties['Type'] as string;

    try {
      const resourceRecordSet = this.buildResourceRecordSet(properties);

      const comment = properties['Comment'] as string | undefined;

      await this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            ...(comment ? { Comment: comment } : {}),
            Changes: [
              {
                Action: 'UPSERT',
                ResourceRecordSet: resourceRecordSet,
              },
            ],
          },
        })
      );

      const compositeId = `${hostedZoneId}|${recordName}|${recordType}`;
      this.logger.debug(`Successfully updated record set ${logicalId}`);

      return {
        physicalId: compositeId,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update record set ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteRecordSet(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Route 53 record set ${logicalId}: ${physicalId}`);

    // Parse composite ID: hostedZoneId|name|type
    const parts = physicalId.split('|');
    if (parts.length !== 3) {
      throw new ProvisioningError(
        `Invalid record set physical ID format: ${physicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const [hostedZoneId] = parts;

    // We need the full record details for DELETE action
    if (!properties) {
      throw new ProvisioningError(
        `Properties required to delete record set ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      const resourceRecordSet = this.buildResourceRecordSet(properties);

      await this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            Changes: [
              {
                Action: 'DELETE',
                ResourceRecordSet: resourceRecordSet,
              },
            ],
          },
        })
      );

      this.logger.debug(`Successfully deleted record set ${logicalId}`);
    } catch (error) {
      // Treat "not found" errors as success for idempotency
      if (
        error instanceof Error &&
        (error.name === 'InvalidChangeBatch' || error.message.includes('it was not found'))
      ) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Record set ${physicalId} does not exist, skipping deletion`);
        return;
      }
      if (error instanceof Error && error.name === 'NoSuchHostedZone') {
        this.logger.debug(
          `Hosted zone for record set ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete record set ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Build a ResourceRecordSet object from CDK properties.
   *
   * Handles conversion of CDK-style ResourceRecords (array of strings)
   * to SDK-style ResourceRecords (array of {Value}).
   * Also handles routing policy properties: Weight, Region, Failover,
   * MultiValueAnswer, GeoLocation, SetIdentifier, and HealthCheckId.
   */
  private buildResourceRecordSet(properties: Record<string, unknown>): ResourceRecordSet {
    const name = properties['Name'] as string;
    const type = properties['Type'] as string;
    const ttl = properties['TTL'] as string | number | undefined;
    const resourceRecords = properties['ResourceRecords'] as unknown[] | undefined;
    const aliasTarget = properties['AliasTarget'] as Record<string, unknown> | undefined;

    const recordSet: ResourceRecordSet = {
      Name: name,
      Type: type as RRType,
    };

    if (aliasTarget) {
      recordSet.AliasTarget = {
        HostedZoneId: aliasTarget['HostedZoneId'] as string,
        DNSName: aliasTarget['DNSName'] as string,
        EvaluateTargetHealth: (aliasTarget['EvaluateTargetHealth'] as boolean) ?? false,
      };
    } else {
      // Standard record with TTL and ResourceRecords
      if (ttl !== undefined) {
        recordSet.TTL = Number(ttl);
      }

      if (resourceRecords) {
        // CDK provides ResourceRecords as array of strings,
        // SDK expects array of {Value: string}
        recordSet.ResourceRecords = resourceRecords.map((record) => {
          if (typeof record === 'string') {
            return { Value: record };
          }
          // Already in {Value: string} format
          return record as { Value: string };
        });
      }
    }

    // Routing policy properties
    const setIdentifier = properties['SetIdentifier'] as string | undefined;
    if (setIdentifier) {
      recordSet.SetIdentifier = setIdentifier;
    }

    const weight = properties['Weight'] as number | string | undefined;
    if (weight !== undefined) {
      recordSet.Weight = Number(weight);
    }

    const region = properties['Region'] as string | undefined;
    if (region) {
      recordSet.Region = region as ResourceRecordSet['Region'];
    }

    const failover = properties['Failover'] as string | undefined;
    if (failover) {
      recordSet.Failover = failover as ResourceRecordSet['Failover'];
    }

    const multiValueAnswer = properties['MultiValueAnswer'] as boolean | string | undefined;
    if (multiValueAnswer !== undefined) {
      recordSet.MultiValueAnswer =
        typeof multiValueAnswer === 'string'
          ? multiValueAnswer.toLowerCase() === 'true'
          : multiValueAnswer;
    }

    const healthCheckId = properties['HealthCheckId'] as string | undefined;
    if (healthCheckId) {
      recordSet.HealthCheckId = healthCheckId;
    }

    const geoLocation = properties['GeoLocation'] as Record<string, unknown> | undefined;
    if (geoLocation) {
      recordSet.GeoLocation = {
        ...(geoLocation['ContinentCode']
          ? { ContinentCode: geoLocation['ContinentCode'] as string }
          : {}),
        ...(geoLocation['CountryCode']
          ? { CountryCode: geoLocation['CountryCode'] as string }
          : {}),
        ...(geoLocation['SubdivisionCode']
          ? { SubdivisionCode: geoLocation['SubdivisionCode'] as string }
          : {}),
      };
    }

    return recordSet;
  }

  // ─── HostedZone Helpers ───────────────────────────────────────────

  /**
   * Apply tags to a hosted zone using ChangeTagsForResource.
   * CFn property: HostedZoneTags (array of {Key, Value}).
   */
  private async applyHostedZoneTags(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string
  ): Promise<void> {
    const tags = properties['HostedZoneTags'] as Array<{ Key: string; Value: string }> | undefined;
    if (!tags || !Array.isArray(tags) || tags.length === 0) return;

    try {
      await this.getClient().send(
        new ChangeTagsForResourceCommand({
          ResourceType: 'hostedzone',
          ResourceId: zoneId,
          AddTags: tags.map((t) => ({ Key: t.Key, Value: t.Value })),
        })
      );
      this.logger.debug(`Applied ${tags.length} tag(s) to hosted zone ${logicalId}`);
    } catch (error) {
      this.logger.warn(
        `Failed to apply tags to hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Apply QueryLoggingConfig to a hosted zone.
   * CFn property: QueryLoggingConfig ({ CloudWatchLogsLogGroupArn }).
   * Only one query logging config per hosted zone is allowed.
   */
  private async applyQueryLoggingConfig(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string
  ): Promise<void> {
    const queryLoggingConfig = properties['QueryLoggingConfig'] as
      | Record<string, unknown>
      | undefined;
    if (!queryLoggingConfig) return;

    const cloudWatchLogsLogGroupArn = queryLoggingConfig['CloudWatchLogsLogGroupArn'] as
      | string
      | undefined;
    if (!cloudWatchLogsLogGroupArn) return;

    try {
      // Delete existing query logging config first (only one allowed per zone)
      await this.deleteQueryLoggingConfigForZone(zoneId, logicalId);

      await this.getClient().send(
        new CreateQueryLoggingConfigCommand({
          HostedZoneId: zoneId,
          CloudWatchLogsLogGroupArn: cloudWatchLogsLogGroupArn,
        })
      );
      this.logger.debug(`Applied query logging config to hosted zone ${logicalId}`);
    } catch (error) {
      // QueryLoggingConfigAlreadyExists is not fatal if we tried to delete first
      if (error instanceof Error && error.name === 'QueryLoggingConfigAlreadyExists') {
        this.logger.debug(`Query logging config already exists for hosted zone ${logicalId}`);
        return;
      }
      this.logger.warn(
        `Failed to apply query logging config to hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Delete query logging config(s) for a hosted zone.
   */
  private async deleteQueryLoggingConfigForZone(zoneId: string, logicalId: string): Promise<void> {
    try {
      const listResponse = await this.getClient().send(
        new ListQueryLoggingConfigsCommand({ HostedZoneId: zoneId })
      );
      const configs = listResponse.QueryLoggingConfigs ?? [];
      for (const config of configs) {
        if (config.Id) {
          await this.getClient().send(new DeleteQueryLoggingConfigCommand({ Id: config.Id }));
          this.logger.debug(
            `Deleted query logging config ${config.Id} for hosted zone ${logicalId}`
          );
        }
      }
    } catch (error) {
      // NoSuchHostedZone or NoSuchQueryLoggingConfig are not fatal during cleanup
      if (
        error instanceof Error &&
        (error.name === 'NoSuchHostedZone' || error.name === 'NoSuchQueryLoggingConfig')
      ) {
        return;
      }
      this.logger.warn(
        `Failed to delete query logging config for hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Sync VPC associations for a private hosted zone during update.
   * Compares current VPC associations with desired ones and adds/removes as needed.
   */
  private async syncVPCAssociations(
    zoneId: string,
    properties: Record<string, unknown>,
    logicalId: string
  ): Promise<void> {
    const desiredVpcs = properties['VPCs'] as Array<Record<string, unknown>> | undefined;
    if (!desiredVpcs || desiredVpcs.length === 0) return;

    try {
      // Get current VPC associations
      const getResponse = await this.getClient().send(new GetHostedZoneCommand({ Id: zoneId }));
      const currentVpcs = getResponse.VPCs ?? [];

      const currentVpcIds = new Set(currentVpcs.map((v) => v.VPCId));
      const desiredVpcIds = new Set(desiredVpcs.map((v) => v['VPCId'] as string));

      // Associate new VPCs
      for (const vpc of desiredVpcs) {
        const vpcId = vpc['VPCId'] as string;
        if (!currentVpcIds.has(vpcId)) {
          this.logger.debug(`Associating VPC ${vpcId} with hosted zone ${zoneId}`);
          await this.getClient().send(
            new AssociateVPCWithHostedZoneCommand({
              HostedZoneId: zoneId,
              VPC: {
                VPCId: vpcId,
                VPCRegion: vpc['VPCRegion'] as VPCRegion | undefined,
              },
            })
          );
        }
      }

      // Disassociate removed VPCs (but never remove the last one)
      for (const vpc of currentVpcs) {
        if (vpc.VPCId && !desiredVpcIds.has(vpc.VPCId)) {
          // Don't disassociate if it would leave 0 VPCs
          if (currentVpcs.length <= 1) {
            this.logger.warn(
              `Cannot disassociate last VPC ${vpc.VPCId} from hosted zone ${logicalId}`
            );
            continue;
          }
          this.logger.debug(`Disassociating VPC ${vpc.VPCId} from hosted zone ${zoneId}`);
          await this.getClient().send(
            new DisassociateVPCFromHostedZoneCommand({
              HostedZoneId: zoneId,
              VPC: {
                VPCId: vpc.VPCId,
                VPCRegion: vpc.VPCRegion,
              },
            })
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Failed to sync VPC associations for hosted zone ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ─── RecordSet Helpers ────────────────────────────────────────────

  /**
   * Resolve HostedZoneId from properties.
   * If HostedZoneId is provided, use it directly.
   * If HostedZoneName is provided, resolve it to a HostedZoneId via ListHostedZonesByName.
   */
  private async resolveHostedZoneId(
    properties: Record<string, unknown>,
    logicalId: string,
    resourceType: string,
    physicalId?: string
  ): Promise<string> {
    const hostedZoneId = properties['HostedZoneId'] as string | undefined;
    if (hostedZoneId) return hostedZoneId;

    const hostedZoneName = properties['HostedZoneName'] as string | undefined;
    if (hostedZoneName) {
      try {
        const response = await this.getClient().send(
          new ListHostedZonesByNameCommand({
            DNSName: hostedZoneName,
            MaxItems: 1,
          })
        );
        const zones = response.HostedZones ?? [];
        // Match the zone name (Route53 returns names with trailing dot)
        const normalizedName = hostedZoneName.endsWith('.') ? hostedZoneName : `${hostedZoneName}.`;
        const matchedZone = zones.find((z) => z.Name === normalizedName);
        if (matchedZone?.Id) {
          return matchedZone.Id.replace('/hostedzone/', '');
        }
      } catch (error) {
        this.logger.warn(
          `Failed to resolve HostedZoneName "${hostedZoneName}" for ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new ProvisioningError(
      `Either HostedZoneId or HostedZoneName is required for record set ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  /**
   * Adopt an existing Route 53 resource into cdkd state.
   *
   * Supported types: `AWS::Route53::HostedZone` (full tag-based
   * lookup); `AWS::Route53::RecordSet` (override-only — RecordSets are
   * not taggable, and the composite child-of-zone identity makes auto
   * lookup impractical).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.importHostedZone(input);
      case 'AWS::Route53::RecordSet':
        // RecordSets aren't taggable; only honor explicit overrides.
        if (input.knownPhysicalId) {
          return { physicalId: input.knownPhysicalId, attributes: {} };
        }
        return null;
      default:
        return null;
    }
  }

  private async importHostedZone(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.getClient().send(new GetHostedZoneCommand({ Id: input.knownPhysicalId }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof Error && err.name === 'NoSuchHostedZone') return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListHostedZonesCommand({ ...(marker && { Marker: marker }) })
      );
      for (const zone of list.HostedZones ?? []) {
        if (!zone.Id) continue;
        const zoneId = zone.Id.replace('/hostedzone/', '');
        try {
          const tagsResp = await this.getClient().send(
            new ListTagsForResourceCommand({
              ResourceType: 'hostedzone',
              ResourceId: zoneId,
            })
          );
          if (matchesCdkPath(tagsResp.ResourceTagSet?.Tags, input.cdkPath)) {
            return { physicalId: zoneId, attributes: {} };
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'NoSuchHostedZone') continue;
          throw err;
        }
      }
      marker = list.IsTruncated ? list.NextMarker : undefined;
    } while (marker);
    return null;
  }
}
