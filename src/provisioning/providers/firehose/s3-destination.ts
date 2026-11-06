import type { FirehoseProvider } from '../firehose-provider.js';
import type {
  S3DestinationConfiguration,
  ExtendedS3DestinationConfiguration,
  ExtendedS3DestinationUpdate,
  S3DestinationUpdate,
} from '@aws-sdk/client-firehose';

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Map CFn S3DestinationConfiguration to SDK format
 *
 * CFn uses PascalCase (BucketArn, RoleArn) while SDK uses uppercase ARN
 * (BucketARN, RoleARN).
 */
export function mapS3DestinationConfiguration(
  this: FirehoseProvider,
  config: Record<string, unknown>
): S3DestinationConfiguration {
  const result: S3DestinationConfiguration = {
    BucketARN: (config['BucketArn'] || config['BucketARN']) as string,
    RoleARN: (config['RoleArn'] || config['RoleARN']) as string,
  };

  if (config['Prefix'] !== undefined) {
    result.Prefix = config['Prefix'] as string;
  }

  if (config['ErrorOutputPrefix'] !== undefined) {
    result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
  }

  if (config['CompressionFormat'] !== undefined) {
    result.CompressionFormat = config[
      'CompressionFormat'
    ] as S3DestinationConfiguration['CompressionFormat'];
  }

  if (config['BufferingHints'] !== undefined) {
    const hints = config['BufferingHints'] as Record<string, unknown>;
    result.BufferingHints = {
      ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
      ...(hints['IntervalInSeconds'] !== undefined && {
        IntervalInSeconds: hints['IntervalInSeconds'] as number,
      }),
    };
  }

  if (config['EncryptionConfiguration'] !== undefined) {
    result.EncryptionConfiguration = config[
      'EncryptionConfiguration'
    ] as S3DestinationConfiguration['EncryptionConfiguration'];
  }

  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as S3DestinationConfiguration['CloudWatchLoggingOptions'];
  }

  return result;
}

/**
 * Map CFn ExtendedS3DestinationConfiguration to SDK format
 */
export function mapExtendedS3DestinationConfiguration(
  this: FirehoseProvider,
  config: Record<string, unknown>
): ExtendedS3DestinationConfiguration {
  const result: ExtendedS3DestinationConfiguration = {
    BucketARN: (config['BucketArn'] || config['BucketARN']) as string,
    RoleARN: (config['RoleArn'] || config['RoleARN']) as string,
  };

  if (config['Prefix'] !== undefined) {
    result.Prefix = config['Prefix'] as string;
  }

  if (config['ErrorOutputPrefix'] !== undefined) {
    result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
  }

  if (config['CompressionFormat'] !== undefined) {
    result.CompressionFormat = config[
      'CompressionFormat'
    ] as ExtendedS3DestinationConfiguration['CompressionFormat'];
  }

  if (config['BufferingHints'] !== undefined) {
    const hints = config['BufferingHints'] as Record<string, unknown>;
    result.BufferingHints = {
      ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
      ...(hints['IntervalInSeconds'] !== undefined && {
        IntervalInSeconds: hints['IntervalInSeconds'] as number,
      }),
    };
  }

  if (config['EncryptionConfiguration'] !== undefined) {
    result.EncryptionConfiguration = config[
      'EncryptionConfiguration'
    ] as ExtendedS3DestinationConfiguration['EncryptionConfiguration'];
  }

  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as ExtendedS3DestinationConfiguration['CloudWatchLoggingOptions'];
  }

  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as ExtendedS3DestinationConfiguration['ProcessingConfiguration'];
  }

  if (config['S3BackupMode'] !== undefined) {
    result.S3BackupMode = config[
      'S3BackupMode'
    ] as ExtendedS3DestinationConfiguration['S3BackupMode'];
  }

  if (config['S3BackupConfiguration'] !== undefined) {
    const backupConfig = config['S3BackupConfiguration'] as Record<string, unknown>;
    result.S3BackupConfiguration = this.mapS3DestinationConfiguration(backupConfig);
  }

  if (config['DataFormatConversionConfiguration'] !== undefined) {
    result.DataFormatConversionConfiguration = config[
      'DataFormatConversionConfiguration'
    ] as ExtendedS3DestinationConfiguration['DataFormatConversionConfiguration'];
  }

  // A dynamic-partitioning Prefix (`!{partitionKeyFromQuery:...}`) is refused
  // without `DynamicPartitioningConfiguration`, so dropping it fails the create.
  if (config['DynamicPartitioningConfiguration'] !== undefined) {
    result.DynamicPartitioningConfiguration = config[
      'DynamicPartitioningConfiguration'
    ] as ExtendedS3DestinationConfiguration['DynamicPartitioningConfiguration'];
  }

  if (config['FileExtension'] !== undefined) {
    result.FileExtension = config['FileExtension'] as string;
  }

  if (config['CustomTimeZone'] !== undefined) {
    result.CustomTimeZone = config['CustomTimeZone'] as string;
  }

  return result;
}

/**
 * Map CFn `ExtendedS3DestinationConfiguration` to the
 * `ExtendedS3DestinationUpdate` shape expected by AWS
 * `UpdateDestinationCommand` (#477). Shape is structurally identical
 * to `ExtendedS3DestinationConfiguration` but every field is optional
 * — only the fields present in `config` are forwarded so undefined
 * keys do not clobber AWS-side state.
 *
 * Omitting a sub-field REMOVED from the template is CloudFormation
 * parity, not a gap (#1160): `UpdateDestination` merges, and a live
 * CloudFormation A/B kept every removed sub-field (`Prefix`,
 * `ErrorOutputPrefix`, `BufferingHints`, `CompressionFormat`,
 * `FileExtension`, `CustomTimeZone`, `CloudWatchLoggingOptions`,
 * `ProcessingConfiguration`, and the nested S3 configuration's fields on
 * an HttpEndpoint destination) whether or not a sibling change forced the
 * update. Every destination's reverse-mapper below relies on this; do not
 * add a reset-on-removal here.
 *
 * `S3BackupConfiguration` is mapped through {@link mapS3ConfigToUpdate}
 * so its own optional fields likewise round-trip cleanly.
 */
