import type { DBInstance, DBInstanceStatusInfo } from '@aws-sdk/client-rds';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';

/** How the caller read the instance it records. */
export interface DbInstanceAttributeRead {
  /**
   * The operation waited for the instance to settle (`false` for a create or
   * update that did not wait under `--no-wait`; a restore or replica create
   * waits even then), or the read is not an operation's (an
   * `import()` re-read). Gates the TRANSIENT values, with the instance's own
   * `available` status: see {@link dbInstanceAttributes}.
   */
  readonly settled: boolean;
}

/**
 * The `Fn::GetAtt` attributes an RDS DB instance records, from a
 * `DescribeDBInstances` / `CreateDBInstance` instance: every writer of the
 * record (create, update, `import()`) builds it here, so the key sets cannot
 * drift apart — `attributes` REPLACES the record on update.
 *
 * go-to-k/cdkd#6242: `DbiResourceId` (CDK's `instanceResourceId`, which
 * `grantConnect` builds its `rds-db:connect` ARN from), `Endpoint.HostedZoneId`,
 * `ListenerEndpoint.*` and `CertificateDetails.*` were never recorded, so a
 * reference resolved to the instance identifier. A value the response does not
 * carry (a listener endpoint on an instance with none, an endpoint while
 * `creating`) stays ABSENT, never `''`. The whole `Endpoint` /
 * `ListenerEndpoint` / `CertificateDetails` objects are not recorded a second
 * time: the resolver assembles them from these flat members, so the object
 * and its members cannot disagree.
 *
 * The read-only scalars keep the JSON type CloudFormation serves them in
 * (`IsStorageConfigUpgradeAvailable` a boolean), timestamps CloudFormation's
 * text, and the lists are `[]` for a described instance that reports none, as
 * CloudFormation serves them (its handler's SDK reads an absent list as
 * empty). `DBInstanceStatus`, `PercentProgress` and `StorageOperation*`
 * describe the instance at one moment: CloudFormation serves them as its
 * stabilized `available` instance reports them, so they are recorded only
 * from a settled read of an `available` instance — never from an operation
 * that did not wait (`--no-wait`), nor from a read taken mid-modification (an update returns before
 * RDS finishes most modifications). Absent, a reference re-reads the
 * instance (the stale-attribute heal) or is refused.
 *
 * go-to-k/cdkd#6913: `MasterUserSecret.SecretArn` (CDK's
 * `attrMasterUserSecretSecretArn`) is absent when RDS manages no master
 * secret for the instance.
 */
export function dbInstanceAttributes(
  instance: DBInstance | undefined,
  read: DbInstanceAttributeRead
): Record<string, unknown> {
  const transient = read.settled && instance?.DBInstanceStatus === 'available';
  const described = instance !== undefined;
  return definedAttributes({
    'Endpoint.Address': instance?.Endpoint?.Address,
    'Endpoint.Port': stringifyIfAssigned(instance?.Endpoint?.Port),
    'Endpoint.HostedZoneId': instance?.Endpoint?.HostedZoneId,
    Arn: instance?.DBInstanceArn,
    DbiResourceId: instance?.DbiResourceId,
    'MasterUserSecret.SecretArn': instance?.MasterUserSecret?.SecretArn,
    'ListenerEndpoint.Address': instance?.ListenerEndpoint?.Address,
    'ListenerEndpoint.Port': stringifyIfAssigned(instance?.ListenerEndpoint?.Port),
    'ListenerEndpoint.HostedZoneId': instance?.ListenerEndpoint?.HostedZoneId,
    'CertificateDetails.CAIdentifier': instance?.CertificateDetails?.CAIdentifier,
    'CertificateDetails.ValidTill': javaInstantText(instance?.CertificateDetails?.ValidTill),
    InstanceCreateTime: javaInstantText(instance?.InstanceCreateTime),
    LatestRestorableTime: javaInstantText(instance?.LatestRestorableTime),
    AutomaticRestartTime: javaInstantText(instance?.AutomaticRestartTime),
    ResumeFullAutomationModeTime: javaInstantText(instance?.ResumeFullAutomationModeTime),
    SecondaryAvailabilityZone: instance?.SecondaryAvailabilityZone,
    IsStorageConfigUpgradeAvailable: instance?.IsStorageConfigUpgradeAvailable,
    ReadReplicaDBInstanceIdentifiers: described
      ? [...(instance.ReadReplicaDBInstanceIdentifiers ?? [])]
      : undefined,
    ReadReplicaDBClusterIdentifiers: described
      ? [...(instance.ReadReplicaDBClusterIdentifiers ?? [])]
      : undefined,
    StatusInfos: described ? (instance.StatusInfos ?? []).map(statusInfo) : undefined,
    DBInstanceStatus: transient ? instance?.DBInstanceStatus : undefined,
    PercentProgress: transient ? instance?.PercentProgress : undefined,
    StorageOperationStatus: transient ? instance?.StorageOperationStatus : undefined,
    StorageOperationPercentProgress: transient
      ? instance?.StorageOperationPercentProgress
      : undefined,
  });
}

/**
 * One `StatusInfos` entry, its four documented members only. `Message` is
 * AWS free text; like every recorded attribute it is value-scanned for this
 * run's secrets at the state-persist choke point (`scrubResourceRecord`).
 */
function statusInfo(info: DBInstanceStatusInfo): Record<string, unknown> {
  return definedAttributes({
    StatusType: info.StatusType,
    Normal: info.Normal,
    Status: info.Status,
    Message: info.Message,
  });
}

/**
 * A timestamp as CloudFormation's Java handler renders an `Instant`
 * (`Instant.toString()`): ISO 8601 in UTC, the fraction only when non-zero.
 */
function javaInstantText(value: Date | undefined): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  return value.toISOString().replace('.000Z', 'Z');
}
