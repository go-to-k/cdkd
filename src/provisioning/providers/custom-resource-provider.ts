import { LambdaClient, InvokeCommand, type InvocationResponse } from '@aws-sdk/client-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * CloudFormation Custom Resource Response format
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
 */
interface CfnCustomResourceResponse {
  Status: 'SUCCESS' | 'FAILED';
  Reason?: string;
  PhysicalResourceId?: string;
  StackId?: string;
  RequestId?: string;
  LogicalResourceId?: string;
  NoEcho?: boolean;
  Data?: Record<string, unknown>;
}

/**
 * Custom Resource Lambda Response Payload (direct return)
 * Some handlers return data directly in the Lambda payload instead of via ResponseURL
 */
interface CustomResourceResponsePayload {
  PhysicalResourceId?: string;
  Data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Configuration for Custom Resource Provider
 */
export interface CustomResourceProviderConfig {
  /** S3 bucket name for storing custom resource responses */
  responseBucket?: string;
  /** S3 key prefix for response objects */
  responsePrefix?: string;
  /**
   * Max time (ms) to wait for async custom resource responses (e.g., CDK Provider framework
   * with isCompleteHandler that uses Step Functions polling).
   * Default: 1 hour (3600000ms), matching CDK's default totalTimeout.
   */
  asyncResponseTimeoutMs?: number;
}

/**
 * Type guard to validate Lambda response payload structure
 */
function isCustomResourceResponsePayload(value: unknown): value is CustomResourceResponsePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;

  if ('PhysicalResourceId' in payload && typeof payload['PhysicalResourceId'] !== 'string') {
    return false;
  }

  if ('Data' in payload) {
    if (typeof payload['Data'] !== 'object' || payload['Data'] === null) {
      return false;
    }
  }

  return true;
}

/**
 * Parse Lambda response payload with type safety
 */
