/**
 * go-to-k/cdkd#6610: the revert re-add for the pairs the two older helpers
 * handle (`iam-sibling-managed-policies.ts`, `sg-sibling-rules.ts`), which
 * strip a sibling's members from the revert's desired bag but never put the
 * live ones back. Their SDK providers' readbacks filter those members, so the
 * previous side lacks them too and nothing is removed. A Cloud Control
 * readback filters nothing: there the previous side holds the sibling's
 * member, and a desired list without it would make the update REMOVE it.
 *
 * So each live member the helper's own ownership test assigns to a sibling
 * goes back into the desired list, after its nearest earlier live neighbour
 * that list holds. On the SDK route the readback holds none, and this returns
 * the bag by identity.
 */
import type { ReadCurrentStateContext } from '../../types/resource.js';
import {
  collectGroupsAddedBySiblings,
  collectManagedPolicyArnsAttachedBySiblings,
  collectPrincipalsAttachingPolicy,
  managedPolicyAttachmentField,
} from '../iam-sibling-managed-policies.js';
import { sgRuleOwnershipIdentity, siblingOwnedSgRuleIdentities } from '../sg-sibling-rules.js';

/** One helper-owned list: its key, a member's key, and which keys a sibling owns. */
interface OwnedList {
  key: string;
  keyOf: (member: unknown) => string | undefined;
  owned: ReadonlySet<string>;
}

const asString = (m: unknown): string | undefined => (typeof m === 'string' ? m : undefined);
const folded = (m: unknown): string | undefined =>
  typeof m === 'string' ? m.toLowerCase() : undefined;

/** The helper-owned lists of one resource, each with the members a sibling owns minus the ones its template declares. */
function helperOwnedLists(
  resourceType: string,
  physicalId: string,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): OwnedList[] {
  const declared = (key: string, keyOf: (m: unknown) => string | undefined): Set<string> => {
    const list = properties?.[key];
    const out = new Set<string>();
    if (Array.isArray(list)) {
      for (const m of list) {
        const k = keyOf(m);
        if (k !== undefined) out.add(k);
      }
    }
    return out;
  };
  const list = (
    key: string,
    keyOf: (m: unknown) => string | undefined,
    members: Iterable<string>
  ): OwnedList => {
    const own = declared(key, keyOf);
    const owned = new Set<string>();
    for (const m of members) {
      const k = keyOf(m);
      if (k !== undefined && !own.has(k)) owned.add(k);
    }
    return { key, keyOf, owned };
  };
  const out: OwnedList[] = [];
  const field = managedPolicyAttachmentField(resourceType);
  if (field !== undefined) {
    out.push(
      list(
        'ManagedPolicyArns',
        asString,
        collectManagedPolicyArnsAttachedBySiblings(physicalId, context, field)
      )
    );
  }
  if (resourceType === 'AWS::IAM::User') {
    out.push(list('Groups', folded, collectGroupsAddedBySiblings(physicalId, context)));
  }
  if (resourceType === 'AWS::IAM::ManagedPolicy') {
    for (const key of ['Roles', 'Users', 'Groups'] as const) {
      out.push(list(key, asString, collectPrincipalsAttachingPolicy(physicalId, context, key)));
    }
  }
  if (resourceType === 'AWS::EC2::SecurityGroup') {
    for (const [key, direction] of [
      ['SecurityGroupIngress', 'ingress'],
      ['SecurityGroupEgress', 'egress'],
    ] as const) {
      // Already minus the rules the group's own template declares.
      out.push({
        key,
        keyOf: (m) => sgRuleOwnershipIdentity(m, direction),
        owned: siblingOwnedSgRuleIdentities(physicalId, direction, properties, context),
      });
    }
  }
  return out.filter((l) => l.owned.size > 0);
}

/**
 * `desired` with each LIVE member of `aws` that a helper assigns to a sibling
 * put back into its list (see the module comment). Returned by identity when
 * nothing is added.
 */
export function withLiveHelperOwnedMembers(
  resourceType: string,
  physicalId: string | undefined,
  desired: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): Record<string, unknown> {
  if (typeof physicalId !== 'string' || physicalId === '') return desired;
  let out = desired;
  for (const { key, keyOf, owned } of helperOwnedLists(
    resourceType,
    physicalId,
    properties,
    context
  )) {
    const kept = out[key];
    const live = aws[key];
    if (!Array.isArray(kept) || !Array.isArray(live)) continue;
    const anyKey = (m: unknown): string => keyOf(m) ?? JSON.stringify(m) ?? '';
    const present = new Set(kept.map(anyKey));
    const result = [...kept];
    live.forEach((m, index) => {
      const k = keyOf(m);
      if (k === undefined || !owned.has(k) || present.has(k)) return;
      let at = 0;
      for (let j = index - 1; j >= 0; j--) {
        const pos = result.findIndex((r) => anyKey(r) === anyKey(live[j]));
        if (pos >= 0) {
          at = pos + 1;
          break;
        }
      }
      result.splice(at, 0, m);
      present.add(k);
    });
    if (result.length !== kept.length) out = { ...out, [key]: result };
  }
  return out;
}
