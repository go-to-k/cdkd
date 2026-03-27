import {
  AppSyncClient,
  CreateGraphqlApiCommand,
  DeleteGraphqlApiCommand,
  CreateDataSourceCommand,
  DeleteDataSourceCommand,
  CreateResolverCommand,
  DeleteResolverCommand,
  CreateApiKeyCommand,
  DeleteApiKeyCommand,
  StartSchemaCreationCommand,
  type AuthenticationType,
  type DataSourceType,
  type CreateGraphqlApiCommandInput,
  type CreateDataSourceCommandInput,
  type CreateResolverCommandInput,
  type CreateApiKeyCommandInput,
} from '@aws-sdk/client-appsync';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS AppSync resources
 *
 * CC API doesn't support Create for AWS::AppSync::GraphQLApi.
 * This provider uses the AppSync SDK directly.
 *
 * Supported resource types:
 * - AWS::AppSync::GraphQLApi
 * - AWS::AppSync::GraphQLSchema
 * - AWS::AppSync::DataSource
 * - AWS::AppSync::Resolver
 * - AWS::AppSync::ApiKey
 */
export class AppSyncProvider implements ResourceProvider {
  private client: AppSyncClient | undefined;
  private logger = getLogger().child('AppSyncProvider');

  private getClient(): AppSyncClient {
    if (!this.client) {
      this.client = new AppSyncClient({});
    }
    return this.client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::AppSync::GraphQLApi':
        return this.createGraphQLApi(logicalId, resourceType, properties);
      case 'AWS::AppSync::GraphQLSchema':
        return this.createGraphQLSchema(logicalId, resourceType, properties);
      case 'AWS::AppSync::DataSource':
        return this.createDataSource(logicalId, resourceType, properties);
      case 'AWS::AppSync::Resolver':
        return this.createResolver(logicalId, resourceType, properties);
      case 'AWS::AppSync::ApiKey':
        return this.createApiKey(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Update for ${resourceType} ${logicalId} (${physicalId}) - no-op, immutable`);
    return Promise.resolve({ physicalId, wasReplaced: false });
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::AppSync::GraphQLApi':
        return this.deleteGraphQLApi(logicalId, physicalId, resourceType);
      case 'AWS::AppSync::GraphQLSchema':
        // Schema is deleted with the API, no-op
        this.logger.debug(`Schema ${logicalId} is deleted with its API, skipping`);
        return;
      case 'AWS::AppSync::DataSource':
        return this.deleteDataSource(logicalId, physicalId, resourceType);
      case 'AWS::AppSync::Resolver':
        return this.deleteResolver(logicalId, physicalId, resourceType);
      case 'AWS::AppSync::ApiKey':
        return this.deleteApiKey(logicalId, physicalId, resourceType);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    this.logger.debug(`getAttribute for ${resourceType} ${physicalId}: ${attributeName}`);
    return Promise.resolve(undefined);
  }

  // ─── AWS::AppSync::GraphQLApi ──────────────────────────────────────

  private async createGraphQLApi(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating GraphQL API ${logicalId}`);

    const name = properties['Name'] as string;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for GraphQLApi ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const authenticationType = properties['AuthenticationType'] as AuthenticationType | undefined;

    try {
      const input: CreateGraphqlApiCommandInput = {
        name,
        authenticationType: authenticationType ?? 'API_KEY',
      };

      if (properties['XrayEnabled'] !== undefined) {
        input.xrayEnabled = properties['XrayEnabled'] as boolean;
      }

      if (properties['LogConfig']) {
        const logConfig = properties['LogConfig'] as Record<string, unknown>;
        input.logConfig = {
          cloudWatchLogsRoleArn: logConfig['CloudWatchLogsRoleArn'] as string,
          fieldLogLevel: logConfig['FieldLogLevel'] as 'NONE' | 'ERROR' | 'ALL',
          excludeVerboseContent: logConfig['ExcludeVerboseContent'] as boolean | undefined,
        };
      }

      // Tags
      if (properties['Tags']) {
        const tags = properties['Tags'] as Array<{
          Key: string;
          Value: string;
        }>;
        const tagMap: Record<string, string> = {};
        for (const tag of tags) {
          tagMap[tag.Key] = tag.Value;
        }
        input.tags = tagMap;
      }

      const response = await this.getClient().send(new CreateGraphqlApiCommand(input));

      const apiId = response.graphqlApi!.apiId!;
      const arn = response.graphqlApi!.arn!;
      const graphQLUrl = response.graphqlApi!.uris?.['GRAPHQL'] ?? '';

      this.logger.debug(`Successfully created GraphQL API ${logicalId}: ${apiId}`);

      return {
        physicalId: apiId,
        attributes: {
          ApiId: apiId,
          Arn: arn,
          GraphQLUrl: graphQLUrl,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create GraphQL API ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteGraphQLApi(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting GraphQL API ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteGraphqlApiCommand({ apiId: physicalId }));
      this.logger.debug(`Successfully deleted GraphQL API ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(`GraphQL API ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete GraphQL API ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::AppSync::GraphQLSchema ───────────────────────────────────

  private async createGraphQLSchema(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating GraphQL Schema ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required for GraphQLSchema ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const definition = properties['Definition'] as string | undefined;
    const definitionS3Location = properties['DefinitionS3Location'] as string | undefined;

    try {
      if (definition) {
        await this.getClient().send(
          new StartSchemaCreationCommand({
            apiId,
            definition: new TextEncoder().encode(definition),
          })
        );
      } else if (definitionS3Location) {
        // For S3-based schema, pass as definition bytes
        // In practice, CDK usually inlines the schema
        this.logger.warn(`S3-based schema definition for ${logicalId} - using inline only`);
      }

      this.logger.debug(`Successfully started schema creation for ${logicalId}`);

      // Schema is tied to the API, use apiId as physical ID
      return {
        physicalId: apiId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create GraphQL Schema ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // ─── AWS::AppSync::DataSource ──────────────────────────────────────

  private async createDataSource(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DataSource ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    const name = properties['Name'] as string;
    const type = properties['Type'] as DataSourceType;

    if (!apiId || !name || !type) {
      throw new ProvisioningError(
        `ApiId, Name, and Type are required for DataSource ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const input: CreateDataSourceCommandInput = {
        apiId,
        name,
        type,
      };

      if (properties['Description']) {
        input.description = properties['Description'] as string;
      }
      if (properties['ServiceRoleArn']) {
        input.serviceRoleArn = properties['ServiceRoleArn'] as string;
      }
      if (properties['DynamoDBConfig']) {
        const config = properties['DynamoDBConfig'] as Record<string, unknown>;
        input.dynamodbConfig = {
          tableName: config['TableName'] as string,
          awsRegion: config['AwsRegion'] as string,
          useCallerCredentials: config['UseCallerCredentials'] as boolean | undefined,
        };
      }
      if (properties['LambdaConfig']) {
        const config = properties['LambdaConfig'] as Record<string, unknown>;
        input.lambdaConfig = {
          lambdaFunctionArn: config['LambdaFunctionArn'] as string,
        };
      }
      if (properties['HttpConfig']) {
        const config = properties['HttpConfig'] as Record<string, unknown>;
        input.httpConfig = {
          endpoint: config['Endpoint'] as string,
        };
      }

      await this.getClient().send(new CreateDataSourceCommand(input));

      const physicalId = `${apiId}|${name}`;
      this.logger.debug(`Successfully created DataSource ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {
          DataSourceArn: `arn:aws:appsync:*:*:apis/${apiId}/datasources/${name}`,
          Name: name,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DataSource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteDataSource(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting DataSource ${logicalId}: ${physicalId}`);

    const [apiId, name] = physicalId.split('|');
    if (!apiId || !name) {
      this.logger.warn(`Invalid DataSource physical ID format: ${physicalId}, skipping`);
      return;
    }

    try {
      await this.getClient().send(new DeleteDataSourceCommand({ apiId, name }));
      this.logger.debug(`Successfully deleted DataSource ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(`DataSource ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DataSource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::AppSync::Resolver ────────────────────────────────────────

  private async createResolver(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Resolver ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    const typeName = properties['TypeName'] as string;
    const fieldName = properties['FieldName'] as string;

    if (!apiId || !typeName || !fieldName) {
      throw new ProvisioningError(
        `ApiId, TypeName, and FieldName are required for Resolver ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const input: CreateResolverCommandInput = {
        apiId,
        typeName,
        fieldName,
      };

      if (properties['DataSourceName']) {
        input.dataSourceName = properties['DataSourceName'] as string;
      }
      if (properties['RequestMappingTemplate']) {
        input.requestMappingTemplate = properties['RequestMappingTemplate'] as string;
      }
      if (properties['ResponseMappingTemplate']) {
        input.responseMappingTemplate = properties['ResponseMappingTemplate'] as string;
      }
      if (properties['Kind']) {
        input.kind = properties['Kind'] as 'UNIT' | 'PIPELINE';
      }
      if (properties['PipelineConfig']) {
        const pipelineConfig = properties['PipelineConfig'] as Record<string, unknown>;
        input.pipelineConfig = {
          functions: pipelineConfig['Functions'] as string[] | undefined,
        };
      }
      if (properties['Runtime']) {
        const runtime = properties['Runtime'] as Record<string, unknown>;
        input.runtime = {
          name: runtime['Name'] as 'APPSYNC_JS',
          runtimeVersion: runtime['RuntimeVersion'] as string,
        };
      }
      if (properties['Code']) {
        input.code = properties['Code'] as string;
      }

      await this.getClient().send(new CreateResolverCommand(input));

      const physicalId = `${apiId}|${typeName}|${fieldName}`;
      this.logger.debug(`Successfully created Resolver ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {
          ResolverArn: `arn:aws:appsync:*:*:apis/${apiId}/types/${typeName}/resolvers/${fieldName}`,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Resolver ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteResolver(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting Resolver ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length < 3) {
      this.logger.warn(`Invalid Resolver physical ID format: ${physicalId}, skipping`);
      return;
    }
    const [apiId, typeName, fieldName] = parts;

    try {
      await this.getClient().send(new DeleteResolverCommand({ apiId, typeName, fieldName }));
      this.logger.debug(`Successfully deleted Resolver ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(`Resolver ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Resolver ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::AppSync::ApiKey ──────────────────────────────────────────

  private async createApiKey(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating ApiKey ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required for ApiKey ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const input: CreateApiKeyCommandInput = { apiId };

      if (properties['Description']) {
        input.description = properties['Description'] as string;
      }
      if (properties['Expires']) {
        input.expires = properties['Expires'] as number;
      }

      const response = await this.getClient().send(new CreateApiKeyCommand(input));

      const apiKeyId = response.apiKey!.id!;
      this.logger.debug(`Successfully created ApiKey ${logicalId}: ${apiKeyId}`);

      return {
        physicalId: `${apiId}|${apiKeyId}`,
        attributes: {
          ApiKey: response.apiKey!.id!,
          Arn: `arn:aws:appsync:*:*:apis/${apiId}/apikeys/${apiKeyId}`,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create ApiKey ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteApiKey(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting ApiKey ${logicalId}: ${physicalId}`);

    const [apiId, apiKeyId] = physicalId.split('|');
    if (!apiId || !apiKeyId) {
      this.logger.warn(`Invalid ApiKey physical ID format: ${physicalId}, skipping`);
      return;
    }

    try {
      await this.getClient().send(new DeleteApiKeyCommand({ apiId, id: apiKeyId }));
      this.logger.debug(`Successfully deleted ApiKey ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(`ApiKey ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete ApiKey ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private isNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    const name = (error as { name?: string }).name ?? '';
    return (
      message.includes('not found') ||
      message.includes('does not exist') ||
      name === 'NotFoundException'
    );
  }
}
