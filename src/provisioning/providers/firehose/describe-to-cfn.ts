import type { DeliveryStreamDescription, MSKSourceConfiguration } from '@aws-sdk/client-firehose';
import { maskDeep, type MaskerFn } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { isPlainRecord } from './shared.js';

// ─── Description → CFn nested-shape helpers ──────────────────────────
//
// The AWS Firehose SDK returns destination configuration under
// `*DestinationDescription` types. For most of the inner sub-shapes
// (`EncryptionConfiguration`, `CloudWatchLoggingOptions`,
// `ProcessingConfiguration`, `DataFormatConversionConfiguration`,
// `DynamicPartitioningConfiguration`) the SDK reuses the same type as
// the corresponding `*Configuration` input — so reverse-mapping is a
// pass-through that strips `undefined` fields. Per docs/provider-rules.md#readcurrentstate-for-drift-detection
//  "always emit user-controllable top-level keys": even though
// these are nested rather than top-level, surfacing them on every
// readCurrentState call (as `{}` placeholder when AWS reports nothing)
// keeps the v3 observedProperties baseline consistent so console-side
// ADDs to a previously-undefined sub-shape surface as drift.

export type Defined<T> = {
  [K in keyof T]-?: T[K] extends undefined ? never : Exclude<T[K], undefined>;
};

/**
 * Strip `undefined` fields (and empty resulting objects) from an AWS-SDK
 * Description object so it round-trips cleanly through cdkd's drift
 * comparator. Recursive — descends through nested objects but leaves
 * arrays as-is (positional compare on AWS-returned order is stable for
 * Firehose's response shapes).
 */
export function pickDefinedDeep<T>(input: T | undefined): Partial<Defined<T>> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') return input as unknown as Partial<Defined<T>>;
  if (Array.isArray(input)) {
    return input.map((v) => pickDefinedDeep(v)) as unknown as Partial<Defined<T>>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cleaned = pickDefinedDeep(v as unknown);
    if (cleaned === undefined) continue;
    if (
      cleaned !== null &&
      typeof cleaned === 'object' &&
      !Array.isArray(cleaned) &&
      Object.keys(cleaned as Record<string, unknown>).length === 0
    ) {
      // Drop empty nested objects to avoid `{}` clutter — except at the
      // top level, the caller decides whether to surface a placeholder.
      continue;
    }
    out[k] = cleaned;
  }
  return out as Partial<Defined<T>>;
}

/**
 * Map S3DestinationDescription → CFn S3DestinationConfiguration.
 * Surfaces the top-level subset that has a clean reverse-mapping plus
 * the inner nested complex fields (EncryptionConfiguration /
 * CloudWatchLoggingOptions) that the SDK reuses across both shapes.
 *
 * Typed as `Record<string, unknown>` to side-step the SDK's strict
 * required/optional discriminator on `RoleARN` / `BucketARN` that
 * `exactOptionalPropertyTypes` rejects when passing a sub-object whose
 * own RoleARN/BucketARN may be undefined (e.g. the deprecated
 * S3BackupDescription form). Behavior unchanged.
 */
export function mapS3DescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (desc['BucketARN'] !== undefined) out['BucketARN'] = desc['BucketARN'];
  if (desc['RoleARN'] !== undefined) out['RoleARN'] = desc['RoleARN'];
  if (desc['Prefix'] !== undefined) out['Prefix'] = desc['Prefix'];
  if (desc['ErrorOutputPrefix'] !== undefined) {
    out['ErrorOutputPrefix'] = desc['ErrorOutputPrefix'];
  }
  if (desc['CompressionFormat'] !== undefined) {
    out['CompressionFormat'] = desc['CompressionFormat'];
  }
  if (desc['BufferingHints']) {
    const hints = pickDefinedDeep(desc['BufferingHints']);
    if (hints && typeof hints === 'object' && Object.keys(hints).length > 0) {
      out['BufferingHints'] = hints;
    }
  }
  // EncryptionConfiguration: surface always so a console-side enable on a
  // previously-default destination shows as drift on v3 baseline.
  out['EncryptionConfiguration'] = pickDefinedDeep(desc['EncryptionConfiguration']) ?? {};
  // CloudWatchLoggingOptions: same pattern.
  out['CloudWatchLoggingOptions'] = pickDefinedDeep(desc['CloudWatchLoggingOptions']) ?? {};
  return out;
}

