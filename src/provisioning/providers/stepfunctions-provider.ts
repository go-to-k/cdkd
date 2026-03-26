import {
  SFNClient,
  CreateStateMachineCommand,
  UpdateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeStateMachineCommand,
  StateMachineDoesNotExist,
  type CreateStateMachineCommandInput,
  type LoggingConfiguration,
  type TracingConfiguration,
  type Tag,
  type StateMachineType,
} from '@aws-sdk/client-sfn';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS Step Functions State Machine Provider
 *
 * Implements resource provisioning for AWS::StepFunctions::StateMachine using the SFN SDK.
 * WHY: SFN CreateStateMachine is synchronous - the CC API adds unnecessary polling
 * overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class StepFunctionsProvider implements ResourceProvider {
  private sfnClient?: SFNClient;
  private logger = getLogger().child('StepFunctionsProvider');

  private getClient(): SFNClient {
    if (!this.sfnClient) {
      this.sfnClient = new SFNClient({});
    }
    return this.sfnClient;
  }

  /**
   * Create a Step Functions state machine
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Step Functions state machine ${logicalId}`);

    const stateMachineName = (properties['StateMachineName'] as string | undefined) || logicalId;
    const roleArn = properties['RoleArn'] as string | undefined;

    if (!roleArn) {
      throw new ProvisioningError(
        `RoleArn is required for Step Functions state machine ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Build definition string - handle both string and object forms
      const definitionString = this.buildDefinitionString(properties);

      // Build tags: CDK uses [{Key, Value}], SFN SDK uses [{key, value}]
      let tags: Tag[] | undefined;
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        tags = tagList.map((tag) => ({ key: tag.Key, value: tag.Value }));
      }

      const createParams: CreateStateMachineCommandInput = {
        name: stateMachineName,
        definition: definitionString,
        roleArn: roleArn,
        type: properties['StateMachineType'] as StateMachineType | undefined,
        loggingConfiguration: properties['LoggingConfiguration'] as
          | LoggingConfiguration
          | undefined,
        tracingConfiguration: properties['TracingConfiguration'] as
          | TracingConfiguration
          | undefined,
        tags: tags,
      };

      const response = await this.getClient().send(new CreateStateMachineCommand(createParams));

      const stateMachineArn = response.stateMachineArn;
      if (!stateMachineArn) {
        throw new Error('CreateStateMachine did not return stateMachineArn');
      }

      this.logger.debug(
        `Successfully created Step Functions state machine ${logicalId}: ${stateMachineArn}`
      );

      // Extract name from ARN (last segment after :)
      const name = stateMachineArn.split(':').pop() || stateMachineName;

      return {
        physicalId: stateMachineArn,
        attributes: {
          Arn: stateMachineArn,
          Name: name,
          StateMachineRevisionId: response.stateMachineVersionArn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Step Functions state machine ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        stateMachineName,
        cause
      );
    }
  }

  /**
   * Update a Step Functions state machine
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Step Functions state machine ${logicalId}: ${physicalId}`);

    try {
      const definitionString = this.buildDefinitionString(properties);

      await this.getClient().send(
        new UpdateStateMachineCommand({
          stateMachineArn: physicalId,
          definition: definitionString,
          roleArn: properties['RoleArn'] as string | undefined,
          loggingConfiguration: properties['LoggingConfiguration'] as
            | LoggingConfiguration
            | undefined,
          tracingConfiguration: properties['TracingConfiguration'] as
            | TracingConfiguration
            | undefined,
        })
      );

      this.logger.debug(`Updated Step Functions state machine ${physicalId}`);

      // Describe to get updated attributes
      const describeResponse = await this.getClient().send(
        new DescribeStateMachineCommand({ stateMachineArn: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: physicalId,
          Name: describeResponse.name,
          StateMachineRevisionId: describeResponse.revisionId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Step Functions state machine ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Step Functions state machine
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting Step Functions state machine ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteStateMachineCommand({ stateMachineArn: physicalId }));
      this.logger.debug(`Successfully deleted Step Functions state machine ${logicalId}`);
    } catch (error) {
      if (error instanceof StateMachineDoesNotExist) {
        this.logger.debug(
          `Step Functions state machine ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Step Functions state machine ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Build definition string from CDK properties.
   * Handles both DefinitionString (string) and DefinitionString (object) forms.
   */
  private buildDefinitionString(properties: Record<string, unknown>): string {
    const definitionString = properties['DefinitionString'];
    const definition = properties['Definition'];

    if (definitionString !== undefined) {
      if (typeof definitionString === 'string') {
        return definitionString;
      }
      // Object form - stringify it
      return JSON.stringify(definitionString);
    }

    if (definition !== undefined) {
      if (typeof definition === 'string') {
        return definition;
      }
      return JSON.stringify(definition);
    }

    // Empty definition - SFN API will reject this, but let it through
    // for consistent error reporting from the API
    return '{}';
  }
}
