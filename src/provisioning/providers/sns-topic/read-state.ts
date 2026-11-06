import type { SNSTopicProvider } from '../sns-topic-provider.js';
import {
  GetTopicAttributesCommand,
  ListTopicsCommand,
  ListTagsForResourceCommand,
  ListSubscriptionsByTopicCommand,
  NotFoundException,
} from '@aws-sdk/client-sns';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT,
  snsTopicAttributes,
  stateProtocolCaseMap,
  mapDeliveryStatusLogging,
} from './shared.js';

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
 * (`HTTP` / `SQS` / `Lambda` / `Firehose` / `Application`); a
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
 * Returns `RESOURCE_NOT_FOUND` when the topic is gone (`NotFoundException`).
 */
export async function readCurrentState(
  this: SNSTopicProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let attrs: Record<string, string> | undefined;
  try {
    const resp = await this.snsClient.send(new GetTopicAttributesCommand({ TopicArn: physicalId }));
    attrs = resp.Attributes;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
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

  // MaximumMessageSize (issue #3413) — emitted UNCONDITIONALLY, folding an
  // absent attribute to the default, for the same reason the string members
  // above emit `''`: the drift comparator's top-level walk visits the keys
  // of the BASELINE (`observedProperties`, this method's own answer at
  // deploy time), so a key this method omits is a key no console-side
  // change can ever surface under. AWS reports the attribute only once it
  // has been SET (a fresh topic carries no value; measured us-east-1
  // 2026-09-18) and a template REMOVAL resets it to the default rather than
  // unsetting it (SNS refuses `''`) — so absent and 262144 are the same
  // live fact, and folding them makes every baseline carry the key: a
  // reset-to-default compares equal to itself (no phantom drift), a
  // console-side ADD compares unequal (drift, and `--revert` sends the
  // default back, which SNS accepts). A number, like the SQS sibling, so a
  // template's integer compares equal to the readback. "Every baseline"
  // means every baseline THIS binary captured: an `observedProperties` bag
  // written by an older cdkd has no key and is refreshed only on the
  // resource's next real update or by `cdkd state refresh-observed` — the
  // same transition the `''` string members above went through.
  // `||`, not `??`: SNS refuses `''` on write, so it should never be
  // reported, but `Number('')` is a finite 0 and would surface as drift
  // against 262144 if it ever were.
  const liveMaxSize = attrs['MaximumMessageSize'] || SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT;
  const maxSizeNumber = Number(liveMaxSize);
  result['MaximumMessageSize'] = Number.isFinite(maxSizeNumber) ? maxSizeNumber : liveMaxSize;

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
  // (HTTP / SQS / Lambda / Firehose / Application) and emits a
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
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
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
export async function importImpl(
  this: SNSTopicProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      await this.snsClient.send(new GetTopicAttributesCommand({ TopicArn: input.knownPhysicalId }));
      // Issue #3627: the same map `create()` records. The resolver's
      // `TopicArn` / `TopicName` arms read the physical id as a NAME, but it
      // is the ARN, so without these an imported topic served a doubled ARN
      // and an ARN as its name, silently.
      return {
        physicalId: input.knownPhysicalId,
        attributes: snsTopicAttributes(input.knownPhysicalId),
      };
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  const desiredName =
    typeof input.properties?.['TopicName'] === 'string' ? input.properties['TopicName'] : undefined;
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
        return { physicalId: t.TopicArn, attributes: snsTopicAttributes(t.TopicArn) };
      }
    }
    marker = list.NextToken;
  } while (marker);
  return null;
}
