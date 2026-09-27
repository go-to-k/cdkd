/**
 * How a state record's `AWS::IAM::Policy` principal list (`Roles`, `Users`,
 * `Groups`) is read before cdkd removes the inline policy from each name
 * (go-to-k/cdkd#3878). A LEAF with no imports, shared by every
 * `IAMPolicyProvider` method that addresses a principal by name and by
 * `cdkd export`'s IAM::Policy pre-delete, so they agree on which recorded list
 * values are well-formed. (What each does with a well-formed EMPTY list, or a
 * legacy `<policyName>:<roleName>` id with no list, is still its own call.)
 *
 * The record is read unvalidated. Both deletes used to cast the value to
 * `string[]` and iterate it, so a string was walked character by character —
 * `Roles: "AdminRole"` issued `DeleteRolePolicy` for roles `A`, `d`, `m`, ...,
 * removing a same-named inline policy from any one-letter role and never
 * touching `AdminRole` — and a `{}` threw mid-loop after earlier targets were
 * already detached. A caller refuses a `malformed` list before any AWS call.
 */

/**
 * An IAM role, user or group NAME: IAM's own character set, and at most 128
 * characters (AWS caps a group name at 128, a role or user name at 64). A
 * recorded entry outside it is not a principal name, so the list holding it is
 * `malformed` rather than handed to `Delete*Policy`.
 */
export const IAM_PRINCIPAL_NAME = /^[\w+=,.@-]{1,128}$/;

/** What {@link readRecordedPrincipals} found for one kind. */
export type RecordedPrincipals =
  | { kind: 'absent' }
  | { kind: 'names'; names: string[] }
  | { kind: 'malformed'; detail: string };

/**
 * Read one recorded principal list.
 *
 * - `undefined` or `null` is ABSENT: `null` is what a hand-edited or pre-v7
 *   state file can carry, and the provider has always treated it as no list.
 *   Any OTHER falsy value (`''`, `0`, `false`) is malformed, not absent: it
 *   names no principal, and reading it as absent would hand a legacy
 *   `<policyName>:<roleName>` id's role the delete instead.
 * - A list whose every entry is an {@link IAM_PRINCIPAL_NAME} is `names`,
 *   including the EMPTY list, which a caller may read as "nothing attached".
 * - Anything else is `malformed`. `detail` names only the value's SHAPE, never
 *   its content, so a message built from it cannot echo record content.
 */
export function readRecordedPrincipals(value: unknown): RecordedPrincipals {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (!Array.isArray(value)) return { kind: 'malformed', detail: `found ${typeof value}` };
  if (!value.every((v) => typeof v === 'string' && IAM_PRINCIPAL_NAME.test(v))) {
    return {
      kind: 'malformed',
      detail: `a ${value.length}-element list holding a non-name entry`,
    };
  }
  return { kind: 'names', names: value as string[] };
}
