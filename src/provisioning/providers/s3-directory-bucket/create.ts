import {
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  DeleteBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  PutBucketMetricsConfigurationCommand,
  DeleteBucketMetricsConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  DeleteBucketInventoryConfigurationCommand,
  type DataRedundancy,
  type Tag,
} from '@aws-sdk/client-s3';
import { replayWarn, requireConfigString } from '../../config-shape.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import type { S3DirectoryBucketProvider } from '../s3-directory-bucket-provider.js';
import {
  sameJson,
  encryptionToSdk,
  lifecycleToSdk,
  recordedItems,
  desiredConfigurations,
  configurationRefuser,
} from './configurations.js';
import type { Refuse, DesiredConfigurations } from './configurations.js';

/**
 * Create an S3 Express Directory Bucket
 */
export async function create(
  this: S3DirectoryBucketProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating S3 Express Directory Bucket ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  // go-to-k/cdkd#2762: the configuration writes after CreateBucket, built
  // (and a malformed one refused) before any call.
  // A create REPLAYING a state record (the rollback executor reviving the old
  // bucket of a reverse replacement) warns and leaves a malformed one out,
  // as `DataRedundancy` does below (issue #1544): the template cannot fix it.
  const configs = desiredConfigurations(
    properties,
    configurationRefuser(resourceType, logicalId),
    replayWarn(this.logger, context).onUnusable
  );

  // `replayWarn`: the rollback executor's reverse-replacement arm revives
  // the OLD bucket from `previousState.properties`, which the user cannot
  // edit from the template — a hard refusal there would leave the resource
  // unrestorable (issue #1544). Template-path creates keep the refusal.
  const dataRedundancy = requireConfigString(
    properties['DataRedundancy'],
    'SingleAvailabilityZone',
    'AWS::S3Express::DirectoryBucket DataRedundancy',
    replayWarn(this.logger, context)
  );
  // CFn LocationName: "us-east-1a--x-s3" → extract AZ name: "us-east-1a"
  const cfnLocationName = properties['LocationName'] as string | undefined;
  const azName = cfnLocationName?.replace(/--x-s3$/, '') || 'us-east-1a';

  // S3 CreateBucket API requires AZ ID (use1-az1), not AZ name (us-east-1a)
  const azId = await this.getAzId(azName);

  // Generate bucket name if not specified
  // Directory bucket names must follow: {name}--{az-id}--x-s3
  let bucketName = properties['BucketName'] as string | undefined;
  if (!bucketName) {
    // The WHOLE name is at most 63 characters (go-to-k/cdkd#5064: a cut to
    // 64 before the suffix made every long name invalid). The rule Cloud
    // Control fills too (go-to-k/cdkd#5095).
    bucketName = generatedNameFor('AWS::S3Express::DirectoryBucket', logicalId, {
      zoneId: azId,
    });
  }

  // Tags ride the create call itself (`CreateBucketConfiguration.Tags`,
  // needing `s3express:TagResource`) — the ONLY tag write the plain
  // s3express data/control split supports at create time. A malformed
  // value was refused above; an absent or empty list omits the member.
  const tags: Tag[] = desiredTags;
  const includeTags = tags.length > 0;

  let bucketCreated = false;
  try {
    // Resolved BEFORE CreateBucket (go-to-k/cdkd#4583): the STS account
    // lookup is the only call that could otherwise fail after the bucket
    // exists, leaving a bucket no state record names.
    const attributes = await this.buildAttributes(bucketName);

    await (
      await this.getCreateClient()
    ).send(
      new CreateBucketCommand({
        Bucket: bucketName,
        CreateBucketConfiguration: {
          Bucket: {
            Type: 'Directory',
            DataRedundancy: dataRedundancy as DataRedundancy,
          },
          Location: {
            Name: azId,
            // A Local Zone bucket names its zone with `Type: 'LocalZone'`
            // (go-to-k/cdkd#5317); the zone id flows through `getAzId`
            // unchanged (its lookup fails soft to the given name).
            Type: dataRedundancy === 'SingleLocalZone' ? 'LocalZone' : 'AvailabilityZone',
          },
          ...(includeTags ? { Tags: tags } : {}),
        },
      })
    );
    bucketCreated = true;
    this.logger.debug(`Created S3 Express Directory Bucket: ${bucketName}`);

    await this.applyConfigurations(bucketName, configs, properties, {}, true);

    return {
      physicalId: bucketName,
      attributes,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create S3 Express Directory Bucket ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          bucketName,
          cause
        )
    );
    // A configuration write failed after CreateBucket returned: the bucket
    // exists because THIS create made it, so the deploy engine can journal
    // it for `cdkd rollback --revert-failed`.
    if (bucketCreated) markCreatedBeforeFailure(thrown, logicalId, resourceType, bucketName);
    throw thrown;
  }
}

/**
 * Converge the four configuration properties (go-to-k/cdkd#2762) from
 * `previous` to `desired`: what `desired` holds and `previous` does not hold
 * in the same form is Put, and what `previous` holds and `desired` no longer
 * does is Deleted. On create (`creating`) everything desired is Put and
 * nothing is Deleted. A Delete is a REMOVAL from the template. That this
 * matches CloudFormation's update is ASSUMED, not measured with a CFn A/B:
 * it is inferred from the CFn handler's update permissions, the
 * `s3express:Put*` ones the directory-bucket Delete calls require:
 *  - `DeleteBucketEncryption` returns the bucket to its default, SSE-S3;
 *  - `DeleteBucketLifecycle` removes every rule;
 *  - `DeleteBucketMetricsConfiguration` / `DeleteBucketInventoryConfiguration`
 *    remove the one item a removed `Id` names, leaving the others.
 * `previous` is read leniently (it is the record, which the template cannot
 * fix); only `desired` was refused when malformed.
 */
