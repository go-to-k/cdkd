import { LambdaClient, InvokeCommand, type InvocationResponse } from '@aws-sdk/client-lambda';
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
 * Response handling strategy:
 * 1. Generate a pre-signed S3 PUT URL as the ResponseURL
 * 2. Invoke Lambda synchronously (RequestResponse)
 * 3. Check Lambda payload for direct response (simple handlers)
 * 4. If no direct response, read the response from S3 (cfn-response handlers)
 */
export class CustomResourceProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private s3Client: S3Client;
  private logger = getLogger().child('CustomResourceProvider');
  private responseBucket: string | undefined;
  private responsePrefix: string;

  /** Max time to wait for S3 response after Lambda invocation (30 seconds) */
  private readonly RESPONSE_WAIT_TIMEOUT_MS = 30_000;
  /** Poll interval for checking S3 response (1 second) */
  private readonly RESPONSE_POLL_INTERVAL_MS = 1_000;

  constructor(config?: CustomResourceProviderConfig) {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
    this.s3Client = awsClients.s3;
    this.responseBucket = config?.responseBucket;
    this.responsePrefix = config?.responsePrefix ?? 'custom-resource-responses';
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
        ResourceProperties: properties,
      };

      this.logger.debug(`Invoking Lambda for custom resource create: ${serviceToken}`);

      const response = await this.invokeLambda(serviceToken, request);
      const cfnResponse = await this.getCustomResourceResponse(
        response,
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
        ResourceProperties: properties,
        OldResourceProperties: previousProperties,
      };

      this.logger.debug(`Invoking Lambda for custom resource update: ${serviceToken}`);

      const response = await this.invokeLambda(serviceToken, request);
      const cfnResponse = await this.getCustomResourceResponse(
        response,
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
        ResourceProperties: properties,
      };

      this.logger.debug(`Invoking Lambda for custom resource delete: ${serviceToken}`);

      const response = await this.invokeLambda(serviceToken, request);
      const cfnResponse = await this.getCustomResourceResponse(
        response,
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

    this.logger.debug(`Waiting for S3 response from Lambda for ${logicalId} (${operation})`);
    return await this.pollS3Response(responseKey, logicalId, operation);
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

    // Generate pre-signed PUT URL (valid for 5 minutes)
    // Don't specify ContentType so any Content-Type is accepted (cfn-response may send different types)
    const command = new PutObjectCommand({
      Bucket: this.responseBucket,
      Key: responseKey,
    });

    const presignedUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 300,
    });

    this.logger.debug(
      `Generated pre-signed URL for response: s3://${this.responseBucket}/${responseKey}`
    );
    return presignedUrl;
  }

  /**
   * Poll S3 for the custom resource response
   */
  private async pollS3Response(
    responseKey: string,
    logicalId: string,
    operation: string
  ): Promise<CfnCustomResourceResponse> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.RESPONSE_WAIT_TIMEOUT_MS) {
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

      await this.sleep(this.RESPONSE_POLL_INTERVAL_MS);
    }

    // Cleanup on timeout
    await this.cleanupResponseObject(responseKey);

    throw new Error(
      `Timeout waiting for custom resource response for ${logicalId} (${operation}) ` +
        `after ${this.RESPONSE_WAIT_TIMEOUT_MS / 1000}s. ` +
        `The Lambda handler may not be sending a response to ResponseURL.`
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
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
