import type { EventBridgeRuleProvider, RuleTarget } from '../eventbridge-rule-provider.js';
import {
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  DeleteRuleCommand,
  DescribeRuleCommand,
  ListTargetsByRuleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-eventbridge';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import {
  hasErrorName,
  nameHeldBefore,
  skippedCleanupText,
  type NameHeldBefore,
} from '../create-ownership.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';

/**
 * Create an EventBridge rule
 */
export async function create(
  this: EventBridgeRuleProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // The rule name is a resolved property value: the cleanup warnings below
  // print it, so they go through the caller's masker (go-to-k/cdkd#4403).
  const mask = maskerOrIdentity(context?.maskSecrets);
  this.logger.debug(`Creating EventBridge rule ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const ruleName =
    (properties['Name'] as string | undefined) ||
    (this.generatedCreateName(resourceType, logicalId, properties) as string);
  const targets = properties['Targets'] as RuleTarget[] | undefined;

  // go-to-k/cdkd#4583: the ARN of a rule this create made and the wiring
  // cleanup failed to delete, for the failed-CREATE journal mark.
  let leftLiveArn: string | undefined;
  try {
    // Whether the cleanup below may delete the rule: PutRule OVERWRITES a
    // rule that already held the name on that bus (go-to-k/cdkd#4403).
    // Asked only when the targets step, the one that can fail, runs.
    const heldBefore: NameHeldBefore =
      targets && targets.length > 0
        ? await nameHeldBefore(
            async () => {
              await this.eventBridgeClient.send(
                new DescribeRuleCommand({
                  Name: ruleName,
                  ...(properties['EventBusName'] !== undefined && {
                    EventBusName: properties['EventBusName'] as string,
                  }),
                })
              );
              return true;
            },
            (error) =>
              error instanceof ResourceNotFoundException ||
              hasErrorName(error, ['ResourceNotFoundException'])
          )
        : 'free';

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
      putRuleParams['Tags'] = desiredTags;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    const response = await this.eventBridgeClient.send(new PutRuleCommand(putRuleParams as any));

    const ruleArn = response.RuleArn!;
    this.logger.debug(`Created EventBridge rule: ${ruleName} (${ruleArn})`);
    // go-to-k/cdkd#5511: only a rule the name was free for.
    if (heldBefore === 'free') reportCreatedResource(logicalId, resourceType, ruleArn);

    // PutRuleCommand has succeeded — AWS has now committed the Rule
    // (and any inline Tags). If the subsequent PutTargetsCommand throws,
    // the rule exists on AWS but cdkd state will NOT (the throw aborts
    // before the success-return). PutRule is idempotent on Name (a
    // re-deploy would UPDATE the existing rule), so the orphan is
    // structurally self-healing on retry for a GENERATED name only (an
    // explicit one is refused by the create arm's name lookup,
    // go-to-k/cdkd#4180) — and only if the user's
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
            Targets: this.toSdkTargets(targets),
          })
        );
        this.logger.debug(`Added ${targets.length} targets to rule ${ruleName}`);
      }
    } catch (innerError) {
      // The rule name and bus are TEMPLATE values, so the command renders
      // through `pasteableAwsCommand` (issue #3136): sanitized and
      // shell-quoted, and withheld whole when one cannot be printed exactly.
      // The masker WITHHOLDS a command naming a secret-derived rule or bus.
      const aws = pasteableAwsCommand(mask);
      const busArg = eventBusName ? aws` --event-bus-name ${eventBusName}` : aws``;
      // The target ids go to `--ids` as ONE JSON-list word, never one word
      // each (`jq | xargs`, before go-to-k/cdkd#4199): an id is a
      // template value that may start with `-`, and a bare word after a
      // list-valued flag is parsed as an OPTION (`--region`, `--profile`
      // redirected the call, measured). A JSON list element is data.
      const command = aws`aws events remove-targets --rule ${ruleName}${busArg} --ids "$(aws events list-targets-by-rule --rule ${ruleName}${busArg} --query 'Targets[].Id' --output json)"; aws events delete-rule --name ${ruleName}${busArg}`;
      if (heldBefore !== 'free') {
        // Neither its targets nor the rule: both may be someone else's.
        this.logger.warn(
          mask(
            skippedCleanupText(
              heldBefore,
              `EventBridge rule ${logicalId} (${ruleName})`,
              command.render()
            )
          )
        );
      } else {
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
          retractCreatedResource(logicalId, resourceType, ruleArn);
          this.logger.debug(
            `Cleaned up partially-created EventBridge rule ${logicalId} (${ruleName}) after wiring failure`
          );
        } catch (cleanupError) {
          leftLiveArn = ruleArn;
          // The class at warn, AWS's text at debug (go-to-k/cdkd#2319): a
          // denied DeleteRule names the caller's assumed-role ARN.
          const cleanupFailure = describeAwsFailure(cleanupError);
          const cleanupHead = `Failed to clean up partially-created EventBridge rule ${logicalId} (${ruleName}): `;
          if (cleanupFailure.redacted) {
            this.logger.debug(mask(`${cleanupHead}${cleanupFailure.detail}`));
          }
          this.logger.warn(
            mask(
              // When RemoveTargets already succeeded, the listing is `[]` and the
              // pasted remove-targets fails validation (an empty `--ids`) before
              // the delete-rule after it runs; the message says so up front, so
              // that error line does not read as the cleanup failing. Only when
              // the command is PRINTED: a withheld one has no steps to describe.
              `${cleanupHead}${cleanupFailure.redacted ? `${cleanupFailure.summary} ` : `${cleanupFailure.detail}. `}Manual deletion may be required before the next deploy` +
                (command.text === undefined
                  ? `: ${command.render()}`
                  : `. If the rule has no targets left, the remove-targets step reports an empty id list; that error is harmless and the delete-rule step still runs: ${command.render()}`)
            )
          );
        }
      }
      // The rule itself was created: an "already exists" from its wiring is an
      // auxiliary object's, not this rule's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    return {
      physicalId: ruleArn,
      attributes: {
        Arn: ruleArn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create EventBridge rule ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          ruleName,
          cause
        )
    );
    // Only a rule the name was free for: a held one is not ours to delete.
    if (leftLiveArn) markCreatedBeforeFailure(thrown, logicalId, resourceType, leftLiveArn);
    throw thrown;
  }
}