export async function applyConfigurations(
  this: S3DirectoryBucketProvider,
  bucketName: string,
  desired: DesiredConfigurations,
  desiredRaw: Record<string, unknown>,
  previousRaw: Record<string, unknown>,
  creating: boolean,
  // go-to-k/cdkd#5380: named before each write, so an update failing after
  // an earlier write landed leaves that key unsettled for the next deploy.
  markUnsettled: (key: string) => void = () => {}
): Promise<void> {
  const changed = (desiredValue: unknown, previousValue: unknown): boolean =>
    creating || !sameJson(desiredValue, previousValue);
  // What the RECORD holds, read leniently: an empty rule list (the readback's
  // "none") holds nothing to delete, and a malformed record is assumed to
  // hold something, so the Delete converges it.
  const holds = (value: unknown, toSdk: (v: unknown, refuse: Refuse) => unknown): boolean => {
    try {
      return (
        toSdk(value, () => {
          throw new Error('malformed');
        }) !== undefined
      );
    } catch {
      return true;
    }
  };

  if (changed(desiredRaw['BucketEncryption'], previousRaw['BucketEncryption'])) {
    if (desired.encryption) {
      markUnsettled('BucketEncryption');
      await this.s3Client.send(
        new PutBucketEncryptionCommand({
          Bucket: bucketName,
          ServerSideEncryptionConfiguration: desired.encryption,
        })
      );
    } else if (!creating && holds(previousRaw['BucketEncryption'], encryptionToSdk)) {
      markUnsettled('BucketEncryption');
      await this.s3Client.send(new DeleteBucketEncryptionCommand({ Bucket: bucketName }));
      this.logger.debug('Sent DeleteBucketEncryption: the default encryption is back to SSE-S3');
    }
  }

  if (changed(desiredRaw['LifecycleConfiguration'], previousRaw['LifecycleConfiguration'])) {
    if (desired.lifecycle) {
      markUnsettled('LifecycleConfiguration');
      await this.s3Client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucketName,
          LifecycleConfiguration: desired.lifecycle,
        })
      );
    } else if (!creating && holds(previousRaw['LifecycleConfiguration'], lifecycleToSdk)) {
      markUnsettled('LifecycleConfiguration');
      await this.s3Client.send(new DeleteBucketLifecycleCommand({ Bucket: bucketName }));
      this.logger.debug('Sent DeleteBucketLifecycle: every lifecycle rule is removed');
    }
  }

  const desiredMetrics = recordedItems(desiredRaw['MetricsConfigurations']);
  const previousMetrics = creating
    ? new Map<string, unknown>()
    : recordedItems(previousRaw['MetricsConfigurations']);
  for (const [id, config] of desired.metrics) {
    if (previousMetrics.has(id) && sameJson(previousMetrics.get(id), desiredMetrics.get(id))) {
      continue;
    }
    markUnsettled('MetricsConfigurations');
    await this.s3Client.send(
      new PutBucketMetricsConfigurationCommand({
        Bucket: bucketName,
        Id: id,
        MetricsConfiguration: config,
      })
    );
  }
  for (const id of previousMetrics.keys()) {
    if (desired.metrics.has(id)) continue;
    markUnsettled('MetricsConfigurations');
    await this.deleteItemIdempotently(
      new DeleteBucketMetricsConfigurationCommand({ Bucket: bucketName, Id: id })
    );
  }

  const desiredInventory = recordedItems(desiredRaw['InventoryConfigurations']);
  const previousInventory = creating
    ? new Map<string, unknown>()
    : recordedItems(previousRaw['InventoryConfigurations']);
  for (const [id, config] of desired.inventory) {
    if (
      previousInventory.has(id) &&
      sameJson(previousInventory.get(id), desiredInventory.get(id))
    ) {
      continue;
    }
    markUnsettled('InventoryConfigurations');
    await this.s3Client.send(
      new PutBucketInventoryConfigurationCommand({
        Bucket: bucketName,
        Id: id,
        InventoryConfiguration: config,
      })
    );
  }
  for (const id of previousInventory.keys()) {
    if (desired.inventory.has(id)) continue;
    markUnsettled('InventoryConfigurations');
    await this.deleteItemIdempotently(
      new DeleteBucketInventoryConfigurationCommand({ Bucket: bucketName, Id: id })
    );
  }
}

/**
 * A per-`Id` Delete whose item is already gone is done: the deploy engine
 * re-runs a failed `update()` whole with the same `previousProperties`, so
 * an item an earlier attempt deleted answers `NoSuchConfiguration` on the
 * retry, and failing there would strand the update on every later deploy.
 */
export async function deleteItemIdempotently(
  this: S3DirectoryBucketProvider,
  command: DeleteBucketMetricsConfigurationCommand | DeleteBucketInventoryConfigurationCommand
): Promise<void> {
  try {
    if (command instanceof DeleteBucketMetricsConfigurationCommand) {
      await this.s3Client.send(command);
    } else {
      await this.s3Client.send(command);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchConfiguration') {
      this.logger.debug('A configuration this update deletes is already gone');
      return;
    }
    throw error;
  }
}
