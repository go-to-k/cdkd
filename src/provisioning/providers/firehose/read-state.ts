import type { FirehoseProvider } from '../firehose-provider.js';
import {
  DescribeDeliveryStreamCommand,
  ListTagsForDeliveryStreamCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-firehose';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { ENCRYPTION_KEY, liveEncryptionAsCfn } from './shared.js';
import {
  mapS3DescriptionToCfn,
  mapExtendedS3DescriptionToCfn,
  mapNonS3DestinationToCfn,
  mapRedshiftDescriptionToCfn,
  mapMskSourceDescriptionToCfn,
  mapIcebergDescriptionToCfn,
  mapHttpEndpointDescriptionToCfn,
} from './describe-to-cfn.js';

/**
 * Adopt an existing Kinesis Firehose delivery stream into cdkd state.
 *
 * Lookup order:
 *  1. `--resource <id>=<name>` override or `Properties.DeliveryStreamName`
 *     → verify with `DescribeDeliveryStream`.
 *  2. Walk `ListDeliveryStreams` (paged via `ExclusiveStartDeliveryStreamName`)
 *     and match the `aws:cdk:path` tag via
 *     `ListTagsForDeliveryStream(DeliveryStreamName)`.
 *
 * Firehose tags use the standard `Tag[]` array shape (`Key`/`Value`).
 */
/**
 * go-to-k/cdkd#5380: the encryption key is still in transition while the
 * stream reads ENABLING / DISABLING, which `liveEncryptionAsCfn` reports as
 * a settled value. A failed read answers it as still in transition too: the
 * caller keeps the name, which only costs a re-send on the next deploy.
 */
export async function unsettledInTransition(
  this: FirehoseProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  names: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  if (!names.has(ENCRYPTION_KEY)) return new Set();
  try {
    const resp = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const status = resp.DeliveryStreamDescription?.DeliveryStreamEncryptionConfiguration?.Status;
    return status === 'ENABLING' || status === 'DISABLING' ? new Set([ENCRYPTION_KEY]) : new Set();
  } catch {
    return new Set([ENCRYPTION_KEY]);
  }
}

/**
 * Read the AWS-current Firehose delivery stream configuration in CFn-property shape.
 *
 * Surfaces top-level configuration that has a clean 1:1 mapping back to
 * cdkd state — `DeliveryStreamName`, `DeliveryStreamType`, and the
 * `KinesisStreamSourceConfiguration` parent fields when present (the
 * `DescribeDeliveryStream` response splits source under `Source.KinesisStreamSourceDescription`),
 * `DirectPutSourceConfiguration` from `Source.DirectPutSourceDescription`, and
 * `MSKSourceConfiguration` from `Source.MSKSourceDescription`
 * (`ReadFromTimestamp` in the template's epoch-millisecond spelling).
 *
 * **Destination configurations**: full coverage for S3 / ExtendedS3.
 * AWS returns destination config under `Destinations[0].*DestinationDescription`
 * (note: `Description`, not `Configuration`); the SDK reuses the same
 * type as the corresponding `*Configuration` input for the inner
 * sub-shapes, so reverse-mapping is a `pickDefinedDeep` pass-through.
 *
 * Surfaced top-level fields: `BucketARN`, `RoleARN`, `Prefix`,
 * `ErrorOutputPrefix`, `BufferingHints`, `CompressionFormat`, plus
 * `S3BackupMode` for Extended. Surfaced inner nested fields:
 * `EncryptionConfiguration`, `CloudWatchLoggingOptions` (both shapes);
 * additionally for Extended `ProcessingConfiguration`,
 * `DataFormatConversionConfiguration`, `DynamicPartitioningConfiguration`,
 * `S3BackupConfiguration` (reverse-mapped from the AWS-side
 * `S3BackupDescription`). Each inner subtree is always emitted (even
 * as `{}` placeholder) so the v3 `observedProperties` baseline catches
 * console-side ADDs to a previously-default sub-shape.
 *
 * Non-S3 destination types
 * (`Redshift`/`Elasticsearch`/`Amazonopensearchservice`/`Splunk`/`HttpEndpoint`/`AmazonOpenSearchServerless`)
 * are reverse-mapped via `mapRedshiftDescriptionToCfn` /
 * `mapHttpEndpointDescriptionToCfn` / `mapNonS3DestinationToCfn`. The
 * SDK reuses field names between Description and Configuration for
 * these destinations, so a `pickDefinedDeep` pass-through produces a
 * CFn-compatible shape. AWS-managed read-only `VpcId` is stripped
 * from `VpcConfigurationDescription`. `Iceberg` goes through
 * `mapIcebergDescriptionToCfn`, which restores CloudFormation's spellings
 * of three renamed members. Write-only fields AWS strips
 * from descriptions (`RedshiftDestinationConfiguration.Password`,
 * `HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey`)
 * stay drift-unknown via `getDriftUnknownPaths` — no AWS API recovers them.
 *
 * `DeliveryStreamEncryptionConfigurationInput` is also surfaced. AWS
 * returns the read-side shape `DeliveryStreamEncryptionConfiguration`
 * (with extra `Status` / `FailureDescription` fields); we reverse-map
 * to the CFn input shape (`KeyARN` + `KeyType`) while the stream is
 * encrypted or becoming so, and otherwise emit a `{}` placeholder so the
 * v3 baseline catches console-side encryption enables on a
 * previously-default stream (`liveEncryptionAsCfn`).
 *
 * Tags are surfaced via a follow-up `ListTagsForDeliveryStream` call
 * with `aws:*` filtered out and always emitted as `[]` placeholder when
 * no user tags remain.
 *
 * Returns `RESOURCE_NOT_FOUND` when the stream is gone (`ResourceNotFoundException`).
 */
export async function readCurrentState(
  this: FirehoseProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let desc;
  try {
    const resp = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    desc = resp.DeliveryStreamDescription;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!desc) return undefined;

  const result: Record<string, unknown> = {};
  if (desc.DeliveryStreamName !== undefined) {
    result['DeliveryStreamName'] = desc.DeliveryStreamName;
  }
  if (desc.DeliveryStreamType !== undefined) {
    result['DeliveryStreamType'] = desc.DeliveryStreamType;
  }

  // Source: the Kinesis, Direct PUT and MSK descriptions, the sources cdkd
  // sends (a database source routes through Cloud Control).
  if (desc.Source?.KinesisStreamSourceDescription) {
    const src = desc.Source.KinesisStreamSourceDescription;
    const srcOut: Record<string, unknown> = {};
    if (src.KinesisStreamARN !== undefined) srcOut['KinesisStreamARN'] = src.KinesisStreamARN;
    if (src.RoleARN !== undefined) srcOut['RoleARN'] = src.RoleARN;
    if (Object.keys(srcOut).length > 0) {
      result['KinesisStreamSourceConfiguration'] = srcOut;
    }
  }
  // go-to-k/cdkd#2762: AWS returns `DirectPutSourceDescription` only when the
  // stream was created with a hint (measured 2026-11-01: a DirectPut stream
  // created without one reads back no `Source`). Create-only, so no
  // placeholder: a later add is a replacement, never an in-place change.
  const directPut = desc.Source?.DirectPutSourceDescription;
  if (directPut?.ThroughputHintInMBs !== undefined) {
    result['DirectPutSourceConfiguration'] = {
      ThroughputHintInMBs: directPut.ThroughputHintInMBs,
    };
  }

  // go-to-k/cdkd#5636: create-only, so no placeholder.
  const msk = desc.Source?.MSKSourceDescription;
  if (msk) {
    result['MSKSourceConfiguration'] = mapMskSourceDescriptionToCfn(
      msk,
      properties?.['MSKSourceConfiguration']
    );
  }

  // Destinations: Firehose holds at most one destination on a delivery
  // stream. CDK constructs typically emit ExtendedS3 (the modern shape)
  // even for plain S3 use cases; legacy `S3DestinationDescription` is
  // still surfaced separately for templates that pin the legacy shape.
  // The two shapes are mutually exclusive on AWS responses.
  const dest = desc.Destinations?.[0];
  if (dest?.ExtendedS3DestinationDescription) {
    result['ExtendedS3DestinationConfiguration'] = mapExtendedS3DescriptionToCfn(
      dest.ExtendedS3DestinationDescription as unknown as Record<string, unknown>
    );
  } else if (dest?.IcebergDestinationDescription) {
    // Ahead of the legacy S3 branch, as ExtendedS3 is: nothing in the SDK
    // model rules out a top-level `S3DestinationDescription` beside it, and
    // Iceberg's own bucket sits inside its description (go-to-k/cdkd#5636).
    result['IcebergDestinationConfiguration'] = mapIcebergDescriptionToCfn(
      dest.IcebergDestinationDescription as unknown as Record<string, unknown>
    );
  } else if (dest?.S3DestinationDescription) {
    result['S3DestinationConfiguration'] = mapS3DescriptionToCfn(
      dest.S3DestinationDescription as unknown as Record<string, unknown>
    );
  } else if (dest?.RedshiftDestinationDescription) {
    result['RedshiftDestinationConfiguration'] = mapRedshiftDescriptionToCfn(
      dest.RedshiftDestinationDescription as unknown as Record<string, unknown>
    );
  } else if (dest?.ElasticsearchDestinationDescription) {
    result['ElasticsearchDestinationConfiguration'] = mapNonS3DestinationToCfn(
      dest.ElasticsearchDestinationDescription as unknown as Record<string, unknown>
    );
  } else if (dest?.AmazonopensearchserviceDestinationDescription) {
    result['AmazonopensearchserviceDestinationConfiguration'] = mapNonS3DestinationToCfn(
      dest.AmazonopensearchserviceDestinationDescription as unknown as Record<string, unknown>
    );
  } else if (dest?.AmazonOpenSearchServerlessDestinationDescription) {
    result['AmazonOpenSearchServerlessDestinationConfiguration'] = mapNonS3DestinationToCfn(
      dest.AmazonOpenSearchServerlessDestinationDescription as unknown as Record<string, unknown>
    );
  } else if (dest?.SplunkDestinationDescription) {
    result['SplunkDestinationConfiguration'] = mapNonS3DestinationToCfn(
      dest.SplunkDestinationDescription as unknown as Record<string, unknown>
    );
  } else if (dest?.HttpEndpointDestinationDescription) {
    result['HttpEndpointDestinationConfiguration'] = mapHttpEndpointDescriptionToCfn(
      dest.HttpEndpointDestinationDescription as unknown as Record<string, unknown>
    );
  }

  // DeliveryStreamEncryptionConfigurationInput: AWS returns the read-side
  // shape `DeliveryStreamEncryptionConfiguration` with extra status /
  // failure fields. CFn input shape carries `KeyARN` + `KeyType` only.
  // Surface those when AWS reports them; emit `{}` placeholder always so
  // the v3 baseline catches a console-side enable on a previously-default
  // stream (PR #145 always-emit pattern).
  // Only while encryption is in effect or being enabled (issue #5357).
  result['DeliveryStreamEncryptionConfigurationInput'] = liveEncryptionAsCfn(
    desc.DeliveryStreamEncryptionConfiguration
  );

  // Tags via ListTagsForDeliveryStream.
  // Always emit `Tags` (even as `[]`) per docs/provider-rules.md#readcurrentstate-for-drift-detection
  //  "always emit user-controllable top-level keys": omitting the
  // key on the failure path means the comparator's state-keys-only
  // walk skips Tags forever, hiding console-side tag adds from drift.
  try {
    const tagsResp = await this.getClient().send(
      new ListTagsForDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    this.logger.debug(
      `Firehose ListTagsForDeliveryStream(${physicalId}) failed: ${describeAwsFailure(err).detail}`
    );
    result['Tags'] = [];
  }

  return result;
}

/**
 * Drift-unknown paths for `AWS::KinesisFirehose::DeliveryStream`.
 *
 * The drift comparator skips these state property paths so they never
 * fire false-positive drift on every run. See the `readCurrentState`
 * docstring for the full rationale per category.
 *
 * Only write-only fields AWS strips from descriptions remain:
 * Redshift `Password`, HttpEndpoint `EndpointConfiguration.AccessKey`.
 * State that carries these would otherwise fire drift on every run —
 * declaring them as drift-unknown is the cleanest fix because there
 * is no AWS read API to recover their values.
 *
 * S3 / ExtendedS3 inner nested fields, non-S3 destination types
 * (Redshift / Elasticsearch / Amazonopensearchservice / Splunk /
 * HttpEndpoint / AmazonOpenSearchServerless), and
 * `DeliveryStreamEncryptionConfigurationInput` are all reverse-mapped
 * by `readCurrentState` and no longer drift-unknown.
 */
export function getDriftUnknownPaths(this: FirehoseProvider): string[] {
  return [
    // Write-only fields AWS does not return on read — no API workaround.
    'RedshiftDestinationConfiguration.Password',
    'HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey',
  ];
}

export async function importImpl(
  this: FirehoseProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DeliveryStreamName');
  if (explicit) {
    try {
      await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: explicit })
      );
      return { physicalId: explicit, attributes: {} };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
  // tag never exists on a real resource and the walk could not match (issue
  // #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a
  // delivery stream reaching here needs an explicit `--resource` override.
  return null;
}
