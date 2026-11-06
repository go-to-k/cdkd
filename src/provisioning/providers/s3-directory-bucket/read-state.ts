import {
  HeadBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  ListBucketMetricsConfigurationsCommand,
  ListBucketInventoryConfigurationsCommand,
} from '@aws-sdk/client-s3';
import { ListTagsForResourceCommand } from '@aws-sdk/client-s3-control';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import type { S3DirectoryBucketProvider } from '../s3-directory-bucket-provider.js';
import {
  encryptionFromSdk,
  lifecycleFromSdk,
  metricsFromSdk,
  inventoryFromSdk,
  CONFIGURATION_READ_ACTIONS,
} from './configurations.js';

/**
 * {@link readCurrentState}'s read. Every configuration read must succeed: a
 * value left out would read as REMOVED to `cdkd drift` (a directory bucket's
 * encryption is recorded even when undeclared, SSE-S3 being its default), so
 * `--accept` would record nothing and `--revert` would put it back. A
 * missing permission is therefore an error naming the action
 * ({@link CONFIGURATION_READ_ACTIONS}), like any other failure.
 */
export async function readState(
  this: S3DirectoryBucketProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound> {
  let locationType: string | undefined;
  try {
    const head = await this.s3Client.send(new HeadBucketCommand({ Bucket: physicalId }));
    locationType = head?.BucketLocationType;
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'NotFound' || e.name === 'NoSuchBucket' || e.name === 'BucketNotFound') {
      return RESOURCE_NOT_FOUND;
    }
    throw err;
  }

  const result: Record<string, unknown> = {
    BucketName: physicalId,
  };

  // Best-effort: directory bucket names always carry `--x-s3`. HeadBucket's
  // `BucketLocationType` tells a Local Zone bucket (`SingleLocalZone`) from
  // an Availability Zone one (`SingleAvailabilityZone`, go-to-k/cdkd#5317),
  // so the comparator does not flag drift when state holds the same value.
  if (physicalId.endsWith('--x-s3')) {
    result['DataRedundancy'] =
      locationType === 'LocalZone' ? 'SingleLocalZone' : 'SingleAvailabilityZone';
  }

  // Tags via S3 Control ListTagsForResource (always-emit per
  // docs/provider-rules.md#readcurrentstate-for-drift-detection; an untagged bucket returns an empty
  // list, not an error, and the comparator's "key absent in state never
  // drifts" rule keeps pre-Tags-support stacks quiet).
  result['Tags'] = await this.readTags(physicalId);

  // go-to-k/cdkd#2762, always emitted: an unset configuration reads as its
  // empty form (`[]` rules / items), which `update()` treats as "none".
  const reads: Array<[string, () => Promise<unknown>]> = [
    ['BucketEncryption', () => this.readEncryption(physicalId)],
    ['LifecycleConfiguration', () => this.readLifecycle(physicalId)],
    ['MetricsConfigurations', () => this.readMetrics(physicalId)],
    ['InventoryConfigurations', () => this.readInventory(physicalId)],
  ];
  const values = await Promise.all(
    reads.map(([key, read]) =>
      read().catch((error: unknown) => {
        const name = (error as { name?: unknown } | undefined)?.name;
        if (name === 'AccessDenied' || name === 'AccessDeniedException') {
          // A plain Error, not a ProvisioningError: the engine's unsettled
          // convergence passes a ProvisioningError through as its own
          // refusal, and wraps anything else with its context.
          throw new Error(
            `Reading ${key} of an S3 Express directory bucket needs ` +
              `${CONFIGURATION_READ_ACTIONS[key]}: grant it to read the bucket back`,
            { cause: error }
          );
        }
        throw error;
      })
    )
  );
  values.forEach((value, i) => {
    result[reads[i]![0]] = value;
  });

  return result;
}

export async function readEncryption(
  this: S3DirectoryBucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
    return encryptionFromSdk(resp.ServerSideEncryptionConfiguration?.Rules ?? []);
  } catch (err) {
    if ((err as { name?: string }).name === 'ServerSideEncryptionConfigurationNotFoundError') {
      return { ServerSideEncryptionConfiguration: [] };
    }
    throw err;
  }
}

export async function readLifecycle(
  this: S3DirectoryBucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
    );
    return lifecycleFromSdk(resp.Rules ?? []);
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchLifecycleConfiguration') {
      return { Rules: [] };
    }
    throw err;
  }
}

export async function readMetrics(
  this: S3DirectoryBucketProvider,
  bucket: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let token: string | undefined;
  do {
    const resp = await this.s3Client.send(
      new ListBucketMetricsConfigurationsCommand({ Bucket: bucket, ContinuationToken: token })
    );
    for (const item of resp.MetricsConfigurationList ?? []) out.push(metricsFromSdk(item));
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function readInventory(
  this: S3DirectoryBucketProvider,
  bucket: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let token: string | undefined;
  do {
    const resp = await this.s3Client.send(
      new ListBucketInventoryConfigurationsCommand({ Bucket: bucket, ContinuationToken: token })
    );
    for (const item of resp.InventoryConfigurationList ?? []) out.push(inventoryFromSdk(item));
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function readTags(
  this: S3DirectoryBucketProvider,
  bucketName: string
): Promise<Array<{ Key: string; Value: string }>> {
  const accountId = await this.getAccountId();
  const resourceArn = await this.buildBucketArn(bucketName, accountId);
  const resp = await this.getS3ControlClient().send(
    new ListTagsForResourceCommand({ AccountId: accountId, ResourceArn: resourceArn })
  );
  return normalizeAwsTagsToCfn(resp.Tags);
}

/**
 * Adopt an existing S3 Express Directory Bucket into cdkd state.
 *
 * Lookup order:
 *  1. `--resource <id>=<name>` override or `Properties.BucketName` →
 *     verify via `HeadBucket`.
 */
export async function importImpl(
  this: S3DirectoryBucketProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'BucketName');
  if (explicit) {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: explicit }));
      return { physicalId: explicit, attributes: {} };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NotFound' || e.name === 'NoSuchBucket') return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a
  // directory bucket reaching here needs an explicit `--resource` override.
  return null;
}