export function mapExtendedS3ConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): ExtendedS3DestinationUpdate {
  const result: ExtendedS3DestinationUpdate = {};
  const bucketArn = (config['BucketArn'] ?? config['BucketARN']) as string | undefined;
  if (bucketArn !== undefined) result.BucketARN = bucketArn;
  const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  if (config['Prefix'] !== undefined) result.Prefix = config['Prefix'] as string;
  if (config['ErrorOutputPrefix'] !== undefined) {
    result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
  }
  if (config['CompressionFormat'] !== undefined) {
    result.CompressionFormat = config[
      'CompressionFormat'
    ] as ExtendedS3DestinationUpdate['CompressionFormat'];
  }
  if (config['BufferingHints'] !== undefined) {
    const hints = config['BufferingHints'] as Record<string, unknown>;
    result.BufferingHints = {
      ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
      ...(hints['IntervalInSeconds'] !== undefined && {
        IntervalInSeconds: hints['IntervalInSeconds'] as number,
      }),
    };
  }
  if (config['EncryptionConfiguration'] !== undefined) {
    result.EncryptionConfiguration = config[
      'EncryptionConfiguration'
    ] as ExtendedS3DestinationUpdate['EncryptionConfiguration'];
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as ExtendedS3DestinationUpdate['CloudWatchLoggingOptions'];
  }
  if (config['ProcessingConfiguration'] !== undefined) {
    result.ProcessingConfiguration = config[
      'ProcessingConfiguration'
    ] as ExtendedS3DestinationUpdate['ProcessingConfiguration'];
  }
  if (config['S3BackupMode'] !== undefined) {
    result.S3BackupMode = config['S3BackupMode'] as ExtendedS3DestinationUpdate['S3BackupMode'];
  }
  if (config['S3BackupConfiguration'] !== undefined) {
    // CFn property is `S3BackupConfiguration`; SDK's Update shape uses
    // `S3BackupUpdate`. The reverse-mapper consumes CFn-shaped input,
    // so only the CFn key needs to be handled.
    result.S3BackupUpdate = this.mapS3ConfigToUpdate(
      config['S3BackupConfiguration'] as Record<string, unknown>
    );
  }
  if (config['DataFormatConversionConfiguration'] !== undefined) {
    result.DataFormatConversionConfiguration = config[
      'DataFormatConversionConfiguration'
    ] as ExtendedS3DestinationUpdate['DataFormatConversionConfiguration'];
  }
  // On a stream with dynamic partitioning enabled, an `UpdateDestination`
  // that omits this block reads as "disable it" and is refused ("Enabling
  // or disabling Dynamic Partitioning is not supported"), so it is forwarded
  // on every update, like the rest of the desired shape.
  if (config['DynamicPartitioningConfiguration'] !== undefined) {
    result.DynamicPartitioningConfiguration = config[
      'DynamicPartitioningConfiguration'
    ] as ExtendedS3DestinationUpdate['DynamicPartitioningConfiguration'];
  }
  if (config['FileExtension'] !== undefined) {
    result.FileExtension = config['FileExtension'] as string;
  }
  if (config['CustomTimeZone'] !== undefined) {
    result.CustomTimeZone = config['CustomTimeZone'] as string;
  }
  return result;
}

/**
 * Map CFn `S3DestinationConfiguration` to the `S3DestinationUpdate`
 * shape used by AWS `UpdateDestinationCommand` (#477): the top-level
 * legacy destination ({@link applyS3DestinationUpdate}, #5439) and every
 * nested `S3Update` / `S3BackupUpdate` slot.
 * Every field optional — only present keys are forwarded.
 */
export function mapS3ConfigToUpdate(
  this: FirehoseProvider,
  config: Record<string, unknown>
): S3DestinationUpdate {
  const result: S3DestinationUpdate = {};
  const bucketArn = (config['BucketArn'] ?? config['BucketARN']) as string | undefined;
  if (bucketArn !== undefined) result.BucketARN = bucketArn;
  const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
  if (roleArn !== undefined) result.RoleARN = roleArn;
  if (config['Prefix'] !== undefined) result.Prefix = config['Prefix'] as string;
  if (config['ErrorOutputPrefix'] !== undefined) {
    result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
  }
  if (config['CompressionFormat'] !== undefined) {
    result.CompressionFormat = config[
      'CompressionFormat'
    ] as S3DestinationUpdate['CompressionFormat'];
  }
  if (config['BufferingHints'] !== undefined) {
    const hints = config['BufferingHints'] as Record<string, unknown>;
    result.BufferingHints = {
      ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
      ...(hints['IntervalInSeconds'] !== undefined && {
        IntervalInSeconds: hints['IntervalInSeconds'] as number,
      }),
    };
  }
  if (config['EncryptionConfiguration'] !== undefined) {
    result.EncryptionConfiguration = config[
      'EncryptionConfiguration'
    ] as S3DestinationUpdate['EncryptionConfiguration'];
  }
  if (config['CloudWatchLoggingOptions'] !== undefined) {
    result.CloudWatchLoggingOptions = config[
      'CloudWatchLoggingOptions'
    ] as S3DestinationUpdate['CloudWatchLoggingOptions'];
  }
  return result;
}
