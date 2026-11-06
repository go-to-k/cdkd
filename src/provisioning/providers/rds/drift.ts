import { canonicalAssociatedRoles } from '../db-associated-roles.js';
import type { RDSProvider } from '../rds-provider.js';
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
  return resourceType === 'AWS::RDS::DBCluster' || resourceType === 'AWS::RDS::DBInstance'
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
 * so DescribeDBInstances never returns them.
 */
export function getDriftUnknownPaths(
  this: RDSProvider,
  resourceType: string,
  properties?: Record<string, unknown>
): string[] {
  if (resourceType === 'AWS::RDS::DBInstance') {
    return ['AllowMajorVersionUpgrade', 'CertificateRotationRestart'];
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
 * `'true'` / `'false'` and the retention period as a numeric string, while
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
  for (const key of ['PerformanceInsightsRetentionPeriod', 'BacktrackWindow']) {
    const value = properties[key];
    if (typeof value === 'string') {
      const parsed = retentionPeriodValue(value);
      if (typeof parsed === 'number') set(key, parsed);
    }
  }
  return out ?? properties;
}

/** The post-update proof (#5380) compares through the same normalization. */
export function canonicalizeUnsettledProperties(
  this: RDSProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  return this.canonicalizeDriftProperties(resourceType, properties);
}
