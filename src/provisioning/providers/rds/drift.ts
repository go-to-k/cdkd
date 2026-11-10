import { canonicalAssociatedRoles } from '../db-associated-roles.js';
import type { RDSProvider } from '../rds-provider.js';
import { sameReplicaSource } from './read-replica.js';
import {
  type ServerlessV2ScalingProps,
  CLUSTER_BOOLEAN_SCALARS,
  retentionPeriodValue,
} from './cluster-members.js';

/**
 * go-to-k/cdkd#5639 / #5640: RDS answers the exported log types in its own
 * order, and the template's order means nothing to it; likewise the
 * associated IAM roles. Also what `unsettledAfterUpdate` compares by.
 */
export function getDriftUnorderedPaths(this: RDSProvider, resourceType: string): string[] {
  // go-to-k/cdkd#5640: an instance's processor features, in RDS's own order.
  if (resourceType === 'AWS::RDS::DBInstance') {
    return ['EnableCloudwatchLogsExports', 'AssociatedRoles', 'ProcessorFeatures'];
  }
  return resourceType === 'AWS::RDS::DBCluster'
    ? ['EnableCloudwatchLogsExports', 'AssociatedRoles']
    : [];
}

/**
 * Issue #5466: `readCurrentState` reads `SecondsUntilAutoPause`, which
 * DescribeDBClusters returns on a cluster with `MinCapacity` 0 even when no
 * template declares it (AWS's 300-second default; measured us-east-1,
 * 2026-10-28). On the `observedProperties` baseline the comparator walks the
 * key UNION, so a record captured before this member was read would report
 * it as drift; the path is compared only where the template declares it.
 *
 * go-to-k/cdkd#2762: a DB instance's `AllowMajorVersionUpgrade` and
 * `CertificateRotationRestart` are ModifyDBInstance flags RDS keeps nowhere,
 * so DescribeDBInstances never returns them. go-to-k/cdkd#5640: nor
 * `SourceRegion`, which RDS never receives (write-only).
 */
export function getDriftUnknownPaths(
  this: RDSProvider,
  resourceType: string,
  properties?: Record<string, unknown>
): string[] {
  if (resourceType === 'AWS::RDS::DBInstance') {
    // go-to-k/cdkd#5640: `UseDefaultProcessorFeatures` is write-only. The
    // live `ProcessorFeatures` is compared only where the bag declares a
    // non-empty list (RDS reports none for an empty one), so a baseline
    // captured before it was read reports no drift; anything else declared is
    // compared. With no bag (the post-update unsettled proof) it is not: that
    // comparison does not narrow the live list to the declared features
    // (`canonicalizeDriftPair`), so a partial declared list would never settle.
    const instanceUnknown = [
      'AllowMajorVersionUpgrade',
      'CertificateRotationRestart',
      'SourceRegion',
      'UseDefaultProcessorFeatures',
      // go-to-k/cdkd#5640: write-only in the registry schema.
      'AutomaticBackupReplicationKmsKeyId',
    ];
    // go-to-k/cdkd#5640: an undeclared replication retention reads as the
    // instance's own BackupRetentionPeriod, which RDS applies by default, so
    // it is compared only where declared (and not with no bag).
    const retention = properties?.['AutomaticBackupReplicationRetentionPeriod'];
    const declared = properties?.['ProcessorFeatures'];
    return [
      ...instanceUnknown,
      ...(declared == null || (Array.isArray(declared) && declared.length === 0)
        ? ['ProcessorFeatures']
        : []),
      // Blank is unset, as the create and update read it (`backupReplicationOf`).
      ...(retention == null || retention === ''
        ? ['AutomaticBackupReplicationRetentionPeriod']
        : []),
    ];
  }
  if (resourceType !== 'AWS::RDS::DBCluster') return [];
  // go-to-k/cdkd#5639: keys `readCurrentState` never reads back, so a
  // baseline taken from the recorded `properties` (an import whose readback
  // failed) would compare them against nothing.
  const neverRead = [
    'EngineMode',
    'AvailabilityZones',
    'ClusterScalabilityType',
    'MasterUserAuthenticationType',
    // Not read back: a cluster a CDK `GlobalCluster` adopted through its
    // `SourceDBClusterIdentifier` is a member its template never names.
    'GlobalClusterIdentifier',
    // Write-only: a ModifyDBCluster input RDS applies to the instances.
    'DBInstanceParameterGroupName',
    // go-to-k/cdkd#5984: a CreateDBCluster input DescribeDBClusters has no member for.
    'WithExpressConfiguration',
  ];
  // An absent or empty bag records nothing to scope by: compare.
  if (properties === undefined || Object.keys(properties).length === 0) return neverRead;
  const scaling = properties?.['ServerlessV2ScalingConfiguration'] as
    | ServerlessV2ScalingProps
    | undefined;
  return scaling?.SecondsUntilAutoPause === undefined
    ? [...neverRead, 'ServerlessV2ScalingConfiguration.SecondsUntilAutoPause']
    : neverRead;
}

