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
import { injectiveKey } from '../state/record-keys.js';
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

/** A list key of one record and the members to drop from its baseline. */
export interface StoppedSiblingMembers {
  key: string;
  members: Set<string>;
  foldCase: boolean;
}

/** The minimal record shape {@link membersSiblingsStoppedWriting} reads. */
interface WriterRecord {
  resourceType: string;
  physicalId?: string;
  properties?: Record<string, unknown>;
  deletionPolicy?: string | undefined;
  updateReplacePolicy?: string | undefined;
}

const RETAINS: ReadonlySet<unknown> = new Set(['Retain', 'RetainExceptOnCreate']);

/**
 * Whether the AWS resource behind `previous[logicalId]` may still exist after
 * the deploy, so it may still write what its record lists: a DELETE under a
 * retaining `DeletionPolicy` drops the record without a provider call, and a
 * replacement under a retaining `UpdateReplacePolicy`, or whose old-resource
 * delete was deferred, skipped or not confirmed (`oldMaySurvive`), leaves the
 * old physical resource attached.
 */
function previousMaySurvive(
  logicalId: string,
  record: WriterRecord,
  next: Readonly<Record<string, WriterRecord>>,
  oldMaySurvive: (logicalId: string) => boolean,
  templatePolicies: TemplatePolicies | undefined
): boolean {
  // A record lacking a policy (written before state schema v5) falls back to
  // the template's, as `delete.ts` does, reading the same Condition-filtered
  // template: a removed resource has no definition there, so the fallback
  // only reaches a resource the template still defines (a replacement).
  const policies = templatePolicies?.(logicalId);
  const now = next[logicalId];
  if (now === undefined) {
    return RETAINS.has(record.deletionPolicy ?? policies?.deletionPolicy);
  }
  if (now.physicalId === record.physicalId) return false;
  return (
    RETAINS.has(record.updateReplacePolicy ?? policies?.updateReplacePolicy) ||
    oldMaySurvive(logicalId)
  );
}

/** The template's `DeletionPolicy` / `UpdateReplacePolicy` for a logical id. */
export type TemplatePolicies = (
  logicalId: string
) => { deletionPolicy?: unknown; updateReplacePolicy?: unknown } | undefined;

/**
 * A stored expression or mask (`{{resolve:...}}`, `***`) rather than a name:
 * `previous` holds the PERSISTED form and `next` the in-memory plaintext, so a
 * member or target spelled this way cannot be compared across the two.
 */
function isStoredExpression(value: string): boolean {
  return value.includes('{{resolve:') || value.includes('***');
}

/**
 * Every member `record` writes onto ANOTHER stack resource's list, as
 * `[targetType, targetId, key, member, foldCase]`: a managed policy's ARN onto
 * each principal its `Roles` / `Users` / `Groups` names, a principal's name
 * onto each policy its `ManagedPolicyArns` names, and a
 * `UserToGroupAddition`'s group onto each user its `Users` names (folded:
 * IAM user and group names are case-insensitive).
 */
function siblingWritesOf(record: WriterRecord): Array<[string, string, string, string, boolean]> {
  const out: Array<[string, string, string, string, boolean]> = [];
  const props = record.properties ?? {};
  const id = record.physicalId;
  if (record.resourceType === 'AWS::IAM::ManagedPolicy' && typeof id === 'string' && id !== '') {
    for (const field of ['Roles', 'Users', 'Groups'] as const) {
      for (const name of stringsAt(props, field) ?? []) {
        out.push([PRINCIPAL_TYPE[field], name, 'ManagedPolicyArns', id, false]);
      }
    }
  }
  const field = managedPolicyAttachmentField(record.resourceType);
  if (field !== undefined && typeof id === 'string' && id !== '') {
    for (const arn of stringsAt(props, 'ManagedPolicyArns') ?? []) {
      out.push(['AWS::IAM::ManagedPolicy', arn, field, id, false]);
    }
  }
  if (record.resourceType === 'AWS::IAM::UserToGroupAddition') {
    const group = props['GroupName'];
    if (typeof group === 'string' && group !== '') {
      for (const user of stringsAt(props, 'Users') ?? []) {
        out.push(['AWS::IAM::User', user.toLowerCase(), 'Groups', group.toLowerCase(), true]);
      }
    }
  }
  return out.filter(
    ([, target, , member]) => !isStoredExpression(target) && !isStoredExpression(member)
  );
}