/**
 * Map ExtendedS3DestinationDescription → CFn ExtendedS3DestinationConfiguration.
 * Adds the Extended-only inner fields (`ProcessingConfiguration`,
 * `DataFormatConversionConfiguration`, `DynamicPartitioningConfiguration`,
 * `S3BackupConfiguration`) on top of the S3 base set.
 *
 * `S3BackupDescription` (note: Description, not Configuration) is
 * delegated to `mapS3DescriptionToCfn` since AWS uses the deprecated
 * S3DestinationDescription shape for backup, but CFn input expects
 * S3DestinationConfiguration — same field names work.
 */
export function mapExtendedS3DescriptionToCfn(
  desc: Record<string, unknown>
): Record<string, unknown> {
  const out = mapS3DescriptionToCfn(desc);
  if (desc['S3BackupMode'] !== undefined) out['S3BackupMode'] = desc['S3BackupMode'];
  // Inner nested complex fields. SDK reuses the *Configuration types in
  // *Description responses, so a deep `pickDefinedDeep` produces a CFn-
  // compatible shape.
  out['ProcessingConfiguration'] = pickDefinedDeep(desc['ProcessingConfiguration']) ?? {};
  out['DataFormatConversionConfiguration'] =
    pickDefinedDeep(desc['DataFormatConversionConfiguration']) ?? {};
  out['DynamicPartitioningConfiguration'] =
    pickDefinedDeep(desc['DynamicPartitioningConfiguration']) ?? {};
  // AWS omits both from the description when they were never set.
  if (desc['FileExtension'] !== undefined) out['FileExtension'] = desc['FileExtension'];
  if (desc['CustomTimeZone'] !== undefined) out['CustomTimeZone'] = desc['CustomTimeZone'];
  // S3BackupConfiguration: AWS returns S3BackupDescription (deprecated
  // shape); reverse-map to the modern Configuration shape via the same
  // top-level helper. Field names align since the deprecated shape and
  // the modern shape share the BucketARN / RoleARN / Prefix / etc.
  // surface, just with the EncryptionConfiguration / CloudWatchLoggingOptions
  // inner placeholders included.
  if (desc['S3BackupDescription']) {
    out['S3BackupConfiguration'] = mapS3DescriptionToCfn(
      desc['S3BackupDescription'] as Record<string, unknown>
    );
  } else {
    out['S3BackupConfiguration'] = {};
  }
  return out;
}

/**
 * Map a non-S3 destination description (Elasticsearch /
 * Amazonopensearchservice / AmazonOpenSearchServerless / Splunk) to
 * its CFn `*Configuration` shape.
 *
 * AWS reuses field names between Description and Configuration for
 * these destinations, so a `pickDefinedDeep` pass-through produces a
 * CFn-compatible shape. The exception is `VpcConfigurationDescription`
 * which carries an AWS-managed read-only `VpcId` not present in the
 * CFn `VpcConfiguration` input shape — strip it so the comparator
 * doesn't fire false drift on the read-only field.
 *
 * Always-emit pattern: every nested complex sub-shape AWS reports
 * (BufferingHints / RetryOptions / ProcessingConfiguration /
 * CloudWatchLoggingOptions / VpcConfiguration / DocumentIdOptions /
 * SecretsManagerConfiguration) that the SDK reuses across both shapes
 * is surfaced via `pickDefinedDeep`. Non-templated sub-shapes are
 * dropped to avoid `{}` clutter; the v3 baseline catches console-side
 * ADDs at the top-level destination key, not at every leaf.
 */
export function mapNonS3DestinationToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const cleaned = pickDefinedDeep(desc) as Record<string, unknown> | undefined;
  if (!cleaned) return {};
  // AWS returns VpcConfigurationDescription with a read-only VpcId; the
  // CFn VpcConfiguration shape does not include it. Strip if present.
  if (cleaned['VpcConfigurationDescription']) {
    const vpc = { ...(cleaned['VpcConfigurationDescription'] as Record<string, unknown>) };
    delete vpc['VpcId'];
    // Rename to the CFn key (`VpcConfiguration`).
    delete cleaned['VpcConfigurationDescription'];
    if (Object.keys(vpc).length > 0) cleaned['VpcConfiguration'] = vpc;
  }
  return cleaned;
}

