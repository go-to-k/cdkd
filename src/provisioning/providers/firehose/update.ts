import type { FirehoseProvider } from '../firehose-provider.js';
import {
  DescribeDeliveryStreamCommand,
  UpdateDestinationCommand,
  TagDeliveryStreamCommand,
  UntagDeliveryStreamCommand,
  type DeliveryStreamDescription,
  type DeliveryStreamEncryptionConfiguration,
} from '@aws-sdk/client-firehose';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch } from '../../region-check.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  ENCRYPTION_KEY,
  readEncryptionInput,
  sameEncryptionInput,
  liveEncryptionAsCfn,
  isReadableTagList,
  FIXED_BACKUP_MODE_DESTINATIONS,
  DEFAULT_OPENSEARCH_BACKUP_MODE,
  unappliedS3BackupModeDestination,
} from './shared.js';

/**
 * Apply in-place updates to a Firehose delivery stream via the per-shape
 * AWS APIs (#477):
 *
 *   - **Tags** (`TagDeliveryStream` / `UntagDeliveryStream`) — always
 *     supported; runs first since it is destination-independent.
 *   - **`ExtendedS3DestinationConfiguration`** (`UpdateDestination` with
 *     an `ExtendedS3DestinationUpdate` payload) — recovers
 *     `CurrentDeliveryStreamVersionId` + `DestinationId` from a
 *     `DescribeDeliveryStream` call, then applies the diff. Only fires
 *     when the destination shape actually differs.
 *
 *   - `RedshiftDestinationConfiguration` (#549) — same flow as
 *     ExtendedS3: `DescribeDeliveryStream` recovers VersionId +
 *     DestinationId, then `UpdateDestinationCommand` issues the
 *     diff with a `RedshiftDestinationUpdate` payload produced by
 *     {@link mapRedshiftConfigToUpdate}. Handles `CopyCommand`,
 *     `RetryOptions`, `S3Configuration` → `S3Update`,
 *     `S3BackupConfiguration` → `S3BackupUpdate`,
 *     `ProcessingConfiguration`, `S3BackupMode`,
 *     `CloudWatchLoggingOptions`, `Username` / `Password` /
 *     `RoleARN` / `ClusterJDBCURL`.
 *
 *   - `SplunkDestinationConfiguration` (#549) — same flow as
 *     Redshift: `DescribeDeliveryStream` recovers VersionId +
 *     DestinationId, then `UpdateDestinationCommand` issues the
 *     diff with a `SplunkDestinationUpdate` payload produced by
 *     {@link mapSplunkConfigToUpdate}. Handles `HECEndpoint`,
 *     `HECEndpointType`, `HECToken`,
 *     `HECAcknowledgmentTimeoutInSeconds`, `RetryOptions`,
 *     `S3BackupMode`, `S3Configuration` → `S3Update`,
 *     `ProcessingConfiguration`, `CloudWatchLoggingOptions`,
 *     `BufferingHints`, `SecretsManagerConfiguration`. Splunk has
 *     no S3 backup destination shape (no `S3BackupConfiguration`
 *     field) — unlike Redshift / ExtendedS3.
 *
 *   - `AmazonopensearchserviceDestinationConfiguration` (#549) —
 *     `AmazonopensearchserviceDestinationUpdate` payload produced
 *     by {@link mapAmazonopensearchserviceConfigToUpdate}. Handles
 *     `RoleARN`, `DomainARN`, `ClusterEndpoint`, `IndexName`,
 *     `TypeName`, `IndexRotationPeriod`, `BufferingHints`,
 *     `RetryOptions`, `S3Configuration` → `S3Update`,
 *     `ProcessingConfiguration`, `CloudWatchLoggingOptions`,
 *     `DocumentIdOptions`. `VpcConfiguration` has no Update member;
 *     it is create-only in the CloudFormation schema, so the diff
 *     plans a replacement for a change there.
 *
 *   - `AmazonOpenSearchServerlessDestinationConfiguration` (#549) —
 *     `AmazonOpenSearchServerlessDestinationUpdate` payload
 *     produced by {@link mapAmazonOpenSearchServerlessConfigToUpdate}.
 *     Simpler than the service variant — `RoleARN`,
 *     `CollectionEndpoint`, `IndexName`, `BufferingHints`,
 *     `RetryOptions`, `S3Configuration` → `S3Update`,
 *     `ProcessingConfiguration`, `CloudWatchLoggingOptions`.
 *
 *   - `S3BackupMode` on the three OpenSearch / Elasticsearch
 *     destinations has no Update member: a change is not sent, as
 *     CloudFormation does, and is warned (#5386,
 *     {@link warnUnappliedS3BackupMode}).
 *
 *   - `HttpEndpointDestinationConfiguration` (#549) —
 *     `HttpEndpointDestinationUpdate` payload produced by
 *     {@link mapHttpEndpointConfigToUpdate}. Handles
 *     `EndpointConfiguration`, `BufferingHints`,
 *     `CloudWatchLoggingOptions`, `RequestConfiguration`,
 *     `ProcessingConfiguration`, `RoleARN`, `RetryOptions`,
 *     `S3BackupMode`, `S3Configuration` → `S3Update`,
 *     `SecretsManagerConfiguration`.
 *
 *   - `ElasticsearchDestinationConfiguration` (#549) —
 *     `ElasticsearchDestinationUpdate` payload produced by
 *     {@link mapElasticsearchConfigToUpdate}. Legacy variant of
 *     `Amazonopensearchservice*`; same field shape sans
 *     `VpcConfiguration` (also create-only, so replaced).
 *
 *   - `IcebergDestinationConfiguration` (#549) —
 *     `IcebergDestinationUpdate` payload produced by
 *     {@link mapIcebergConfigToUpdate}. Handles
 *     `DestinationTableConfigurationList`,
 *     `SchemaEvolutionConfiguration`,
 *     `TableCreationConfiguration`, `BufferingHints`,
 *     `CloudWatchLoggingOptions`, `ProcessingConfiguration`,
 *     `s3BackupMode` (CloudFormation's spelling), `RetryOptions`,
 *     `RoleARN`, `AppendOnly`, `S3Configuration`; never the create-only
 *     `CatalogConfiguration`. **Quirk**: the
 *     SDK Update shape's S3 field is named `S3Configuration` (full
 *     `S3DestinationConfiguration` shape), NOT `S3Update` — unlike
 *     every other destination type. The reverse-mapper forwards it
 *     verbatim without renaming.
 *
 *   - `SnowflakeDestinationConfiguration` (#549) —
 *     `SnowflakeDestinationUpdate` payload produced by
 *     {@link mapSnowflakeConfigToUpdate}. Handles many connector
 *     credentials (`AccountUrl` / `PrivateKey` / `KeyPassphrase` /
 *     `User` / `Database` / `Schema` / `Table` /
 *     `SnowflakeRoleConfiguration`) plus the standard suite
 *     (`DataLoadingOption`, `MetaDataColumnName`,
 *     `ContentColumnName`, `CloudWatchLoggingOptions`,
 *     `ProcessingConfiguration`, `RoleARN`, `RetryOptions`,
 *     `S3BackupMode`, `S3Configuration` → `S3Update`,
 *     `SecretsManagerConfiguration`, `BufferingHints`).
 *
 *   - **`DeliveryStreamEncryptionConfigurationInput`** (#5357) —
 *     `StartDeliveryStreamEncryption` / `StopDeliveryStreamEncryption`,
 *     waiting for the asynchronous transition; see
 *     {@link applyEncryptionUpdate}. Runs after the destination update.
 *
 *   - The legacy `S3DestinationConfiguration` (#5439) —
 *     `S3DestinationUpdate` payload produced by
 *     {@link mapS3ConfigToUpdate}; see {@link applyS3DestinationUpdate}.
 *
 * Destination-type SWITCHES (e.g. ExtendedS3 → Redshift) are immutable
 * on AWS; cdkd surfaces `ResourceUpdateNotSupportedError` so the caller
 * can `cdkd deploy --replace`.
 */
