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
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { importTagWalk } from '../import-tag-walk.js';
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

      // PutRuleCommand has succeeded — AWS has now committed the Rule
      // (and any inline Tags). If the subsequent PutTargetsCommand throws,
      // the rule exists on AWS but cdkd state will NOT (the throw aborts
      // before the success-return). PutRule is idempotent on Name (a
      // re-deploy would UPDATE the existing rule), so the orphan is
      // structurally self-healing on retry — but only if the user's
      // template hasn't changed AND only if they don't run `cdkd destroy`
      // first (state has no record so destroy would skip the orphan).
      // Wrap the PutTargets call in an inner try/catch that issues
      // best-effort `RemoveTargets` + `DeleteRule` before re-throwing
      // the original error. Mirror of `delete()` modulo `ResourceNotFound`
      // tolerance (which we collapse into the cleanup catch as a WARN).
      const eventBusName = properties['EventBusName'] as string | undefined;
      try {
        // Add targets if specified
        if (targets && targets.length > 0) {
          await this.eventBridgeClient.send(
            new PutTargetsCommand({
              Rule: ruleName,
              EventBusName: eventBusName,
              Targets: targets,
            })
          );
          this.logger.debug(`Added ${targets.length} targets to rule ${ruleName}`);
        }
      } catch (innerError) {
        try {
          // PutTargets may have partially succeeded before throwing; list
          // and remove any attached targets before deleting the rule.
          // ListTargetsByRule + RemoveTargets is the same sequence
          // `delete()` uses; AWS rejects DeleteRule when targets exist.
          const targetsResponse = await this.eventBridgeClient.send(
            new ListTargetsByRuleCommand({ Rule: ruleName, EventBusName: eventBusName })
          );
          const targetIds = (targetsResponse.Targets || [])
            .map((t) => t.Id)
            .filter((id): id is string => id !== undefined);
          if (targetIds.length > 0) {
            await this.eventBridgeClient.send(
              new RemoveTargetsCommand({
                Rule: ruleName,
                EventBusName: eventBusName,
                Ids: targetIds,
              })
            );
          }
          await this.eventBridgeClient.send(
            new DeleteRuleCommand({ Name: ruleName, EventBusName: eventBusName })
          );
          this.logger.debug(
            `Cleaned up partially-created EventBridge rule ${logicalId} (${ruleName}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created EventBridge rule ${logicalId} (${ruleName}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws events list-targets-by-rule --rule ${ruleName}${eventBusName ? ` --event-bus-name ${eventBusName}` : ''} | jq -r '.Targets[].Id' | xargs aws events remove-targets --rule ${ruleName}${eventBusName ? ` --event-bus-name ${eventBusName}` : ''} --ids; aws events delete-rule --name ${ruleName}${eventBusName ? ` --event-bus-name ${eventBusName}` : ''}`
          );
        }
        throw innerError;
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
    // A custom-bus rule MUST be addressed with its EventBusName — the
    // Name-only form targets the default bus, so ListTargetsByRule /
    // DeleteRule would report ResourceNotFound and the delete would
    // silently no-op, orphaning the rule (issue #955).
    const busParam = this.busParamFromArn(physicalId);

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
        this.logger.debug(`Removed ${targetIds.length} targets from rule ${ruleName}`);
      }

      // Delete the rule
      await this.eventBridgeClient.send(new DeleteRuleCommand({ Name: ruleName, ...busParam }));

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
        new DescribeRuleCommand({
          Name: ruleName,
          ...this.busParamFromArn(physicalId),
        })
      );
      return response.Arn;
    }

    throw new Error(`Unsupported attribute: ${attributeName} for AWS::Events::Rule`);
  }

  /**
   * Read the AWS-current EventBridge rule configuration in CFn-property shape.
   *
   * Issues `DescribeRule` for the rule's main config, then a separate
   * `ListTargetsByRule` for `Targets`.
   *
   * Surfaced keys (when present): `Name`, `Description`, `EventBusName`,
   * `EventPattern` (parsed from JSON string back to object — cdkd state holds
   * it as the user typed it, typically an object), `ScheduleExpression`,
   * `State`, `RoleArn`, `Targets` (CFn shape `[{Id, Arn, ...}]`).
   *
   * `Tags` is surfaced via a follow-up `ListTagsForResource` call (using the
   * rule ARN — the same `physicalId` cdkd state holds). CDK's `aws:*`
   * auto-tags are filtered out; the result key is omitted entirely when AWS
   * reports no user tags.
   *
   * Returns `undefined` when the rule is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    const ruleName = this.extractRuleNameFromArn(physicalId);
    const busParam = this.busParamFromArn(physicalId);

    let resp: {
      Name?: string;
      Description?: string;
      EventBusName?: string;
      EventPattern?: string;
      ScheduleExpression?: string;
      State?: string;
      RoleArn?: string;
    };
    try {
      resp = (await this.eventBridgeClient.send(
        new DescribeRuleCommand({
          Name: ruleName,
          ...busParam,
        })
      )) as unknown as typeof resp;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }

    const result: Record<string, unknown> = {};
    if (resp.Name !== undefined) result['Name'] = resp.Name;
    result['Description'] = resp.Description ?? '';
    if (resp.EventBusName !== undefined && resp.EventBusName !== 'default') {
      result['EventBusName'] = resp.EventBusName;
    }
    if (resp.EventPattern !== undefined) {
      try {
        result['EventPattern'] = JSON.parse(resp.EventPattern) as unknown;
      } catch {
        result['EventPattern'] = resp.EventPattern;
      }
    }
    if (resp.ScheduleExpression !== undefined) {
      result['ScheduleExpression'] = resp.ScheduleExpression;
    }
    if (resp.State !== undefined) result['State'] = resp.State;
    if (resp.RoleArn !== undefined) result['RoleArn'] = resp.RoleArn;

    // Targets: separate API call. "Not configured" returns an empty array.
    try {
      const targetsResp = await this.eventBridgeClient.send(
        new ListTargetsByRuleCommand({
          Rule: ruleName,
          ...busParam,
        })
      );
      result['Targets'] = targetsResp.Targets ?? [];
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        throw err;
      }
    }

    // Tags via ListTagsForResource. The rule ARN is the physicalId cdkd
    // state holds.
    try {
      const tagsResp = await this.eventBridgeClient.send(
        new ListTagsForResourceCommand({ ResourceARN: physicalId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
      result['Tags'] = tags;
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        throw err;
      }
    }

    return result;
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
        // An ARN override already names its bus — derive it from the ARN
        // (the template property may still be an unresolved intrinsic
        // object at import time). Bare-name overrides fall back to the
        // template property when it is a literal string.
        const arnBusParam = this.busParamFromArn(input.knownPhysicalId);
        const busParam =
          'EventBusName' in arnBusParam
            ? arnBusParam
            : typeof eventBusName === 'string' && eventBusName
              ? { EventBusName: eventBusName }
              : {};
        const resp = await this.eventBridgeClient.send(
          new DescribeRuleCommand({
            Name: ruleName,
            ...busParam,
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

    // Tag-based fallback via the shared throttle-tolerant walk: the N+1
    // ListTagsForResource burst is retried with exponential backoff when AWS
    // throttles it instead of aborting the whole import. The template's
    // EventBusName (when literal) scopes every ListRules page, matching the
    // previous inline loop.
    const match = await importTagWalk({
      cdkPath: input.cdkPath,
      logicalId: input.logicalId,
      listPage: async (marker) => {
        const list = await this.eventBridgeClient.send(
          new ListRulesCommand({
            ...(eventBusName && { EventBusName: eventBusName }),
            ...(marker && { NextToken: marker }),
          })
        );
        return { items: list.Rules, nextMarker: list.NextToken };
      },
      describe: async (rule) => {
        if (!rule.Arn) return undefined;
        return await this.eventBridgeClient.send(
          new ListTagsForResourceCommand({ ResourceARN: rule.Arn })
        );
      },
      tagsOf: (tagsResp) => tagsResp.Tags,
    });
    if (!match) return null;
    // Non-null by construction: `describe` skips summaries without an ARN.
    return { physicalId: match.summary.Arn!, attributes: {} };
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

  /**
   * Extract the event bus name from a rule ARN.
   *
   * ARN format: `arn:aws:events:region:account:rule/rule-name` (default bus, returns 'default')
   *          or `arn:aws:events:region:account:rule/bus-name/rule-name` (custom bus).
   *
   * Returns `undefined` when the input is not an ARN (we can't tell which bus).
   */
  /**
   * `EventBusName` request parameter derived from a rule ARN — `{}` for
   * default-bus rules (preserves the Name-only wire shape) and for non-ARN
   * physical ids (bus unknowable).
   */
  private busParamFromArn(arn: string): { EventBusName?: string } {
    const eventBusName = this.extractBusNameFromArn(arn);
    return eventBusName && eventBusName !== 'default' ? { EventBusName: eventBusName } : {};
  }

  private extractBusNameFromArn(arn: string): string | undefined {
    if (!arn.startsWith('arn:')) return undefined;
    const parts = arn.split('/');
    // arn:aws:events:r:a:rule/<rule>              → 2 segments (split by '/')
    // arn:aws:events:r:a:rule/<bus>/<rule>        → 3 segments
    // arn:aws:events:r:a:rule/aws.partner/x/y/<r> → 5 segments (partner-bus
    //   NAMES contain slashes; rule names cannot, so the bus is everything
    //   between the first and last segment — same last-slash rule as
    //   cfnRefValueFromPhysicalId in the intrinsic resolver)
    if (parts.length >= 3) return parts.slice(1, -1).join('/');
    return 'default';
  }
}
