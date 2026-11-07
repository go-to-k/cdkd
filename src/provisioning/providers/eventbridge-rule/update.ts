import type { EventBridgeRuleProvider, RuleTarget } from '../eventbridge-rule-provider.js';
import {
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type Tag,
} from '@aws-sdk/client-eventbridge';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch } from '../../region-check.js';
import { generatedNameFor } from '../../resource-name.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';

/**
 * Update an EventBridge rule
 */
export async function update(
  this: EventBridgeRuleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating EventBridge rule ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: the update addresses the rule by NAME and `PutRule` is an upsert, so a
  // client in another region than the state record would rewrite a same-named rule cdkd does
  // not manage, or create one there, and then retarget it. Refuse before any call; the
  // client's region is resolved only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.eventBridgeClient.config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  // go-to-k/cdkd#5064: `PutRule` is an upsert by name, so a re-derived name
  // that differs from the recorded rule's would CREATE a second rule: by the
  // naming scheme (a v13 stack holding a legacy name), or outside the stack's
  // scope (`drift --revert`). A rule's `Name` is create-only, so an update
  // never renames one: a rule the template does not name keeps the name its
  // ARN (`rule/[<bus>/]<name>`) carries.
  const recordedRuleName = physicalId.split('/').pop() ?? '';
  const declaredRuleName = properties['Name'] as string | undefined;
  const ruleName =
    declaredRuleName || recordedRuleName || generatedNameFor('AWS::Events::Rule', logicalId);
  const newTargets = properties['Targets'] as RuleTarget[] | undefined;
  const oldTargets = previousProperties['Targets'] as RuleTarget[] | undefined;

  try {
    // Update rule properties
    const putRuleParams: Record<string, unknown> = {
      Name: ruleName,
    };

    if (properties['Description'] !== undefined) {
      putRuleParams['Description'] = properties['Description'];
    }
    if (properties['EventBusName'] !== undefined) {
      putRuleParams['EventBusName'] = properties['EventBusName'];
    }
    if (properties['EventPattern'] !== undefined) {
      putRuleParams['EventPattern'] =
        typeof properties['EventPattern'] === 'string'
          ? properties['EventPattern']
          : JSON.stringify(properties['EventPattern']);
    }
    if (properties['State'] !== undefined) {
      putRuleParams['State'] = properties['State'];
    }
    if (properties['ScheduleExpression'] !== undefined) {
      putRuleParams['ScheduleExpression'] = properties['ScheduleExpression'];
    }
    if (properties['RoleArn'] !== undefined) {
      putRuleParams['RoleArn'] = properties['RoleArn'];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    const response = await this.eventBridgeClient.send(new PutRuleCommand(putRuleParams as any));

    const ruleArn = response.RuleArn!;

    // Update targets if changed
    const eventBusName = properties['EventBusName'] as string | undefined;

    // Remove old targets that are no longer present
    if (oldTargets && oldTargets.length > 0) {
      const newTargetIds = new Set((newTargets || []).map((t) => t.Id));
      const targetsToRemove = oldTargets.filter((t) => !newTargetIds.has(t.Id)).map((t) => t.Id);

      if (targetsToRemove.length > 0) {
        await this.eventBridgeClient.send(
          new RemoveTargetsCommand({
            Rule: ruleName,
            EventBusName: eventBusName,
            Ids: targetsToRemove,
          })
        );
        this.logger.debug(`Removed ${targetsToRemove.length} targets from rule ${ruleName}`);
      }
    }

    // Add/update new targets
    if (newTargets && newTargets.length > 0) {
      await this.eventBridgeClient.send(
        new PutTargetsCommand({
          Rule: ruleName,
          EventBusName: eventBusName,
          Targets: this.toSdkTargets(newTargets),
        })
      );
      this.logger.debug(`Updated ${newTargets.length} targets on rule ${ruleName}`);
    }

    // Update Tags if changed. Both sides are read through `planTagDiff`
    // (go-to-k/cdkd#3994): an unreadable record untags nothing.
    const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    if (plan.set.size > 0 || plan.remove.length > 0) {
      // Remove tags the template no longer names
      if (plan.remove.length > 0) {
        await this.eventBridgeClient.send(
          new UntagResourceCommand({
            ResourceARN: ruleArn,
            TagKeys: plan.remove,
          })
        );
      }
      // Apply added / changed tags
      if (plan.set.size > 0) {
        const tagsToAdd: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
        await this.eventBridgeClient.send(
          new TagResourceCommand({
            ResourceARN: ruleArn,
            Tags: tagsToAdd,
          })
        );
      }
      this.logger.debug(`Updated tags for rule ${ruleName}`);
    }

    this.logger.debug(`Successfully updated EventBridge rule ${logicalId}`);

    return {
      physicalId: ruleArn,
      wasReplaced: false,
      attributes: {
        Arn: ruleArn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update EventBridge rule ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
