/**
 * go-to-k/cdkd#6324: managed policies that a SIBLING `AWS::IAM::ManagedPolicy`
 * attaches to an IAM principal through its own `Roles` / `Users` / `Groups`
 * list, the managed-policy analogue of the inline-policy filter
 * (`collectInlinePolicyNamesManagedBySiblings`, #323 / go-to-k/cdkd#4821).
 *
 * CDK's `new iam.ManagedPolicy(s, 'Mp', { roles: [role] })` attaches the policy
 * from the POLICY side (`AttachRolePolicy`), so `ListAttachedRolePolicies` on
 * the role reports its ARN while the role's own template never declares it.
 * Compared as the role's `ManagedPolicyArns`, that ARN read as drift on every
 * fresh stack, and `cdkd drift --revert` detached it (the role's `update()`
 * detaches what the previous side holds and the desired side lacks).
 *
 * The ARN is excluded from the principal's `ManagedPolicyArns` on BOTH drift
 * sides: the readback drops it (`readCurrentState`), and
 * {@link stripSiblingOwnedMembers} drops it from the recorded baseline
 * too, so a baseline captured after the sibling's attach (a race at the
 * principal's CREATE capture, a later UPDATE capture, or a record written
 * before this fix) compares clean without a redeploy. An ARN the principal's
 * OWN template also declares stays compared: the principal then owns it as
 * well, and a detach of it is real drift on the principal.
 *
 * The sibling's ARN is its state record's physicalId, so a sibling with no
 * recorded physicalId (not created yet) excludes nothing.
 */
import type { ReadCurrentStateContext } from '../types/resource.js';

/** The `AWS::IAM::ManagedPolicy` list that names a principal of each type. */
const ATTACHMENT_FIELD: Readonly<Record<string, 'Roles' | 'Users' | 'Groups'>> = {
  'AWS::IAM::Role': 'Roles',
  'AWS::IAM::User': 'Users',
  'AWS::IAM::Group': 'Groups',
};

/**
 * The `AWS::IAM::ManagedPolicy` field listing principals of `resourceType`, or
 * `undefined` for a type a managed policy does not attach to.
 */
export function managedPolicyAttachmentField(
  resourceType: string
): 'Roles' | 'Users' | 'Groups' | undefined {
  return ATTACHMENT_FIELD[resourceType];
}

/**
 * The ARNs of every sibling `AWS::IAM::ManagedPolicy` whose `attachmentField`
 * list names `targetPhysicalId`. Empty without a context.
 */
export function collectManagedPolicyArnsAttachedBySiblings(
  targetPhysicalId: string,
  context: ReadCurrentStateContext | undefined,
  attachmentField: 'Roles' | 'Users' | 'Groups'
): Set<string> {
  const result = new Set<string>();
  for (const sibling of Object.values(context?.siblings ?? {})) {
    if (sibling.resourceType !== 'AWS::IAM::ManagedPolicy') continue;
    const arn = sibling.physicalId;
    if (typeof arn !== 'string' || arn === '') continue;
    const attachments = sibling.properties[attachmentField];
    if (!Array.isArray(attachments)) continue;
    if (attachments.some((a) => a === targetPhysicalId)) result.add(arn);
  }
  return result;
}

/**
 * `arns` without the sibling-attached ones the principal's own `properties`
 * (its template) do not declare in `ManagedPolicyArns`. Order is kept.
 */
export function withoutSiblingAttachedArns(
  arns: readonly string[],
  siblingArns: ReadonlySet<string>,
  properties: Record<string, unknown> | undefined
): string[] {
  return withoutSiblingOwned(arns, siblingArns, properties, 'ManagedPolicyArns');
}

/**
 * `members` without the `owned` ones the resource's own `properties` (its
 * template) do not declare under `key`. Order is kept. `foldCase` compares
 * case-insensitively: the `UserToGroupAddition` group match passes it, since a
 * hand-written `GroupName` need not spell the group the way AWS returns it.
 */
export function withoutSiblingOwned(
  members: readonly string[],
  owned: ReadonlySet<string>,
  properties: Record<string, unknown> | undefined,
  key: string,
  foldCase = false
): string[] {
  if (owned.size === 0) return [...members];
  const declared = properties?.[key];
  const own = new Set(Array.isArray(declared) ? declared : []);
  if (!foldCase) return members.filter((m) => !owned.has(m) || own.has(m));
  const fold = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v);
  const ownedFolded = new Set([...owned].map(fold));
  const ownFolded = new Set([...own].map(fold));
  return members.filter((m) => !ownedFolded.has(fold(m)) || ownFolded.has(fold(m)));
}

/**
 * go-to-k/cdkd#6328: the groups a sibling `AWS::IAM::UserToGroupAddition` adds
 * `userName` to (its `GroupName`, when its `Users` names the user). AWS reports
 * them in `ListGroupsForUser`, but that resource owns the membership.
 */
