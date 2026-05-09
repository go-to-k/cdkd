import {
  KinesisClient,
  RegisterStreamConsumerCommand,
  DeregisterStreamConsumerCommand,
  DescribeStreamConsumerCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::Kinesis::StreamConsumer.
 *
 * The CC API fallback covered basic CRUD for this type, but per
 * `feedback_dedicated_provider_over_special_case.md` consistent
 * coverage is achieved via dedicated SDK providers — not CC-API
 * special-cases.
 *
 * StreamConsumer is **immutable**: both `ConsumerName` and `StreamARN`
 * lock at registration. Any property change triggers replacement; the
 * provider's `update()` therefore throws `ResourceUpdateNotSupportedError`
 * (the deploy engine's replacement-detection layer handles real changes
 * by issuing DELETE + CREATE).
 *
 * Tags are mutable via the generic `TagResource` / `UntagResource` /
 * `ListTagsForResource` APIs (which accept any Kinesis resource ARN
 * including a consumer ARN). They are surfaced in `readCurrentState`
 * with the always-emit `[]` placeholder pattern (PR #145) so the v3
 * `observedProperties` baseline catches console-side tag additions on a
 * previously-untagged consumer. The CFn schema for
 * `AWS::Kinesis::StreamConsumer` does not currently model `Tags` as a
 * top-level property, but cdkd surfaces it defensively in case future
 * CFn schema revisions add it.
 *
 * physicalId for this provider is the consumer's `ConsumerARN`
 * (stable, AWS-assigned, returned by `RegisterStreamConsumer`).
 */
export class KinesisStreamConsumerProvider implements ResourceProvider {
  private client: KinesisClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('KinesisStreamConsumerProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Kinesis::StreamConsumer', new Set(['ConsumerName', 'StreamARN', 'Tags'])],
  ]);

  private getClient(): KinesisClient {
    if (!this.client) {
      this.client = new KinesisClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Register a Kinesis stream consumer.
   *
   * Polls `DescribeStreamConsumer` until ConsumerStatus flips from
   * `CREATING` to `ACTIVE` (matches CFn behavior). 1s polling interval
   * is faster than the CC API exponential backoff used to be.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    const consumerName = properties['ConsumerName'] as string | undefined;
    const streamArn = properties['StreamARN'] as string | undefined;

    if (!consumerName) {
      throw new ProvisioningError(
        'AWS::Kinesis::StreamConsumer requires ConsumerName',
        resourceType,
        logicalId
      );
    }
    if (!streamArn) {
      throw new ProvisioningError(
        'AWS::Kinesis::StreamConsumer requires StreamARN',
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Registering Kinesis stream consumer ${logicalId}: ${consumerName}`);

    const tagList = Array.isArray(properties['Tags'])
      ? (properties['Tags'] as Array<{ Key?: string; Value?: string }>)
      : undefined;
    const tagMap = tagListToMap(tagList);

    try {
      const resp = await this.getClient().send(
        new RegisterStreamConsumerCommand({
          StreamARN: streamArn,
          ConsumerName: consumerName,
          ...(tagMap && Object.keys(tagMap).length > 0 ? { Tags: tagMap } : {}),
        })
      );

      const consumer = resp.Consumer;
      if (!consumer?.ConsumerARN || !consumer.ConsumerName) {
        throw new ProvisioningError(
          'RegisterStreamConsumer did not return ConsumerARN/ConsumerName',
          resourceType,
          logicalId
        );
      }

      // Poll until ACTIVE.
      const consumerArn = consumer.ConsumerARN;
      await this.waitForConsumerActive(consumerArn);

      this.logger.debug(`Successfully registered Kinesis stream consumer ${logicalId}`);

      return {
        physicalId: consumerArn,
        attributes: {
          ConsumerARN: consumerArn,
          ConsumerName: consumer.ConsumerName,
          ConsumerStatus: consumer.ConsumerStatus,
          ConsumerCreationTimestamp: consumer.ConsumerCreationTimestamp?.toISOString() ?? undefined,
          // CFn `Id` for StreamConsumer is the ConsumerARN (matches the
          // CFn return-values doc).
          Id: consumerArn,
          StreamARN: streamArn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to register Kinesis stream consumer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        consumerName,
        cause
      );
    }
  }

  /**
   * Update is a no-op for the immutable `ConsumerName` / `StreamARN`
   * fields (the deploy engine's replacement-detection layer triggers
   * DELETE + CREATE for those changes). Tags ARE mutable via
   * `TagResource` / `UntagResource` so the diff is applied here.
   *
   * If a non-Tags property changes, throw `ResourceUpdateNotSupportedError`
   * — `cdkd drift --revert` will surface that to the user with the
   * "use cdkd deploy --replace" suggestion.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // Only Tags are mutable. Reject any non-Tags diff with
    // ResourceUpdateNotSupportedError so the user gets a clear hint.
    const newConsumerName = properties['ConsumerName'];
    const oldConsumerName = previousProperties['ConsumerName'];
    const newStreamArn = properties['StreamARN'];
    const oldStreamArn = previousProperties['StreamARN'];

    if (newConsumerName !== oldConsumerName || newStreamArn !== oldStreamArn) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'AWS::Kinesis::StreamConsumer ConsumerName / StreamARN are immutable; re-deploy with cdkd deploy --replace, or destroy + redeploy'
      );
    }

    // Apply Tags diff via TagResource / UntagResource.
    await this.applyTagDiff(
      physicalId,
      previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
      properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
    );

    // Re-fetch attributes for the result.
    let attrs: Record<string, unknown> = {};
    try {
      const resp = await this.getClient().send(
        new DescribeStreamConsumerCommand({ ConsumerARN: physicalId })
      );
      const desc = resp.ConsumerDescription;
      if (desc) {
        attrs = {
          ConsumerARN: desc.ConsumerARN,
          ConsumerName: desc.ConsumerName,
          ConsumerStatus: desc.ConsumerStatus,
          ConsumerCreationTimestamp: desc.ConsumerCreationTimestamp?.toISOString() ?? undefined,
          Id: desc.ConsumerARN,
          StreamARN: desc.StreamARN,
        };
      }
    } catch (err) {
      // Best-effort attribute refresh — do not fail the update path on
      // a transient read error.
      this.logger.debug(
        `DescribeStreamConsumer(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      physicalId,
      wasReplaced: false,
      attributes: attrs,
    };
  }

  /**
   * Deregister a Kinesis stream consumer.
   *
   * Per CFn semantics, DELETE returns once `DeregisterStreamConsumer`
   * returns — AWS handles eventual disappearance asynchronously, but
   * cdkd does not need to poll for that. `ResourceNotFoundException`
   * is treated as idempotent success (subject to the standard region
   * verification for delete idempotency).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deregistering Kinesis stream consumer ${logicalId}: ${physicalId}`);
    try {
      await this.getClient().send(new DeregisterStreamConsumerCommand({ ConsumerARN: physicalId }));
      this.logger.debug(`Successfully deregistered Kinesis stream consumer ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Kinesis stream consumer ${physicalId} not found, skipping`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to deregister Kinesis stream consumer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'ConsumerARN' || attributeName === 'Id') {
      // physicalId IS the ConsumerARN.
      return physicalId;
    }
    const resp = await this.getClient().send(
      new DescribeStreamConsumerCommand({ ConsumerARN: physicalId })
    );
    const desc = resp.ConsumerDescription;
    if (!desc) return undefined;
    switch (attributeName) {
      case 'ConsumerName':
        return desc.ConsumerName;
      case 'ConsumerStatus':
        return desc.ConsumerStatus;
      case 'ConsumerCreationTimestamp':
        return desc.ConsumerCreationTimestamp?.toISOString() ?? undefined;
      case 'StreamARN':
        return desc.StreamARN;
      default:
        return undefined;
    }
  }

  /**
   * Read the AWS-current StreamConsumer configuration in CFn-property shape.
   *
   * Surfaces `ConsumerName` + `StreamARN` (the only user-controllable
   * top-level CFn properties). AWS-managed read-only fields
   * (`ConsumerARN`, `ConsumerCreationTimestamp`, `ConsumerStatus`) are
   * omitted — they are not in `handledProperties` and surface only as
   * `getAttribute` results.
   *
   * `Tags` are surfaced via `ListTagsForResource(ResourceARN=ConsumerARN)`
   * with `aws:*` filtered out and the always-emit `[]` placeholder
   * pattern (PR #145). The CFn schema for `AWS::Kinesis::StreamConsumer`
   * does not currently model Tags as a top-level property, but cdkd
   * surfaces it defensively so future schema revisions or custom
   * property overrides can round-trip cleanly.
   *
   * Returns `undefined` when the consumer is gone
   * (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    if (resourceType !== 'AWS::Kinesis::StreamConsumer') return undefined;

    let desc;
    try {
      const resp = await this.getClient().send(
        new DescribeStreamConsumerCommand({ ConsumerARN: physicalId })
      );
      desc = resp.ConsumerDescription;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
    if (!desc) return undefined;

    const result: Record<string, unknown> = {};
    if (desc.ConsumerName !== undefined) result['ConsumerName'] = desc.ConsumerName;
    if (desc.StreamARN !== undefined) result['StreamARN'] = desc.StreamARN;

    // Tags via ListTagsForResource(ResourceARN=consumerArn). Always-emit
    // `[]` placeholder so a console-side tag add fires drift on the v3
    // observed-properties baseline.
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceARN: physicalId })
      );
      result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      // Best-effort: log and emit empty placeholder.
      this.logger.debug(
        `ListTagsForResource(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
      result['Tags'] = [];
    }

    return result;
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via Kinesis's
   * generic `TagResource` (TagMap shape) / `UntagResource` (TagKeys list)
   * APIs. Mirrors `KinesisStreamProvider.applyTagDiff`, except the
   * Kinesis service splits the per-resource-type tag APIs vs the generic
   * tag APIs — StreamConsumer uses the generic ones (which accept any
   * Kinesis resource ARN).
   */
  private async applyTagDiff(
    consumerArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const oldMap = tagListToMap(oldTagsRaw) ?? {};
    const newMap = tagListToMap(newTagsRaw) ?? {};

    const tagsToAdd: Record<string, string> = {};
    for (const [k, v] of Object.entries(newMap)) {
      if (oldMap[k] !== v) tagsToAdd[k] = v;
    }
    const tagsToRemove: string[] = [];
    for (const k of Object.keys(oldMap)) {
      if (!(k in newMap)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new UntagResourceCommand({ ResourceARN: consumerArn, TagKeys: tagsToRemove })
      );
      this.logger.debug(
        `Removed ${tagsToRemove.length} tag(s) from Kinesis stream consumer ${consumerArn}`
      );
    }
    if (Object.keys(tagsToAdd).length > 0) {
      await this.getClient().send(
        new TagResourceCommand({ ResourceARN: consumerArn, Tags: tagsToAdd })
      );
      this.logger.debug(
        `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on Kinesis stream consumer ${consumerArn}`
      );
    }
  }

  /**
   * Poll DescribeStreamConsumer until the consumer reaches `ACTIVE`.
   *
   * Uses 1s polling intervals — consumer registration is typically
   * sub-second, but AWS can take up to ~30s under load. Caps at 60
   * attempts (1 minute total) which is bounded above by the per-resource
   * `--resource-timeout` deadline.
   */
  private async waitForConsumerActive(consumerArn: string, maxAttempts = 60): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await this.getClient().send(
        new DescribeStreamConsumerCommand({ ConsumerARN: consumerArn })
      );
      const status = resp.ConsumerDescription?.ConsumerStatus;
      this.logger.debug(
        `Consumer ${consumerArn} status: ${status} (attempt ${attempt}/${maxAttempts})`
      );
      if (status === 'ACTIVE') return;
      if (status !== 'CREATING') {
        throw new Error(`Unexpected consumer status: ${status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Consumer ${consumerArn} did not reach ACTIVE status within ${maxAttempts} seconds`
    );
  }
}

/**
 * Convert a CFn-shape Tags array to the Kinesis SDK TagMap shape
 * (`{ "<key>": "<value>" }`). Returns `undefined` when the input is
 * empty / missing so callers can skip the SDK Tags field entirely
 * (rather than passing an empty map that some AWS APIs treat as
 * "remove all").
 */
function tagListToMap(
  tags: Array<{ Key?: string; Value?: string }> | undefined
): Record<string, string> | undefined {
  if (!tags || tags.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const t of tags) {
    if (t.Key !== undefined && t.Value !== undefined) out[t.Key] = t.Value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
