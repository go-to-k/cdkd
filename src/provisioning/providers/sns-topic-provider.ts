import {
  SNSClient,
  CreateTopicCommand,
  DeleteTopicCommand,
  GetTopicAttributesCommand,
  ListTopicsCommand,
  ListTagsForResourceCommand,
  ListSubscriptionsByTopicCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
  UnsubscribeCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
  type CreateTopicCommandInput,
  type SubscribeCommandInput,
  type Tag,
} from '@aws-sdk/client-sns';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { stringifyValue } from '../../utils/stringify.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS SNS Topic Provider
 *
 * Implements resource provisioning for AWS::SNS::Topic using the SNS SDK.
 * WHY: SNS CreateTopic is synchronous and idempotent - the CC API adds unnecessary
 * polling overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class SNSTopicProvider implements ResourceProvider {
  private snsClient: SNSClient;
  private logger = getLogger().child('SNSTopicProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SNS::Topic',
      new Set([
        'TopicName',
        'FifoTopic',
        'ContentBasedDeduplication',
        'DisplayName',
        'KmsMasterKeyId',
        'Tags',
        'TracingConfig',
        'SignatureVersion',
        'ArchivePolicy',
        'DataProtectionPolicy',
        'DeliveryStatusLogging',
        'Subscription',
        'FifoThroughputScope',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.snsClient = awsClients.sns;
  }

  /**
   * Create an SNS topic
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SNS topic ${logicalId}`);

    const topicName =
      (properties['TopicName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 256 });

    try {
      // Build attributes map for topic configuration
      const topicAttributes: Record<string, string> = {};

      if (properties['FifoTopic']) {
        topicAttributes['FifoTopic'] = stringifyValue(properties['FifoTopic']);
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

      // Build tags
      let tags: Tag[] | undefined;
      if (properties['Tags']) {
        tags = properties['Tags'] as Tag[];
      }

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

      // CreateTopicCommand has succeeded — AWS has now committed the
      // Topic (and any inline Tags + Attributes). If a subsequent
      // SetTopicAttributesCommand throws (ArchivePolicy on FIFO,
      // DataProtectionPolicy, per-protocol DeliveryStatusLogging), the
      // topic exists on AWS but cdkd state will NOT (the throw aborts
      // before the success-return). CreateTopic is idempotent on Name
      // — re-deploy would adopt the orphan rather than fail — so the
      // partial-policy state could persist silently across redeploys.
      // Wrap the wiring in an inner try/catch that issues a best-effort
      // `DeleteTopicCommand` before re-throwing the original error.
      // Note: CreateTopic does NOT throw on pre-existing topics (unlike
      // S3/Logs which raise BucketAlreadyOwnedByYou / ResourceAlreadyExists),
      // so cdkd cannot distinguish "we created this" vs "we adopted a
      // pre-existing topic" — this matches the existing `delete()`
      // behavior (always deletes), and the cleanup follows suit. If a
      // user has a pre-existing topic with the same name AND a wiring
      // step fails on first deploy, cdkd will delete the pre-existing
      // topic. This is a known limitation matching the existing destroy
      // semantics; not a regression introduced by this fix.
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
        // parameter: AttributeName`. Normalize every entry's protocol via
        // `normalizeDeliveryStatusProtocol` before building the SDK input;
        // an unknown / unsupported protocol throws a clear error rather
        // than letting AWS produce the cryptic generic rejection.
        if (properties['DeliveryStatusLogging']) {
          const loggingConfigs = properties['DeliveryStatusLogging'] as Array<
            Record<string, unknown>
          >;
          for (const config of loggingConfigs) {
            const protocol = normalizeDeliveryStatusProtocolOrThrow(config['Protocol'], logicalId);
            if (config['SuccessFeedbackRoleArn']) {
              await this.snsClient.send(
                new SetTopicAttributesCommand({
                  TopicArn: topicArn,
                  AttributeName: `${protocol}SuccessFeedbackRoleArn`,
                  AttributeValue: config['SuccessFeedbackRoleArn'] as string,
                })
              );
            }
            if (config['SuccessFeedbackSampleRate']) {
              await this.snsClient.send(
                new SetTopicAttributesCommand({
                  TopicArn: topicArn,
                  AttributeName: `${protocol}SuccessFeedbackSampleRate`,
                  AttributeValue: stringifyValue(config['SuccessFeedbackSampleRate']),
                })
              );
            }
            if (config['FailureFeedbackRoleArn']) {
              await this.snsClient.send(
                new SetTopicAttributesCommand({
                  TopicArn: topicArn,
                  AttributeName: `${protocol}FailureFeedbackRoleArn`,
                  AttributeValue: config['FailureFeedbackRoleArn'] as string,
                })
              );
            }
          }
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
            await this.subscribeInline(topicArn, sub, logicalId);
          }
        }
      } catch (innerError) {
        try {
          await this.snsClient.send(new DeleteTopicCommand({ TopicArn: topicArn }));
          this.logger.debug(
            `Cleaned up partially-created SNS topic ${logicalId} (${topicArn}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created SNS topic ${logicalId} (${topicArn}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws sns delete-topic --topic-arn ${topicArn}`
          );
        }
        throw innerError;
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
      throw new ProvisioningError(
        `Failed to create SNS topic ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        topicName,
        cause
      );
    }
  }

  /**
   * Update an SNS topic
   *
   * SNS topics have limited mutable properties (DisplayName, KmsMasterKeyId, etc.).
   * TopicName is immutable and requires replacement (handled by deployment layer).
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SNS topic ${logicalId}: ${physicalId}`);

    // Update mutable topic attributes via SetTopicAttributes
    const mutableAttributes: Array<{ name: string; prop: string; serialize?: boolean }> = [
      { name: 'DisplayName', prop: 'DisplayName' },
      { name: 'KmsMasterKeyId', prop: 'KmsMasterKeyId' },
      { name: 'ContentBasedDeduplication', prop: 'ContentBasedDeduplication' },
      { name: 'TracingConfig', prop: 'TracingConfig' },
      { name: 'SignatureVersion', prop: 'SignatureVersion' },
      { name: 'FifoThroughputScope', prop: 'FifoThroughputScope' },
      { name: 'ArchivePolicy', prop: 'ArchivePolicy', serialize: true },
      { name: 'DataProtectionPolicy', prop: 'DataProtectionPolicy', serialize: true },
    ];

    for (const attr of mutableAttributes) {
      const newVal = properties[attr.prop];
      const oldVal = previousProperties[attr.prop];
      if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
        let value: string;
        if (newVal === undefined || newVal === null) {
          value = '';
        } else if (attr.serialize && typeof newVal !== 'string') {
          value = JSON.stringify(newVal);
        } else {
          value = stringifyValue(newVal);
        }
        await this.snsClient.send(
          new SetTopicAttributesCommand({
            TopicArn: physicalId,
            AttributeName: attr.name,
            AttributeValue: value,
          })
        );
        this.logger.debug(`Updated ${attr.name} for topic ${physicalId}`);
      }
    }

    // Update DeliveryStatusLogging if changed — same lowercase-rejection
    // pitfall as create(). Normalize every entry's `Protocol` before
    // building attribute names. See `normalizeDeliveryStatusProtocol`.
    if (
      JSON.stringify(properties['DeliveryStatusLogging']) !==
      JSON.stringify(previousProperties['DeliveryStatusLogging'])
    ) {
      const loggingConfigs =
        (properties['DeliveryStatusLogging'] as Array<Record<string, unknown>>) || [];
      for (const config of loggingConfigs) {
        const protocol = normalizeDeliveryStatusProtocolOrThrow(config['Protocol'], logicalId);
        if (config['SuccessFeedbackRoleArn']) {
          await this.snsClient.send(
            new SetTopicAttributesCommand({
              TopicArn: physicalId,
              AttributeName: `${protocol}SuccessFeedbackRoleArn`,
              AttributeValue: config['SuccessFeedbackRoleArn'] as string,
            })
          );
        }
        if (config['SuccessFeedbackSampleRate']) {
          await this.snsClient.send(
            new SetTopicAttributesCommand({
              TopicArn: physicalId,
              AttributeName: `${protocol}SuccessFeedbackSampleRate`,
              AttributeValue: stringifyValue(config['SuccessFeedbackSampleRate']),
            })
          );
        }
        if (config['FailureFeedbackRoleArn']) {
          await this.snsClient.send(
            new SetTopicAttributesCommand({
              TopicArn: physicalId,
              AttributeName: `${protocol}FailureFeedbackRoleArn`,
              AttributeValue: config['FailureFeedbackRoleArn'] as string,
            })
          );
        }
      }
    }

    // Update inline Subscription list if changed (issue #980). CloudFormation
    // adds newly-declared inline subscriptions and removes dropped ones on an
    // UPDATE; mirror that. Matching is on (Protocol, Endpoint) — the identity
    // AWS uses when listing a topic's subscriptions.
    if (
      JSON.stringify(properties['Subscription']) !==
      JSON.stringify(previousProperties['Subscription'])
    ) {
      await this.reconcileInlineSubscriptions(
        physicalId,
        (previousProperties['Subscription'] as Array<Record<string, unknown>>) || [],
        (properties['Subscription'] as Array<Record<string, unknown>>) || [],
        logicalId
      );
    }

    // Update Tags if changed
    const newTags = properties['Tags'] as Tag[] | undefined;
    const oldTags = previousProperties['Tags'] as Tag[] | undefined;
    if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
      // Remove old tags
      if (oldTags && oldTags.length > 0) {
        const oldTagKeys = oldTags.map((t) => t.Key).filter((k): k is string => !!k);
        if (oldTagKeys.length > 0) {
          await this.snsClient.send(
            new UntagResourceCommand({
              ResourceArn: physicalId,
              TagKeys: oldTagKeys,
            })
          );
        }
      }
      // Apply new tags
      if (newTags && newTags.length > 0) {
        await this.snsClient.send(
          new TagResourceCommand({
            ResourceArn: physicalId,
            Tags: newTags,
          })
        );
      }
      this.logger.debug(`Updated tags for topic ${physicalId}`);
    }

    const topicName = physicalId.split(':').pop() || logicalId;

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        TopicArn: physicalId,
        TopicName: topicName,
      },
    };
  }

  /**
   * Subscribe a single inline `Subscription` entry to the topic.
   *
   * Each entry carries at least `Protocol` + `Endpoint` (the two required CFn
   * fields). Documented optional subscription attributes that are settable at
   * subscribe time are passed through the `Subscribe` `Attributes` map
   * (`RawMessageDelivery`, `FilterPolicy`, `FilterPolicyScope`, `RedrivePolicy`,
   * `DeliveryPolicy`, `ReplayPolicy`, `SubscriptionRoleArn`). Object-valued
   * attributes (policies) are JSON-stringified; everything else is stringified
   * verbatim — AWS's `SubscribeCommand` accepts `Attributes` as a
   * `Record<string,string>`.
   */
  private async subscribeInline(
    topicArn: string,
    sub: Record<string, unknown>,
    logicalId: string
  ): Promise<void> {
    const protocol = sub['Protocol'];
    const endpoint = sub['Endpoint'];
    if (typeof protocol !== 'string' || typeof endpoint !== 'string') {
      throw new Error(
        `SNS topic ${logicalId}: inline Subscription entry requires string Protocol and Endpoint, got ${JSON.stringify(sub)}`
      );
    }

    const attributes = buildSubscriptionAttributes(sub);
    const input: SubscribeCommandInput = {
      TopicArn: topicArn,
      Protocol: protocol,
      Endpoint: endpoint,
      ReturnSubscriptionArn: true,
      ...(Object.keys(attributes).length > 0 && { Attributes: attributes }),
    };
    await this.snsClient.send(new SubscribeCommand(input));
    this.logger.debug(`Subscribed ${protocol}:${endpoint} to topic ${topicArn} for ${logicalId}`);
  }

  /**
   * Reconcile the inline `Subscription` list on an UPDATE: add entries present
   * in the new list but not the old, and unsubscribe entries present in the
   * old list but not the new. Identity is `(Protocol, Endpoint)`.
   *
   * Removals need the live `SubscriptionArn`, which the template does not
   * carry — resolve it via `ListSubscriptionsByTopic` (paginated). A removed
   * entry whose subscription is still `PendingConfirmation` (never confirmed)
   * has no ARN to unsubscribe and is skipped with a debug log.
   *
   * KNOWN LIMITATION: identity is `(Protocol, Endpoint)` only, so an
   * attribute-only change on an UNCHANGED endpoint (e.g. editing `FilterPolicy`
   * / `RawMessageDelivery` while keeping the same protocol+endpoint) is neither
   * an add nor a remove and is therefore NOT re-applied here — it would need a
   * `SetSubscriptionAttributes` pass. CloudFormation updates those in place.
   * The primary #980 silent-drop (create / add / remove / drift) is fixed; the
   * attribute-only in-place update is a deliberately-scoped follow-up.
   */
  private async reconcileInlineSubscriptions(
    topicArn: string,
    oldSubs: Array<Record<string, unknown>>,
    newSubs: Array<Record<string, unknown>>,
    logicalId: string
  ): Promise<void> {
    const key = (protocol: unknown, endpoint: unknown): string =>
      `${String(protocol)}${String(endpoint)}`;

    const oldKeys = new Set(oldSubs.map((s) => key(s['Protocol'], s['Endpoint'])));
    const newKeys = new Set(newSubs.map((s) => key(s['Protocol'], s['Endpoint'])));

    // Additions: in new, not in old.
    for (const sub of newSubs) {
      if (!oldKeys.has(key(sub['Protocol'], sub['Endpoint']))) {
        await this.subscribeInline(topicArn, sub, logicalId);
      }
    }

    // Removals: in old, not in new. Resolve ARNs from AWS.
    const removed = oldSubs.filter((s) => !newKeys.has(key(s['Protocol'], s['Endpoint'])));
    if (removed.length === 0) return;

    const arnByKey = new Map<string, string>();
    let nextToken: string | undefined;
    do {
      const resp = await this.snsClient.send(
        new ListSubscriptionsByTopicCommand({
          TopicArn: topicArn,
          ...(nextToken && { NextToken: nextToken }),
        })
      );
      for (const s of resp.Subscriptions ?? []) {
        if (!s.SubscriptionArn || s.SubscriptionArn === 'PendingConfirmation') continue;
        arnByKey.set(key(s.Protocol, s.Endpoint), s.SubscriptionArn);
      }
      nextToken = resp.NextToken;
    } while (nextToken);

    for (const sub of removed) {
      const arn = arnByKey.get(key(sub['Protocol'], sub['Endpoint']));
      if (!arn) {
        this.logger.debug(
          `No confirmed SubscriptionArn for ${String(sub['Protocol'])}:${String(sub['Endpoint'])} on topic ${topicArn} — skipping unsubscribe`
        );
        continue;
      }
      await this.snsClient.send(new UnsubscribeCommand({ SubscriptionArn: arn }));
      this.logger.debug(`Unsubscribed ${arn} from topic ${topicArn} for ${logicalId}`);
    }
  }

  /**
   * Delete an SNS topic
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SNS topic ${logicalId}: ${physicalId}`);

    try {
      await this.snsClient.send(new DeleteTopicCommand({ TopicArn: physicalId }));
      this.logger.debug(`Successfully deleted SNS topic ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.snsClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`SNS topic ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SNS topic ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing SNS topic.
   *
   * CloudFormation's `AWS::SNS::Topic` exposes `TopicName` and `TopicArn`.
   * The cdkd physicalId is the topic ARN, so both are derivable without
   * an AWS call. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-sns-topic.html#aws-properties-sns-topic-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- consistent async signature with other providers
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'TopicArn':
        return physicalId;
      case 'TopicName':
        return physicalId.split(':').pop();
      default:
        return undefined;
    }
  }

  /**
   * Read the AWS-current SNS topic configuration in CFn-property shape.
   *
   * Issues `GetTopicAttributes` for the topic-level configuration. AWS
   * returns ALL attribute values as strings; we type-coerce booleans back
   * to booleans and parse `ArchivePolicy` / `DataProtectionPolicy` from
   * JSON strings so the comparator matches cdkd state's typed values.
   *
   * `TopicName` is derived from the ARN tail (the `physicalId` is the
   * topic ARN).
   *
   * `Tags` is surfaced via a follow-up `ListTagsForResource` call. CDK's
   * `aws:*` auto-tags are filtered out by `normalizeAwsTagsToCfn`; the
   * result key is omitted entirely when AWS reports no user tags (matches
   * `create()`'s behavior of only sending Tags when the template carries
   * them).
   *
   * `DeliveryStatusLogging` is reverse-mapped from per-protocol flat
   * attributes (`{Protocol}SuccessFeedbackRoleArn` etc.) back to the CFn
   * array shape `[{Protocol, SuccessFeedbackRoleArn?, SuccessFeedbackSampleRate?,
   * FailureFeedbackRoleArn?}]`. Walks the known protocol prefix list
   * (`HTTP` / `HTTPS` / `SQS` / `Lambda` / `Firehose` / `Application`); a
   * protocol is included in the result iff at least one of its three
   * sub-attributes is set on the topic. Entries are sorted by canonical
   * PascalCase `Protocol` for stable positional compare (AWS does not
   * preserve template order across `GetTopicAttributes` calls).
   *
   * The emitted `Protocol` value preserves state's case when known
   * (CDK templates emit lowercase `'lambda'` / `'sqs'` / ...; AWS's
   * attribute prefix is PascalCase). Without case preservation the
   * comparator would fire false drift on every clean run for any
   * lowercase-`Protocol` template.
   *
   * `Subscription` is reverse-mapped from `ListSubscriptionsByTopic` ONLY
   * when the passed-in `properties` recorded an inline `Subscription` list
   * (issue #980) — L1 `CfnTopic` / migrated CloudFormation. A Topic whose
   * subscriptions are separate `AWS::SNS::Subscription` resources (CDK L2
   * `addSubscription()`) has no inline list in state, so its subscriptions
   * are not surfaced here (they belong to sibling resources).
   *
   * Returns `undefined` when the topic is gone (`NotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    let attrs: Record<string, string> | undefined;
    try {
      const resp = await this.snsClient.send(
        new GetTopicAttributesCommand({ TopicArn: physicalId })
      );
      attrs = resp.Attributes;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
    if (!attrs) return undefined;

    const result: Record<string, unknown> = {};

    // TopicName from ARN tail.
    const tail = physicalId.substring(physicalId.lastIndexOf(':') + 1);
    if (tail) result['TopicName'] = tail;

    // Boolean attributes — AWS returns "true" / "false" strings.
    const bool: string[] = ['FifoTopic', 'ContentBasedDeduplication'];
    for (const key of bool) {
      const v = attrs[key];
      if (v !== undefined) result[key] = v === 'true';
    }

    // String attributes valid for any topic type — emit unconditionally so a
    // console-side ADD surfaces as drift.
    const str: string[] = ['DisplayName', 'KmsMasterKeyId', 'TracingConfig', 'SignatureVersion'];
    for (const key of str) {
      result[key] = attrs[key] ?? '';
    }

    // FifoThroughputScope is FIFO-only — emitting `''` as a placeholder on
    // a standard topic would have `cdkd drift --revert` push the empty
    // value back to AWS, which `SetTopicAttributes` rejects. Same
    // type-discriminator-tagged pattern as the SQS DeduplicationScope /
    // FifoThroughputLimit guards.
    const isFifo = attrs['FifoTopic'] === 'true';
    if (isFifo) {
      result['FifoThroughputScope'] = attrs['FifoThroughputScope'] ?? '';
    }

    // JSON-document attributes — AWS returns a JSON string; cdkd state
    // typically holds the parsed object after intrinsic resolution.
    for (const key of ['ArchivePolicy', 'DataProtectionPolicy']) {
      const v = attrs[key];
      if (v) {
        try {
          result[key] = JSON.parse(v) as unknown;
        } catch {
          result[key] = v;
        }
      }
    }

    // DeliveryStatusLogging: reverse-map from per-protocol flat attributes
    // back to the CFn array shape. Walks the known protocol prefix list
    // (HTTP / HTTPS / SQS / Lambda / Firehose / Application) and emits a
    // CFn entry whenever any of the three sub-attributes is set.
    //
    // CDK templates emit `Protocol` lowercase (`'lambda'` / `'sqs'` / ...),
    // but AWS's per-protocol attribute prefix is PascalCase. To keep the
    // positional comparator from firing false drift on case alone, surface
    // each AWS-current entry using the SAME case the state holds for that
    // protocol — `stateProtocolCaseMap` extracts state's casing per
    // canonical PascalCase prefix.
    result['DeliveryStatusLogging'] = mapDeliveryStatusLogging(
      attrs,
      stateProtocolCaseMap(properties?.['DeliveryStatusLogging'])
    );

    // Tags via ListTagsForResource.
    try {
      const tagsResp = await this.snsClient.send(
        new ListTagsForResourceCommand({ ResourceArn: physicalId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
      result['Tags'] = tags;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }

    // Inline Subscription list — only surfaced for drift when the state
    // actually recorded inline subscriptions (issue #980). CDK's L2
    // `addSubscription()` manages subscriptions as separate
    // `AWS::SNS::Subscription` resources, so a Topic deployed that way has
    // `Subscription` absent from state; emitting AWS's subscriptions there
    // would produce guaranteed false drift (the subscriptions belong to
    // sibling resources, not the Topic property). When state DOES carry
    // inline subscriptions (L1 `CfnTopic` / migrated CFn), reverse-map the
    // live `(Protocol, Endpoint)` pairs so drift can compare them.
    if (Array.isArray(properties?.['Subscription'])) {
      const subs: Array<Record<string, unknown>> = [];
      let nextToken: string | undefined;
      do {
        const resp = await this.snsClient.send(
          new ListSubscriptionsByTopicCommand({
            TopicArn: physicalId,
            ...(nextToken && { NextToken: nextToken }),
          })
        );
        for (const s of resp.Subscriptions ?? []) {
          if (!s.Protocol || !s.Endpoint) continue;
          subs.push({ Protocol: s.Protocol, Endpoint: s.Endpoint });
        }
        nextToken = resp.NextToken;
      } while (nextToken);
      // Stable positional order for the comparator (AWS does not preserve
      // template order across reads).
      subs.sort((a, b) =>
        `${String(a['Protocol'])} ${String(a['Endpoint'])}`.localeCompare(
          `${String(b['Protocol'])} ${String(b['Endpoint'])}`
        )
      );
      result['Subscription'] = subs;
    }

    return result;
  }

  /**
   * No drift-unknown paths remain. `DeliveryStatusLogging` is reverse-mapped
   * (see `readCurrentState`), and the inline `Subscription` list is now
   * reverse-mapped too (issue #980) — but only when state actually recorded
   * inline subscriptions, so a Topic whose subscriptions are managed as
   * separate `AWS::SNS::Subscription` resources (CDK L2 `addSubscription()`)
   * does not surface them here.
   */
  getDriftUnknownPaths(): string[] {
    return [];
  }

  /**
   * Adopt an existing SNS topic into cdkd state.
   *
   * SNS physical IDs are full ARNs (`arn:aws:sns:...:TopicName`). The
   * `--resource` override is expected to receive an ARN; bare topic names
   * trigger a `ListTopics` walk that resolves to the ARN.
   *
   * Lookup order:
   *  1. `--resource` override → trust as ARN, verify via `GetTopicAttributes`.
   *  2. `Properties.TopicName` → `ListTopics` to find the matching ARN.
   *
   * The `aws:cdk:path` tag match that used to ride the same `ListTopics` walk
   * is gone (issue #1134): AWS rejects `aws:`-prefixed tag writes, so that tag
   * never exists on a real resource and the walk could not match. Auto-mode
   * import resolves ids from CloudFormation's `DescribeStackResources` or the
   * template's physical name; without a `TopicName` there is nothing to match.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.snsClient.send(
          new GetTopicAttributesCommand({ TopicArn: input.knownPhysicalId })
        );
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
    }

    const desiredName =
      typeof input.properties?.['TopicName'] === 'string'
        ? input.properties['TopicName']
        : undefined;
    if (!desiredName) return null;

    // Match the template's TopicName against each topic's ARN tail
    // (arn:aws:sns:...:NAME).
    let marker: string | undefined;
    do {
      const list = await this.snsClient.send(
        new ListTopicsCommand({ ...(marker && { NextToken: marker }) })
      );
      for (const t of list.Topics ?? []) {
        if (!t.TopicArn) continue;
        const arnTail = t.TopicArn.substring(t.TopicArn.lastIndexOf(':') + 1);
        if (arnTail === desiredName) {
          return { physicalId: t.TopicArn, attributes: {} };
        }
      }
      marker = list.NextToken;
    } while (marker);
    return null;
  }
}

// ─── DeliveryStatusLogging reverse-mapping ─────────────────────────────
//
// CFn input shape:
//   DeliveryStatusLogging: [
//     { Protocol: 'HTTP'|'HTTPS'|'SQS'|'Lambda'|'Firehose'|'Application',
//       SuccessFeedbackRoleArn?, SuccessFeedbackSampleRate?, FailureFeedbackRoleArn? }
//   ]
// AWS GetTopicAttributes flat attribute shape (one per protocol):
//   <Protocol>SuccessFeedbackRoleArn  (e.g. HTTPSuccessFeedbackRoleArn)
//   <Protocol>SuccessFeedbackSampleRate
//   <Protocol>FailureFeedbackRoleArn
// where <Protocol> is the canonical PascalCase prefix.
//
// Wire-format note: AWS's attribute prefix is always PascalCase
// (`Lambda`, `SQS`, `HTTPS`, ...) regardless of how `Protocol` was
// spelled in the template. CDK emits lowercase (`'lambda'` / `'sqs'`
// / `'http'`) — passing those through directly to
// `${protocol}SuccessFeedbackRoleArn` produces invalid attribute names
// AWS rejects with `InvalidParameter: Invalid parameter:
// AttributeName`. `normalizeDeliveryStatusProtocol` is the single
// chokepoint mapping any-case input to the canonical PascalCase prefix.

// ─── Inline Subscription attribute mapping (issue #980) ────────────────
//
// The documented optional attributes of an inline `AWS::SNS::Topic`
// `Subscription` entry that are settable at `Subscribe` time. `Protocol`
// and `Endpoint` are the two required fields (handled separately); every
// other key here maps 1:1 to an SNS subscription attribute name. Object-
// valued policies are JSON-stringified; scalar values are stringified
// verbatim (AWS's Subscribe `Attributes` map is `Record<string,string>`).
const SNS_SUBSCRIPTION_ATTRIBUTE_KEYS = [
  'RawMessageDelivery',
  'FilterPolicy',
  'FilterPolicyScope',
  'RedrivePolicy',
  'DeliveryPolicy',
  'ReplayPolicy',
  'SubscriptionRoleArn',
] as const;

/**
 * Build the SNS `Subscribe` `Attributes` map from an inline `Subscription`
 * entry, skipping the required `Protocol` / `Endpoint` fields. Undefined /
 * null values are omitted; object values (policy documents) are
 * JSON-stringified; scalars are `String()`-coerced.
 */
export function buildSubscriptionAttributes(sub: Record<string, unknown>): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const key of SNS_SUBSCRIPTION_ATTRIBUTE_KEYS) {
    const value = sub[key];
    if (value === undefined || value === null) continue;
    attributes[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return attributes;
}

const SNS_DELIVERY_STATUS_PROTOCOLS = [
  'Application',
  'Firehose',
  'HTTP',
  'HTTPS',
  'Lambda',
  'SQS',
] as const;

type SnsDeliveryStatusProtocol = (typeof SNS_DELIVERY_STATUS_PROTOCOLS)[number];

/**
 * Map a (possibly-mixed-case) protocol string from a CFn template to the
 * canonical PascalCase prefix AWS expects on `${Protocol}<Suffix>`
 * attribute names.
 *
 * Returns `undefined` for unknown / unsupported protocols — callers must
 * handle this case explicitly. Accepting an arbitrary string would
 * defer the failure to AWS, which produces the unhelpful generic
 * `InvalidParameter: Invalid parameter: AttributeName` message; failing
 * fast in cdkd lets us name the offending value.
 *
 * Case map (lowercase canonical → PascalCase prefix):
 *   application → Application
 *   firehose    → Firehose
 *   http        → HTTP
 *   https       → HTTPS
 *   lambda      → Lambda
 *   sqs        → SQS
 */
export function normalizeDeliveryStatusProtocol(
  input: unknown
): SnsDeliveryStatusProtocol | undefined {
  if (typeof input !== 'string') return undefined;
  const lower = input.toLowerCase();
  switch (lower) {
    case 'application':
      return 'Application';
    case 'firehose':
      return 'Firehose';
    case 'http':
      return 'HTTP';
    case 'https':
      return 'HTTPS';
    case 'lambda':
      return 'Lambda';
    case 'sqs':
      return 'SQS';
    default:
      return undefined;
  }
}

/**
 * Variant used by `create()` / `update()` to fail fast when a template
 * carries an unknown protocol. Throws a clear error naming the offending
 * value so the user sees what to fix instead of AWS's generic
 * `InvalidParameter` rejection.
 */
function normalizeDeliveryStatusProtocolOrThrow(
  input: unknown,
  logicalId: string
): SnsDeliveryStatusProtocol {
  const normalized = normalizeDeliveryStatusProtocol(input);
  if (normalized === undefined) {
    throw new Error(
      `SNS topic ${logicalId}: unsupported DeliveryStatusLogging protocol ${JSON.stringify(input)}. ` +
        `Expected one of ${SNS_DELIVERY_STATUS_PROTOCOLS.join(', ')} (case-insensitive).`
    );
  }
  return normalized;
}

/**
 * Build a `{canonicalPascalCase: stateRecordedCase}` lookup from state's
 * recorded `DeliveryStatusLogging[]`. Used by `mapDeliveryStatusLogging`
 * to surface AWS-current entries in the same case the state holds, so
 * the positional comparator does not fire false drift on case alone.
 *
 * Unrecognized state-side protocols are silently dropped; the
 * comparator falls back to the canonical PascalCase prefix for those
 * (worst case: a one-time drift entry that disappears once the user
 * re-records the state).
 */
function stateProtocolCaseMap(stateLogging: unknown): Map<SnsDeliveryStatusProtocol, string> {
  const map = new Map<SnsDeliveryStatusProtocol, string>();
  if (!Array.isArray(stateLogging)) return map;
  for (const entry of stateLogging) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = (entry as Record<string, unknown>)['Protocol'];
    if (typeof raw !== 'string') continue;
    const normalized = normalizeDeliveryStatusProtocol(raw);
    if (!normalized) continue;
    // First state entry per canonical protocol wins; duplicates would
    // already be a state error and the map's last-write semantics is
    // immaterial in practice.
    if (!map.has(normalized)) map.set(normalized, raw);
  }
  return map;
}

/**
 * Reverse-map per-protocol flat attributes returned by GetTopicAttributes
 * back to the CFn `DeliveryStatusLogging` array shape. Always emits an
 * array (even `[]`) so the v3 `observedProperties` baseline catches a
 * console-side enable on a previously-default topic (PR #145 always-emit
 * pattern).
 *
 * Entries are sorted by canonical PascalCase `Protocol` (alphabetical) for
 * stable positional compare since AWS does not preserve template order.
 * State-driven order reconciliation is unnecessary here — every entry's
 * identity is fully determined by `Protocol` (no two entries share a
 * protocol).
 *
 * The `Protocol` value emitted in each entry uses the case the state
 * recorded for that protocol (when known via `stateCaseMap`); falls back
 * to the canonical PascalCase prefix otherwise. This keeps the comparator
 * from firing false drift when state holds CDK's `'lambda'` and AWS's
 * attribute prefix is `Lambda`.
 *
 * `SuccessFeedbackSampleRate` is surfaced as the AWS-returned string
 * (`'0'`-`'100'`) to match the CFn shape (`String` per the docs).
 */
function mapDeliveryStatusLogging(
  attrs: Record<string, string>,
  stateCaseMap: Map<SnsDeliveryStatusProtocol, string> = new Map()
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const protocol of SNS_DELIVERY_STATUS_PROTOCOLS) {
    const success = attrs[`${protocol}SuccessFeedbackRoleArn`];
    const sample = attrs[`${protocol}SuccessFeedbackSampleRate`];
    const failure = attrs[`${protocol}FailureFeedbackRoleArn`];
    if (success === undefined && sample === undefined && failure === undefined) continue;
    const entry: Record<string, unknown> = {
      Protocol: stateCaseMap.get(protocol) ?? protocol,
    };
    if (success !== undefined) entry['SuccessFeedbackRoleArn'] = success;
    if (sample !== undefined) entry['SuccessFeedbackSampleRate'] = sample;
    if (failure !== undefined) entry['FailureFeedbackRoleArn'] = failure;
    result.push(entry);
  }
  return result;
}
