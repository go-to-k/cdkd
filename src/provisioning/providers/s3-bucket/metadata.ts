/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import type {
  MetadataConfiguration,
  MetadataConfigurationResult,
  MetadataTableEncryptionConfiguration,
} from '@aws-sdk/client-s3';
import { isPlainObject } from './shared.js';

/**
 * go-to-k/cdkd#2762: S3 reads a bucket that never set ABAC as `Disabled`, and
 * CloudFormation sends `Disabled` when a template drops `AbacStatus` (measured
 * 2026-11-01), so an undeclared value is that one.
 */
export const ABAC_DISABLED = 'Disabled';
export const ABAC_ENABLED = 'Enabled';

/** The table states of a CFn `MetadataConfiguration`; an undeclared one is off. */
export const METADATA_TABLE_DISABLED = 'DISABLED';
export const METADATA_TABLE_ENABLED = 'ENABLED';
/**
 * CloudFormation took 33 seconds over a journal and an inventory table
 * (measured 2026-11-01); the budget only bounds a table that never settles.
 */
export const METADATA_TABLE_POLL_MS = 2_000;
export const METADATA_TABLE_BUDGET_MS = 5 * 60_000;

export function abacStatusOf(properties: Record<string, unknown>): unknown {
  return properties['AbacStatus'] ?? ABAC_DISABLED;
}

