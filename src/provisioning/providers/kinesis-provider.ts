import {
  KinesisClient,
  CreateStreamCommand,
  DeleteStreamCommand,
  DescribeStreamCommand,
  DescribeStreamSummaryCommand,
  UpdateStreamModeCommand,
  UpdateShardCountCommand,
  AddTagsToStreamCommand,
  RemoveTagsFromStreamCommand,
  IncreaseStreamRetentionPeriodCommand,
  DecreaseStreamRetentionPeriodCommand,
  StartStreamEncryptionCommand,
  StopStreamEncryptionCommand,
  ListTagsForStreamCommand,
  ResourceNotFoundException,
  type EncryptionType,
} from '@aws-sdk/client-kinesis';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * Class 1/2 sanitize for `StreamEncryption` placeholder.
 *
 * `readCurrentState` always-emits `StreamEncryption: { EncryptionType:
 * 'NONE' }` for unencrypted streams so the drift comparator can detect
 * a console-side KMS attach (state-keys-only top-level walk needs the
 * key present). On the write side, neither `StartStreamEncryption`
 * (KMS-only) nor `StopStreamEncryption` accepts `NONE` as input —
 * pushing the placeholder through `cdkd drift --revert` would trigger
 * a ValidationException. This helper returns true only when the value
 * represents real KMS encryption (sibling discriminator `EncryptionType
 * === 'KMS'`); the create / update code paths gate every encryption-
 * mutating SDK call on it.
 */
function isKmsEncryption(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false;
  return value['EncryptionType'] === 'KMS';
}

/**
 * AWS Kinesis Stream Provider
 *
 * Implements resource provisioning for AWS::Kinesis::Stream using the Kinesis SDK.
 * WHY: The CC API polls with exponential backoff (1s->2s->4s->8s->10s) for stream
 * creation, but we can poll DescribeStream directly with shorter intervals (2s),
 * eliminating the CC API intermediary overhead and reducing total wait time.
 */