/**
 * Map RedshiftDestinationDescription → CFn RedshiftDestinationConfiguration.
 *
 * Redshift carries a nested S3DestinationDescription (deprecated shape)
 * that's required as `S3Configuration` in the CFn input. Reverse-map via
 * the shared `mapS3DescriptionToCfn` helper. `S3BackupDescription` is
 * mapped to `S3BackupConfiguration` the same way.
 *
 * `Password` is write-only — AWS never returns it on read. State that
 * carries `Password` falls back to v2 baseline; declared in
 * `getDriftUnknownPaths`.
 */
export function mapRedshiftDescriptionToCfn(
  desc: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'RoleARN',
    'ClusterJDBCURL',
    'CopyCommand',
    'Username',
    'RetryOptions',
    'ProcessingConfiguration',
    'S3BackupMode',
    'CloudWatchLoggingOptions',
    'SecretsManagerConfiguration',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  // Required nested S3 destination — reverse-map via the S3 helper.
  if (desc['S3DestinationDescription']) {
    out['S3Configuration'] = mapS3DescriptionToCfn(
      desc['S3DestinationDescription'] as Record<string, unknown>
    );
  }
  if (desc['S3BackupDescription']) {
    out['S3BackupConfiguration'] = mapS3DescriptionToCfn(
      desc['S3BackupDescription'] as Record<string, unknown>
    );
  }
  return out;
}

/**
 * CloudFormation reads `MSKSourceConfiguration.ReadFromTimestamp` as a string
 * of epoch MILLISECONDS (go-to-k/cdkd#5636, measured through Cloud Control:
 * `1761955200` reached Firehose as 1970-01-21T09:25:55.200Z, and
 * `2026-11-01T00:00:00Z`, `2026-11-01T00:00:00` and `2026-11-01` were each
 * refused with `For input string: "<value>"`). The same spellings a Java
 * `Long.parseLong` takes: an optional sign, then digits. A whole-number value
 * is read as its decimal string, as CloudFormation coerces a scalar to the
 * schema's `string` type (a raw template's unquoted `1767225600000`).
 */
export const EPOCH_MILLIS = /^[+-]?\d+$/;

