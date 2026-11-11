import type { SNSTopicProvider } from '../sns-topic-provider.js';
import {
  CreateTopicCommand,
  DeleteTopicCommand,
  SetTopicAttributesCommand,
  type CreateTopicCommandInput,
  type Tag,
} from '@aws-sdk/client-sns';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { stringifyValue } from '../../../utils/stringify.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { ResourceCreateResult, CreateContext, SecretMasker } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { skippedCleanupText, type NameHeldBefore } from '../create-ownership.js';
import { buildDeliveryStatusAttributeMap } from './shared.js';

/**
 * Create an SNS topic
 *
 * `context.replayingState` (issue #1551) downgrades this method's one
 * template-shape refusal — `buildDeliveryStatusAttributeMap`'s `'throw'`
 * mode — to a warning. The rollback executor's
 * reverse-replacement arm revives the OLD topic with
 * `create(..., previousState.properties, REPLAYING_STATE_CREATE_CONTEXT)`,
 * so the properties bag can be a historical cdkd STATE record carrying a
 * shape this provider now refuses — and the user has no template-side
 * remedy for a state record. The parameter was previously absent, so that
 * 4th argument was silently ignored and `buildDeliveryStatusAttributeMap`'s
 * `'throw'` mode stranded the replay; issue #1538 fixed the update side
 * only.
 */
