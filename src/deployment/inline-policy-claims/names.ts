/**
 * The IAM name rules and resource-type tables every inline-policy claim
 * reader shares: the name charset and its case-insensitive compare, the
 * principal / standalone-policy type tables, and the match keys the
 * dispatch-time ordering reads. Split out of `inline-policy-claims.ts`
 * (go-to-k/cdkd#5835); that module re-exports the public names.
 */
import type { InlinePolicyClaimed, InlinePolicyPrincipalKind } from '../../types/resource.js';
import type { ResourceChange } from '../../types/state.js';

/**
 * Only a value in IAM's name charset matches: a mask or a redacted reference
 * names no principal or policy, even if the query spells it too. Names compare
 * case-insensitively, as IAM compares them on one principal.
 */
export function sameIamName(a: unknown, b: string): boolean {
  return typeof a === 'string' && IAM_NAME.test(a) && a.toLowerCase() === b.toLowerCase();
}

export function removalKey(
  kind: InlinePolicyPrincipalKind,
  principal: string,
  policyName: string
): string {
  return JSON.stringify([kind, principal.toLowerCase(), policyName.toLowerCase()]);
}

/** IAM's role / group / user / inline policy name charset. */
export const IAM_NAME = /^[\w+=,.@-]+$/;

export const POLICY_LIST_FIELDS: Record<InlinePolicyPrincipalKind, string> = {
  role: 'Roles',
  group: 'Groups',
  user: 'Users',
};

export const PRINCIPAL_KINDS: Record<string, InlinePolicyPrincipalKind> = {
  'AWS::IAM::Role': 'role',
  'AWS::IAM::Group': 'group',
  'AWS::IAM::User': 'user',
};

/**
 * go-to-k/cdkd#4821: the resource types that are ONE inline policy name on one
 * principal (no SDK provider: they go through Cloud Control).
 */
const STANDALONE_POLICY_KINDS: Record<string, InlinePolicyPrincipalKind> = {
  'AWS::IAM::RolePolicy': 'role',
  'AWS::IAM::GroupPolicy': 'group',
  'AWS::IAM::UserPolicy': 'user',
};

/** Whether `resourceType` is a standalone inline policy (`AWS::IAM::RolePolicy` ...). */
export function isStandaloneInlinePolicyType(resourceType: string): boolean {
  return Object.hasOwn(STANDALONE_POLICY_KINDS, resourceType);
}

/**
 * The principal and name a standalone inline policy record holds, read from
 * its properties, as recorded (unvalidated: a value that is not an IAM name
 * matches nothing). `undefined` for every other type.
 */
export function standaloneInlinePolicyOf(
  resourceType: string,
  properties: Readonly<Record<string, unknown>> | undefined
): { kind: InlinePolicyPrincipalKind; principal: unknown; policyName: unknown } | undefined {
  if (!isStandaloneInlinePolicyType(resourceType)) return undefined;
  const kind = STANDALONE_POLICY_KINDS[resourceType]!;
  const props = properties ?? {};
  return {
    kind,
    principal: props[PRINCIPAL_NAME_FIELDS[kind]],
    policyName: props['PolicyName'],
  };
}

/**
 * go-to-k/cdkd#4821: whether a delete of the standalone inline policy record
 * `properties` would remove a name ANOTHER completed writer of this deploy has
 * put on the same principal (`claimed`), so the delete must leave it. Any
 * doubt (no predicate, an unreadable name or principal, a `physicalId` that
 * is not Cloud Control's `<PolicyName>|<principal>` for them) answers
 * `false`: the delete proceeds.
 */
export function standaloneInlinePolicyHandedOff(
  resourceType: string,
  properties: Readonly<Record<string, unknown>> | undefined,
  claimed: InlinePolicyClaimed | undefined,
  physicalId?: string
): boolean {
  if (claimed === undefined) return false;
  const target = standaloneInlinePolicyOf(resourceType, properties);
  if (target === undefined) return false;
  const { kind, principal, policyName } = target;
  if (typeof principal !== 'string' || !IAM_NAME.test(principal)) return false;
  if (typeof policyName !== 'string' || !IAM_NAME.test(policyName)) return false;
  if (
    physicalId !== undefined &&
    physicalId.toLowerCase() !== `${policyName}|${principal}`.toLowerCase()
  ) {
    return false;
  }
  return claimed(kind, principal, policyName) === true;
}

/** Whether `resourceType` is a principal that holds inline `Policies`. */
export function isInlinePolicyPrincipalType(resourceType: string): boolean {
  return Object.hasOwn(PRINCIPAL_KINDS, resourceType);
}

export function principalKindOf(resourceType: string): InlinePolicyPrincipalKind | undefined {
  return Object.hasOwn(PRINCIPAL_KINDS, resourceType) ? PRINCIPAL_KINDS[resourceType] : undefined;
}

/** A principal or policy name this deploy cannot know before it resolves. */
export const ANY = '*';

export const PRINCIPAL_NAME_FIELDS: Record<InlinePolicyPrincipalKind, string> = {
  role: 'RoleName',
  group: 'GroupName',
  user: 'UserName',
};

/** An IAM name as a match key (lowercased), or {@link ANY} for anything else. */
export function nameKey(value: unknown): string {
  return typeof value === 'string' && IAM_NAME.test(value) ? value.toLowerCase() : ANY;
}

/** The names of a `Policies` list; a list that is not one may hold any. */
export function policiesNames(policies: unknown): string[] {
  if (policies === undefined || policies === null) return [];
  if (!Array.isArray(policies)) return [ANY];
  return policies.map((entry) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? nameKey((entry as Record<string, unknown>)['PolicyName'])
      : ANY
  );
}

/**
 * Whether this deploy's diff changed the principal's `Policies` itself — a
 * row the diff only PROPAGATED from another resource does not count.
 */
export function ownPoliciesChange(change: ResourceChange | undefined): boolean {
  return (change?.propertyChanges ?? []).some(
    (c) => c.path === 'Policies' && c.inPlacePropagated !== true && c.replacementPropagated !== true
  );
}