function parseLambdaPayload(payloadBytes: Uint8Array | undefined): CustomResourceResponsePayload {
  if (!payloadBytes) {
    return {};
  }

  const payloadString = Buffer.from(payloadBytes).toString();

  // Handle empty or null responses
  if (!payloadString || payloadString === 'null' || payloadString === '""') {
    return {};
  }

  const parsed: unknown = JSON.parse(payloadString);

  if (!isCustomResourceResponsePayload(parsed)) {
    throw new Error(`Invalid Lambda response payload format: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

/**
 * Custom Resource Provider
 *
 * Implements Lambda-backed custom resources by invoking the Lambda function
 * specified in the ServiceToken property.
 *
 * This provider follows the CloudFormation custom resource protocol:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/custom-resources.html
 *
 * Supports both standard custom resources and CDK's Provider framework:
 *
 * **Standard custom resources:**
 * - ServiceToken Lambda is invoked synchronously
 * - Handler sends cfn-response to ResponseURL (S3 pre-signed URL) or returns directly
 * - Short polling timeout (30 seconds)
 *
 * **CDK Provider framework (with isCompleteHandler):**
 * - ServiceToken points to the framework's onEvent wrapper Lambda
 * - Lambda invokes user's onEventHandler, then starts a Step Functions state machine
 * - Step Functions polls the isCompleteHandler until IsComplete: true
 * - Step Functions sends cfn-response to ResponseURL when done
 * - Lambda returns null/empty payload (async pattern detected automatically)
 * - Long polling timeout with exponential backoff (default: 1 hour)
 *
 * Response handling strategy:
 * 1. Generate a pre-signed S3 PUT URL as the ResponseURL (valid for 2 hours)
 * 2. Invoke Lambda synchronously (RequestResponse)
 * 3. Check Lambda payload for direct response (simple handlers)
 * 4. If no direct response, detect async pattern and poll S3 with appropriate timeout
 */
export class CustomResourceProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private snsClient: SNSClient;
  private s3Client: S3Client;
  private logger = getLogger().child('CustomResourceProvider');
  private responseBucket: string | undefined;
  private responsePrefix: string;

  /** Max time to wait for synchronous S3 response after Lambda invocation (30 seconds) */
  private readonly SYNC_RESPONSE_TIMEOUT_MS = 30_000;
  /** Max time to wait for async S3 response (CDK Provider framework with isCompleteHandler) */
  private readonly asyncResponseTimeoutMs: number;
  /** Default async response timeout: 1 hour (matches CDK's default totalTimeout) */
  private static readonly DEFAULT_ASYNC_RESPONSE_TIMEOUT_MS = 3_600_000;
  /** Initial poll interval for checking S3 response (2 seconds) */
  private readonly INITIAL_POLL_INTERVAL_MS = 2_000;
  /** Max poll interval for async polling with exponential backoff (30 seconds) */
  private readonly MAX_POLL_INTERVAL_MS = 30_000;

  constructor(config?: CustomResourceProviderConfig) {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
    this.snsClient = awsClients.sns;
    this.s3Client = awsClients.s3;
    this.responseBucket = config?.responseBucket;
    this.responsePrefix = config?.responsePrefix ?? 'custom-resource-responses';
    this.asyncResponseTimeoutMs =
      config?.asyncResponseTimeoutMs ?? CustomResourceProvider.DEFAULT_ASYNC_RESPONSE_TIMEOUT_MS;
  }

  /**
   * Set the S3 bucket for custom resource responses
   * Called by ProviderRegistry when state bucket is configured
   */
  setResponseBucket(bucket: string): void {
    this.responseBucket = bucket;
  }

  /**
   * Create a custom resource by invoking its Lambda handler
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating custom resource ${logicalId} (${resourceType})`);

    const serviceToken = properties['ServiceToken'] as string | undefined;

    if (!serviceToken) {
      throw new ProvisioningError(
        `ServiceToken is required for custom resource ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const requestId = `cdkq-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const responseKey = this.getResponseKey(requestId);
      const responseURL = await this.generateResponseURL(responseKey);

      const request = {
        RequestType: 'Create',
        RequestId: requestId,
        ResponseURL: responseURL,
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        StackId: `arn:aws:cloudformation:us-east-1:000000000000:stack/cdkq-${logicalId}/cdkq`,
        ResourceProperties: this.stringifyProperties(properties),
      };

      this.logger.debug(`Sending custom resource create request: ${serviceToken}`);

      const cfnResponse = await this.sendRequest(
        serviceToken,
        request,
        responseKey,
        logicalId,
        'Create'
      );

      if (cfnResponse.Status === 'FAILED') {
        throw new Error(
          `Custom resource handler returned FAILED: ${cfnResponse.Reason || 'Unknown reason'}`
        );
      }

      const physicalId: string = cfnResponse.PhysicalResourceId || logicalId;
      const attributes: Record<string, unknown> = cfnResponse.Data || {};

      this.logger.debug(`Successfully created custom resource ${logicalId}: ${physicalId}`);

      return { physicalId, attributes };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create custom resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a custom resource by invoking its Lambda handler
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating custom resource ${logicalId}: ${physicalId} (${resourceType})`);

    const serviceToken = properties['ServiceToken'] as string | undefined;

    if (!serviceToken) {
      throw new ProvisioningError(
        `ServiceToken is required for custom resource ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      const requestId = `cdkq-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const responseKey = this.getResponseKey(requestId);
      const responseURL = await this.generateResponseURL(responseKey);

      const request = {
        RequestType: 'Update',
        RequestId: requestId,
        ResponseURL: responseURL,
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        PhysicalResourceId: physicalId,
        StackId: `arn:aws:cloudformation:us-east-1:000000000000:stack/cdkq-${logicalId}/cdkq`,
        ResourceProperties: this.stringifyProperties(properties),
        OldResourceProperties: this.stringifyProperties(previousProperties),
      };

      this.logger.debug(`Sending custom resource update request: ${serviceToken}`);

      const cfnResponse = await this.sendRequest(
        serviceToken,
        request,
        responseKey,
        logicalId,
        'Update'
      );

      if (cfnResponse.Status === 'FAILED') {
        throw new Error(
          `Custom resource handler returned FAILED: ${cfnResponse.Reason || 'Unknown reason'}`
        );
      }

      const newPhysicalId: string = cfnResponse.PhysicalResourceId || physicalId;
      const wasReplaced: boolean = newPhysicalId !== physicalId;
      const attributes: Record<string, unknown> = cfnResponse.Data || {};

      this.logger.debug(
        `Successfully updated custom resource ${logicalId}: ${newPhysicalId}${wasReplaced ? ' (replaced)' : ''}`
      );

      return { physicalId: newPhysicalId, wasReplaced, attributes };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update custom resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a custom resource by invoking its Lambda handler
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting custom resource ${logicalId}: ${physicalId} (${resourceType})`);

    if (!properties) {
      this.logger.warn(
        `No properties available for custom resource ${logicalId}, skipping deletion`
      );
      return;
    }

    const serviceToken = properties['ServiceToken'] as string | undefined;

    if (!serviceToken) {
      this.logger.warn(`No ServiceToken found for custom resource ${logicalId}, skipping deletion`);
      return;
    }

    try {
      const requestId = `cdkq-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const responseKey = this.getResponseKey(requestId);
      const responseURL = await this.generateResponseURL(responseKey);

      const request = {
        RequestType: 'Delete',
        RequestId: requestId,
        ResponseURL: responseURL,
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        PhysicalResourceId: physicalId,
        StackId: `arn:aws:cloudformation:us-east-1:000000000000:stack/cdkq-${logicalId}/cdkq`,
        ResourceProperties: this.stringifyProperties(properties),
      };

      this.logger.debug(`Sending custom resource delete request: ${serviceToken}`);

      const cfnResponse = await this.sendRequest(
        serviceToken,
        request,
        responseKey,
        logicalId,
        'Delete'
      );

      if (cfnResponse.Status === 'FAILED') {
        this.logger.warn(
          `Custom resource delete handler returned FAILED for ${logicalId}: ${cfnResponse.Reason || 'Unknown reason'}`
        );
      } else {
        this.logger.debug(`Successfully deleted custom resource ${logicalId}`);
      }
    } catch (error) {
      // For deletion, we should be more lenient with errors
      this.logger.warn(
        `Failed to delete custom resource ${logicalId}, but continuing: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if a ServiceToken is an SNS topic ARN
   */
  isSnsServiceToken(serviceToken: string): boolean {
    return serviceToken.startsWith('arn:aws:sns:');
  }

  /**
   * Send custom resource request via the appropriate service (Lambda or SNS)
   * For Lambda: invokes synchronously and returns the response
   * For SNS: publishes to topic and polls S3 for response
   */
  private async sendRequest(
    serviceToken: string,
    request: Record<string, unknown>,
    responseKey: string,
    logicalId: string,
    operation: string
  ): Promise<CfnCustomResourceResponse> {
    if (this.isSnsServiceToken(serviceToken)) {
      this.logger.debug(`ServiceToken is SNS topic, publishing to: ${serviceToken}`);
      await this.publishToSns(serviceToken, request);
      return await this.pollS3Response(responseKey, logicalId, operation);
    }

    const response = await this.invokeLambda(serviceToken, request);
    return await this.getCustomResourceResponse(response, responseKey, logicalId, operation);
  }

  /**
   * Publish custom resource request to an SNS topic
   */
  private async publishToSns(topicArn: string, request: Record<string, unknown>): Promise<void> {
    await this.snsClient.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(request),
      })
    );
  }

  /**
   * Invoke Lambda function synchronously
   */
  private async invokeLambda(
    serviceToken: string,
    request: Record<string, unknown>
  ): Promise<InvocationResponse> {
    return await this.lambdaClient.send(
      new InvokeCommand({
        FunctionName: serviceToken,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(request)),
      })
    );
  }

  /**
   * Get custom resource response from either Lambda payload or S3
   *
   * Strategy:
   * 1. If Lambda returned a direct payload with Status field → use it (cfn-response inline)
   * 2. If Lambda returned a payload with PhysicalResourceId → use it (simple handler)
   * 3. Otherwise, poll S3 for the response (cfn-response via ResponseURL)
   */
  private async getCustomResourceResponse(
    lambdaResponse: InvocationResponse,
    responseKey: string,
    logicalId: string,
    operation: string
  ): Promise<CfnCustomResourceResponse> {
    // Check for Lambda execution errors
    if (lambdaResponse.FunctionError) {
      const errorPayload = lambdaResponse.Payload
        ? Buffer.from(lambdaResponse.Payload).toString()
        : 'Unknown';
      throw new Error(`Lambda function error (${lambdaResponse.FunctionError}): ${errorPayload}`);
    }

    // Try to parse direct Lambda response
    // Track whether Lambda returned a meaningful payload. If not, this likely indicates
    // an async pattern (e.g., CDK Provider framework with isCompleteHandler that delegates
    // to Step Functions for polling).
    let hasDirectPayload = false;
    try {
      const payload = parseLambdaPayload(lambdaResponse.Payload);

      // Check if this is a full cfn-response (has Status field)
      if (
        'Status' in payload &&
        (payload['Status'] === 'SUCCESS' || payload['Status'] === 'FAILED')
      ) {
        this.logger.debug(`Got direct cfn-response from Lambda for ${logicalId}`);
        await this.cleanupResponseObject(responseKey);
        return payload as unknown as CfnCustomResourceResponse;
      }

      // Check if this is a simple handler response (has PhysicalResourceId but no Status)
      if (payload.PhysicalResourceId || payload.Data) {
        this.logger.debug(`Got simple handler response from Lambda for ${logicalId}`);
        await this.cleanupResponseObject(responseKey);
        const result: CfnCustomResourceResponse = {
          Status: 'SUCCESS',
        };
        if (payload.PhysicalResourceId) {
          result.PhysicalResourceId = payload.PhysicalResourceId;
        }
        if (payload.Data) {
          result.Data = payload.Data;
        }
        return result;
      }

      // Payload parsed but contained no recognizable fields (e.g., empty object from
      // CDK Provider framework after starting Step Functions). Mark as no direct payload.
      hasDirectPayload = Object.keys(payload).length > 0;
    } catch {
      // Payload parsing failed, try S3
      this.logger.debug(`Lambda payload parse failed for ${logicalId}, checking S3 response`);
    }

    // Poll S3 for response (cfn-response module sends to ResponseURL)
    if (!this.responseBucket) {
      this.logger.warn(
        `No response bucket configured for custom resource ${logicalId}. ` +
          `The Lambda handler likely uses cfn-response module which sends to ResponseURL. ` +
          `Configure --state-bucket to enable S3-based response handling.`
      );
      return {
        Status: 'SUCCESS',
        PhysicalResourceId: logicalId,
      };
    }

    // Detect async custom resource pattern (CDK Provider framework with isCompleteHandler).
    // When the framework Lambda starts a Step Functions state machine for async polling,
    // it returns no meaningful payload (empty/null). In this case, the Step Functions
    // will eventually PUT the cfn-response to the ResponseURL, which may take up to
    // the configured totalTimeout (default: 1 hour in CDK).
    // We use a longer timeout for this case vs the short timeout for synchronous handlers.
    const isAsyncPattern = !hasDirectPayload;
    if (isAsyncPattern) {
      this.logger.info(
        `Custom resource ${logicalId} appears to use async Provider framework (no direct Lambda response). ` +
          `Waiting up to ${Math.round(this.asyncResponseTimeoutMs / 60_000)} minutes for Step Functions completion.`
      );
    } else {
      this.logger.debug(`Waiting for S3 response from Lambda for ${logicalId} (${operation})`);
    }

    const timeoutMs = isAsyncPattern ? this.asyncResponseTimeoutMs : this.SYNC_RESPONSE_TIMEOUT_MS;
    return await this.pollS3Response(responseKey, logicalId, operation, timeoutMs, isAsyncPattern);
  }

  /**
   * Generate a pre-signed S3 PUT URL for Lambda to send its response
   */
  private async generateResponseURL(responseKey: string): Promise<string> {
    if (!this.responseBucket) {
      // Fallback: return a dummy URL (legacy behavior)
      return 'https://localhost/cfn-response-not-configured';
    }

    // Create an empty placeholder object first (so the key exists for cleanup)
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.responseBucket,
        Key: responseKey,
        Body: '',
        ContentType: 'application/json',
      })
    );

    // Generate pre-signed PUT URL (valid for 2 hours to accommodate async Provider framework
    // patterns where Step Functions may poll isCompleteHandler for up to 1 hour)
    // Don't specify ContentType so any Content-Type is accepted (cfn-response may send different types)
    const command = new PutObjectCommand({
      Bucket: this.responseBucket,
      Key: responseKey,
    });

    const presignedUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 7200,
    });

    this.logger.debug(
      `Generated pre-signed URL for response: s3://${this.responseBucket}/${responseKey}`
    );
    return presignedUrl;
  }

  /**
   * Poll S3 for the custom resource response
   *
   * Uses exponential backoff for polling interval:
   * - Sync mode (standard handlers): starts at 2s, no backoff (short timeout)
   * - Async mode (Provider framework with isCompleteHandler): starts at 2s, backs off to 30s max
   *
   * @param responseKey S3 key where response will be written
   * @param logicalId Logical resource ID for logging
   * @param operation Operation type (Create/Update/Delete) for logging
   * @param timeoutMs Maximum time to wait for response
   * @param useBackoff Whether to use exponential backoff (for async/long-running operations)
   */
  private async pollS3Response(
    responseKey: string,
    logicalId: string,
    operation: string,
    timeoutMs: number = this.SYNC_RESPONSE_TIMEOUT_MS,
    useBackoff: boolean = false
  ): Promise<CfnCustomResourceResponse> {
    const startTime = Date.now();
    let currentInterval = this.INITIAL_POLL_INTERVAL_MS;
    let pollCount = 0;

    while (Date.now() - startTime < timeoutMs) {
      pollCount++;
      try {
        const response = await this.s3Client.send(
          new GetObjectCommand({
            Bucket: this.responseBucket!,
            Key: responseKey,
          })
        );

        const body = await response.Body?.transformToString();
        if (body && body.length > 0) {
          this.logger.debug(`Got S3 response for ${logicalId}: ${body.substring(0, 200)}`);

          try {
            const cfnResponse = JSON.parse(body) as CfnCustomResourceResponse;

            // Validate response has required fields
            if (cfnResponse.Status === 'SUCCESS' || cfnResponse.Status === 'FAILED') {
              // Cleanup the response object
              await this.cleanupResponseObject(responseKey);
              return cfnResponse;
            }
          } catch {
            // JSON parse failed, response not yet written properly
            this.logger.debug(`S3 response not yet valid JSON for ${logicalId}, retrying...`);
          }
        }
      } catch (error) {
        const err = error as { name?: string };
        if (err.name !== 'NoSuchKey') {
          this.logger.debug(`Error reading S3 response for ${logicalId}: ${err.name}`);
        }
      }

      await this.sleep(currentInterval);

      // Apply exponential backoff for async patterns (long-running operations)
      if (useBackoff) {
        currentInterval = Math.min(currentInterval * 1.5, this.MAX_POLL_INTERVAL_MS);

        // Log progress periodically for long-running operations
        if (pollCount % 10 === 0) {
          const elapsedSec = Math.round((Date.now() - startTime) / 1000);
          this.logger.info(
            `Still waiting for async custom resource ${logicalId} (${operation})... ` +
              `${elapsedSec}s elapsed, polling every ${Math.round(currentInterval / 1000)}s`
          );
        }
      }
    }

    // Cleanup on timeout
    await this.cleanupResponseObject(responseKey);

    const elapsedMin = Math.round((Date.now() - startTime) / 60_000);
    throw new Error(
      `Timeout waiting for custom resource response for ${logicalId} (${operation}) ` +
        `after ${elapsedMin} minutes. ` +
        (useBackoff
          ? `The async custom resource handler (Provider framework with isCompleteHandler) did not complete within the timeout. ` +
            `Check the Step Functions execution and isCompleteHandler Lambda logs for errors.`
          : `The Lambda handler may not be sending a response to ResponseURL.`)
    );
  }

  /**
   * Get S3 key for response object
   */
  private getResponseKey(requestId: string): string {
    return `${this.responsePrefix}/${requestId}.json`;
  }

  /**
   * Cleanup response object from S3
   */
  private async cleanupResponseObject(responseKey: string): Promise<void> {
    if (!this.responseBucket) return;

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.responseBucket,
          Key: responseKey,
        })
      );
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Convert property values to strings for CloudFormation compatibility
   *
   * CloudFormation converts all ResourceProperties values to strings before
   * passing them to Lambda handlers. Some CDK internal handlers (like
   * BucketNotificationsHandler) depend on this behavior (e.g., calling .lower()
   * on boolean values).
   */
  private stringifyProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === 'boolean') {
        result[key] = String(value);
      } else if (typeof value === 'number') {
        result[key] = String(value);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.stringifyProperties(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