export async function create(
  this: SNSTopicProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // ONE masked sink for this method's own lines (issue #1997). `topicArn` is
  // derived from `properties['TopicName']`, so the partial-create cleanup
  // warning below names a resolved property value.
  const maskSecrets: SecretMasker = context?.maskSecrets ?? ((text) => text);
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  this.logger.debug(`Creating SNS topic ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const topicName =
    (properties['TopicName'] as string | undefined) ||
    (this.generatedCreateName(resourceType, logicalId, properties) as string);
  // go-to-k/cdkd#4583: the ARN of a topic this create made and failed to clean
  // up; a topic that held the name before (`heldBefore`) is never set here.
  let leftBehindArn: string | undefined;

  try {
    // Build attributes map for topic configuration
    const topicAttributes: Record<string, string> = {};

    if (properties['FifoTopic']) {
      // go-to-k/cdkd#6100: read as the name's `.fifo` rule reads it, so a
      // `'TRUE'` that names the topic `.fifo` also makes it FIFO.
      const fifo = coerceCfnBoolean(properties['FifoTopic']);
      topicAttributes['FifoTopic'] =
        fifo === undefined ? stringifyValue(properties['FifoTopic']) : String(fifo);
    }
    if (properties['ContentBasedDeduplication']) {
      topicAttributes['ContentBasedDeduplication'] = stringifyValue(
        properties['ContentBasedDeduplication']
      );
    }
    if (properties['DisplayName']) {
      topicAttributes['DisplayName'] = properties['DisplayName'] as string;
    }
    if (properties['KmsMasterKeyId']) {
      topicAttributes['KmsMasterKeyId'] = properties['KmsMasterKeyId'] as string;
    }
    if (properties['TracingConfig']) {
      topicAttributes['TracingConfig'] = properties['TracingConfig'] as string;
    }
    if (properties['SignatureVersion']) {
      topicAttributes['SignatureVersion'] = stringifyValue(properties['SignatureVersion']);
    }
    if (properties['FifoThroughputScope']) {
      topicAttributes['FifoThroughputScope'] = properties['FifoThroughputScope'] as string;
    }
    // Issue #3413. `!= null`, not truthiness: the value is a byte count
    // (1024..1048576 measured live, us-east-1 2026-09-18), never a legitimate
    // 0, but a numeric member must not ride a string-shaped gate. CreateTopic
    // accepts it in `Attributes` (measured), so no follow-up call is needed.
    if (properties['MaximumMessageSize'] != null) {
      topicAttributes['MaximumMessageSize'] = stringifyValue(properties['MaximumMessageSize']);
    }

    // Build tags (the list read above; `Tags: []` is sent as declared)
    let tags: Tag[] | undefined;
    if (properties['Tags'] != null) {
      tags = desiredTags;
    }

    // Whether the cleanup below may delete what CreateTopic returns: it hands
    // back a topic that already held the name (go-to-k/cdkd#4403). Asked
    // only when a wiring step can fail.
    const wiringDeclared =
      Boolean(properties['ArchivePolicy']) ||
      Boolean(properties['DataProtectionPolicy']) ||
      properties['DeliveryStatusLogging'] != null ||
      Array.isArray(properties['Subscription']);
    const heldBefore: NameHeldBefore = wiringDeclared
      ? await this.topicHeldBefore(topicName)
      : 'free';

    const createParams: CreateTopicCommandInput = {
      Name: topicName,
      ...(Object.keys(topicAttributes).length > 0 && { Attributes: topicAttributes }),
      ...(tags && { Tags: tags }),
    };

    const response = await this.snsClient.send(new CreateTopicCommand(createParams));

    const topicArn = response.TopicArn;
    if (!topicArn) {
      // Theoretical AWS SDK contract violation: CreateTopic returned
      // success but with no TopicArn. Cannot clean up — we have no
      // ARN to delete. Has never been observed in practice.
      throw new Error('CreateTopic did not return TopicArn');
    }
    // go-to-k/cdkd#5511: only a topic the name was free for is this create's.
    if (wiringDeclared && heldBefore === 'free')
      reportCreatedResource(logicalId, resourceType, topicArn);

    // CreateTopicCommand has succeeded — AWS has now committed the
    // Topic (and any inline Tags + Attributes). If a subsequent
    // SetTopicAttributesCommand throws (ArchivePolicy on FIFO,
    // DataProtectionPolicy, per-protocol DeliveryStatusLogging), the
    // topic exists on AWS but cdkd state will NOT (the throw aborts
    // before the success-return). CreateTopic is idempotent on Name
    // — re-deploy would adopt the orphan rather than fail (under a
    // GENERATED name; an explicit one is refused by the create arm's name
    // lookup, go-to-k/cdkd#4180) — so the
    // partial-policy state could persist silently across redeploys.
    // Wrap the wiring in an inner try/catch that issues a best-effort
    // `DeleteTopicCommand` before re-throwing the original error.
    // CreateTopic does NOT throw on a pre-existing topic (unlike S3 / Logs,
    // which raise BucketAlreadyOwnedByYou / ResourceAlreadyExists), so the
    // delete runs only when the lookup before the create found the name
    // free (`heldBefore`, go-to-k/cdkd#4403); otherwise the topic stays and
    // the warning says why.
    try {
      // Apply ArchivePolicy (FIFO topics only, must be set after creation)
      if (properties['ArchivePolicy']) {
        const archivePolicy =
          typeof properties['ArchivePolicy'] === 'string'
            ? properties['ArchivePolicy']
            : JSON.stringify(properties['ArchivePolicy']);
        await this.snsClient.send(
          new SetTopicAttributesCommand({
            TopicArn: topicArn,
            AttributeName: 'ArchivePolicy',
            AttributeValue: archivePolicy,
          })
        );
      }

      // Apply DataProtectionPolicy
      if (properties['DataProtectionPolicy']) {
        const dataProtectionPolicy =
          typeof properties['DataProtectionPolicy'] === 'string'
            ? properties['DataProtectionPolicy']
            : JSON.stringify(properties['DataProtectionPolicy']);
        await this.snsClient.send(
          new SetTopicAttributesCommand({
            TopicArn: topicArn,
            AttributeName: 'DataProtectionPolicy',
            AttributeValue: dataProtectionPolicy,
          })
        );
      }

      // Apply DeliveryStatusLogging — every per-protocol attribute name AWS
      // accepts is PascalCase-prefixed (`LambdaSuccessFeedbackRoleArn`,
      // `SQSSuccessFeedbackRoleArn`, ...). CDK templates emit the
      // `Protocol` value lowercase (`'lambda'` / `'sqs'` / `'http'`), so
      // the raw `${protocol}<Suffix>` concatenation produces invalid
      // attribute names that AWS rejects with `InvalidParameter: Invalid
      // parameter: AttributeName`. `buildDeliveryStatusAttributeMap`
      // normalizes every entry's protocol; an unknown / unsupported
      // protocol throws a clear error rather than letting AWS produce
      // the cryptic generic rejection.
      // `'warn'` on a STATE REPLAY (issue #1551): the desired bag is then a
      // cdkd state record, not a template, so a refusal would leave the old
      // topic unrestorable with only a hand-edit of `state.json` as a
      // remedy. A template-path create keeps `'throw'`.
      const deliveryStatusAttributes = buildDeliveryStatusAttributeMap(
        properties['DeliveryStatusLogging'],
        logicalId,
        context?.replayingState === true ? 'warn' : 'throw',
        // Issue #1997: the warnings this may emit name RESOLVED property
        // values. `maskSecrets` above already applied the defensive default,
        // so create() has ONE masker rather than two reads that could drift.
        maskSecrets
      );
      for (const [attributeName, attributeValue] of deliveryStatusAttributes) {
        await this.snsClient.send(
          new SetTopicAttributesCommand({
            TopicArn: topicArn,
            AttributeName: attributeName,
            AttributeValue: attributeValue,
          })
        );
      }

      // Inline Subscription property - matches CloudFormation, which creates
      // (and later updates) subscriptions declared inline on the Topic. CDK's
      // L2 `topic.addSubscription()` emits separate `AWS::SNS::Subscription`
      // resources (handled by their own provider), but L1 `CfnTopic` with a
      // `subscription: [...]` list AND migrated CloudFormation templates carry
      // the subscriptions inline on the Topic - those were previously dropped
      // silently (issue #980). Subscribe for each entry. This runs INSIDE the
      // wiring try/catch so a mid-subscribe failure best-effort-deletes the
      // topic rather than orphaning it with a partial subscription set (which
      // the idempotent CreateTopic would silently adopt on the next deploy).
      if (Array.isArray(properties['Subscription'])) {
        const subscriptions = properties['Subscription'] as Array<Record<string, unknown>>;
        for (const sub of subscriptions) {
          await this.subscribeInline(topicArn, sub, logicalId, maskSecrets);
        }
      }
    } catch (innerError) {
      if (heldBefore !== 'free') {
        warn(
          skippedCleanupText(
            heldBefore,
            `SNS topic ${logicalId} (${topicArn})`,
            pasteableAwsCommand(maskSecrets)`aws sns delete-topic --topic-arn ${topicArn}`.render()
          )
        );
      } else {
        try {
          await this.snsClient.send(new DeleteTopicCommand({ TopicArn: topicArn }));
          retractCreatedResource(logicalId, resourceType, topicArn);
          this.logger.debug(
            `Cleaned up partially-created SNS topic ${logicalId} (${topicArn}) after wiring failure`
          );
        } catch (cleanupError) {
          leftBehindArn = topicArn;
          // The class at warn, AWS's text at debug (go-to-k/cdkd#2319): a
          // denied DeleteTopic names the caller's assumed-role ARN.
          const cleanupFailure = describeAwsFailure(cleanupError);
          const cleanupHead = `Failed to clean up partially-created SNS topic ${logicalId} (${topicArn}): `;
          if (cleanupFailure.redacted) {
            this.logger.debug(maskSecrets(`${cleanupHead}${cleanupFailure.detail}`));
          }
          warn(
            `${cleanupHead}${cleanupFailure.redacted ? `${cleanupFailure.summary} ` : `${cleanupFailure.detail}. `}Outside a rollback's re-create, the failed deploy's rollback journal records it for \`cdkd rollback --revert-failed\`; otherwise delete it yourself before the next deploy: ${pasteableAwsCommand(maskSecrets)`aws sns delete-topic --topic-arn ${topicArn}`.render()}`
          );
        }
      }
      // The topic itself was created: an "already exists" from its wiring is an
      // auxiliary object's, not this topic's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    this.logger.debug(`Successfully created SNS topic ${logicalId}: ${topicArn}`);

    // Extract topic name from ARN (last segment after :)
    const extractedName = topicArn.split(':').pop() || topicName;

    return {
      physicalId: topicArn,
      attributes: {
        TopicArn: topicArn,
        TopicName: extractedName,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create SNS topic ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          topicName,
          cause
        )
    );
    if (leftBehindArn) markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindArn);
    throw thrown;
  }
}
