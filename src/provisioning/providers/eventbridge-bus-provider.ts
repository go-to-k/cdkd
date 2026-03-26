import {
  EventBridgeClient,
  CreateEventBusCommand,
  DeleteEventBusCommand,
  ListRulesCommand,
  RemoveTargetsCommand,
  DeleteRuleCommand,
  ListTargetsByRuleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-eventbridge';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::Events::EventBus
 *
 * Uses direct SDK calls instead of Cloud Control API because:
 * - CC API deletes EventBus in parallel with Rules on the same bus
 * - EventBridge rejects EventBus deletion while Rules still exist
 * - SDK Provider ensures all Rules+Targets are cleaned up before bus deletion
 */
export class EventBridgeBusProvider implements ResourceProvider {
  private eventBridgeClient: EventBridgeClient;
  private logger = getLogger().child('EventBridgeBusProvider');

  constructor() {
    this.eventBridgeClient = getAwsClients().eventBridge;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    const name = properties['Name'] as string;
    if (!name) {
      throw new ProvisioningError(
        `Name is required for EventBus ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Creating EventBus ${logicalId}: ${name}`);

    try {
      const response = await this.eventBridgeClient.send(new CreateEventBusCommand({ Name: name }));

      return {
        physicalId: name,
        attributes: {
          Arn: response.EventBusArn ?? '',
          Name: name,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EventBus ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(_logicalId: string, physicalId: string): Promise<ResourceUpdateResult> {
    // EventBus properties are immutable (Name can't change)
    return { physicalId, wasReplaced: false, attributes: {} };
  }

  async delete(logicalId: string, physicalId: string, resourceType: string): Promise<void> {
    this.logger.debug(`Deleting EventBus ${logicalId}: ${physicalId}`);

    try {
      // First, clean up all rules on this bus (they block deletion)
      await this.cleanupRulesOnBus(physicalId);

      // Then delete the bus
      await this.eventBridgeClient.send(new DeleteEventBusCommand({ Name: physicalId }));
      this.logger.debug(`Successfully deleted EventBus ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        this.logger.debug(`EventBus ${physicalId} does not exist, skipping`);
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('does not exist')) {
        this.logger.debug(`EventBus ${physicalId} does not exist, skipping`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EventBus ${logicalId}: ${msg}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Arn') {
      // Can't construct ARN without region/account, return physicalId
      return undefined;
    }
    if (attributeName === 'Name') {
      return physicalId;
    }
    return undefined;
  }

  /**
   * Remove all rules and their targets from an event bus before deletion.
   */
  private async cleanupRulesOnBus(busName: string): Promise<void> {
    try {
      const rulesResponse = await this.eventBridgeClient.send(
        new ListRulesCommand({ EventBusName: busName })
      );

      const rules = rulesResponse.Rules ?? [];
      if (rules.length === 0) return;

      this.logger.debug(`Cleaning up ${rules.length} rule(s) on bus ${busName}`);

      for (const rule of rules) {
        if (!rule.Name) continue;

        // Remove targets first
        try {
          const targetsResponse = await this.eventBridgeClient.send(
            new ListTargetsByRuleCommand({
              Rule: rule.Name,
              EventBusName: busName,
            })
          );

          const targetIds = (targetsResponse.Targets ?? [])
            .map((t) => t.Id)
            .filter((id): id is string => !!id);

          if (targetIds.length > 0) {
            await this.eventBridgeClient.send(
              new RemoveTargetsCommand({
                Rule: rule.Name,
                EventBusName: busName,
                Ids: targetIds,
              })
            );
          }
        } catch {
          // Best-effort target removal
        }

        // Delete the rule
        try {
          await this.eventBridgeClient.send(
            new DeleteRuleCommand({
              Name: rule.Name,
              EventBusName: busName,
            })
          );
        } catch {
          // Best-effort rule removal
        }
      }
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return;
      this.logger.debug(
        `Failed to list rules on bus ${busName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
