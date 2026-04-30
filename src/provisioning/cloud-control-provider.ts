import {
  CloudControlClient,
  CreateResourceCommand,
  UpdateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
  type ProgressEvent,
} from '@aws-sdk/client-cloudcontrol';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { GetRestApiCommand } from '@aws-sdk/client-api-gateway';
import { GetCloudFrontOriginAccessIdentityCommand } from '@aws-sdk/client-cloudfront';
import { GetFunctionUrlConfigCommand } from '@aws-sdk/client-lambda';
import { getAccountInfo } from '../deployment/intrinsic-function-resolver.js';
import { getAwsClients } from '../utils/aws-clients.js';
import { getLogger } from '../utils/logger.js';
import { ProvisioningError } from '../utils/error-handler.js';
import { JsonPatchGenerator } from './json-patch-generator.js';
import { assertRegionMatch, type DeleteContext } from './region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../types/resource.js';

/**
 * AWS Cloud Control API Provider
 *
 * Provisions resources using the Cloud Control API, which provides
 * a unified interface for managing AWS resources.
 *
 * Note: Not all AWS resources are supported by Cloud Control API.
 * Use isSupportedResourceType() to check before usage.
 */
/**
 * Properties that CC API expects as JSON strings, not objects.
 * CC API schema declares these as type: ["string", "object"] but
 * the implementation only accepts strings.
 */
const JSON_STRING_PROPERTIES: Record<string, Set<string>> = {
  'AWS::Events::Rule': new Set(['EventPattern']),
};

/**
 * Stringify object properties that CC API expects as JSON strings.
 */
function stringifyJsonProperties(
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const jsonProps = JSON_STRING_PROPERTIES[resourceType];
  if (!jsonProps) return properties;

  const result = { ...properties };
  for (const key of jsonProps) {
    if (key in result && typeof result[key] === 'object' && result[key] !== null) {
      result[key] = JSON.stringify(result[key]);
    }
  }
  return result;
}

/**
 * Recursively strip null and undefined values from an object.
 * This prevents CC API errors caused by null property values
 * (e.g., EventBridge Rule with null ScheduleExpression causes Java NPE).
 */
function stripNullValues(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return undefined;
  }
  if (Array.isArray(obj)) {
    return obj.map(stripNullValues).filter((v) => v !== undefined);
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const stripped = stripNullValues(value);
      if (stripped !== undefined) {
        result[key] = stripped;
      }
    }
    return result;
  }
  return obj;
}

export class CloudControlProvider implements ResourceProvider {
  private cloudControlClient: CloudControlClient;
  private logger = getLogger().child('CloudControlProvider');
  private patchGenerator = new JsonPatchGenerator();

  // Maximum time to wait for operation completion (15 minutes)
  private readonly MAX_WAIT_TIME_MS = 15 * 60 * 1000;
  // Initial poll interval (1 second) - increases with 1.5x exponential backoff
  private readonly INITIAL_POLL_INTERVAL_MS = 1_000;
  // Maximum poll interval (10 seconds)
  private readonly MAX_POLL_INTERVAL_MS = 10_000;

  constructor() {
    const awsClients = getAwsClients();
    this.cloudControlClient = awsClients.cloudControl;
  }

