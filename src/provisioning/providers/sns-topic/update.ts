import type { SNSTopicProvider } from '../sns-topic-provider.js';
import {
  ListSubscriptionsByTopicCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
  UnsubscribeCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type SubscribeCommandInput,
} from '@aws-sdk/client-sns';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import { stringifyValue } from '../../../utils/stringify.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import { maskDeep, maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import type { ResourceUpdateResult, UpdateContext, SecretMasker } from '../../../types/resource.js';
import {
  SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT,
  buildSubscriptionAttributes,
  buildDeliveryStatusAttributeMap,
  deliveryStatusRemovalResetValue,
} from './shared.js';

/**
 * Update an SNS topic
 *
 * SNS topics have limited mutable properties (DisplayName, KmsMasterKeyId, etc.).
 * TopicName is immutable and requires replacement (handled by deployment layer).
 *
 * Thin wrapper that maps any AWS SDK failure onto {@link ProvisioningError}
 * the same way {@link create} and {@link delete} do, so an update failure
 * carries cdkd's typed error formatting and exit-code handling instead of
 * surfacing raw (issue #1267). This provider issues many separate `send`
 * calls across attributes / policies / subscriptions, so the wrap lives at
 * the boundary and the body stays in {@link applyUpdate}.
 *
 * A typed control-flow error is re-thrown untouched: the deploy engine
 * matches those by class to decide its fallback, so swallowing one into a
 * ProvisioningError would silently disable that path.
 */