export async function update(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#2613: the physical id is the delivery stream NAME, so a client in another region
  // than the state record would retag and update a same-named stream cdkd does not manage.
  // Outside the try, ahead of `applyUpdate`'s first call. Refuse before any call; the client's
  // region is resolved only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  try {
    return await this.applyUpdate(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  } catch (error) {
    // Pass through every cdkd-typed error untouched: the destination-switch
    // guard below raises ResourceUpdateNotSupportedError, which the deploy
    // engine matches BY CLASS to fall back to replacement, and an inner
    // ProvisioningError already carries better context than a re-wrap.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Firehose delivery stream ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function applyUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Firehose delivery stream ${logicalId}: ${physicalId}`);

  // Like the destination checks below, refused before any mutating call.
  const desiredEncryption = readEncryptionInput(
    properties[ENCRYPTION_KEY],
    context?.desiredFromAwsReadback === true
  );
  // go-to-k/cdkd#5380: an earlier update's Start / Stop that did not finish
  // left the key unsettled, so the stream may hold either block although the
  // template and the record agree. `applyEncryptionUpdate` reads the stream
  // and sends only what it lacks. An unusable block is not forced: it was
  // never sent, and refusing it now would fail a deploy that sent nothing.
  const encryptionChanged =
    !sameEncryptionInput(
      properties[ENCRYPTION_KEY],
      desiredEncryption,
      previousProperties[ENCRYPTION_KEY]
    ) ||
    (context?.unsettledProperties?.has(ENCRYPTION_KEY) === true &&
      desiredEncryption.kind !== 'unusable');
  let encryptionSkipped = false;
  if (encryptionChanged && desiredEncryption.kind === 'unusable') {
    const message =
      `${ENCRYPTION_KEY} of Firehose delivery stream ${logicalId} is not an object with a ` +
      `string KeyType (and a string KeyARN, if any)`;
    // A state record has no template-side remedy: leave the stream's
    // encryption as it is and record the previous block (issue #3141).
    if (context?.replayingState !== true) {
      throw markNonRetryable(
        new ProvisioningError(
          `${message} — nothing was updated`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    this.logger.warn(safeMsg`${message}; its encryption is left unchanged`);
    encryptionSkipped = true;
  }

  // Validate destination shape BEFORE issuing any mutating call so a
  // Tags+rejected-destination combined diff does not write Tags then
  // throw — otherwise AWS would carry new tags while cdkd state was
  // never updated (m1 in PR review).
  const destKey = this.findDestinationKey(properties);
  const prevDestKey = this.findDestinationKey(previousProperties);

  // Destination-type switch is immutable on AWS (UpdateDestination only
  // accepts the SAME destination type; switching types requires replace).
  if (destKey && prevDestKey && destKey !== prevDestKey) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `Switching Firehose destination type from '${prevDestKey}' to '${destKey}' is not supported in-place — AWS UpdateDestination requires the same destination type as the original CreateDeliveryStream. Re-deploy with cdkd deploy --replace.`
    );
  }

  // Every destination key findDestinationKey returns has an in-place
  // UpdateDestination branch below.
  const activeDest = destKey ?? prevDestKey;

  // Now that destination validity is established, apply Tags
  // (TagDeliveryStream / UntagDeliveryStream is independent of
  // destination type but must not run BEFORE the rejection branches —
  // otherwise a partial AWS write strands tags on a stream whose
  // destination diff was rejected).
  const nextTagsOk = isReadableTagList(properties['Tags']);
  const prevTagsOk = isReadableTagList(previousProperties['Tags']);
  if (!nextTagsOk || !prevTagsOk) {
    // Names the side only, never record content. A recorded value holding a
    // dynamic reference or its mask must not be answered with "write the
    // value into state.json"; `[]` removes nothing and re-applies the tags.
    const recordedSecret = !prevTagsOk && holdsSecretDerivedEntry(previousProperties['Tags']);
    throw markNonRetryable(
      new ProvisioningError(
        `${[!nextTagsOk && 'desired Tags', !prevTagsOk && 'recorded Tags'].filter(Boolean).join(' / ')} ` +
          `of Firehose delivery stream ${logicalId} is not a list of tags with a Key — no tag ` +
          `was added or removed` +
          (prevTagsOk
            ? ''
            : recordedSecret
              ? ': the recorded Tags is secret-derived (cdkd keeps the dynamic reference or its ' +
                'mask in state), so do not write the value into state.json; set it to [] in ' +
                'state.json and re-run, which removes nothing'
              : ': repair the recorded Tags in state.json to a list of tags with a Key and re-run'),
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  await this.applyTagsDiff(physicalId, properties['Tags'], previousProperties['Tags']);

  if (activeDest === 'ExtendedS3DestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applyExtendedS3DestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'S3DestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applyS3DestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'RedshiftDestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applyRedshiftDestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'SplunkDestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applySplunkDestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'AmazonopensearchserviceDestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applyAmazonopensearchserviceDestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'AmazonOpenSearchServerlessDestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applyAmazonOpenSearchServerlessDestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'HttpEndpointDestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applyHttpEndpointDestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'ElasticsearchDestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applyElasticsearchDestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'IcebergDestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applyIcebergDestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (activeDest === 'SnowflakeDestinationConfiguration') {
    const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
    const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
    if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
      await this.applySnowflakeDestinationUpdate(logicalId, physicalId, nextDest);
    }
  }

  if (encryptionChanged && desiredEncryption.kind !== 'unusable') {
    await this.applyEncryptionUpdate(
      logicalId,
      physicalId,
      resourceType,
      desiredEncryption,
      maskerOrIdentity(context?.maskSecrets),
      context?.markUnsettled
    );
  }

  // Pull current AWS state for the result envelope.
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  // go-to-k/cdkd#5386: named after the last call that could fail, so a
  // failed update (and its retry) never prints it, and confirmed against
  // this same read rather than a second one.
  this.warnUnappliedS3BackupMode(
    logicalId,
    properties,
    unappliedS3BackupModeDestination(
      properties,
      previousProperties,
      destKey,
      context?.changedProperties
    ),
    description.DeliveryStreamDescription
  );
  const desc = description.DeliveryStreamDescription;
  return {
    physicalId,
    wasReplaced: false,
    attributes: {
      ...(desc?.DeliveryStreamARN !== undefined && { Arn: desc.DeliveryStreamARN }),
    },
    ...(encryptionSkipped && {
      effectiveProperties: this.withRecordedEncryption(
        properties,
        previousProperties[ENCRYPTION_KEY],
        desc?.DeliveryStreamEncryptionConfiguration
      ),
    }),
  };
}

/**
 * Warn that the `S3BackupMode` change {@link unappliedS3BackupModeDestination}
 * found was not applied (go-to-k/cdkd#5386), unless the live stream already
 * holds the declared mode. The state records the declared value, never
 * applied, so a template-to-state difference alone also fires on a rollback
 * revert, on a template reverted to what AWS holds, and on a mode declared at
 * the value AWS already has. `live` is the update's own closing
 * `DescribeDeliveryStream` answer. When it does not report the destination's
 * mode, the warning is kept: it cannot be confirmed either way, and the
 * update itself has succeeded.
 */
export function warnUnappliedS3BackupMode(
  this: FirehoseProvider,
  logicalId: string,
  properties: Record<string, unknown>,
  destKey: string | undefined,
  live: DeliveryStreamDescription | undefined
): void {
  if (destKey === undefined) return;
  const declared = (properties[destKey] as Record<string, unknown>)['S3BackupMode'];
  const desired = declared ?? DEFAULT_OPENSEARCH_BACKUP_MODE;
  const member = FIXED_BACKUP_MODE_DESTINATIONS[destKey];
  const liveMode: unknown =
    member === undefined ? undefined : live?.Destinations?.[0]?.[member]?.S3BackupMode;
  if (liveMode !== undefined && liveMode === desired) return;
  if (liveMode === undefined) {
    this.logger.debug(
      safeMsg`Firehose delivery stream ${logicalId} reported no S3BackupMode for ${destKey}; warning unconfirmed`
    );
  }
  const kept = typeof liveMode === 'string' ? `its current mode (${liveMode})` : 'its current mode';
  this.logger.warn(
    safeMsg`${logicalId} (AWS::KinesisFirehose::DeliveryStream): ${destKey}.S3BackupMode changed, but Firehose cannot change the backup mode of an existing delivery stream, so the stream keeps ${kept}, as CloudFormation does. To apply it, replace the stream, for example by giving it a new DeliveryStreamName or a new logical id.`
  );
}

/**
 * The desired bag with the encryption block an update SKIPPED replaced by
 * what the stream holds: an absent previous drops the key, and a present one
 * records the live reading, in the shape `readCurrentState` emits. The
 * recorded previous is never trusted as-is: on a rollback it can be a block a
 * failed update never applied.
 */
export function withRecordedEncryption(
  this: FirehoseProvider,
  properties: Record<string, unknown>,
  previous: unknown,
  live: DeliveryStreamEncryptionConfiguration | undefined
): Record<string, unknown> {
  const { [ENCRYPTION_KEY]: _skipped, ...rest } = properties;
  if (previous === undefined || previous === null) return rest;
  return { ...rest, [ENCRYPTION_KEY]: liveEncryptionAsCfn(live) };
}

/**
 * Recover `CurrentDeliveryStreamVersionId` + `DestinationId` from
 * `DescribeDeliveryStream` and issue `UpdateDestination` with the new
 * ExtendedS3 shape. The reverse-mapper at
 * {@link mapExtendedS3ConfigToUpdate} produces the
 * `ExtendedS3DestinationUpdate` payload (CFn property names →
 * SDK camelCase, omitting `Prefix` / `BufferingHints` / etc. when the
 * source is undefined), which keeps a removed sub-field live as
 * CloudFormation does (#1160).
 */
export async function applyExtendedS3DestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const currentDestination = desc?.Destinations?.[0];
  const destinationId = currentDestination?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      ExtendedS3DestinationUpdate: this.mapExtendedS3ConfigToUpdate(nextConfig),
    })
  );
}