/**
 * go-to-k/cdkd#5639: a raw CFn template may spell the DBCluster booleans as
 * `'true'` / `'false'` and the retention period, backtrack window, storage
 * size and IOPS as numeric strings, while
 * `readCurrentState` answers a boolean and a number. On a baseline taken
 * from the recorded `properties` (no `observedProperties`) the two would
 * read as drift; both sides fold to the readback's type. Anything else is
 * left as it is.
 *
 * go-to-k/cdkd#5639 / #5640: on both types, `AssociatedRoles` folds a
 * repeated entry and an empty `FeatureName`, which AWS never holds
 * (`canonicalAssociatedRoles`).
 */
export function canonicalizeDriftProperties(
  this: RDSProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::RDS::DBCluster' && resourceType !== 'AWS::RDS::DBInstance') {
    return properties;
  }
  let out: Record<string, unknown> | undefined;
  const set = (key: string, value: unknown): void => {
    out ??= { ...properties };
    out[key] = value;
  };
  if (Array.isArray(properties['AssociatedRoles'])) {
    set('AssociatedRoles', canonicalAssociatedRoles(properties['AssociatedRoles']));
  }
  if (resourceType !== 'AWS::RDS::DBCluster') return out ?? properties;
  for (const key of CLUSTER_BOOLEAN_SCALARS) {
    const value = properties[key];
    if (value === 'true' || value === 'false') set(key, value === 'true');
  }
  for (const key of [
    'PerformanceInsightsRetentionPeriod',
    'BacktrackWindow',
    'AllocatedStorage',
    'Iops',
  ]) {
    const value = properties[key];
    if (typeof value === 'string') {
      const parsed = retentionPeriodValue(value);
      if (typeof parsed === 'number') set(key, parsed);
    }
  }
  return out ?? properties;
}

/**
 * go-to-k/cdkd#5640: a read replica's source. The readback is an ARN; a
 * record may hold a bare identifier or an ARN in another case. The two compare
 * as one source only when they name the same instance by (region, account,
 * name) (`sameReplicaSource`): the AWS side then takes the baseline's
 * spelling. A same-named instance in
 * another region or account stays a difference. Both bags by identity
 * otherwise.
 */
export async function canonicalizeDriftPair(
  this: RDSProvider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  if (resourceType === 'AWS::RDS::DBInstance') {
    aws = withDeclaredProcessorFeatures(baseline, aws);
  }
  const recorded = baseline['SourceDBInstanceIdentifier'];
  const live = aws['SourceDBInstanceIdentifier'];
  if (
    resourceType !== 'AWS::RDS::DBInstance' ||
    typeof recorded !== 'string' ||
    typeof live !== 'string' ||
    recorded === live
  ) {
    return { baseline, aws };
  }
  // A bare spelling resolves to this client's region. The account needs no
  // own scope: the readback is an ARN that carries it (`readCurrentState`
  // builds a same-region source from the replica's own ARN), so a record ARN
  // naming another account differs from it there.
  const region = await this.getClient().config.region();
  return sameReplicaSource(recorded, live, { region })
    ? { baseline, aws: { ...aws, SourceDBInstanceIdentifier: recorded } }
    : { baseline, aws };
}

/**
 * go-to-k/cdkd#5640: RDS lists every processor feature of the class, while a
 * template may declare only some (`threadsPerCore` alone): the live list keeps
 * the features the baseline names, so a declared value that differs still
 * reads as drift and an undeclared one never does. A baseline or live side
 * that is not a list of named entries is left as it is.
 */
function withDeclaredProcessorFeatures(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Record<string, unknown> {
  const declared = baseline['ProcessorFeatures'];
  const live = aws['ProcessorFeatures'];
  if (!Array.isArray(declared) || !Array.isArray(live)) return aws;
  const names = new Set<unknown>();
  for (const item of declared as unknown[]) {
    if (item === null || typeof item !== 'object') return aws;
    names.add((item as Record<string, unknown>)['Name']);
  }
  const kept = (live as unknown[]).filter(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      names.has((item as Record<string, unknown>)['Name'])
  );
  return kept.length === live.length ? aws : { ...aws, ProcessorFeatures: kept };
}

/** The post-update proof (#5380) compares through the same normalization. */
export function canonicalizeUnsettledProperties(
  this: RDSProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  return this.canonicalizeDriftProperties(resourceType, properties);
}
