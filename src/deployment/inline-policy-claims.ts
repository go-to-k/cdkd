import type { InlinePolicyPrincipalKind } from '../types/resource.js';
import type { ResourceChange, ResourceState } from '../types/state.js';

/**
 * How a resource's completed provider call in this deploy wrote its inline
 * policies: `'create'` (a create, or the create of a replacement) puts every
 * one it declares; `'update'` puts what its provider's update puts.
 */
export type InlinePolicyWrite = 'create' | 'update';

/**
 * go-to-k/cdkd#4156: whether ANOTHER resource of this deploy has ALREADY
 * written the inline policy `policyName` onto `principal` — so removing that
 * name from it would strip that resource's live grant.
 *
 * An `AWS::IAM::Policy` update or delete removes its OLD name from principals.
 * When another resource hands that name onto the same principal in the same
 * deploy (a swap of two policies' names, a rename away from a name a new policy
 * takes, a delete beside a create of the same name), the removal used to strip
 * the other resource's grant, and the next deploy saw no diff.
 *
 * Evaluated LIVE, at the moment of each removal, from what each other resource
 * RECORDED after its provider call completed in this deploy (`writers`), never
 * from the template: a value resolved ahead of the write (a custom resource's
 * `Data`, a `GetAtt` of a resource this deploy updates, a nested stack's
 * output) can differ from what is written, and a claimant that has not run,
 * is still running, or failed has put nothing. Any such case answers `false`,
 * so the removal proceeds; a claimant that runs later puts the name back. A
 * wrong `true` would be FAIL-OPEN — the removed policy's OLD document would
 * stay attached under that name, owned by no record — so every doubt answers
 * `false`: a value that is not a string in IAM's name charset (a mask or a
 * redacted secret-derived reference included) matches nothing.
 *
 * - An `AWS::IAM::Policy` writer claims the name it RECORDED as its physical id
 *   (what its create / update returned) on each principal its recorded
 *   `Roles` / `Groups` / `Users` lists.
 * - An `AWS::IAM::Role` / `Group` / `User` writer claims each recorded
 *   `Policies[].PolicyName` on its recorded physical id — only when the write
 *   put them: a create, or an update whose own diff changed `Policies`.
 *
 * Names compare case-insensitively, as IAM compares them on one principal.
 */
export function isInlinePolicyClaimedByCompletedWriter(
  args: {
    /** The resource removing the name; it never claims against itself. */
    selfLogicalId: string;
    /** The resources whose provider write COMPLETED in this deploy. */
    writers: ReadonlyMap<string, InlinePolicyWrite>;
    changes: ReadonlyMap<string, ResourceChange>;
    /** This deploy's live state bag: each writer's record as it wrote it. */
    stateResources: Record<string, ResourceState>;
  },
  kind: InlinePolicyPrincipalKind,
  principal: string,
  policyName: string
): boolean {
  const { selfLogicalId, writers, changes, stateResources } = args;
  // Only a value in IAM's name charset matches: a mask or a redacted
  // reference names no principal or policy, even if the query spells it too.
  const same = (a: unknown, b: string): boolean =>
    typeof a === 'string' && IAM_NAME.test(a) && a.toLowerCase() === b.toLowerCase();
  for (const [lid, write] of writers) {
    if (lid === selfLogicalId || !Object.hasOwn(stateResources, lid)) continue;
    const record = stateResources[lid]!;
    // Only the SDK providers are known to put every name and entry they
    // record; a Cloud Control write is not confirmed to (an unchanged entry
    // may not be re-put), so it claims nothing.
    if (record.provisionedBy === 'cc-api') continue;
    const props = record.properties ?? {};
    if (record.resourceType === 'AWS::IAM::Policy') {
      if (!same(record.physicalId, policyName)) continue;
      const listed = props[POLICY_LIST_FIELDS[kind]];
      if (Array.isArray(listed) && listed.some((p) => same(p, principal))) return true;
      continue;
    }
    if (!Object.hasOwn(PRINCIPAL_KINDS, record.resourceType)) continue;
    if (PRINCIPAL_KINDS[record.resourceType] !== kind) continue;
    if (!same(record.physicalId, principal)) continue;
    if (write !== 'create' && !ownPoliciesChange(changes.get(lid))) continue;
    const policies = props['Policies'];
    if (!Array.isArray(policies)) continue;
    const declares = policies.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        same((entry as Record<string, unknown>)['PolicyName'], policyName)
    );
    if (declares) return true;
  }
  return false;
}

/** IAM's role / group / user / inline policy name charset. */
const IAM_NAME = /^[\w+=,.@-]+$/;

const POLICY_LIST_FIELDS: Record<InlinePolicyPrincipalKind, string> = {
  role: 'Roles',
  group: 'Groups',
  user: 'Users',
};

const PRINCIPAL_KINDS: Record<string, InlinePolicyPrincipalKind> = {
  'AWS::IAM::Role': 'role',
  'AWS::IAM::Group': 'group',
  'AWS::IAM::User': 'user',
};

/**
 * Whether this deploy's diff changed the principal's `Policies` itself — a
 * row the diff only PROPAGATED from another resource does not count.
 */
function ownPoliciesChange(change: ResourceChange | undefined): boolean {
  return (change?.propertyChanges ?? []).some(
    (c) => c.path === 'Policies' && c.inPlacePropagated !== true && c.replacementPropagated !== true
  );
}