/** The instant an epoch-milliseconds `ReadFromTimestamp` names, or `undefined`. */
export function epochMillisTimestamp(value: unknown): Date | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !EPOCH_MILLIS.test(value)) return undefined;
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Map CFn `MSKSourceConfiguration` to the SDK create shape
 * (go-to-k/cdkd#5636). The members share their names; `ReadFromTimestamp` is
 * a string of epoch milliseconds in the template, as CloudFormation reads it
 * ({@link EPOCH_MILLIS}), and a `Date` on the wire. Any other spelling, an ISO
 * 8601 date-time included, is refused here as CloudFormation refuses it,
 * before any AWS call, naming the property.
 */
export function mapMskSourceConfiguration(
  config: Record<string, unknown>,
  mask: MaskerFn,
  resourceType: string,
  logicalId: string
): MSKSourceConfiguration {
  const auth = config['AuthenticationConfiguration'] as Record<string, unknown> | undefined;
  const result: MSKSourceConfiguration = {
    MSKClusterARN: config['MSKClusterARN'] as string,
    TopicName: config['TopicName'] as string,
    AuthenticationConfiguration: auth && {
      RoleARN: auth['RoleARN'] as string,
      Connectivity: auth['Connectivity'] as 'PUBLIC' | 'PRIVATE',
    },
  };
  const raw = config['ReadFromTimestamp'];
  if (raw !== undefined) {
    const parsed = epochMillisTimestamp(raw);
    if (parsed === undefined) {
      throw markNonRetryable(
        new ProvisioningError(
          `MSKSourceConfiguration.ReadFromTimestamp of Firehose delivery stream ${logicalId} is ` +
            `not a string of epoch milliseconds: ${JSON.stringify(maskDeep(raw, mask))} — ` +
            `CloudFormation reads it as one and refuses any other spelling, an ISO 8601 date ` +
            `included; write e.g. '1767225600000' for 2026-01-01T00:00:00Z. The delivery ` +
            `stream was not created`,
          resourceType,
          logicalId
        )
      );
    }
    result.ReadFromTimestamp = parsed;
  }
  return result;
}

/**
 * Map `Source.MSKSourceDescription` → CFn `MSKSourceConfiguration`
 * (go-to-k/cdkd#5636). `ReadFromTimestamp` comes back as a `Date` and is
 * written as epoch milliseconds, the template's spelling ({@link EPOCH_MILLIS}),
 * keeping the recorded string when it names the same instant (`+0…` forms).
 * A stream created without one read back none (measured 2026-11-03, a
 * stream ACTIVE for minutes: only `DeliveryStartTimestamp`); should AWS
 * report one anyway, it is written as epoch milliseconds and lands in the
 * observed baseline, never the template's keys. The read-only
 * `DeliveryStartTimestamp` is not a template member.
 */
export function mapMskSourceDescriptionToCfn(
  desc: NonNullable<NonNullable<DeliveryStreamDescription['Source']>['MSKSourceDescription']>,
  recorded: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (desc.MSKClusterARN !== undefined) out['MSKClusterARN'] = desc.MSKClusterARN;
  if (desc.TopicName !== undefined) out['TopicName'] = desc.TopicName;
  const auth = desc.AuthenticationConfiguration;
  if (auth) {
    out['AuthenticationConfiguration'] = {
      ...(auth.RoleARN !== undefined && { RoleARN: auth.RoleARN }),
      ...(auth.Connectivity !== undefined && { Connectivity: auth.Connectivity }),
    };
  }
  const live = desc.ReadFromTimestamp;
  if (live instanceof Date && !Number.isNaN(live.getTime())) {
    const spelled = isPlainRecord(recorded) ? recorded['ReadFromTimestamp'] : undefined;
    out['ReadFromTimestamp'] =
      epochMillisTimestamp(spelled)?.getTime() === live.getTime()
        ? spelled
        : String(live.getTime());
  }
  return out;
}

/**
 * Map IcebergDestinationDescription → CFn IcebergDestinationConfiguration
 * (go-to-k/cdkd#5636). Three members are renamed back to CloudFormation's
 * spelling: `S3BackupMode` → `s3BackupMode`, `CatalogConfiguration.CatalogARN`
 * → `CatalogArn`, and the nested `S3DestinationDescription` →
 * `S3Configuration` (through {@link mapS3DescriptionToCfn}). The rest share
 * their names with the input shape.
 */
export function mapIcebergDescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'DestinationTableConfigurationList',
    'SchemaEvolutionConfiguration',
    'TableCreationConfiguration',
    'BufferingHints',
    'CloudWatchLoggingOptions',
    'ProcessingConfiguration',
    'RetryOptions',
    'RoleARN',
    'AppendOnly',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  if (desc['S3BackupMode'] !== undefined) out['s3BackupMode'] = desc['S3BackupMode'];
  const catalog = desc['CatalogConfiguration'] as Record<string, unknown> | undefined;
  if (catalog) {
    out['CatalogConfiguration'] = {
      ...(catalog['CatalogARN'] !== undefined && { CatalogArn: catalog['CatalogARN'] }),
      ...(catalog['WarehouseLocation'] !== undefined && {
        WarehouseLocation: catalog['WarehouseLocation'],
      }),
    };
  }
  if (desc['S3DestinationDescription']) {
    out['S3Configuration'] = mapS3DescriptionToCfn(
      desc['S3DestinationDescription'] as Record<string, unknown>
    );
  }
  return out;
}

/**
 * Map HttpEndpointDestinationDescription → CFn HttpEndpointDestinationConfiguration.
 *
 * AWS returns `EndpointConfiguration: HttpEndpointDescription` (Url +
 * Name only). The CFn input `HttpEndpointConfiguration` additionally
 * accepts `AccessKey` (write-only — redacted from the Description).
 * State that carries `AccessKey` falls back to v2 baseline; declared in
 * `getDriftUnknownPaths`.
 *
 * `RequestConfiguration` and `SecretsManagerConfiguration` are pass-
 * through (SDK reuses the same shapes between Configuration and
 * Description).
 */
export function mapHttpEndpointDescriptionToCfn(
  desc: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'BufferingHints',
    'CloudWatchLoggingOptions',
    'RequestConfiguration',
    'ProcessingConfiguration',
    'RoleARN',
    'RetryOptions',
    'SecretsManagerConfiguration',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  if (desc['EndpointConfiguration']) {
    const endpoint = pickDefinedDeep(desc['EndpointConfiguration']);
    if (endpoint !== undefined) out['EndpointConfiguration'] = endpoint;
  }
  return out;
}
