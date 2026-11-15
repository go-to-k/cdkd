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
 * {@link stripSiblingManagedPolicyArns} drops it from the recorded baseline
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
  if (siblingArns.size === 0) return [...arns];
  const declared = properties?.['ManagedPolicyArns'];
  const own = new Set(Array.isArray(declared) ? declared : []);
  return arns.filter((arn) => !siblingArns.has(arn) || own.has(arn));
}

/**
 * The drift-pair half: drop the sibling-attached ARNs from `ManagedPolicyArns`
 * in both bags. Non-mutating; each bag is returned by identity when it has
 * nothing to drop (always, for a non-principal type or without a context).
 *
 * Dropping from the BASELINE is safe for `drift --revert`, which sends this
 * baseline as the desired side against the raw readback: the readback has
 * dropped the same ARNs, so the role's `update()` sees them on neither side
 * and never detaches them.
 */
export function stripSiblingManagedPolicyArns(
  resourceType: string,
  physicalId: string | undefined,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): { baseline: Record<string, unknown>; aws: Record<string, unknown> } {
  const field = managedPolicyAttachmentField(resourceType);
  if (field === undefined || physicalId === undefined) return { baseline, aws };
  const siblingArns = collectManagedPolicyArnsAttachedBySiblings(physicalId, context, field);
  if (siblingArns.size === 0) return { baseline, aws };
  const strip = (bag: Record<string, unknown>): Record<string, unknown> => {
    const arns = bag['ManagedPolicyArns'];
    if (!Array.isArray(arns) || !arns.every((a): a is string => typeof a === 'string')) {
      return bag;
    }
    const kept = withoutSiblingAttachedArns(arns, siblingArns, properties);
    return kept.length === arns.length ? bag : { ...bag, ManagedPolicyArns: kept };
  };
  return { baseline: strip(baseline), aws: strip(aws) };
}
