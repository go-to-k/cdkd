/**
 * SDK Provider for AWS::BedrockAgentCore::Runtime
 *
 * Uses direct SDK calls instead of Cloud Control API because:
 * 1. CC API CREATE is async - it returns IN_PROGRESS, then polls for completion
 * 2. IAM role propagation to BedrockAgentCore is very slow (30-60+ seconds)
 * 3. When CC API polling returns FAILED (role validation), cdkd retries CREATE
 * 4. But the first CREATE actually succeeded asynchronously in the background
 * 5. The retry then fails with "already exists"
 * 6. CC API ClientToken caches the failure result, making it worse
 *
 * With direct SDK calls, we can:
 * - Call CreateAgentRuntime synchronously
 * - Get immediate error responses for IAM propagation issues
 * - Retry with proper exponential backoff
 * - Avoid the async CREATE + polling + retry conflict
 */
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  UpdateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getLogger } from '../../utils/logger.js';

/**
 * Recursively convert PascalCase object keys to camelCase.
 * Only converts keys of plain objects; string values, arrays of strings,
 * and other primitives are left untouched.
 */
function pascalToCamelCaseKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(pascalToCamelCaseKeys);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const camelKey = key.charAt(0).toLowerCase() + key.slice(1);
      result[camelKey] = pascalToCamelCaseKeys(val);
    }
    return result;
  }
  return value;
}
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS BedrockAgentCore Runtime Provider
 *
 * Implements resource provisioning for AWS::BedrockAgentCore::Runtime using the
 * BedrockAgentCoreControl SDK.
 */
export class AgentCoreRuntimeProvider implements ResourceProvider {
  private client: BedrockAgentCoreControlClient;
  private logger = getLogger().child('AgentCoreRuntimeProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.client = awsClients.bedrockAgentCoreControl;
  }