  /**
   * Create a resource using Cloud Control API
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating resource ${logicalId} (${resourceType})`);

    try {
      // Start resource creation
      const cleanProperties = stripNullValues(properties) as Record<string, unknown>;
      const ccProperties = stringifyJsonProperties(resourceType, cleanProperties);
      const desiredState = JSON.stringify(ccProperties);
      this.logger.debug(`DesiredState for ${logicalId}: ${desiredState}`);
      const createResponse = await this.cloudControlClient.send(
        new CreateResourceCommand({
          TypeName: resourceType,
          DesiredState: desiredState,
        })
      );

      if (!createResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to create resource ${logicalId}: No request token received`,
          resourceType,
          logicalId
        );
      }

      this.logger.debug(
        `Create request submitted for ${logicalId}, token: ${createResponse.ProgressEvent.RequestToken}`
      );

      // Wait for creation to complete
      const progressEvent = await this.waitForOperation(
        createResponse.ProgressEvent.RequestToken,
        logicalId,
        'CREATE'
      );

      if (!progressEvent.Identifier) {
        throw new ProvisioningError(
          `Failed to create resource ${logicalId}: No physical ID returned`,
          resourceType,
          logicalId
        );
      }

      this.logger.debug(`Created resource ${logicalId}, physical ID: ${progressEvent.Identifier}`);

      // Parse resource properties to extract attributes
      const result: ResourceCreateResult = {
        physicalId: progressEvent.Identifier,
      };

      if (progressEvent.ResourceModel) {
        result.attributes = this.parseResourceModel(progressEvent.ResourceModel);
      }

      // Enrich attributes with computed values for specific resource types
      result.attributes = await this.enrichResourceAttributes(
        resourceType,
        progressEvent.Identifier,
        result.attributes || {}
      );

      return result;
    } catch (error) {
      this.handleError(error, 'CREATE', resourceType, logicalId);
    }
  }

  /**
   * Update a resource using Cloud Control API
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(
      `Updating resource ${logicalId} (${resourceType}), physical ID: ${physicalId}`
    );

    try {
      // Strip null/undefined values and stringify JSON properties before generating patch
      const cleanPreviousProperties = stringifyJsonProperties(
        resourceType,
        stripNullValues(previousProperties) as Record<string, unknown>
      );
      const cleanProperties = stringifyJsonProperties(
        resourceType,
        stripNullValues(properties) as Record<string, unknown>
      );

      // Generate JSON Patch document
      const patch = this.patchGenerator.generatePatch(cleanPreviousProperties, cleanProperties);

      if (patch.length === 0) {
        // No changes detected
        this.logger.debug(`No property changes detected for ${logicalId}, skipping update`);
        return {
          physicalId,
          wasReplaced: false,
        };
      }

      this.logger.debug(
        `Generated ${patch.length} patch operations for ${logicalId}: ${JSON.stringify(patch)}`
      );

      // Start resource update
      const updateResponse = await this.cloudControlClient.send(
        new UpdateResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
          PatchDocument: JSON.stringify(patch),
        })
      );

      if (!updateResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to update resource ${logicalId}: No request token received`,
          resourceType,
          logicalId,
          physicalId
        );
      }

      this.logger.debug(
        `Update request submitted for ${logicalId}, token: ${updateResponse.ProgressEvent.RequestToken}`
      );

      // Wait for update to complete
      const progressEvent = await this.waitForOperation(
        updateResponse.ProgressEvent.RequestToken,
        logicalId,
        'UPDATE'
      );

      this.logger.debug(`Updated resource ${logicalId}`);

      // Parse resource properties to extract attributes
      // Resource replacement for immutable property changes is detected and handled
      // by DeployEngine (immutable property detection + CREATE→DELETE flow) before
      // reaching this update method, so wasReplaced is always false here.
      const result: ResourceUpdateResult = {
        physicalId,
        wasReplaced: false,
      };

      if (progressEvent.ResourceModel) {
        result.attributes = this.parseResourceModel(progressEvent.ResourceModel);
      }

      // Enrich attributes with computed values for specific resource types
      result.attributes = await this.enrichResourceAttributes(
        resourceType,
        physicalId,
        result.attributes || {}
      );

      return result;
    } catch (error) {
      this.handleError(error, 'UPDATE', resourceType, logicalId, physicalId);
    }
  }

  /**
   * Delete a resource using Cloud Control API
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(
      `Deleting resource ${logicalId} (${resourceType}), physical ID: ${physicalId}`
    );

    try {
      // Start resource deletion
      const deleteResponse = await this.cloudControlClient.send(
        new DeleteResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
        })
      );

      if (!deleteResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to delete resource ${logicalId}: No request token received`,
          resourceType,
          logicalId,
          physicalId
        );
      }

      this.logger.debug(
        `Delete request submitted for ${logicalId}, token: ${deleteResponse.ProgressEvent.RequestToken}`
      );

      // Wait for deletion to complete
      await this.waitForOperation(deleteResponse.ProgressEvent.RequestToken, logicalId, 'DELETE');

      this.logger.debug(`Deleted resource ${logicalId}`);
    } catch (error) {
      // Treat "not found" / "does not exist" as idempotent success for DELETE,
      // but only when the AWS client is operating against the same region the
      // resource was deployed to. A region mismatch must surface — otherwise a
      // destroy run with the wrong region would silently strip every resource
      // from state while leaving the actual AWS resources orphaned.
      const err = error as { name?: string; message?: string };
      if (
        err.name === 'ResourceNotFoundException' ||
        err.message?.includes('does not exist') ||
        err.message?.includes('not found') ||
        err.message?.includes('NotFound')
      ) {
        const clientRegion = await this.cloudControlClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Resource ${logicalId} already deleted (not found), treating as success`);
        return;
      }
      this.handleError(error, 'DELETE', resourceType, logicalId, physicalId);
    }
  }

  /**
   * Get current state of a resource
   */
  async getResourceState(
    resourceType: string,
    physicalId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.cloudControlClient.send(
        new GetResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
        })
      );

      if (!response.ResourceDescription?.Properties) {
        return null;
      }

      return this.parseResourceModel(response.ResourceDescription.Properties);
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Wait for an asynchronous operation to complete
   */
  private async waitForOperation(
    requestToken: string,
    logicalId: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE'
  ): Promise<ProgressEvent> {
    const startTime = Date.now();
    let attempts = 0;
    let pollInterval = this.INITIAL_POLL_INTERVAL_MS;

    while (Date.now() - startTime < this.MAX_WAIT_TIME_MS) {
      attempts++;

      const statusResponse = await this.cloudControlClient.send(
        new GetResourceRequestStatusCommand({
          RequestToken: requestToken,
        })
      );

      const progressEvent = statusResponse.ProgressEvent;

      if (!progressEvent) {
        throw new ProvisioningError(
          `Failed to get status for ${logicalId}: No progress event`,
          'Unknown',
          logicalId
        );
      }

      this.logger.debug(
        `${operation} ${logicalId}: ${progressEvent.OperationStatus} (attempt ${attempts}, next poll ${pollInterval}ms)`
      );

      switch (progressEvent.OperationStatus) {
        case 'SUCCESS':
          return progressEvent;

        case 'FAILED':
          throw new ProvisioningError(
            `${operation} failed for ${logicalId}: ${progressEvent.StatusMessage || 'Unknown error'}`,
            progressEvent.TypeName || 'Unknown',
            logicalId,
            progressEvent.Identifier
          );

        case 'CANCEL_COMPLETE':
          throw new ProvisioningError(
            `${operation} cancelled for ${logicalId}`,
            progressEvent.TypeName || 'Unknown',
            logicalId,
            progressEvent.Identifier
          );

        case 'IN_PROGRESS':
        case 'PENDING':
          // Exponential backoff with 1.5x multiplier for flatter curve:
          // 1s → 1.5s → 2.25s → 3.4s → 5s → 7.5s → 10s (capped)
          // Most CC API operations complete in 1-5s, so slower ramp-up
          // polls more frequently during the common case.
          await this.sleep(pollInterval);
          pollInterval = Math.min(Math.ceil(pollInterval * 1.5), this.MAX_POLL_INTERVAL_MS);
          break;

        default:
          this.logger.warn(
            `Unknown operation status for ${logicalId}: ${progressEvent.OperationStatus}`
          );
          await this.sleep(pollInterval);
          pollInterval = Math.min(Math.ceil(pollInterval * 1.5), this.MAX_POLL_INTERVAL_MS);
      }
    }

    throw new ProvisioningError(
      `${operation} timeout for ${logicalId} after ${this.MAX_WAIT_TIME_MS / 1000}s`,
      'Unknown',
      logicalId
    );
  }

  /**
   * Parse resource model JSON string
   */
  private parseResourceModel(resourceModel: string): Record<string, unknown> {
    try {
      return JSON.parse(resourceModel) as Record<string, unknown>;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to parse resource model: ${errorMessage}\n` +
          `Raw model: ${resourceModel.substring(0, 500)}${resourceModel.length > 500 ? '...' : ''}`
      );
      return {};
    }
  }

  /**
   * Enrich resource attributes with computed values
   *
   * CC API GetResource returns property names that match CloudFormation
   * Fn::GetAtt attribute names, so all properties are passed through as-is.
   * This method adds fallback attributes for edge cases where CC API
   * may not return certain values.
   */
  private async enrichResourceAttributes(
    resourceType: string,
    physicalId: string,
    attributes: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const enriched: Record<string, unknown> = { ...attributes };

    // Fallback: compute attributes that CC API may not return
    switch (resourceType) {
      case 'AWS::S3::Bucket':
        // S3 bucket ARN: arn:aws:s3:::bucket-name
        if (!enriched['Arn']) {
          enriched['Arn'] = `arn:aws:s3:::${physicalId}`;
        }
        break;

      case 'AWS::DynamoDB::Table':
        // Fallback: CC API GetResource may not include StreamArn when streams are enabled.
        // Call DescribeTable to retrieve LatestStreamArn if not already present.
        if (!enriched['StreamArn']) {
          try {
            const dynamoDBClient = getAwsClients().dynamoDB;
            const describeResponse = await dynamoDBClient.send(
              new DescribeTableCommand({ TableName: physicalId })
            );
            const latestStreamArn = describeResponse.Table?.LatestStreamArn;
            if (latestStreamArn) {
              enriched['StreamArn'] = latestStreamArn;
              this.logger.debug(
                `Enriched DynamoDB StreamArn for ${physicalId}: ${latestStreamArn}`
              );
            }
          } catch (error) {
            // Best-effort: don't fail the operation if DescribeTable fails
            this.logger.debug(
              `Failed to get DynamoDB StreamArn for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::ApiGateway::RestApi':
        // Fallback: ensure RootResourceId is present.
        // CC API GetResource typically returns it, but retrieve via SDK if missing.
        if (!enriched['RootResourceId']) {
          try {
            const apiGatewayClient = getAwsClients().apiGateway;
            const getRestApiResponse = await apiGatewayClient.send(
              new GetRestApiCommand({ restApiId: physicalId })
            );
            if (getRestApiResponse.rootResourceId) {
              enriched['RootResourceId'] = getRestApiResponse.rootResourceId;
              this.logger.debug(
                `Enriched RestApi RootResourceId for ${physicalId}: ${getRestApiResponse.rootResourceId}`
              );
            }
          } catch (error) {
            // Best-effort: don't fail the operation if GetRestApi fails
            this.logger.debug(
              `Failed to get RestApi RootResourceId for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        // Ensure RestApiId is set (physical ID is the rest-api-id)
        if (!enriched['RestApiId']) {
          enriched['RestApiId'] = physicalId;
        }
        break;

      case 'AWS::CloudFront::CloudFrontOriginAccessIdentity':
        // Fallback: ensure S3CanonicalUserId is present.
        // CC API GetResource typically returns it, but retrieve via SDK if missing.
        if (!enriched['S3CanonicalUserId']) {
          try {
            const cloudFrontClient = getAwsClients().cloudFront;
            const oaiResponse = await cloudFrontClient.send(
              new GetCloudFrontOriginAccessIdentityCommand({ Id: physicalId })
            );
            const s3CanonicalUserId = oaiResponse.CloudFrontOriginAccessIdentity?.S3CanonicalUserId;
            if (s3CanonicalUserId) {
              enriched['S3CanonicalUserId'] = s3CanonicalUserId;
              this.logger.debug(
                `Enriched CloudFront OAI S3CanonicalUserId for ${physicalId}: ${s3CanonicalUserId}`
              );
            }
          } catch (error) {
            // Best-effort: don't fail the operation
            this.logger.debug(
              `Failed to get CloudFront OAI S3CanonicalUserId for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::KMS::Key':
        // CC API may not return Arn in ResourceModel.
        // Physical ID is the KeyId (UUID), so construct the ARN.
        if (!enriched['Arn']) {
          try {
            const kmsAccountInfo = await getAccountInfo();
            enriched['Arn'] =
              `arn:${kmsAccountInfo.partition}:kms:${kmsAccountInfo.region}:${kmsAccountInfo.accountId}:key/${physicalId}`;
            this.logger.debug(`Enriched KMS Key Arn for ${physicalId}: ${String(enriched['Arn'])}`);
          } catch (error) {
            this.logger.debug(
              `Failed to construct KMS Key Arn for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        if (!enriched['KeyId']) {
          enriched['KeyId'] = physicalId;
        }
        break;

      case 'AWS::CloudFront::OriginAccessControl':
        // CC API physicalId is the OAC ID
        if (!enriched['Id']) enriched['Id'] = physicalId;
        break;

      case 'AWS::Route53::HealthCheck':
        // CC API physicalId is the HealthCheck ID
        if (!enriched['HealthCheckId']) enriched['HealthCheckId'] = physicalId;
        break;

      case 'AWS::ECR::Repository':
        // CC API physicalId is the repository name, construct ARN
        if (!enriched['Arn']) {
          try {
            const ecrAccountInfo = await getAccountInfo();
            enriched['Arn'] =
              `arn:${ecrAccountInfo.partition}:ecr:${ecrAccountInfo.region}:${ecrAccountInfo.accountId}:repository/${physicalId}`;
            this.logger.debug(
              `Enriched ECR Repository Arn for ${physicalId}: ${String(enriched['Arn'])}`
            );
          } catch (error) {
            this.logger.debug(
              `Failed to construct ECR Repository Arn: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        if (!enriched['RepositoryUri']) {
          try {
            const ecrAccountInfo = await getAccountInfo();
            enriched['RepositoryUri'] =
              `${ecrAccountInfo.accountId}.dkr.ecr.${ecrAccountInfo.region}.amazonaws.com/${physicalId}`;
          } catch {
            /* best effort */
          }
        }
        break;

      case 'AWS::EC2::EIP':
        // CC API returns composite physicalId: "PublicIp|AllocationId"
        // Extract individual attributes for Fn::GetAtt resolution
        if (physicalId.includes('|')) {
          const [publicIp, allocationId] = physicalId.split('|');
          if (!enriched['AllocationId']) enriched['AllocationId'] = allocationId;
          if (!enriched['PublicIp']) enriched['PublicIp'] = publicIp;
          this.logger.debug(
            `Enriched EIP attributes: AllocationId=${allocationId}, PublicIp=${publicIp}`
          );
        }
        break;

      case 'AWS::Lambda::Version':
        // CC API physicalId for Lambda Version is the full version ARN
        // (e.g., arn:aws:lambda:us-east-1:123456:function:MyFunc:1).
        // Lambda::Alias FunctionVersion property needs just the version number.
        if (!enriched['Version']) {
          const versionSegments = physicalId.split(':');
          const versionNumber = versionSegments[versionSegments.length - 1];
          enriched['Version'] = versionNumber;
          this.logger.debug(`Enriched Lambda Version for ${physicalId}: ${versionNumber}`);
        }
        break;

      case 'AWS::Kinesis::Stream':
        // CC API physicalId for Kinesis Stream is the stream name, not the ARN.
        // Fn::GetAtt [Stream, Arn] needs the full ARN.
        if (!enriched['Arn']) {
          try {
            const kinesisAccountInfo = await getAccountInfo();
            enriched['Arn'] =
              `arn:${kinesisAccountInfo.partition}:kinesis:${kinesisAccountInfo.region}:${kinesisAccountInfo.accountId}:stream/${physicalId}`;
            this.logger.debug(
              `Enriched Kinesis Stream Arn for ${physicalId}: ${String(enriched['Arn'])}`
            );
          } catch (error) {
            this.logger.debug(
              `Failed to construct Kinesis Stream Arn for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::Lambda::Url':
        // CC API CREATE response may not include FunctionUrl in ResourceModel.
        // Use Lambda SDK to retrieve it for Fn::GetAtt resolution.
        if (!enriched['FunctionUrl']) {
          try {
            const lambdaClient = getAwsClients().lambda;
            // physicalId is the FunctionArn for Lambda URL
            const urlConfig = await lambdaClient.send(
              new GetFunctionUrlConfigCommand({ FunctionName: physicalId })
            );
            if (urlConfig.FunctionUrl) {
              enriched['FunctionUrl'] = urlConfig.FunctionUrl;
              this.logger.debug(
                `Enriched Lambda URL FunctionUrl for ${physicalId}: ${urlConfig.FunctionUrl}`
              );
            }
            if (urlConfig.FunctionArn) {
              enriched['FunctionArn'] = urlConfig.FunctionArn;
            }
          } catch (error) {
            this.logger.debug(
              `Failed to get Lambda URL config for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      default:
        break;
    }

    return enriched;
  }

  /**
   * Handle errors and throw ProvisioningError
   */
  private handleError(
    error: unknown,
    operation: string,
    resourceType: string,
    logicalId: string,
    physicalId?: string
  ): never {
    const err = error as { name?: string; message?: string };

    // Check if resource type is not supported
    if (err.name === 'UnsupportedActionException' || err.name === 'TypeNotFoundException') {
      throw new ProvisioningError(
        `Resource type ${resourceType} is not supported by Cloud Control API and no SDK provider is registered.\n` +
          `Please report this issue at https://github.com/go-to-k/cdkd/issues so we can add SDK provider support.\n` +
          `Error: ${err.message || 'Unknown error'}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }

    // Re-throw if already a ProvisioningError
    if (error instanceof ProvisioningError) {
      throw error;
    }

    // Wrap other errors
    throw new ProvisioningError(
      `${operation} failed for ${logicalId}: ${err.message || 'Unknown error'}`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if a resource type is supported by Cloud Control API
   *
   * This is a best-effort check. Some resource types may still fail
   * even if they appear to be supported.
   */
  static isSupportedResourceType(resourceType: string): boolean {
    // Common resource types that are NOT supported by Cloud Control API
    const unsupportedTypes = new Set([
      // IAM (most types not supported)
      'AWS::IAM::Role',
      'AWS::IAM::Policy',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::User',
      'AWS::IAM::Group',
      'AWS::IAM::InstanceProfile',

      // Lambda layers
      'AWS::Lambda::LayerVersion',

      // S3 bucket policies (use SDK instead)
      'AWS::S3::BucketPolicy',

      // CloudFormation-specific resources
      'AWS::CloudFormation::Stack',
      'AWS::CloudFormation::WaitCondition',
      'AWS::CloudFormation::WaitConditionHandle',
      'AWS::CloudFormation::CustomResource',

      // CDK-specific resources
      'AWS::CDK::Metadata',
      'Custom::CDKBucketDeployment',
      'Custom::S3AutoDeleteObjects',

      // Route53 hosted zones (complex)
      'AWS::Route53::HostedZone',

      // ACM certificates (validation complexity)
      'AWS::CertificateManager::Certificate',
    ]);

    if (unsupportedTypes.has(resourceType)) {
      return false;
    }

    // Custom resources are never supported by Cloud Control
    if (
      resourceType.startsWith('Custom::') ||
      resourceType.startsWith('AWS::CloudFormation::CustomResource')
    ) {
      return false;
    }

    // Most other AWS:: resources should be supported
    // (This is optimistic; some may still fail)
    return resourceType.startsWith('AWS::');
  }
}