export class KinesisStreamProvider implements ResourceProvider {
  private client: KinesisClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('KinesisProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Kinesis::Stream',
      new Set([
        'Name',
        'StreamModeDetails',
        'ShardCount',
        'Tags',
        'RetentionPeriodHours',
        'StreamEncryption',
      ]),
    ],
  ]);

  private getClient(): KinesisClient {
    if (!this.client) {
      this.client = new KinesisClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Create a Kinesis stream
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Kinesis stream ${logicalId}`);

    const streamName =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 128 });

    try {
      // Determine stream mode
      const streamModeDetails = properties['StreamModeDetails'] as
        | Record<string, unknown>
        | undefined;
      const streamMode = (streamModeDetails?.['StreamMode'] as string) || 'PROVISIONED';

      // ShardCount is required for PROVISIONED mode
      const shardCount =
        streamMode === 'PROVISIONED' ? Number(properties['ShardCount'] ?? 1) : undefined;

      await this.getClient().send(
        new CreateStreamCommand({
          StreamName: streamName,
          ...(shardCount !== undefined && { ShardCount: shardCount }),
          StreamModeDetails: {
            StreamMode: streamMode as 'PROVISIONED' | 'ON_DEMAND',
          },
        })
      );

      this.logger.debug(`CreateStream initiated for ${streamName}, waiting for ACTIVE status`);

      // Poll until stream is ACTIVE
      const streamInfo = await this.waitForStreamActive(streamName);

      // Apply tags if specified
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        const tags: Record<string, string> = {};
        for (const tag of tagList) {
          tags[tag.Key] = tag.Value;
        }
        if (Object.keys(tags).length > 0) {
          await this.getClient().send(
            new AddTagsToStreamCommand({
              StreamName: streamName,
              Tags: tags,
            })
          );
        }
      }

      // Apply RetentionPeriodHours if specified (default is 24 hours)
      const retentionPeriodHours = properties['RetentionPeriodHours'] as number | undefined;
      if (retentionPeriodHours !== undefined && retentionPeriodHours !== 24) {
        this.logger.debug(
          `Setting retention period to ${retentionPeriodHours} hours for ${streamName}`
        );
        if (retentionPeriodHours > 24) {
          await this.getClient().send(
            new IncreaseStreamRetentionPeriodCommand({
              StreamName: streamName,
              RetentionPeriodHours: retentionPeriodHours,
            })
          );
        } else {
          await this.getClient().send(
            new DecreaseStreamRetentionPeriodCommand({
              StreamName: streamName,
              RetentionPeriodHours: retentionPeriodHours,
            })
          );
        }
        // Wait for stream to become ACTIVE after retention period change
        await this.waitForStreamActive(streamName);
      }

      // Apply StreamEncryption if specified.
      //
      // Class 1/2 sanitize: `readCurrentState` always-emits
      // `StreamEncryption: { EncryptionType: 'NONE' }` for unencrypted
      // streams so the comparator can detect a console-side KMS attach.
      // On the write side, `StartStreamEncryption` only accepts `KMS`;
      // the AWS API has no "NONE" mode. Skip the call when the desired
      // EncryptionType is anything but `KMS` so a placeholder round-
      // trip via `cdkd drift --revert` does not push an AWS-invalid
      // input.
      const streamEncryption = properties['StreamEncryption'] as
        | Record<string, unknown>
        | undefined;
      if (isKmsEncryption(streamEncryption)) {
        const keyId = streamEncryption!['KeyId'] as string;
        this.logger.debug(`Enabling stream encryption for ${streamName}`);
        await this.getClient().send(
          new StartStreamEncryptionCommand({
            StreamName: streamName,
            EncryptionType: 'KMS' as EncryptionType,
            KeyId: keyId,
          })
        );
        // Wait for stream to become ACTIVE after encryption change
        await this.waitForStreamActive(streamName);
      }

      this.logger.debug(`Successfully created Kinesis stream ${logicalId}: ${streamName}`);

      return {
        physicalId: streamName,
        attributes: {
          Arn: streamInfo.streamArn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        streamName,
        cause
      );
    }
  }

  /**
   * Update a Kinesis stream
   *
   * Supports switching StreamMode (PROVISIONED <-> ON_DEMAND, via
   * UpdateStreamMode), updating ShardCount for PROVISIONED mode streams,
   * RetentionPeriodHours, StreamEncryption, and Tags. Name changes require
   * replacement (handled by the deployment layer).
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Kinesis stream ${logicalId}: ${physicalId}`);

    try {
      const streamModeDetails = properties['StreamModeDetails'] as
        | Record<string, unknown>
        | undefined;
      const streamMode = (streamModeDetails?.['StreamMode'] as string) || 'PROVISIONED';
      const oldStreamMode =
        ((previousProperties['StreamModeDetails'] as Record<string, unknown> | undefined)?.[
          'StreamMode'
        ] as string) || 'PROVISIONED';

      // Switch StreamMode FIRST (PROVISIONED <-> ON_DEMAND). In CFn,
      // StreamModeDetails is "Update requires: No interruption", applied via
      // UpdateStreamMode. cdkd previously had no UpdateStreamMode call, so a
      // mode switch was silently dropped — the deploy reported success while
      // AWS kept the old mode and state recorded the new one (and the next
      // diff saw no change, so it could never self-heal). Doing it before any
      // ShardCount work means ON_DEMAND -> PROVISIONED lands in provisioned
      // mode before the (invalid-on-on-demand) UpdateShardCount runs, and
      // PROVISIONED -> ON_DEMAND skips the ShardCount path entirely.
      const modeChanged = oldStreamMode !== streamMode;
      if (modeChanged) {
        const streamArn = await this.resolveStreamArn(physicalId);
        this.logger.debug(
          `Switching stream mode for ${physicalId}: ${oldStreamMode} -> ${streamMode}`
        );
        await this.getClient().send(
          new UpdateStreamModeCommand({
            StreamARN: streamArn,
            StreamModeDetails: {
              StreamMode: streamMode as 'PROVISIONED' | 'ON_DEMAND',
            },
          })
        );
        await this.waitForStreamActive(physicalId);
      }

      // Update ShardCount if changed (only for PROVISIONED mode).
      if (streamMode === 'PROVISIONED') {
        const newShardCount = Number(properties['ShardCount'] ?? 1);
        // When we just switched INTO provisioned mode from on-demand, AWS
        // assigns a shard count based on the prior on-demand throughput and
        // previousProperties carries no ShardCount, so read the live count to
        // know the real base to reconcile against.
        const oldShardCount = modeChanged
          ? await this.getOpenShardCount(physicalId)
          : Number(previousProperties['ShardCount'] ?? 1);

        if (newShardCount !== oldShardCount) {
          this.logger.debug(
            `Updating shard count for ${physicalId}: ${oldShardCount} -> ${newShardCount}`
          );

          await this.getClient().send(
            new UpdateShardCountCommand({
              StreamName: physicalId,
              TargetShardCount: newShardCount,
              ScalingType: 'UNIFORM_SCALING',
            })
          );

          // Wait for stream to become ACTIVE after resharding
          await this.waitForStreamActive(physicalId);
        }
      }

      // Update RetentionPeriodHours if changed
      const newRetention = properties['RetentionPeriodHours'] as number | undefined;
      const oldRetention = previousProperties['RetentionPeriodHours'] as number | undefined;
      const effectiveNewRetention = newRetention ?? 24;
      const effectiveOldRetention = oldRetention ?? 24;
      if (effectiveNewRetention !== effectiveOldRetention) {
        this.logger.debug(
          `Updating retention period for ${physicalId}: ${effectiveOldRetention} -> ${effectiveNewRetention}`
        );
        if (effectiveNewRetention > effectiveOldRetention) {
          await this.getClient().send(
            new IncreaseStreamRetentionPeriodCommand({
              StreamName: physicalId,
              RetentionPeriodHours: effectiveNewRetention,
            })
          );
        } else {
          await this.getClient().send(
            new DecreaseStreamRetentionPeriodCommand({
              StreamName: physicalId,
              RetentionPeriodHours: effectiveNewRetention,
            })
          );
        }
        await this.waitForStreamActive(physicalId);
      }

      // Apply tag diff. Kinesis uses AddTagsToStream (map shape) and
      // RemoveTagsFromStream (TagKeys list).
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      // Update StreamEncryption if changed.
      //
      // Class 1/2 sanitize: `readCurrentState` always-emits
      // `StreamEncryption: { EncryptionType: 'NONE' }` on unencrypted
      // streams for drift detection. Treat the NONE placeholder as
      // "no encryption" — it is NOT a valid input to either
      // `StartStreamEncryption` (KMS-only) or `StopStreamEncryption`
      // (encryption-removal). Only call:
      //  - StopStreamEncryption when previous WAS KMS-encrypted.
      //  - StartStreamEncryption when desired IS KMS-encrypted.
      //
      // Without this, a `cdkd drift --revert` round-trip on a stream
      // that has never been KMS-encrypted would push `EncryptionType=NONE`
      // back through the API and AWS rejects with a ValidationException.
      const newEncryption = properties['StreamEncryption'] as Record<string, unknown> | undefined;
      const oldEncryption = previousProperties['StreamEncryption'] as
        | Record<string, unknown>
        | undefined;
      const oldIsKms = isKmsEncryption(oldEncryption);
      const newIsKms = isKmsEncryption(newEncryption);
      const oldKeyId = oldIsKms ? (oldEncryption!['KeyId'] as string | undefined) : undefined;
      const newKeyId = newIsKms ? (newEncryption!['KeyId'] as string | undefined) : undefined;
      if (oldIsKms !== newIsKms || (oldIsKms && newIsKms && oldKeyId !== newKeyId)) {
        // Remove old encryption only when it WAS KMS-encrypted.
        if (oldIsKms) {
          await this.getClient().send(
            new StopStreamEncryptionCommand({
              StreamName: physicalId,
              EncryptionType: 'KMS' as EncryptionType,
              KeyId: oldKeyId,
            })
          );
          await this.waitForStreamActive(physicalId);
        }
        // Apply new encryption only when it IS KMS-encrypted.
        if (newIsKms) {
          await this.getClient().send(
            new StartStreamEncryptionCommand({
              StreamName: physicalId,
              EncryptionType: 'KMS' as EncryptionType,
              KeyId: newKeyId,
            })
          );
          await this.waitForStreamActive(physicalId);
        }
      }

      // Get current stream description for attributes
      const response = await this.getClient().send(
        new DescribeStreamCommand({ StreamName: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: response.StreamDescription?.StreamARN,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Kinesis stream
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Kinesis stream ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteStreamCommand({
          StreamName: physicalId,
          EnforceConsumerDeletion: true,
        })
      );
      this.logger.debug(`Successfully deleted Kinesis stream ${logicalId}`);
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
        this.logger.debug(`Kinesis stream ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via Kinesis's
   * `AddTagsToStream` (map shape) / `RemoveTagsFromStream` (TagKeys list)
   * APIs.
   */
  private async applyTagDiff(
    streamName: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Record<string, string> = {};
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd[k] = v;
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsFromStreamCommand({ StreamName: streamName, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from Kinesis stream ${streamName}`);
    }
    if (Object.keys(tagsToAdd).length > 0) {
      await this.getClient().send(
        new AddTagsToStreamCommand({ StreamName: streamName, Tags: tagsToAdd })
      );
      this.logger.debug(
        `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on Kinesis stream ${streamName}`
      );
    }
  }

  /**
   * Adopt an existing Kinesis stream into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.Name` → verify
   *     with `DescribeStream`.
   */
  /**
   * Read the AWS-current Kinesis stream configuration in CFn-property shape.
   *
   * Issues `DescribeStream` and surfaces the keys cdkd's `create()`
   * accepts: `Name`, `StreamModeDetails`, `ShardCount`, `RetentionPeriodHours`,
   * and `StreamEncryption`. Tags are surfaced via a follow-up
   * `ListTagsForStream` with `aws:*` filtered out.
   *
   * `ShardCount` is reported as the count of `Shards[]` in the stream
   * description (only present for PROVISIONED-mode streams; ON_DEMAND
   * mode reports an empty list).
   *
   * Returns `undefined` when the stream is gone (`ResourceNotFoundException`).
   *
   * `AWS::Kinesis::StreamConsumer` is intentionally not handled here: this
   * provider only registers `AWS::Kinesis::Stream`, so consumer resources
   * route to the CC API fallback for drift detection (CC API's `GetResource`
   * surfaces every Kinesis consumer attribute the user can configure). A
   * dedicated SDK impl would require building out create/update/delete first;
   * out of scope for PR G.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    if (resourceType !== 'AWS::Kinesis::Stream') return undefined;

    let stream;
    try {
      const resp = await this.getClient().send(
        new DescribeStreamCommand({ StreamName: physicalId })
      );
      stream = resp.StreamDescription;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
    if (!stream) return undefined;

    const result: Record<string, unknown> = {};
    if (stream.StreamName !== undefined) result['Name'] = stream.StreamName;
    const streamMode = stream.StreamModeDetails?.StreamMode;
    if (streamMode !== undefined) {
      result['StreamModeDetails'] = { StreamMode: streamMode };
    }
    // Class 1 — `ShardCount` is PROVISIONED-only. AWS rejects
    // `UpdateShardCount` on ON_DEMAND streams; emitting a `ShardCount`
    // placeholder there would surface as a `cdkd drift --revert`
    // failure on the round-trip. ON_DEMAND streams report shards too
    // (capacity is managed by AWS), so gating on `Shards.length` is
    // not enough — the type discriminator is `StreamMode`.
    if (streamMode === 'PROVISIONED' && stream.Shards && stream.Shards.length > 0) {
      result['ShardCount'] = stream.Shards.length;
    }
    if (stream.RetentionPeriodHours !== undefined) {
      result['RetentionPeriodHours'] = stream.RetentionPeriodHours;
    }
    {
      const encryption: Record<string, unknown> = {
        EncryptionType: stream.EncryptionType ?? 'NONE',
      };
      if (stream.KeyId !== undefined) encryption['KeyId'] = stream.KeyId;
      result['StreamEncryption'] = encryption;
    }

    // Tags via ListTagsForStream.
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForStreamCommand({ StreamName: physicalId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
      result['Tags'] = tags;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      this.logger.debug(
        `Kinesis ListTagsForStream(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (explicit) {
      try {
        await this.getClient().send(new DescribeStreamCommand({ StreamName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a stream
    // reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * Poll DescribeStream until the stream reaches ACTIVE status
   *
   * Uses 2s polling intervals instead of CC API's exponential backoff
   * (1s->2s->4s->8s->10s), reducing total wait time.
   */
  private async waitForStreamActive(
    streamName: string,
    maxAttempts = 30
  ): Promise<{ streamArn: string | undefined }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.getClient().send(
        new DescribeStreamCommand({ StreamName: streamName })
      );

      const status = response.StreamDescription?.StreamStatus;
      this.logger.debug(
        `Stream ${streamName} status: ${status} (attempt ${attempt}/${maxAttempts})`
      );

      if (status === 'ACTIVE') {
        return {
          streamArn: response.StreamDescription?.StreamARN,
        };
      }

      if (status !== 'CREATING' && status !== 'UPDATING') {
        throw new Error(`Unexpected stream status: ${status}`);
      }

      // Wait 2 seconds between polls
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(
      `Stream ${streamName} did not reach ACTIVE status within ${maxAttempts * 2} seconds`
    );
  }

  /**
   * Resolve a stream's ARN from its name. UpdateStreamMode is one of the few
   * Kinesis APIs that takes a StreamARN rather than a StreamName, so an
   * update that switches StreamModeDetails needs the ARN.
   */
  private async resolveStreamArn(streamName: string): Promise<string> {
    const response = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: streamName })
    );
    const arn = response.StreamDescriptionSummary?.StreamARN;
    if (!arn) {
      throw new Error(`Unable to resolve StreamARN for stream ${streamName}`);
    }
    return arn;
  }

  /**
   * Read the stream's current open shard count. Used after an
   * ON_DEMAND -> PROVISIONED mode switch, where previousProperties carries no
   * ShardCount and AWS has assigned its own count, so reconciling against the
   * live count (not the absent state value) is the only correct base.
   */
  private async getOpenShardCount(streamName: string): Promise<number> {
    const response = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: streamName })
    );
    return Number(response.StreamDescriptionSummary?.OpenShardCount ?? 1);
  }
}