export function metadataBag(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

/**
 * Why a declared `MetadataConfiguration` cannot be sent, or `undefined`. It runs
 * before anything reads the value, because a non-object would otherwise read
 * as a removal and delete the live configuration
 * (docs/provider-rules.md, "Never infer a default from a possibly-malformed value").
 */
export function metadataConfigurationRefusal(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const root = 'MetadataConfiguration';
  if (!isPlainObject(value)) return `${root} must be an object`;
  const journal = value['JournalTableConfiguration'];
  if (!isPlainObject(journal)) return `${root}.JournalTableConfiguration must be an object`;
  const expiration = journal['RecordExpiration'];
  if (!isPlainObject(expiration)) {
    return `${root}.JournalTableConfiguration.RecordExpiration must be an object`;
  }
  if (typeof expiration['Expiration'] !== 'string') {
    return `${root}.JournalTableConfiguration.RecordExpiration.Expiration must be a string`;
  }
  const days = expiration['Days'];
  if (days !== undefined && (days === '' || days === null || !Number.isInteger(Number(days)))) {
    return `${root}.JournalTableConfiguration.RecordExpiration.Days must be an integer`;
  }
  const tables = [
    ['JournalTableConfiguration', journal],
    ['InventoryTableConfiguration', value['InventoryTableConfiguration']],
    ['AnnotationTableConfiguration', value['AnnotationTableConfiguration']],
  ] as const;
  for (const [member, table] of tables) {
    if (table === undefined) continue;
    if (!isPlainObject(table)) return `${root}.${member} must be an object`;
    if (member !== 'JournalTableConfiguration' && typeof table['ConfigurationState'] !== 'string') {
      return `${root}.${member}.ConfigurationState must be a string`;
    }
    const encryption = table['EncryptionConfiguration'];
    if (encryption === undefined) continue;
    if (!isPlainObject(encryption) || typeof encryption['SseAlgorithm'] !== 'string') {
      return `${root}.${member}.EncryptionConfiguration must be an object with an SseAlgorithm`;
    }
  }
  return undefined;
}

export function metadataEncryptionToSdk(
  table: Record<string, unknown>
): MetadataTableEncryptionConfiguration | undefined {
  const encryption = metadataBag(table['EncryptionConfiguration']);
  if (encryption === undefined) return undefined;
  return {
    SseAlgorithm: encryption[
      'SseAlgorithm'
    ] as MetadataTableEncryptionConfiguration['SseAlgorithm'],
    ...(encryption['KmsKeyArn'] !== undefined
      ? { KmsKeyArn: encryption['KmsKeyArn'] as string }
      : {}),
  };
}

/**
 * CFn `MetadataConfiguration` -> the SDK's, carrying only what a caller can
 * set: the CFn schema marks `Destination` and every `TableName` / `TableArn`
 * read-only. A declared `Days` may arrive as a string through a parameter.
 */
export function metadataConfigurationToSdk(config: Record<string, unknown>): MetadataConfiguration {
  const journal = metadataBag(config['JournalTableConfiguration']) ?? {};
  const expiration = metadataBag(journal['RecordExpiration']) ?? {};
  const days = expiration['Days'];
  const journalEncryption = metadataEncryptionToSdk(journal);
  const inventory = metadataBag(config['InventoryTableConfiguration']);
  const inventoryEncryption = inventory && metadataEncryptionToSdk(inventory);
  const annotation = metadataBag(config['AnnotationTableConfiguration']);
  const annotationEncryption = annotation && metadataEncryptionToSdk(annotation);
  type Sdk = MetadataConfiguration;
  type Inventory = NonNullable<Sdk['InventoryTableConfiguration']>;
  type Annotation = NonNullable<Sdk['AnnotationTableConfiguration']>;
  return {
    JournalTableConfiguration: {
      RecordExpiration: {
        Expiration: expiration['Expiration'] as NonNullable<
          NonNullable<Sdk['JournalTableConfiguration']>['RecordExpiration']
        >['Expiration'],
        ...(days !== undefined
          ? { Days: typeof days === 'string' ? Number(days) : (days as number) }
          : {}),
      },
      ...(journalEncryption ? { EncryptionConfiguration: journalEncryption } : {}),
    },
    ...(inventory
      ? {
          InventoryTableConfiguration: {
            ConfigurationState: inventory['ConfigurationState'] as Inventory['ConfigurationState'],
            ...(inventoryEncryption ? { EncryptionConfiguration: inventoryEncryption } : {}),
          },
        }
      : {}),
    ...(annotation
      ? {
          AnnotationTableConfiguration: {
            ConfigurationState: annotation[
              'ConfigurationState'
            ] as Annotation['ConfigurationState'],
            ...(annotationEncryption ? { EncryptionConfiguration: annotationEncryption } : {}),
            ...(annotation['Role'] !== undefined ? { Role: annotation['Role'] as string } : {}),
          },
        }
      : {}),
  };
}

/**
 * The SDK's readback -> the CFn writable shape, with what
 * `metadataConfigurationToSdk` sends. S3 never returns `EncryptionConfiguration`
 * (write-only in the CFn schema), and the read-only members are attributes.
 */
export function metadataConfigurationFromSdk(
  result: MetadataConfigurationResult
): Record<string, unknown> {
  const journal = result.JournalTableConfigurationResult;
  const inventory = result.InventoryTableConfigurationResult;
  const annotation = result.AnnotationTableConfigurationResult;
  return {
    ...(journal
      ? {
          JournalTableConfiguration: {
            RecordExpiration: {
              Expiration: journal.RecordExpiration?.Expiration,
              ...(journal.RecordExpiration?.Days !== undefined
                ? { Days: journal.RecordExpiration.Days }
                : {}),
            },
          },
        }
      : {}),
    ...(inventory
      ? { InventoryTableConfiguration: { ConfigurationState: inventory.ConfigurationState } }
      : {}),
    ...(annotation
      ? {
          AnnotationTableConfiguration: {
            ConfigurationState: annotation.ConfigurationState,
            ...(annotation.Role !== undefined ? { Role: annotation.Role } : {}),
          },
        }
      : {}),
  };
}

/** The `Fn::GetAtt` names CloudFormation serves from a metadata readback. */
export function metadataAttributesFromSdk(
  result: MetadataConfigurationResult
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  const destination = result.DestinationResult;
  if (destination) {
    const path = 'MetadataConfiguration.Destination';
    attributes[path] = {
      TableBucketArn: destination.TableBucketArn,
      TableBucketType: destination.TableBucketType,
      TableNamespace: destination.TableNamespace,
    };
    attributes[`${path}.TableBucketArn`] = destination.TableBucketArn;
    attributes[`${path}.TableBucketType`] = destination.TableBucketType;
    attributes[`${path}.TableNamespace`] = destination.TableNamespace;
  }
  for (const [member, table] of [
    ['JournalTableConfiguration', result.JournalTableConfigurationResult],
    ['InventoryTableConfiguration', result.InventoryTableConfigurationResult],
    ['AnnotationTableConfiguration', result.AnnotationTableConfigurationResult],
  ] as const) {
    if (table?.TableName !== undefined) {
      attributes[`MetadataConfiguration.${member}.TableName`] = table.TableName;
    }
    if (table?.TableArn !== undefined) {
      attributes[`MetadataConfiguration.${member}.TableArn`] = table.TableArn;
    }
  }
  return attributes;
}

/**
 * The bucket-naming combinations CloudFormation refuses (measured 2026-11-01).
 * `BucketNamespace: account-regional` with neither name stays S3's to refuse:
 * its message names the `-<account>-<region>-an` suffix a name must carry.
 */
export function bucketNameRefusal(properties: Record<string, unknown>): string | undefined {
  const prefix = properties['BucketNamePrefix'];
  if (prefix === undefined) return undefined;
  if (typeof prefix !== 'string' || prefix === '') {
    return 'sets a BucketNamePrefix that is not a non-empty string';
  }
  if (properties['BucketName'] !== undefined) {
    return 'specifies both BucketName and BucketNamePrefix; only one of them is accepted';
  }
  if (properties['BucketNamespace'] !== 'account-regional') {
    return 'sets BucketNamePrefix, which is only supported with BucketNamespace: account-regional';
  }
  return undefined;
}
