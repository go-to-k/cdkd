import {
  CloudControlClient,
  GetResourceCommand,
  ListResourcesCommand,
} from '@aws-sdk/client-cloudcontrol';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Cloud Control API context provider
 *
 * Generic provider that uses Cloud Control API to lookup any resource type.
 * CDK provider type: "cc-api-provider"
 *
 * Used by CDK for lookups like IAM Roles, ECR repositories, RDS instances, etc.
 */
export class CcApiContextProvider implements ContextProvider {
  private logger = getLogger().child('CcApiContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const typeName = props['typeName'] as string;
    const exactIdentifier = props['exactIdentifier'] as string | undefined;
    const propertiesToReturn = (props['propertiesToReturn'] as string[]) || [];
    const propertyMatch = props['propertyMatch'] as Record<string, unknown> | undefined;
    const expectedMatchCount = (props['expectedMatchCount'] as string) || 'exactly-one';
    const dummyValue = props['dummyValue'];
    const ignoreErrorOnMissingContext = props['ignoreErrorOnMissingContext'] as boolean | undefined;

    if (!typeName) {
      throw new Error('CC API context provider requires typeName property');
    }

    this.logger.debug(
      `CC API lookup: ${typeName}${exactIdentifier ? ` (id: ${exactIdentifier})` : ''} (region: ${region})`
    );

    const client = new CloudControlClient({
      ...(region && { region }),
    });

    try {
      let resources: ResourceModel[];

      if (exactIdentifier) {
        // Get specific resource by identifier
        const resource = await this.getResource(client, typeName, exactIdentifier);
        resources = resource ? [resource] : [];
      } else {
        // List resources and filter
        resources = await this.listResources(client, typeName);

        // Apply property match filter
        if (propertyMatch && Object.keys(propertyMatch).length > 0) {
          resources = resources.filter((r) => this.matchesProperties(r, propertyMatch));
        }
      }

      // Validate match count
      this.validateMatchCount(resources, expectedMatchCount, typeName, exactIdentifier);

      if (resources.length === 0) {
        if (ignoreErrorOnMissingContext && dummyValue !== undefined) {
          this.logger.debug(`No resources found, returning dummy value`);
          return dummyValue;
        }
        throw new Error(`No ${typeName} resource found${exactIdentifier ? ` with identifier ${exactIdentifier}` : ''}`);
      }

      // Extract requested properties
      if (resources.length === 1) {
        return this.extractProperties(resources[0]!, propertiesToReturn);
      }

      return resources.map((r) => this.extractProperties(r, propertiesToReturn));
    } finally {
      client.destroy();
    }
  }

  /**
   * Get a single resource by identifier
   */
  private async getResource(
    client: CloudControlClient,
    typeName: string,
    identifier: string
  ): Promise<ResourceModel | null> {
    try {
      const response = await client.send(
        new GetResourceCommand({
          TypeName: typeName,
          Identifier: identifier,
        })
      );

      if (!response.ResourceDescription?.Properties) {
        return null;
      }

      return JSON.parse(response.ResourceDescription.Properties) as ResourceModel;
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      throw error;
    }
  }

  /**
   * List all resources of a type
   */
  private async listResources(
    client: CloudControlClient,
    typeName: string
  ): Promise<ResourceModel[]> {
    const resources: ResourceModel[] = [];
    let nextToken: string | undefined;

    do {
      const response = await client.send(
        new ListResourcesCommand({
          TypeName: typeName,
          ...(nextToken && { NextToken: nextToken }),
        })
      );

      for (const desc of response.ResourceDescriptions ?? []) {
        if (desc.Properties) {
          resources.push(JSON.parse(desc.Properties) as ResourceModel);
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return resources;
  }

  /**
   * Check if resource matches property filter
   */
  private matchesProperties(
    resource: ResourceModel,
    propertyMatch: Record<string, unknown>
  ): boolean {
    for (const [key, expectedValue] of Object.entries(propertyMatch)) {
      const actualValue = this.getNestedProperty(resource, key);
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get nested property value using dot notation
   */
  private getNestedProperty(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /**
   * Validate that the number of matches meets expectations
   */
  private validateMatchCount(
    resources: ResourceModel[],
    expectedMatchCount: string,
    typeName: string,
    identifier?: string
  ): void {
    const count = resources.length;
    const context = identifier ? ` with identifier ${identifier}` : '';

    switch (expectedMatchCount) {
      case 'exactly-one':
        if (count !== 1) {
          throw new Error(
            `Expected exactly one ${typeName}${context}, found ${count}`
          );
        }
        break;
      case 'at-least-one':
        if (count < 1) {
          throw new Error(
            `Expected at least one ${typeName}${context}, found none`
          );
        }
        break;
      case 'at-most-one':
        if (count > 1) {
          throw new Error(
            `Expected at most one ${typeName}${context}, found ${count}`
          );
        }
        break;
      case 'any':
        // No validation needed
        break;
    }
  }

  /**
   * Extract requested properties from resource model
   */
  private extractProperties(
    resource: ResourceModel,
    propertiesToReturn: string[]
  ): Record<string, unknown> {
    if (propertiesToReturn.length === 0) {
      return resource;
    }

    const result: Record<string, unknown> = {};
    for (const prop of propertiesToReturn) {
      result[prop] = this.getNestedProperty(resource, prop);
    }
    return result;
  }
}

type ResourceModel = Record<string, unknown>;