  /**
   * Create a BedrockAgentCore Runtime
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating BedrockAgentCore Runtime ${logicalId}`);

    const agentRuntimeName = properties['AgentRuntimeName'] as string;
    if (!agentRuntimeName) {
      throw new ProvisioningError(
        `AgentRuntimeName is required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const roleArn = properties['RoleArn'] as string;
    if (!roleArn) {
      throw new ProvisioningError(`RoleArn is required for ${logicalId}`, resourceType, logicalId);
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input: Record<string, any> = {
        agentRuntimeName,
        roleArn,
      };

      if (properties['AgentRuntimeArtifact'] !== undefined) {
        input['agentRuntimeArtifact'] = pascalToCamelCaseKeys(properties['AgentRuntimeArtifact']);
      }
      if (properties['NetworkConfiguration'] !== undefined) {
        input['networkConfiguration'] = pascalToCamelCaseKeys(properties['NetworkConfiguration']);
      }
      if (properties['Description'] !== undefined) {
        input['description'] = properties['Description'];
      }
      if (properties['AuthorizerConfiguration'] !== undefined) {
        input['authorizerConfiguration'] = pascalToCamelCaseKeys(
          properties['AuthorizerConfiguration']
        );
      }
      if (properties['ProtocolConfiguration'] !== undefined) {
        // CFn template has ProtocolConfiguration as a string (e.g. "HTTP"),
        // but the SDK expects an object { serverProtocol: "HTTP" }
        const proto = properties['ProtocolConfiguration'];
        if (typeof proto === 'string') {
          input['protocolConfiguration'] = { serverProtocol: proto };
        } else {
          input['protocolConfiguration'] = pascalToCamelCaseKeys(proto);
        }
      }
      // Skip empty LifecycleConfiguration (CFn template may have {} which SDK rejects)
      if (
        properties['LifecycleConfiguration'] !== undefined &&
        typeof properties['LifecycleConfiguration'] === 'object' &&
        properties['LifecycleConfiguration'] !== null &&
        Object.keys(properties['LifecycleConfiguration'] as Record<string, unknown>).length > 0
      ) {
        input['lifecycleConfiguration'] = pascalToCamelCaseKeys(
          properties['LifecycleConfiguration']
        );
      }
      if (properties['EnvironmentVariables'] !== undefined) {
        input['environmentVariables'] = properties['EnvironmentVariables'];
      }
      if (properties['ClientToken'] !== undefined) {
        input['clientToken'] = properties['ClientToken'];
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      const response = await this.client.send(new CreateAgentRuntimeCommand(input as any));

      const agentRuntimeId = response.agentRuntimeId!;
      const agentRuntimeArn = response.agentRuntimeArn!;

      this.logger.debug(`Created BedrockAgentCore Runtime: ${agentRuntimeId} (${agentRuntimeArn})`);

      return {
        physicalId: agentRuntimeId,
        attributes: {
          Arn: agentRuntimeArn,
          AgentRuntimeId: agentRuntimeId,
          AgentRuntimeName: agentRuntimeName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create BedrockAgentCore Runtime ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a BedrockAgentCore Runtime
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating BedrockAgentCore Runtime ${logicalId}: ${physicalId}`);

    const roleArn = properties['RoleArn'] as string;
    if (!roleArn) {
      throw new ProvisioningError(
        `RoleArn is required for ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input: Record<string, any> = {
        agentRuntimeId: physicalId,
        roleArn,
      };

      if (properties['AgentRuntimeArtifact'] !== undefined) {
        input['agentRuntimeArtifact'] = pascalToCamelCaseKeys(properties['AgentRuntimeArtifact']);
      }
      if (properties['NetworkConfiguration'] !== undefined) {
        input['networkConfiguration'] = pascalToCamelCaseKeys(properties['NetworkConfiguration']);
      }
      if (properties['Description'] !== undefined) {
        input['description'] = properties['Description'];
      }
      if (properties['AuthorizerConfiguration'] !== undefined) {
        input['authorizerConfiguration'] = pascalToCamelCaseKeys(
          properties['AuthorizerConfiguration']
        );
      }
      if (properties['ProtocolConfiguration'] !== undefined) {
        const proto = properties['ProtocolConfiguration'];
        if (typeof proto === 'string') {
          input['protocolConfiguration'] = { serverProtocol: proto };
        } else {
          input['protocolConfiguration'] = pascalToCamelCaseKeys(proto);
        }
      }
      if (
        properties['LifecycleConfiguration'] !== undefined &&
        typeof properties['LifecycleConfiguration'] === 'object' &&
        properties['LifecycleConfiguration'] !== null &&
        Object.keys(properties['LifecycleConfiguration'] as Record<string, unknown>).length > 0
      ) {
        input['lifecycleConfiguration'] = pascalToCamelCaseKeys(
          properties['LifecycleConfiguration']
        );
      }
      if (properties['EnvironmentVariables'] !== undefined) {
        input['environmentVariables'] = properties['EnvironmentVariables'];
      }
      if (properties['ClientToken'] !== undefined) {
        input['clientToken'] = properties['ClientToken'];
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      const response = await this.client.send(new UpdateAgentRuntimeCommand(input as any));

      const agentRuntimeArn = response.agentRuntimeArn!;
      const agentRuntimeId = response.agentRuntimeId!;

      this.logger.debug(`Successfully updated BedrockAgentCore Runtime ${logicalId}`);

      return {
        physicalId: agentRuntimeId,
        wasReplaced: false,
        attributes: {
          Arn: agentRuntimeArn,
          AgentRuntimeId: agentRuntimeId,
          AgentRuntimeName: properties['AgentRuntimeName'] as string,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update BedrockAgentCore Runtime ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a BedrockAgentCore Runtime
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting BedrockAgentCore Runtime ${logicalId}: ${physicalId}`);

    try {
      await this.client.send(
        new DeleteAgentRuntimeCommand({
          agentRuntimeId: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted BedrockAgentCore Runtime ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        this.logger.debug(`Runtime ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete BedrockAgentCore Runtime ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution)
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Arn' || attributeName === 'AgentRuntimeArn') {
      const response = await this.client.send(
        new GetAgentRuntimeCommand({ agentRuntimeId: physicalId })
      );
      return response.agentRuntimeArn;
    }

    if (attributeName === 'AgentRuntimeId') {
      return physicalId;
    }

    if (attributeName === 'AgentRuntimeName') {
      const response = await this.client.send(
        new GetAgentRuntimeCommand({ agentRuntimeId: physicalId })
      );
      return response.agentRuntimeName;
    }

    throw new Error(`Unsupported attribute: ${attributeName} for AWS::BedrockAgentCore::Runtime`);
  }
}