export async function update(
  this: SNSTopicProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call
  // (read as empty, it would untag every recorded key).
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  try {
    return await this.applyUpdate(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      // Issue #1997: only `maskSecrets` is read off the context here, and it
      // is forwarded rather than the whole bag so `applyUpdate` cannot grow a
      // dependence on a field the update path does not carry.
      context?.maskSecrets
    );
  } catch (error) {
    // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
    // is control flow the deploy engine matches BY CLASS, and a ProvisioningError
    // raised deeper in the body already carries better context than a re-wrap.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update SNS topic ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function applyUpdate(
  this: SNSTopicProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating SNS topic ${logicalId}: ${physicalId}`);

  // Update mutable topic attributes via SetTopicAttributes.
  //
  // `resetValue` is what a REMOVED member is reset to. The default arm sends
  // `''`, which SNS reads as "clear" for the string / policy attributes; a
  // NUMERIC attribute refuses it (`MaximumMessageSize: '' is not an integer
  // between 1024 and 1048576 bytes`, measured us-east-1 2026-09-18), so a
  // removal has to send the service default explicitly — the same shape
  // `SQS_ATTRIBUTE_REMOVAL_RESET` carries for the queue's numeric members.
  // The enum / boolean / archive members refuse it too (issue #6226, measured
  // us-east-1 2026-11-13: `Invalid tracing config value:` /
  // `ContentBasedDeduplication: Invalid value []` / `ArchivePolicy: JSON is
  // missing required fields`); CloudFormation resets them to `PassThrough` /
  // `false` / no archive policy, which SNS takes as `{}`.
  // `SignatureVersion` and `FifoThroughputScope` refuse `''` as well, but
  // CloudFormation's own removal fails the same way, so they keep the default
  // arm.
  //
  // A DESIRED `''` takes the reset too: `drift --revert` replays a readback
  // baseline, and `readCurrentState` reports an unset `TracingConfig` as `''`.
  const mutableAttributes: Array<{
    name: string;
    prop: string;
    serialize?: boolean;
    resetValue?: string;
  }> = [
    { name: 'DisplayName', prop: 'DisplayName' },
    { name: 'KmsMasterKeyId', prop: 'KmsMasterKeyId' },
    {
      name: 'ContentBasedDeduplication',
      prop: 'ContentBasedDeduplication',
      resetValue: 'false',
    },
    { name: 'TracingConfig', prop: 'TracingConfig', resetValue: 'PassThrough' },
    { name: 'SignatureVersion', prop: 'SignatureVersion' },
    { name: 'FifoThroughputScope', prop: 'FifoThroughputScope' },
    { name: 'ArchivePolicy', prop: 'ArchivePolicy', serialize: true, resetValue: '{}' },
    { name: 'DataProtectionPolicy', prop: 'DataProtectionPolicy', serialize: true },
    // Issue #3413. 262144 (256 KiB) is SNS's standard maximum and what a
    // topic that never set the attribute enforces; a fresh topic REPORTS no
    // value at all, so the reset makes the attribute appear at the default
    // rather than disappear — `readCurrentState` folds that (see there).
    {
      name: 'MaximumMessageSize',
      prop: 'MaximumMessageSize',
      resetValue: SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT,
    },
  ];

  for (const attr of mutableAttributes) {
    const newVal = properties[attr.prop];
    const oldVal = previousProperties[attr.prop];
    if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
      let value: string;
      if (
        newVal === undefined ||
        newVal === null ||
        (newVal === '' && attr.resetValue !== undefined)
      ) {
        value = attr.resetValue ?? '';
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
  // pitfall as create(); `buildDeliveryStatusAttributeMap` normalizes
  // every entry's `Protocol` before building attribute names.
  //
  // Removal semantics (issue #1160): SetTopicAttributes is per-attribute
  // merge — an attribute we never send keeps its live value, so both a
  // whole `DeliveryStatusLogging` removal and a dropped sub-field /
  // protocol entry must be reset EXPLICITLY. The desired side is walked
  // in 'warn' mode (issue #1538): it is NOT always template-borne — the
  // rollback executor's revert arm and `cdkd drift --revert` both put a
  // state-derived bag here, so a malformed value warns-and-skips instead
  // of failing the update permanently (create() still throws, where the
  // value is always template-borne). The previous side comes from cdkd
  // state too, so it is walked in silent 'skip' mode — a state record an
  // older binary wrote must never make the stack permanently
  // undeployable (guard-the-desired-side-only rule).
  if (
    JSON.stringify(properties['DeliveryStatusLogging']) !==
    JSON.stringify(previousProperties['DeliveryStatusLogging'])
  ) {
    const desiredAttributes = buildDeliveryStatusAttributeMap(
      properties['DeliveryStatusLogging'],
      logicalId,
      'warn',
      // Issue #1997: the desired side is the one that warns, and the values it
      // names arrive RESOLVED. The previous side below is walked in silent
      // 'skip' mode and emits nothing, so it needs no masker.
      maskSecrets
    );
    const previousAttributes = buildDeliveryStatusAttributeMap(
      previousProperties['DeliveryStatusLogging'],
      logicalId,
      'skip'
    );
    for (const [attributeName, attributeValue] of desiredAttributes) {
      if (previousAttributes.get(attributeName) === attributeValue) continue;
      await this.snsClient.send(
        new SetTopicAttributesCommand({
          TopicArn: physicalId,
          AttributeName: attributeName,
          AttributeValue: attributeValue,
        })
      );
    }
    for (const attributeName of previousAttributes.keys()) {
      if (desiredAttributes.has(attributeName)) continue;
      await this.snsClient.send(
        new SetTopicAttributesCommand({
          TopicArn: physicalId,
          AttributeName: attributeName,
          AttributeValue: deliveryStatusRemovalResetValue(attributeName),
        })
      );
      this.logger.debug(
        `Reset removed delivery status attribute ${attributeName} for topic ${physicalId}`
      );
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
      logicalId,
      // Issue #2178: the refusal in `subscribeInline` quotes the whole
      // inline entry, which is RESOLVED template content. Absent means
      // unmasked, per the SecretMaskingContext contract.
      maskerOrIdentity(maskSecrets)
    );
  }

  // Update Tags: untag the recorded keys the desired side no longer names,
  // then tag the new / changed ones. Both sides are read through
  // `planTagDiff` (go-to-k/cdkd#3994): an unreadable record untags nothing.
  const tagPlan = planTagDiff(previousProperties['Tags'], properties['Tags']);
  const tagWarning = tagPlanWarning(tagPlan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  if (tagPlan.remove.length > 0) {
    await this.snsClient.send(
      new UntagResourceCommand({
        ResourceArn: physicalId,
        TagKeys: tagPlan.remove,
      })
    );
  }
  if (tagPlan.set.size > 0) {
    await this.snsClient.send(
      new TagResourceCommand({
        ResourceArn: physicalId,
        Tags: [...tagPlan.set].map(([Key, Value]) => ({ Key, Value })),
      })
    );
  }
  if (tagPlan.remove.length > 0 || tagPlan.set.size > 0) {
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
export async function subscribeInline(
  this: SNSTopicProvider,
  topicArn: string,
  sub: Record<string, unknown>,
  logicalId: string,
  mask: MaskerFn
): Promise<void> {
  const protocol = sub['Protocol'];
  const endpoint = sub['Endpoint'];
  if (typeof protocol !== 'string' || typeof endpoint !== 'string') {
    throw new Error(
      `SNS topic ${logicalId}: inline Subscription entry requires string Protocol and ` +
        `Endpoint, got ${JSON.stringify(maskDeep(sub, mask))}`
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
export async function reconcileInlineSubscriptions(
  this: SNSTopicProvider,
  topicArn: string,
  oldSubs: Array<Record<string, unknown>>,
  newSubs: Array<Record<string, unknown>>,
  logicalId: string,
  mask: MaskerFn
): Promise<void> {
  const key = (protocol: unknown, endpoint: unknown): string =>
    `${String(protocol)}${String(endpoint)}`;

  const oldKeys = new Set(oldSubs.map((s) => key(s['Protocol'], s['Endpoint'])));
  const newKeys = new Set(newSubs.map((s) => key(s['Protocol'], s['Endpoint'])));

  // Additions: in new, not in old.
  for (const sub of newSubs) {
    if (!oldKeys.has(key(sub['Protocol'], sub['Endpoint']))) {
      await this.subscribeInline(topicArn, sub, logicalId, mask);
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
