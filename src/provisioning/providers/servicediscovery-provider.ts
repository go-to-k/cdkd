import {
  ServiceDiscoveryClient,
  CreatePrivateDnsNamespaceCommand,
  DeleteNamespaceCommand,
  CreateServiceCommand,
  DeleteServiceCommand,
  GetOperationCommand,
  NamespaceNotFound,
  ServiceNotFound,
  type DnsConfig,
  type HealthCheckCustomConfig,
} from '@aws-sdk/client-servicediscovery';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS Service Discovery Provider
 *
 * Implements resource provisioning for:
 * - AWS::ServiceDiscovery::PrivateDnsNamespace
 * - AWS::ServiceDiscovery::Service
 *
 * WHY: CreatePrivateDnsNamespace is async (returns OperationId) but we handle
 * the polling ourselves, avoiding the CC API's generic polling overhead and
 * giving us direct control over the operation lifecycle.
 */
export class ServiceDiscoveryProvider implements ResourceProvider {
  private client?: ServiceDiscoveryClient;
  private stsClient?: STSClient;
  private logger = getLogger().child('ServiceDiscoveryProvider');

  private getClient(): ServiceDiscoveryClient {
    if (!this.client) {
      this.client = new ServiceDiscoveryClient({});
    }
    return this.client;
  }

  private getStsClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient({});
    }
    return this.stsClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
        return this.createNamespace(logicalId, resourceType, properties);
      case 'AWS::ServiceDiscovery::Service':
        return this.createService(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
        return this.updateNamespace(logicalId, physicalId);
      case 'AWS::ServiceDiscovery::Service':
        return this.updateService(logicalId, physicalId);
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
    _properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
        return this.deleteNamespace(logicalId, physicalId, resourceType);
      case 'AWS::ServiceDiscovery::Service':
        return this.deleteService(logicalId, physicalId, resourceType);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::ServiceDiscovery::PrivateDnsNamespace ───────────────────

  private async createNamespace(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating private DNS namespace ${logicalId}`);
    const client = this.getClient();

    const name = properties['Name'] as string;
    const vpc = properties['Vpc'] as string;
    const description = properties['Description'] as string | undefined;

    if (!name) {
      throw new ProvisioningError(
        `Name is required for PrivateDnsNamespace ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!vpc) {
      throw new ProvisioningError(
        `Vpc is required for PrivateDnsNamespace ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await client.send(
        new CreatePrivateDnsNamespaceCommand({
          Name: name,
          Vpc: vpc,
          ...(description && { Description: description }),
        })
      );

      const operationId = response.OperationId;
      if (!operationId) {
        throw new Error('CreatePrivateDnsNamespace did not return OperationId');
      }

      // Poll for operation completion
      const namespaceId = await this.pollOperation(operationId, logicalId, resourceType);

      // Build ARN
      const arn = await this.buildNamespaceArn(namespaceId);

      this.logger.debug(`Successfully created private DNS namespace ${logicalId}: ${namespaceId}`);

      return {
        physicalId: namespaceId,
        attributes: {
          Id: namespaceId,
          Arn: arn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create private DNS namespace ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async updateNamespace(
    logicalId: string,
    physicalId: string
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating private DNS namespace ${logicalId}: ${physicalId} (no-op)`);
    // Name and Vpc are immutable; updates require replacement (handled by deployment layer)
    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Id: physicalId,
      },
    };
  }

  private async deleteNamespace(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting private DNS namespace ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      const response = await client.send(new DeleteNamespaceCommand({ Id: physicalId }));

      const operationId = response.OperationId;
      if (operationId) {
        await this.pollOperation(operationId, logicalId, resourceType);
      }

      this.logger.debug(`Successfully deleted private DNS namespace ${logicalId}`);
    } catch (error) {
      if (error instanceof NamespaceNotFound) {
        this.logger.debug(`Namespace ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete private DNS namespace ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::ServiceDiscovery::Service ───────────────────────────────

  private async createService(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating service discovery service ${logicalId}`);
    const client = this.getClient();

    const name = properties['Name'] as string;
    const namespaceId = properties['NamespaceId'] as string | undefined;
    const description = properties['Description'] as string | undefined;
    const dnsConfig = properties['DnsConfig'] as DnsConfig | undefined;
    const healthCheckCustomConfig = properties['HealthCheckCustomConfig'] as
      | HealthCheckCustomConfig
      | undefined;

    if (!name) {
      throw new ProvisioningError(
        `Name is required for ServiceDiscovery Service ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await client.send(
        new CreateServiceCommand({
          Name: name,
          ...(namespaceId && { NamespaceId: namespaceId }),
          ...(description && { Description: description }),
          ...(dnsConfig && { DnsConfig: dnsConfig }),
          ...(healthCheckCustomConfig && {
            HealthCheckCustomConfig: healthCheckCustomConfig,
          }),
        })
      );

      const service = response.Service;
      if (!service || !service.Id) {
        throw new Error('CreateService did not return Service ID');
      }

      this.logger.debug(
        `Successfully created service discovery service ${logicalId}: ${service.Id}`
      );

      return {
        physicalId: service.Id,
        attributes: {
          Id: service.Id,
          Arn: service.Arn || '',
          Name: service.Name || name || '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create service discovery service ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async updateService(
    logicalId: string,
    physicalId: string
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating service discovery service ${logicalId}: ${physicalId} (no-op)`);
    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Id: physicalId,
      },
    };
  }

  private async deleteService(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting service discovery service ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      await client.send(new DeleteServiceCommand({ Id: physicalId }));
      this.logger.debug(`Successfully deleted service discovery service ${logicalId}`);
    } catch (error) {
      if (error instanceof ServiceNotFound) {
        this.logger.debug(`Service ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete service discovery service ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Poll a Service Discovery operation until it completes.
   * Returns the target resource ID from the operation result.
   */
  private async pollOperation(
    operationId: string,
    logicalId: string,
    resourceType: string
  ): Promise<string> {
    const client = this.getClient();
    const maxAttempts = 60;
    let delay = 1000; // start at 1s

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await client.send(new GetOperationCommand({ OperationId: operationId }));

      const status = result.Operation?.Status;

      if (status === 'SUCCESS') {
        // Extract the target resource ID (NAMESPACE or SERVICE)
        const targets = result.Operation?.Targets;
        if (targets) {
          return targets['NAMESPACE'] || targets['SERVICE'] || operationId;
        }
        return operationId;
      }

      if (status === 'FAIL') {
        const errorMessage = result.Operation?.ErrorMessage || 'Unknown error';
        throw new ProvisioningError(
          `Operation failed for ${logicalId}: ${errorMessage}`,
          resourceType,
          logicalId
        );
      }

      // SUBMITTED or PENDING - wait and retry
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000); // exponential backoff, max 10s
    }

    throw new ProvisioningError(
      `Operation timed out for ${logicalId} (operationId: ${operationId})`,
      resourceType,
      logicalId
    );
  }

  /**
   * Build a namespace ARN from namespace ID.
   * Format: arn:aws:servicediscovery:{region}:{account}:namespace/{namespaceId}
   */
  private async buildNamespaceArn(namespaceId: string): Promise<string> {
    const stsClient = this.getStsClient();
    const identity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account || '';
    const region = await this.getClient().config.region();
    return `arn:aws:servicediscovery:${region}:${accountId}:namespace/${namespaceId}`;
  }
}
