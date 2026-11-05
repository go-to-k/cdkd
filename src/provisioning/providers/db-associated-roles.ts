import { isUsableAttemptedName } from '../../state/unsettled-properties.js';

/**
 * The `AssociatedRoles` plan the RDS-API providers share (`AWS::Neptune::DBCluster`,
 * `AWS::RDS::DBCluster`, `AWS::RDS::DBInstance`; go-to-k/cdkd#5639 / #5640).
 * One association is one role FOR one feature: AWS keys it on both, and the
 * Add* / Remove* calls name both.
 */

/** A `DBClusterRole` / `DBInstanceRole` entry of the template's `AssociatedRoles`. */
export interface AssociatedRole {
  RoleArn: string;
  FeatureName?: string;
}

/** What a Describe answers for one association. */
export interface LiveAssociatedRole {
  RoleArn?: string | undefined;
  FeatureName?: string | undefined;
}

/** One association's identity: the role AND the feature (an empty feature is none). */
export function associatedRoleKey(role: LiveAssociatedRole): string {
  return `${role.RoleArn ?? ''}\n${role.FeatureName ?? ''}`;
}

/**
 * `AssociatedRoles` as a list, or `undefined` when it is unusable: the gap
 * between the two sides is what gets DETACHED, so a malformed desired value
 * must never read as empty (`.claude/rules/provider-aws-response-reads.md`).
 * Absent or `null` is the empty list. A repeated entry collapses: AWS would
 * refuse the second attach as already there. `featureNameRequired` is the
 * DBInstance shape, whose schema requires the feature and whose
 * AddRoleToDBInstance cannot be sent without one.
 */
export function associatedRoleList(
  value: unknown,
  options?: { featureNameRequired?: boolean }
): AssociatedRole[] | undefined {
  if (value == null) return [];
  if (!Array.isArray(value)) return undefined;
  const roles = new Map<string, AssociatedRole>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const { RoleArn: roleArn, FeatureName: featureName } = entry as Record<string, unknown>;
    if (typeof roleArn !== 'string' || roleArn === '') return undefined;
    if (featureName != null && typeof featureName !== 'string') return undefined;
    if (options?.featureNameRequired === true && !featureName) return undefined;
    const role = { RoleArn: roleArn, ...(featureName ? { FeatureName: featureName } : {}) };
    roles.set(associatedRoleKey(role), role);
  }
  return [...roles.values()];
}

/**
 * The attaches and detaches taking `live` to `desired`: every desired
 * association AWS does not hold, and every `previous` one `desired` dropped
 * that AWS still holds. Planned against the live list so a retry after a
 * partial run neither re-attaches nor re-detaches (neither call is
 * idempotent: AWS refuses an attached role as already there and a detached
 * one as not found). An association cdkd never recorded is left alone.
 */
export function planAssociatedRoleChanges(
  desired: readonly AssociatedRole[],
  previous: readonly AssociatedRole[],
  live: readonly LiveAssociatedRole[]
): { toAdd: AssociatedRole[]; toRemove: AssociatedRole[] } {
  const liveKeys = new Set(live.map(associatedRoleKey));
  const desiredKeys = new Set(desired.map(associatedRoleKey));
  return {
    toAdd: desired.filter((role) => !liveKeys.has(associatedRoleKey(role))),
    toRemove: previous.filter((role) => {
      const key = associatedRoleKey(role);
      return !desiredKeys.has(key) && liveKeys.has(key);
    }),
  };
}

/**
 * A Describe's associations in the CFn shape (`Status` dropped, an empty
 * feature omitted). Always a list: a role lost out of band must read as a
 * change against the recorded list.
 */
export function associatedRolesReadback(
  live: readonly LiveAssociatedRole[] | undefined
): AssociatedRole[] {
  return (live ?? []).flatMap((role) =>
    role.RoleArn
      ? [{ RoleArn: role.RoleArn, ...(role.FeatureName ? { FeatureName: role.FeatureName } : {}) }]
      : []
  );
}

/**
 * go-to-k/cdkd#5487 / #5498: the live associations an unsettled
 * `AssociatedRoles` converges from, kept to those the record, the template or
 * an earlier attempt names. The convergence puts this on the previous side,
 * so a role an out-of-band change added would otherwise read as dropped by
 * the template, and be detached.
 */
export function associatedRolesNamed(
  live: unknown,
  recorded: unknown,
  desired: unknown,
  attempted: Iterable<string> | undefined
): AssociatedRole[] {
  const named = new Set([
    ...(associatedRoleList(recorded) ?? []).map(associatedRoleKey),
    ...(associatedRoleList(desired) ?? []).map(associatedRoleKey),
    ...[...(attempted ?? [])].filter(isUsableAttemptedName),
  ]);
  return (associatedRoleList(live) ?? []).filter((role) => named.has(associatedRoleKey(role)));
}

/**
 * What `getDriftUnorderedPaths` cannot see: AWS holds one association per
 * role and feature and no empty `FeatureName`, so a list with a repeated
 * entry or `FeatureName: ''` reads as the same list. A malformed value is
 * returned as it is.
 */
export function canonicalAssociatedRoles(value: unknown): unknown {
  return Array.isArray(value) ? (associatedRoleList(value) ?? value) : value;
}

/** The role ARNs of association keys, for a log line (the caller masks it). */
export function associatedRoleArns(keys: Iterable<string>): string {
  return [...keys].map((key) => key.split('\n')[0] ?? '').join(', ');
}

/**
 * Whether `error` is AWS refusing an Add* / Remove* role call because the
 * cluster or instance is busy: a cluster that read `available` can go back to
 * `modifying` a moment later (measured on Neptune, go-to-k/cdkd#2762). The
 * wording is these calls' own, so the shared not-`available` match does not
 * cover it. The class alone is not enough: anything else it carries stays
 * terminal. The instance-side wording is the cluster's by assumption, not
 * measured.
 */
export function isRoleCallNotAvailableRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'InvalidDBClusterStateFault' || error.name === 'InvalidDBInstanceStateFault') &&
    /is not available for IAM role association, disassociation, or updates/i.test(error.message)
  );
}
