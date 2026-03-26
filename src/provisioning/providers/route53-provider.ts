import {
  Route53Client,
  CreateHostedZoneCommand,
  DeleteHostedZoneCommand,
  GetHostedZoneCommand,
  ChangeResourceRecordSetsCommand,
  UpdateHostedZoneCommentCommand,
} from '@aws-sdk/client-route-53';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
  private logger = getLogger().child('Route53Provider');

  private getClient(): Route53Client {
    if (!this.route53Client) {
      this.route53Client = new Route53Client({});
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
    properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::Route53::HostedZone':
        return this.deleteHostedZone(logicalId, physicalId, resourceType);
      case 'AWS::Route53::RecordSet':
        return this.deleteRecordSet(logicalId, physicalId, resourceType, properties);
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

      const response = await this.getClient().send(
        new CreateHostedZoneCommand({
          Name: name,
          CallerReference: `${logicalId}-${Date.now()}`,
          ...(hostedZoneConfig?.Comment && {
            HostedZoneConfig: {
              Comment: hostedZoneConfig.Comment as string,
            },
          }),
        })
      );

      const hostedZone = response.HostedZone;
      if (!hostedZone?.Id) {
        throw new Error('CreateHostedZone did not return HostedZone.Id');
      }

      // Extract zone ID without /hostedzone/ prefix
      const zoneId = hostedZone.Id.replace('/hostedzone/', '');

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
      const comment = (hostedZoneConfig?.Comment as string) ?? '';

      await this.getClient().send(
        new UpdateHostedZoneCommentCommand({
          Id: physicalId,
          Comment: comment,
        })
      );

      // Retrieve name servers
      const getResponse = await this.getClient().send(
        new GetHostedZoneCommand({ Id: physicalId })
      );
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
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting Route 53 hosted zone ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteHostedZoneCommand({ Id: physicalId })
      );
      this.logger.debug(`Successfully deleted hosted zone ${logicalId}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchHostedZone') {
        this.logger.debug(
          `Hosted zone ${physicalId} does not exist, skipping deletion`
        );
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
        const response = await this.getClient().send(
          new GetHostedZoneCommand({ Id: physicalId })
        );
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

    const hostedZoneId = properties['HostedZoneId'] as string | undefined;
    if (!hostedZoneId) {
      throw new ProvisioningError(
        `HostedZoneId is required for record set ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const recordName = properties['Name'] as string;
    const recordType = properties['Type'] as string;

    try {
      const resourceRecordSet = this.buildResourceRecordSet(properties);

      await this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
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
      this.logger.debug(
        `Successfully created record set ${logicalId}: ${compositeId}`
      );

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

    const hostedZoneId = properties['HostedZoneId'] as string | undefined;
    if (!hostedZoneId) {
      throw new ProvisioningError(
        `HostedZoneId is required for record set ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const recordName = properties['Name'] as string;
    const recordType = properties['Type'] as string;

    try {
      const resourceRecordSet = this.buildResourceRecordSet(properties);

      await this.getClient().send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
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
    properties?: Record<string, unknown>
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
        (error.name === 'InvalidChangeBatch' ||
          error.message.includes('it was not found'))
      ) {
        this.logger.debug(
          `Record set ${physicalId} does not exist, skipping deletion`
        );
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
   */
  private buildResourceRecordSet(
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    const name = properties['Name'] as string;
    const type = properties['Type'] as string;
    const ttl = properties['TTL'] as string | number | undefined;
    const resourceRecords = properties['ResourceRecords'] as
      | unknown[]
      | undefined;
    const aliasTarget = properties['AliasTarget'] as
      | Record<string, unknown>
      | undefined;

    const recordSet: Record<string, unknown> = {
      Name: name,
      Type: type,
    };

    if (aliasTarget) {
      recordSet['AliasTarget'] = {
        HostedZoneId: aliasTarget['HostedZoneId'] as string,
        DNSName: aliasTarget['DNSName'] as string,
        EvaluateTargetHealth: aliasTarget['EvaluateTargetHealth'] ?? false,
      };
    } else {
      // Standard record with TTL and ResourceRecords
      if (ttl !== undefined) {
        recordSet['TTL'] = Number(ttl);
      }

      if (resourceRecords) {
        // CDK provides ResourceRecords as array of strings,
        // SDK expects array of {Value: string}
        recordSet['ResourceRecords'] = (resourceRecords as unknown[]).map(
          (record) => {
            if (typeof record === 'string') {
              return { Value: record };
            }
            // Already in {Value: string} format
            return record;
          }
        );
      }
    }

    return recordSet;
  }
}
