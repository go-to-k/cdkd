/**
 * Where each type's deletion / termination protection flag lives in cdkd's
 * property bags, and which values count as ON. ONE table for both readers —
 * the destroy confirm prompt (`countProtectedResources` in
 * `src/cli/commands/destroy-runner.ts`) and the deploy engine's stateful
 * replacement refusals (`recorded-protection.ts`, issue
 * [#2610](https://github.com/go-to-k/cdkd/issues/2610)) — so a type cannot be
 * known to one and not the other. `remove-protection-types.test.ts` binds it
 * to every type `--remove-protection` covers.
 */
import { isTruthyCfnBoolean } from './data-delete-intent.js';
import { extractLocalDeletionProtection } from './providers/dynamodb-globaltable-provider.js';

/**
 * Where a type's protection flag lives in a resource's property bag: a
 * top-level key, a PATH of keys for a flag nested in a container, or a reader
 * for a flag that is not at a fixed path (go-to-k/cdkd#3676). A reader gets the
 * bag and the record's region.
 */
export type ProtectionLocator =
  | string
  | readonly string[]
  | ((bag: Record<string, unknown>, region: string | undefined) => unknown);

/**
 * The protection flag per type. `countProtectedResources` (`destroy-runner.ts`)
 * reads it the same way in `properties` and then `observedProperties`, and so
 * does {@link recordedProtectionEvidence} (`recorded-protection.ts`).
 */
export const PROTECTION_PROPERTY_BY_TYPE: Record<string, ProtectionLocator> = {
  'AWS::Logs::LogGroup': 'DeletionProtectionEnabled',
  'AWS::RDS::DBInstance': 'DeletionProtection',
  'AWS::RDS::DBCluster': 'DeletionProtection',
  // DocDB: cluster-level only. The DocDB DBInstance shape does NOT
  // expose a DeletionProtection field (verified against the
  // @aws-sdk/client-docdb CreateDBInstanceMessage type — the field is
  // absent), so there is nothing to flip on destroy of an instance.
  'AWS::DocDB::DBCluster': 'DeletionProtection',
  // Neptune: both cluster and instance expose DeletionProtection.
  'AWS::Neptune::DBCluster': 'DeletionProtection',
  'AWS::Neptune::DBInstance': 'DeletionProtection',
  'AWS::DynamoDB::Table': 'DeletionProtectionEnabled',
  // CFn and CDK put the flag on the local replica
  // (`Replicas[?Region==<region>].DeletionProtectionEnabled`); the provider's
  // `readCurrentState` writes it top-level. `extractLocalDeletionProtection`
  // reads the replica first and the top-level key second, as `create()` does.
  'AWS::DynamoDB::GlobalTable': (bag, region) => extractLocalDeletionProtection(bag, region ?? ''),
  'AWS::EC2::Instance': 'DisableApiTermination',
  'AWS::Cognito::UserPool': 'DeletionProtection',
  'AWS::AutoScaling::AutoScalingGroup': 'DeletionProtection',
  // The flag is one entry of the `LoadBalancerAttributes` key/value list, its
  // value the string `'true'` / `'false'`.
  'AWS::ElasticLoadBalancingV2::LoadBalancer': (bag) => {
    const attrs = bag['LoadBalancerAttributes'];
    if (!Array.isArray(attrs)) return undefined;
    const entry: unknown = attrs.find(
      (a: unknown) =>
        typeof a === 'object' &&
        a !== null &&
        (a as { Key?: unknown }).Key === 'deletion_protection.enabled'
    );
    return (entry as { Value?: unknown } | undefined)?.Value;
  },
  // EMR's termination protection sits inside the `Instances` block, in the
  // template and in the provider's `readCurrentState` bag alike.
  'AWS::EMR::Cluster': ['Instances', 'TerminationProtected'],
  // CC-routed generic protection flip (issues #1312 / #1314) — see
  // src/provisioning/cc-protection-properties.ts.
  'AWS::DSQL::Cluster': 'DeletionProtectionEnabled',
  'AWS::NeptuneGraph::Graph': 'DeletionProtection',
  'AWS::SMSVOICE::ProtectConfiguration': 'DeletionProtectionEnabled',
  'AWS::VerifiedPermissions::PolicyStore': 'DeletionProtection',
  'AWS::EKS::Cluster': 'DeletionProtection',
  'AWS::RDS::GlobalCluster': 'DeletionProtection',
  'AWS::DocDB::GlobalCluster': 'DeletionProtection',
};

/**
 * For string-valued protection enums, the set of values that count as
 * "currently protected" (Cognito UserPool's `'ACTIVE' | 'INACTIVE'`, an Auto
 * Scaling group's `'none' | 'prevent-force-deletion' | 'prevent-all-deletion'`).
 * Types absent from this map use the default (boolean `true`). The destroy
 * prompt's count is informational: each provider's `delete()` flips protection
 * off unconditionally under `--remove-protection`.
 */
export const PROTECTION_ACTIVE_VALUES_BY_TYPE: Record<string, ReadonlySet<unknown>> = {
  'AWS::Cognito::UserPool': new Set(['ACTIVE']),
  'AWS::AutoScaling::AutoScalingGroup': new Set(['prevent-force-deletion', 'prevent-all-deletion']),
};

/**
 * For object-shaped protection properties, a predicate deciding whether the
 * recorded value counts as "currently protected". Checked before the
 * enum-set / boolean defaults. VerifiedPermissions PolicyStore's
 * `DeletionProtection` is `{Mode: 'ENABLED' | 'DISABLED'}` (issue #1314).
 */
export const PROTECTION_ACTIVE_PREDICATE_BY_TYPE: Record<string, (value: unknown) => boolean> = {
  'AWS::VerifiedPermissions::PolicyStore': (value) =>
    typeof value === 'object' && value !== null && (value as { Mode?: unknown }).Mode === 'ENABLED',
};

/**
 * The flag's recorded value in `bag`. A missing or torn container on the way
 * (`null`, a string, a list) yields `undefined`, which leaves the count to the
 * other bag rather than throwing mid-prompt.
 */
export function readProtection(
  bag: unknown,
  locator: ProtectionLocator,
  region: string | undefined
): unknown {
  if (typeof locator === 'function') {
    if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) return undefined;
    return locator(bag as Record<string, unknown>, region);
  }
  let value: unknown = bag;
  for (const key of typeof locator === 'string' ? [locator] : locator) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * An OWN entry of one of the per-type maps. A plain-object map answers a
 * `resourceType` of `constructor` or `__proto__` with an inherited value, and a
 * hand-edited record can carry one.
 */
export function perType<T>(map: Record<string, T>, resourceType: unknown): T | undefined {
  return typeof resourceType === 'string' && Object.hasOwn(map, resourceType)
    ? map[resourceType]
    : undefined;
}

/**
 * Whether a value read through a type's locator counts as protection ON: the
 * type's predicate, else its enum set, else a CFn boolean — `'true'` too, since
 * a String parameter or an `Fn::If` resolves a CFn boolean to a string and the
 * providers flip it all the same.
 */
export function isProtectionValueActive(resourceType: string, value: unknown): boolean {
  const activePredicate = perType(PROTECTION_ACTIVE_PREDICATE_BY_TYPE, resourceType);
  if (activePredicate) return activePredicate(value);
  const activeValues = perType(PROTECTION_ACTIVE_VALUES_BY_TYPE, resourceType);
  if (activeValues) return activeValues.has(value);
  return isTruthyCfnBoolean(value);
}