/**
 * The legacy `S3DestinationConfiguration` (go-to-k/cdkd#5439):
 * `UpdateDestination` with an `S3DestinationUpdate` payload from
 * {@link mapS3ConfigToUpdate}, as CloudFormation does. Measured in
 * us-east-1: a change set changing `BufferingHints` / `Prefix` /
 * `CompressionFormat` planned `Replacement: False` and kept the stream ARN,
 * and one removing `Prefix` and `BufferingHints` beside a sibling change
 * kept both live values, so a removed sub-field is not sent (#1160).
 */
export async function applyS3DestinationUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  nextConfig: Record<string, unknown>
): Promise<void> {
  const description = await this.getClient().send(
    new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
  );
  const desc = description.DeliveryStreamDescription;
  const currentVersionId = desc?.VersionId;
  const destinationId = desc?.Destinations?.[0]?.DestinationId;
  if (!currentVersionId || !destinationId) {
    throw new ProvisioningError(
      `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
      'AWS::KinesisFirehose::DeliveryStream',
      logicalId,
      physicalId
    );
  }
  await this.getClient().send(
    new UpdateDestinationCommand({
      DeliveryStreamName: physicalId,
      CurrentDeliveryStreamVersionId: currentVersionId,
      DestinationId: destinationId,
      S3DestinationUpdate: this.mapS3ConfigToUpdate(nextConfig),
    })
  );
}

/**
 * Diff and apply changes to a Firehose delivery stream's Tags via the
 * `TagDeliveryStream` / `UntagDeliveryStream` AWS APIs.
 *
 * Tags shape is `[{Key, Value}]`. Removed keys go through
 * `UntagDeliveryStream` (key-only); added / modified entries go through
 * `TagDeliveryStream` (full {Key, Value}). No-op when before/after JSON
 * is identical.
 */
export async function applyTagsDiff(
  this: FirehoseProvider,
  physicalId: string,
  next: unknown,
  prev: unknown
): Promise<void> {
  if (JSON.stringify(next ?? []) === JSON.stringify(prev ?? [])) return;
  type CfnTag = { Key?: string; Value?: string };
  // Both sides were validated by the caller: absent reads as the empty list.
  const nextEntries = (next ?? []) as CfnTag[];
  const prevEntries = (prev ?? []) as CfnTag[];
  const nextByKey = new Map<string, CfnTag>();
  for (const t of nextEntries) {
    if (t.Key) nextByKey.set(t.Key, t);
  }
  const prevByKey = new Map<string, CfnTag>();
  for (const t of prevEntries) {
    if (t.Key) prevByKey.set(t.Key, t);
  }
  const tagKeysToRemove: string[] = [];
  for (const key of prevByKey.keys()) {
    if (!nextByKey.has(key)) tagKeysToRemove.push(key);
  }
  if (tagKeysToRemove.length > 0) {
    await this.getClient().send(
      new UntagDeliveryStreamCommand({
        DeliveryStreamName: physicalId,
        TagKeys: tagKeysToRemove,
      })
    );
  }
  const tagsToUpsert: CfnTag[] = [];
  for (const [key, tag] of nextByKey) {
    const before = prevByKey.get(key);
    if (JSON.stringify(before) === JSON.stringify(tag)) continue;
    tagsToUpsert.push(tag);
  }
  if (tagsToUpsert.length > 0) {
    await this.getClient().send(
      new TagDeliveryStreamCommand({
        DeliveryStreamName: physicalId,
        Tags: tagsToUpsert.map((t) => ({
          Key: t.Key as string,
          ...(t.Value !== undefined && { Value: t.Value }),
        })),
      })
    );
  }
}