/**
 * go-to-k/cdkd#6343: per logical id of `next`, the list members a SIBLING
 * wrote onto that resource before this deploy (`previous`) and no longer
 * writes after it: a managed policy that dropped the principal or was
 * replaced (a new ARN) or deleted, a principal that dropped the policy from
 * its `ManagedPolicyArns` or was deleted, a `UserToGroupAddition` that dropped
 * the user. The deploy's own provider call has just removed each of these from
 * AWS (a detach, a `RemoveUserFromGroup`, a delete), so a drift baseline still
 * holding one (a capture that raced the sibling's write, or one taken before
 * go-to-k/cdkd#6324 / #6328) records a member the stack stopped writing:
 * `cdkd drift` would report it lost and `--revert` would re-add it.
 *
 * The evidence is the sibling's own RECORDED write, never the readback, so a
 * member detached out of band and `--accept`ed is not touched: no sibling's
 * record changed for it. A sibling whose previous AWS resource may survive the
 * deploy (`previousMaySurvive`: retained, or a replaced old resource not
 * confirmed gone) stopped nothing. A member the target's own template declares
 * is kept by {@link withoutStoppedSiblingMembers}. In-memory only; no AWS call.
 */
export function membersSiblingsStoppedWriting(
  previous: Readonly<Record<string, WriterRecord>>,
  next: Readonly<Record<string, WriterRecord>>,
  oldMaySurvive: (logicalId: string) => boolean = () => false,
  templatePolicies?: TemplatePolicies
): Map<string, StoppedSiblingMembers[]> {
  const encode = (w: [string, string, string, string, boolean]): string =>
    injectiveKey(w[0], w[1], w[2], w[3], String(w[4]));
  const stillWritten = new Set<string>();
  for (const record of Object.values(next)) {
    for (const w of siblingWritesOf(record)) stillWritten.add(encode(w));
  }
  // injectiveKey(targetType, foldCase, targetId) -> key -> members
  const stopped = new Map<string, Map<string, StoppedSiblingMembers>>();
  for (const [logicalId, record] of Object.entries(previous)) {
    const writes = siblingWritesOf(record);
    if (
      writes.length === 0 ||
      previousMaySurvive(logicalId, record, next, oldMaySurvive, templatePolicies)
    ) {
      continue;
    }
    for (const w of writes) {
      if (stillWritten.has(encode(w))) continue;
      const [targetType, targetId, key, member, foldCase] = w;
      const target = injectiveKey(targetType, String(foldCase), targetId);
      let byKey = stopped.get(target);
      if (byKey === undefined) stopped.set(target, (byKey = new Map()));
      let entry = byKey.get(key);
      if (entry === undefined) byKey.set(key, (entry = { key, members: new Set(), foldCase }));
      entry.members.add(member);
    }
  }
  const result = new Map<string, StoppedSiblingMembers[]>();
  if (stopped.size === 0) return result;
  for (const [logicalId, record] of Object.entries(next)) {
    const id = record.physicalId;
    if (typeof id !== 'string' || id === '') continue;
    const entries = [
      ...(stopped.get(injectiveKey(record.resourceType, 'false', id))?.values() ?? []),
      // A `UserToGroupAddition` names its user folded.
      ...(stopped.get(injectiveKey(record.resourceType, 'true', id.toLowerCase()))?.values() ?? []),
    ];
    if (entries.length > 0) result.set(logicalId, entries);
  }
  return result;
}

/**
 * `bag` without the {@link membersSiblingsStoppedWriting} members the
 * resource's own `properties` do not declare under the same key. Returned by
 * identity when nothing is dropped.
 */
export function withoutStoppedSiblingMembers(
  bag: Record<string, unknown>,
  stopped: readonly StoppedSiblingMembers[],
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  let out = bag;
  for (const { key, members, foldCase } of stopped) {
    const list = stringsAt(out, key);
    if (list === undefined) continue;
    const kept = withoutSiblingOwned(list, members, properties, key, foldCase);
    if (kept.length !== list.length) out = { ...out, [key]: kept };
  }
  return out;
}
