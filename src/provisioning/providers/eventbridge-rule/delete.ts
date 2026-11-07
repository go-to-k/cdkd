import type { EventBridgeRuleProvider } from '../eventbridge-rule-provider.js';
import {
  RemoveTargetsCommand,
  DeleteRuleCommand,
  ListTargetsByRuleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-eventbridge';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markDeleteStarted } from '../../delete-started.js';

/**
 * Delete an EventBridge rule
 *
 * Before deleting, removes all targets (required by EventBridge API).
 */
export async function deleteImpl(
  this: EventBridgeRuleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting EventBridge rule ${logicalId}: ${physicalId}`);

  // Extract rule name from ARN (format: arn:aws:events:region:account:rule/rule-name or rule/bus-name/rule-name)
  const ruleName = this.extractRuleNameFromArn(physicalId);
  // A custom-bus rule MUST be addressed with its EventBusName — the
  // Name-only form targets the default bus, so ListTargetsByRule /
  // DeleteRule would report ResourceNotFound and the delete would
  // silently no-op, orphaning the rule (issue #955).
  const busParam = this.busParamFromArn(physicalId);
  // go-to-k/cdkd#4946: set once targets are removed, so a refused
  // `DeleteRule` is never read as a whole survivor.
  let stripped = false;

  try {
    // List all targets for this rule
    let targetIds: string[] = [];
    try {
      const targetsResponse = await this.eventBridgeClient.send(
        new ListTargetsByRuleCommand({ Rule: ruleName, ...busParam })
      );
      targetIds = (targetsResponse.Targets || [])
        .map((t) => t.Id)
        .filter((id): id is string => id !== undefined);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.eventBridgeClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Rule ${ruleName} does not exist, skipping deletion`);
        return;
      }
      throw error;
    }

    // Remove all targets before deleting the rule
    if (targetIds.length > 0) {
      await this.eventBridgeClient.send(
        new RemoveTargetsCommand({
          Rule: ruleName,
          Ids: targetIds,
          ...busParam,
        })
      );
      stripped = true;
      this.logger.debug(`Removed ${targetIds.length} targets from rule ${ruleName}`);
    }

    // Delete the rule
    await this.eventBridgeClient.send(new DeleteRuleCommand({ Name: ruleName, ...busParam }));

    this.logger.debug(`Successfully deleted EventBridge rule ${logicalId}`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.eventBridgeClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Rule ${ruleName} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const failure = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete EventBridge rule ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    throw stripped ? markDeleteStarted(failure) : failure;
  }
}
