/**
 * go-to-k/cdkd#4156: the claim predicate itself. Split out of
 * `inline-policy-claims.ts` (go-to-k/cdkd#5835), which re-exports it.
 */
import type { InlinePolicyPrincipalKind } from '../../types/resource.js';
import type { ResourceChange, ResourceState } from '../../types/state.js';
import {
  POLICY_LIST_FIELDS,
  PRINCIPAL_KINDS,
  ownPoliciesChange,
  sameIamName,
  standaloneInlinePolicyOf,
} from './names.js';

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
 * - An `AWS::IAM::RolePolicy` / `UserPolicy` / `GroupPolicy` writer claims its
 *   recorded `PolicyName` on its recorded `RoleName` / `UserName` /
 *   `GroupName`, whichever route wrote it (go-to-k/cdkd#4821).
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
  for (const [lid, write] of writers) {
    if (lid === selfLogicalId || !Object.hasOwn(stateResources, lid)) continue;
    const record = stateResources[lid]!;
    // go-to-k/cdkd#4821: a standalone inline policy resource IS one name on
    // one principal, so a completed create or update of it (whatever its
    // route) left that name there, holding its recorded document.
    const standalone = standaloneInlinePolicyOf(record.resourceType, record.properties);
    if (standalone !== undefined) {
      if (
        standalone.kind === kind &&
        sameIamName(standalone.principal, principal) &&
        sameIamName(standalone.policyName, policyName)
      ) {
        return true;
      }
      continue;
    }
    // Only the SDK providers are known to put every name and entry they
    // record; a Cloud Control write is not confirmed to (an unchanged entry
    // may not be re-put), so it claims nothing.
    if (record.provisionedBy === 'cc-api') continue;
    const props = record.properties ?? {};
    if (record.resourceType === 'AWS::IAM::Policy') {
      if (!sameIamName(record.physicalId, policyName)) continue;
      const listed = props[POLICY_LIST_FIELDS[kind]];
      if (Array.isArray(listed) && listed.some((p) => sameIamName(p, principal))) return true;
      continue;
    }
    if (!Object.hasOwn(PRINCIPAL_KINDS, record.resourceType)) continue;
    if (PRINCIPAL_KINDS[record.resourceType] !== kind) continue;
    if (!sameIamName(record.physicalId, principal)) continue;
    if (write !== 'create' && !ownPoliciesChange(changes.get(lid))) continue;
    const policies = props['Policies'];
    if (!Array.isArray(policies)) continue;
    const declares = policies.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        sameIamName((entry as Record<string, unknown>)['PolicyName'], policyName)
    );
    if (declares) return true;
  }
  return false;
}
