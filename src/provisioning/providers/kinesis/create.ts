import type { KinesisStreamProvider } from '../kinesis-provider.js';
import {
  CreateStreamCommand,
  EnableEnhancedMonitoringCommand,
  IncreaseStreamRetentionPeriodCommand,
  DecreaseStreamRetentionPeriodCommand,
  StartStreamEncryptionCommand,
  type EncryptionType,
} from '@aws-sdk/client-kinesis';
import { readConfigString } from '../../config-shape.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import {
  isKmsEncryption,
  readShardLevelMetrics,
  readMaxRecordSize,
  readRetentionHours,
  readEncryptionKeyId,
  readDistributionStrategy,
} from './shared.js';

/**
 * Create a Kinesis stream
 */
export async function create(
  this: KinesisStreamProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2178: the sink for the lines that QUOTE a value read off the bag.
  // `properties` arrives RESOLVED, so a `{{resolve:secretsmanager:...}}`
  // scalar is already plaintext by the time the readers below refuse one.
  // The remaining `this.logger.debug` lines in this method name the stream
  // rather than a property value and are part of issue #2177's TIER A sweep.
  const mask = maskerOrIdentity(context?.maskSecrets);
  const warn = (message: string): void => this.logger.warn(mask(message));

  this.logger.debug(`Creating Kinesis stream ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const streamName =
    (properties['Name'] as string | undefined) ||
    generatedNameFor('AWS::Kinesis::Stream', logicalId);

  // PRE-FLIGHT, deliberately ABOVE the try (docs/provider-rules.md#pre-flight-refusal-when-a-provider-may-reject-what-cloudformation-forwards).
  // Refusing from inside it would throw AFTER `CreateStream` already ran,
  // leaving a stream no state record holds: only `cdkd rollback
  // --revert-failed` removes it (go-to-k/cdkd#1710's mark in the catch below),
  // and until then the retry collides on the deterministic `streamName` with
  // `ResourceInUseException`. None of these checks needs an AWS call.
  const desiredRead = readShardLevelMetrics(properties['DesiredShardLevelMetrics'], mask);
  if (desiredRead.kind === 'unusable') {
    if (context?.replayingState === true) {
      // A state replay cannot be fixed from the user's CDK code, so the
      // refusal downgrades to a warning and the restore proceeds without the
      // metrics rather than leaving the resource unrestorable (issue #1463).
      warn(
        `${desiredRead.reason}. Replaying a state record, so the shard-level metrics are ` +
          `left unset on ${streamName} rather than refusing the restore`
      );
    } else {
      throw new ProvisioningError(desiredRead.reason, resourceType, logicalId, streamName);
    }
  }
  const maxRecordRead = readMaxRecordSize(properties['MaxRecordSizeInKiB'], mask);
  if (maxRecordRead.kind === 'unusable') {
    if (context?.replayingState === true) {
      warn(
        `${maxRecordRead.reason}. Replaying a state record, so ${streamName} is created with ` +
          `AWS's default maximum record size rather than refusing the restore`
      );
    } else {
      throw new ProvisioningError(maxRecordRead.reason, resourceType, logicalId, streamName);
    }
  }
  // go-to-k/cdkd#1710: two FOLLOW-UP calls run after `CreateStream` in the
  // try below — the retention change and `StartStreamEncryption` — so a
  // malformed value there failed against a stream that already exists.
  // Refused here for that reason; the checks are pure.
  //
  // On a state replay an unusable RETENTION skips its call with a warning (a
  // guessed retention would land on a live stream; AWS's default is a safe
  // floor). An unusable KMS block is refused even then: skipping it would
  // leave the stream UNENCRYPTED while the record says KMS, a silent and
  // persistent downgrade.
  const retentionRead = readRetentionHours(properties['RetentionPeriodHours'], mask);
  if (retentionRead.kind === 'unusable') {
    if (context?.replayingState !== true) {
      throw new ProvisioningError(retentionRead.reason, resourceType, logicalId, streamName);
    }
    warn(
      `${retentionRead.reason}. Replaying a state record, so the retention period is left at ` +
        `AWS's default on ${streamName} rather than refusing the restore`
    );
  }
  const encryptionRead = readEncryptionKeyId(
    properties['StreamEncryption'] as Record<string, unknown> | undefined,
    mask
  );
  if (encryptionRead.kind === 'unusable') {
    throw new ProvisioningError(encryptionRead.reason, resourceType, logicalId, streamName);
  }
  // go-to-k/cdkd#2762: it rides on `CreateStream` itself, so an unusable
  // value is refused here rather than sent; a state replay omits it (AWS's
  // default applies) with a warning instead of refusing the restore.
  const strategyRead = readDistributionStrategy(properties['RecordDistributionStrategy'], mask);
  if (strategyRead.kind === 'unusable') {
    if (context?.replayingState !== true) {
      throw new ProvisioningError(strategyRead.reason, resourceType, logicalId, streamName);
    }
    warn(
      `${strategyRead.reason}. Replaying a state record, so ${streamName} is created with ` +
        `AWS's default record distribution strategy rather than refusing the restore`
    );
  }

  // Set once CreateStream returns. No failure after it is this stream's name
  // collision: it is an auxiliary call's (the retention change,
  // StartStreamEncryption, EnableEnhancedMonitoring) or an ACTIVE wait's,
  // so every one is marked (#3826, #3877).
  let streamCreated = false;
  try {
    // Determine stream mode
    const streamModeDetails = properties['StreamModeDetails'] as
      | Record<string, unknown>
      | undefined;
    const streamMode = readConfigString(
      streamModeDetails,
      'StreamMode',
      'PROVISIONED',
      'AWS::Kinesis::Stream StreamModeDetails'
    );

    // ShardCount is required for PROVISIONED mode
    const shardCount =
      streamMode === 'PROVISIONED' ? Number(properties['ShardCount'] ?? 1) : undefined;

    // MaxRecordSizeInKiB is a member of CreateStreamInput, so it lands with
    // the stream itself rather than needing a follow-up call. Validated by
    // the pre-flight above; an unusable value only reaches here on a state
    // replay, where it is omitted and AWS applies its own default.
    const maxRecordSizeInKiB = maxRecordRead.kind === 'usable' ? maxRecordRead.size : undefined;

    // go-to-k/cdkd#4971: the tags ride on `CreateStream` itself, as
    // CloudFormation sends them, so an SCP requiring `aws:RequestTag/...` on
    // `kinesis:CreateStream` sees them. No separate `AddTagsToStream`
    // follows. A tagged `CreateStream` needs `kinesis:AddTagsToStream`
    // (measured), the permission that follow-up call already needed.
    const tags: Record<string, string> = {};
    for (const tag of desiredTags) {
      tags[tag.Key] = tag.Value;
    }

    await this.getCreateClient().send(
      new CreateStreamCommand({
        StreamName: streamName,
        ...(shardCount !== undefined && { ShardCount: shardCount }),
        StreamModeDetails: {
          StreamMode: streamMode as 'PROVISIONED' | 'ON_DEMAND',
        },
        ...(maxRecordSizeInKiB !== undefined && { MaxRecordSizeInKiB: maxRecordSizeInKiB }),
        // go-to-k/cdkd#2762: a `CreateStreamInput` member, as CloudFormation
        // sends it; AWS accepts it only on an ON_DEMAND stream and judges
        // that itself.
        ...(strategyRead.kind === 'usable' && {
          RecordDistributionStrategy: strategyRead.strategy,
        }),
        ...(Object.keys(tags).length > 0 && { Tags: tags }),
      })
    );
    streamCreated = true;
    // go-to-k/cdkd#5511: reported before the ACTIVE wait.
    reportCreatedResource(logicalId, resourceType, streamName);

    this.logger.debug(`CreateStream initiated for ${streamName}, waiting for ACTIVE status`);

    // Poll until stream is ACTIVE
    const streamInfo = await this.waitForStreamActive(streamName);

    // Apply RetentionPeriodHours if specified (default is 24 hours)
    const retentionPeriodHours = retentionRead.kind === 'usable' ? retentionRead.hours : undefined;
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
    const streamEncryption = properties['StreamEncryption'] as Record<string, unknown> | undefined;
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

    // Apply DesiredShardLevelMetrics. `EnableEnhancedMonitoring` takes the
    // stream to UPDATING (measured), so it must settle before create returns.
    //
    // Validated by the pre-flight above the try; an unusable value reaches
    // here only on a state replay, where it was warned about and skipped.
    const desiredMetrics = desiredRead.kind === 'usable' ? desiredRead.expanded : undefined;
    const metricsToEnable = desiredRead.kind === 'usable' ? desiredRead.metrics : [];
    if (metricsToEnable.length > 0) {
      this.logger.debug(
        `Enabling ${metricsToEnable.length} shard-level metric(s) on ${streamName}`
      );
      await this.getClient().send(
        new EnableEnhancedMonitoringCommand({
          StreamName: streamName,
          ShardLevelMetrics: metricsToEnable,
        })
      );
      await this.waitForStreamActive(streamName);
    }

    this.logger.debug(`Successfully created Kinesis stream ${logicalId}: ${streamName}`);

    return {
      physicalId: streamName,
      attributes: {
        Arn: streamInfo.streamArn,
      },
      // Record the EXPANDED metric list when the template used `ALL`: AWS
      // stores the seven names, so recording `ALL` would be permanent phantom
      // drift no `readCurrentState` could ever match. Absent when the
      // expansion was a no-op, which keeps the desired bag recorded verbatim.
      ...this.effectiveMetricsProperties(properties, desiredMetrics),
    };
  } catch (error) {
    if (streamCreated) markAuxiliaryFailure(error, logicalId);
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            mask,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create Kinesis stream ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                streamName,
                error instanceof Error ? error : undefined
              )
          );
    // go-to-k/cdkd#1710: the stream exists and no state record will hold it,
    // so name it for the failed-CREATE journal. Only once CreateStream has
    // returned: before that, `streamName` may be another owner's stream.
    if (streamCreated) markCreatedBeforeFailure(thrown, logicalId, resourceType, streamName);
    throw thrown;
  }
}
