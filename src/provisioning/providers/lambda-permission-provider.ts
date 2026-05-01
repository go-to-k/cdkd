import {
  LambdaClient,
  AddPermissionCommand,
  RemovePermissionCommand,
  ResourceNotFoundException,
  type FunctionUrlAuthType,
} from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS Lambda Permission Provider
 *
 * Implements resource provisioning for AWS::Lambda::Permission using the Lambda SDK.
 * WHY: AddPermission is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LambdaPermissionProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private logger = getLogger().child('LambdaPermissionProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::Permission',
      new Set([
        'FunctionName',
        'Action',
        'Principal',
        'SourceArn',
        'SourceAccount',
        'PrincipalOrgID',
        'EventSourceToken',
        'FunctionUrlAuthType',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * Create a Lambda permission
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Lambda permission ${logicalId}`);

    const functionName = properties['FunctionName'] as string;
    if (!functionName) {
      throw new ProvisioningError(
        `FunctionName is required for Lambda permission ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const action = properties['Action'] as string;
    if (!action) {
      throw new ProvisioningError(
        `Action is required for Lambda permission ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const principal = properties['Principal'] as string;
    if (!principal) {
      throw new ProvisioningError(
        `Principal is required for Lambda permission ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Generate a unique StatementId from the logicalId (max 100 chars)
    let statementId = logicalId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (statementId.length > 100) {
      // Simple hash: sum char codes and convert to hex
      let hashNum = 0;
      for (let i = 0; i < logicalId.length; i++) {
        hashNum = ((hashNum << 5) - hashNum + logicalId.charCodeAt(i)) | 0;
      }
      const hash = Math.abs(hashNum).toString(16).padStart(8, '0').substring(0, 8);
      statementId = `${statementId.substring(0, 91)}-${hash}`;
    }

    try {
      const addParams: import('@aws-sdk/client-lambda').AddPermissionCommandInput = {
        FunctionName: functionName,
        StatementId: statementId,
        Action: action,
        Principal: principal,
      };
      if (properties['SourceArn']) addParams.SourceArn = properties['SourceArn'] as string;
      if (properties['SourceAccount'])
        addParams.SourceAccount = properties['SourceAccount'] as string;
      if (properties['PrincipalOrgID'])
        addParams.PrincipalOrgID = properties['PrincipalOrgID'] as string;
      if (properties['EventSourceToken'])
        addParams.EventSourceToken = properties['EventSourceToken'] as string;
      if (properties['FunctionUrlAuthType'])
        addParams.FunctionUrlAuthType = properties['FunctionUrlAuthType'] as FunctionUrlAuthType;

      await this.lambdaClient.send(new AddPermissionCommand(addParams));

      this.logger.debug(`Successfully created Lambda permission ${logicalId}: ${statementId}`);

      return {
        physicalId: statementId,
        attributes: {
          Id: statementId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Lambda permission ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        statementId,
        cause
      );
    }
  }

  /**
   * Update a Lambda permission
   *
   * Lambda permissions cannot be updated in-place. Remove old and add new.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Lambda permission ${logicalId}: ${physicalId}`);

    try {
      // Remove old permission
      const oldFunctionName =
        (previousProperties['FunctionName'] as string) || (properties['FunctionName'] as string);

      // physicalId may be in "functionArn|statementId" format (from CC API)
      const oldStatementId = physicalId.includes('|') ? physicalId.split('|').pop()! : physicalId;

      try {
        await this.lambdaClient.send(
          new RemovePermissionCommand({
            FunctionName: oldFunctionName,
            StatementId: oldStatementId,
          })
        );
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) {
          throw error;
        }
        this.logger.debug(`Old permission ${oldStatementId} not found, continuing with add`);
      }

      // Add new permission
      const createResult = await this.create(logicalId, resourceType, properties);

      return {
        physicalId: createResult.physicalId,
        wasReplaced: false,
        attributes: createResult.attributes ?? {},
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Lambda permission ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Lambda permission
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Lambda permission ${logicalId}: ${physicalId}`);

    const functionName = properties?.['FunctionName'] as string | undefined;
    if (!functionName) {
      this.logger.warn(
        `FunctionName not available for Lambda permission ${logicalId}, skipping deletion`
      );
      return;
    }

    // physicalId may be in "functionArn|statementId" format (from CC API)
    // Extract just the statementId part
    let statementId = physicalId;
    if (physicalId.includes('|')) {
      statementId = physicalId.split('|').pop()!;
    }

    try {
      await this.lambdaClient.send(
        new RemovePermissionCommand({
          FunctionName: functionName,
          StatementId: statementId,
        })
      );
      this.logger.debug(`Successfully deleted Lambda permission ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Lambda permission ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda permission ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