export function collectGroupsAddedBySiblings(
  userName: string,
  context: ReadCurrentStateContext | undefined
): Set<string> {
  const result = new Set<string>();
  for (const sibling of Object.values(context?.siblings ?? {})) {
    if (sibling.resourceType !== 'AWS::IAM::UserToGroupAddition') continue;
    const group = sibling.properties['GroupName'];
    const users = sibling.properties['Users'];
    if (typeof group !== 'string' || group === '' || !Array.isArray(users)) continue;
    // IAM user names are case-insensitive (`user-to-group-addition.ts`).
    const name = userName.toLowerCase();
    if (users.some((u) => typeof u === 'string' && u.toLowerCase() === name)) result.add(group);
  }
  return result;
}

/** The principal type each `AWS::IAM::ManagedPolicy` list names. */
const PRINCIPAL_TYPE: Readonly<Record<'Roles' | 'Users' | 'Groups', string>> = {
  Roles: 'AWS::IAM::Role',
  Users: 'AWS::IAM::User',
  Groups: 'AWS::IAM::Group',
};

/**
 * go-to-k/cdkd#6328, the mirror of {@link collectManagedPolicyArnsAttachedBySiblings}:
 * the names (physical ids) of every sibling principal of `field`'s type whose
 * own `ManagedPolicyArns` attaches `policyArn` (`role.addManagedPolicy(mp)`).
 * `ListEntitiesForPolicy` reports them on the policy, but the principal owns
 * the attachment.
 */
export function collectPrincipalsAttachingPolicy(
  policyArn: string,
  context: ReadCurrentStateContext | undefined,
  field: 'Roles' | 'Users' | 'Groups'
): Set<string> {
  const result = new Set<string>();
  for (const sibling of Object.values(context?.siblings ?? {})) {
    if (sibling.resourceType !== PRINCIPAL_TYPE[field]) continue;
    const name = sibling.physicalId;
    const arns = sibling.properties['ManagedPolicyArns'];
    if (typeof name !== 'string' || name === '' || !Array.isArray(arns)) continue;
    if (arns.some((a) => a === policyArn)) result.add(name);
  }
  return result;
}

/** The bag's `key` when it is a list of strings, else `undefined`. */
function stringsAt(bag: Record<string, unknown>, key: string): string[] | undefined {
  const value = bag[key];
  return Array.isArray(value) && value.every((v): v is string => typeof v === 'string')
    ? value
    : undefined;
}

/** For one resource, each list key and the members of it a sibling owns. */
function siblingOwnedMembers(
  resourceType: string,
  physicalId: string,
  context: ReadCurrentStateContext | undefined
): Array<[string, Set<string>, boolean]> {
  const out: Array<[string, Set<string>, boolean]> = [];
  const field = managedPolicyAttachmentField(resourceType);
  if (field !== undefined) {
    out.push([
      'ManagedPolicyArns',
      collectManagedPolicyArnsAttachedBySiblings(physicalId, context, field),
      false,
    ]);
  }
  if (resourceType === 'AWS::IAM::User') {
    out.push(['Groups', collectGroupsAddedBySiblings(physicalId, context), true]);
  }
  if (resourceType === 'AWS::IAM::ManagedPolicy') {
    for (const key of ['Roles', 'Users', 'Groups'] as const) {
      out.push([key, collectPrincipalsAttachingPolicy(physicalId, context, key), false]);
    }
  }
  return out.filter(([, owned]) => owned.size > 0);
}

/**
 * The drift-pair half: drop, in both bags, the list members a SIBLING owns
 * (go-to-k/cdkd#6324, #6328):
 *  - an IAM role / user / group's `ManagedPolicyArns`: a sibling
 *    `AWS::IAM::ManagedPolicy` attaching itself through its own list;
 *  - a user's `Groups`: a sibling `AWS::IAM::UserToGroupAddition`;
 *  - a managed policy's `Roles` / `Users` / `Groups`: a sibling principal
 *    attaching it through its own `ManagedPolicyArns`.
 * A member the resource's own template also declares stays compared.
 * Non-mutating; each bag is returned by identity when it has nothing to drop.
 *
 * Dropping from the BASELINE is safe for `drift --revert`, which sends this
 * baseline as the desired side against the raw readback: the readback has
 * dropped the same members, so `update()` sees them on neither side and
 * neither removes nor re-adds them.
 */
export function stripSiblingOwnedMembers(
  resourceType: string,
  physicalId: string | undefined,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): { baseline: Record<string, unknown>; aws: Record<string, unknown> } {
  if (physicalId === undefined) return { baseline, aws };
  const owned = siblingOwnedMembers(resourceType, physicalId, context);
  if (owned.length === 0) return { baseline, aws };
  const strip = (bag: Record<string, unknown>): Record<string, unknown> => {
    let out = bag;
    for (const [key, members, foldCase] of owned) {
      const list = stringsAt(bag, key);
      if (list === undefined) continue;
      const kept = withoutSiblingOwned(list, members, properties, key, foldCase);
      if (kept.length !== list.length) out = { ...out, [key]: kept };
    }
    return out;
  };
  return { baseline: strip(baseline), aws: strip(aws) };
}
