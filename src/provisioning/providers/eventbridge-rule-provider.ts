import {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  DeleteRuleCommand,
  DescribeRuleCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  type Tag,
} from '@aws-sdk/client-eventbridge';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * Target definition from CloudFormation AWS::Events::Rule
 */
interface RuleTarget {
  Id: string;
  Arn: string;
  Input?: string;
  InputPath?: string;
  InputTransformer?: {
    InputPathsMap?: Record<string, string>;
    InputTemplate: string;
  };
  RoleArn?: string;
  [key: string]: unknown;
}

/**
 * AWS EventBridge Rule Provider
 *
 * Implements resource provisioning for AWS::Events::Rule using the EventBridge SDK.
 * This is required because Cloud Control API has a bug where creating a Rule with
 * Targets causes a Java NullPointerException.
 */
export class EventBridgeRuleProvider implements ResourceProvider {
  private eventBridgeClient: EventBridgeClient;
  private logger = getLogger().child('EventBridgeRuleProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Events::Rule',
      new Set([
        'Name',
        'Description',
        'EventBusName',
        'EventPattern',
        'State',
        'ScheduleExpression',
        'RoleArn',
        'Targets',
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.eventBridgeClient = awsClients.eventBridge;
  }

  /**
   * Create an EventBridge rule
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating EventBridge rule ${logicalId}`);

    const ruleName =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
    const targets = properties['Targets'] as RuleTarget[] | undefined;

    try {
      // Build PutRule params (without Targets, which must be added separately)
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
        // EventPattern must be a JSON string for the SDK
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

      // Add tags to PutRule if specified
      if (properties['Tags']) {
        putRuleParams['Tags'] = properties['Tags'];
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const response = await this.eventBridgeClient.send(new PutRuleCommand(putRuleParams as any));

      const ruleArn = response.RuleArn!;
      this.logger.debug(`Created EventBridge rule: ${ruleName} (${ruleArn})`);

      // Add targets if specified
      if (targets && targets.length > 0) {
        await this.eventBridgeClient.send(
          new PutTargetsCommand({
            Rule: ruleName,
            EventBusName: properties['EventBusName'] as string | undefined,
            Targets: targets,
          })
        );
        this.logger.debug(`Added ${targets.length} targets to rule ${ruleName}`);
      }

      return {
        physicalId: ruleArn,
        attributes: {
          Arn: ruleArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EventBridge rule ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        ruleName,
        cause
      );
    }
  }

  /**
   * Update an EventBridge rule
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating EventBridge rule ${logicalId}: ${physicalId}`);

    const ruleName =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
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
            Targets: newTargets,
          })
        );
        this.logger.debug(`Updated ${newTargets.length} targets on rule ${ruleName}`);
      }

      // Update Tags if changed
      const newTags = properties['Tags'] as Tag[] | undefined;
      const oldTags = previousProperties['Tags'] as Tag[] | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        // Remove old tags
        if (oldTags && oldTags.length > 0) {
          const oldTagKeys = oldTags.map((t) => t.Key).filter((k): k is string => !!k);
          if (oldTagKeys.length > 0) {
            await this.eventBridgeClient.send(
              new UntagResourceCommand({
                ResourceARN: ruleArn,
                TagKeys: oldTagKeys,
              })
            );
          }
        }
        // Apply new tags
        if (newTags && newTags.length > 0) {
          await this.eventBridgeClient.send(
            new TagResourceCommand({
              ResourceARN: ruleArn,
              Tags: newTags,
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
      throw new ProvisioningError(
        `Failed to update EventBridge rule ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an EventBridge rule
   *
   * Before deleting, removes all targets (required by EventBridge API).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EventBridge rule ${logicalId}: ${physicalId}`);

    // Extract rule name from ARN (format: arn:aws:events:region:account:rule/rule-name or rule/bus-name/rule-name)
    const ruleName = this.extractRuleNameFromArn(physicalId);

    try {
      // List all targets for this rule
      let targetIds: string[] = [];
      try {
        const targetsResponse = await this.eventBridgeClient.send(
          new ListTargetsByRuleCommand({ Rule: ruleName })
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
          })
        );
        this.logger.debug(`Removed ${targetIds.length} targets from rule ${ruleName}`);
      }

      // Delete the rule
      await this.eventBridgeClient.send(new DeleteRuleCommand({ Name: ruleName }));

      this.logger.debug(`Successfully deleted EventBridge rule ${logicalId}`);
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
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EventBridge rule ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    const ruleName = this.extractRuleNameFromArn(physicalId);

    if (attributeName === 'Arn') {
      const response = await this.eventBridgeClient.send(
        new DescribeRuleCommand({ Name: ruleName })
      );
      return response.Arn;
    }

    throw new Error(`Unsupported attribute: ${attributeName} for AWS::Events::Rule`);
  }

  /**
   * Adopt an existing EventBridge rule into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<arnOrName>` override → verify with
   *     `DescribeRule` (scoped to the same `EventBusName` declared in
   *     the template, if any). The override is honored as-is so users
   *     can pass either the ARN (cdkd's standard physicalId form for
   *     this provider) or just the rule name.
   *  2. If the template carries `Properties.Name` use that as the rule
   *     name lookup, then verify with `DescribeRule` and return the
   *     rule's ARN as physicalId.
   *  3. Walk `ListRules(EventBusName?)` and match `aws:cdk:path` via
   *     `ListTagsForResource(ResourceARN=rule.Arn)`. Returns the rule
   *     ARN as physicalId — same shape that `create` returns.
   *
   * EventBridge tags use the standard `Tag[]` array shape
   * (`Key`/`Value`).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const eventBusName = input.properties['EventBusName'] as string | undefined;
    if (input.knownPhysicalId) {
      try {
        const ruleName = this.extractRuleNameFromArn(input.knownPhysicalId);
        const resp = await this.eventBridgeClient.send(
          new DescribeRuleCommand({
            Name: ruleName,
            ...(eventBusName && { EventBusName: eventBusName }),
          })
        );
        // Return the ARN form as physicalId (matches `create`).
        return { physicalId: resp.Arn ?? input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    const templateName = input.properties['Name'] as string | undefined;
    if (templateName) {
      try {
        const resp = await this.eventBridgeClient.send(
          new DescribeRuleCommand({
            Name: templateName,
            ...(eventBusName && { EventBusName: eventBusName }),
          })
        );
        if (resp.Arn) return { physicalId: resp.Arn, attributes: {} };
        return null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.eventBridgeClient.send(
        new ListRulesCommand({
          ...(eventBusName && { EventBusName: eventBusName }),
          ...(nextToken && { NextToken: nextToken }),
        })
      );
      for (const rule of list.Rules ?? []) {
        if (!rule.Arn) continue;
        const tagsResp = await this.eventBridgeClient.send(
          new ListTagsForResourceCommand({ ResourceARN: rule.Arn })
        );
        if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
          return { physicalId: rule.Arn, attributes: {} };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }

  /**
   * Extract rule name from an ARN
   *
   * ARN format: arn:aws:events:region:account:rule/rule-name
   * or: arn:aws:events:region:account:rule/bus-name/rule-name
   */
  private extractRuleNameFromArn(arn: string): string {
    // If it's not an ARN, assume it's already a rule name
    if (!arn.startsWith('arn:')) {
      return arn;
    }

    const parts = arn.split('/');
    // Last segment is always the rule name
    return parts[parts.length - 1] ?? arn;
  }
}
