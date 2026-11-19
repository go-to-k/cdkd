import { defineOwnKey, hasOwnKey } from '../utils/own-keys.js';

/**
 * Top-level IAM principal keys whose ABSENCE in the template means "none"
 * (go-to-k/cdkd#6627): a role, user or group the template gives no managed
 * policy, inline policy, permissions boundary or (a user) group membership
 * holds none in AWS either, since IAM adds no member of its own there.
 *
 * So `cdkd drift` compares each of them even when the template omits it, on
 * the template-only `properties` baseline (where the walk visits only the
 * baseline's keys) and on the observed baseline (where an undeclared list
 * captured empty, or any undeclared attachment list, used to be skipped). An
 * out-of-band `AttachRolePolicy` of `AdministratorAccess` onto such a role is
 * drift, and `drift --revert` removes that one member: the providers' `update()`
 * diffs each list per member (one `Detach*Policy`, `Delete*Policy` or
 * `RemoveUserFromGroup` per removed member, `Delete*PermissionsBoundary`), and
 * none of these keys is create-only, so a revert never replaces the principal.
 *
 * A member a SIBLING record of the same stack writes (an `AWS::IAM::ManagedPolicy`
 * naming the role in `Roles`, an `AWS::IAM::Policy`, a
 * `UserToGroupAddition`) is not the principal's: it leaves both sides before
 * this runs (`provisioning/sibling-owned-members.ts`), so it is neither drift
 * nor removed. A member written from another stack or tool is drift; a
 * legitimate one is adopted with `drift --accept`, which records it in the
 * observed baseline.
 *
 * The LIST keys are compared one way: only a live member the baseline does not
 * hold is drift. A baseline member AWS no longer holds is not, so `--revert`
 * never ADDS a member under an undeclared key. A baseline read races a
 * sibling's write and can record the sibling's member; once the sibling stops
 * writing it, a two-way comparison reported it lost and `--revert` granted it
 * again (go-to-k/cdkd#6328). Losing a grant the template never declared is not
 * a widening, and an `--accept`ed member that is removed later stays removed.
 * A member both sides hold is still compared by value, so an inline policy
 * whose document changed out of band is drift and `--revert` puts the recorded
 * document back.
 *
 * `PermissionsBoundary` is a scalar and no sibling writes it, so it is compared
 * both ways: a boundary added out of band is removed, and an observed one
 * removed out of band (which widens access) is put back.
 */
const UNDECLARED_GRANT_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::IAM::Role': ['ManagedPolicyArns', 'PermissionsBoundary', 'Policies'],
  'AWS::IAM::User': ['Groups', 'ManagedPolicyArns', 'PermissionsBoundary', 'Policies'],
  // CloudFormation's `AWS::IAM::Group` has no `PermissionsBoundary`.
  'AWS::IAM::Group': ['ManagedPolicyArns', 'Policies'],
};

/** The one scalar key of the table; every other entry is a member list. */
const BOUNDARY_KEY = 'PermissionsBoundary';

const NONE: readonly string[] = [];

/** Whether `value` is a plain object (not an array, not null). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The table keys of `resourceType` that the record's template (`properties`)
 * does not declare. A declared key is compared the ordinary way. A record whose
 * `properties` is not a plain object names none.
 */
export function undeclaredGrantDriftKeys(
  resourceType: string,
  properties: unknown
): readonly string[] {
  if (!hasOwnKey(UNDECLARED_GRANT_KEYS, resourceType)) return NONE;
  if (!isPlainRecord(properties)) return NONE;
  return UNDECLARED_GRANT_KEYS[resourceType]!.filter((key) => !hasOwnKey(properties, key));
}

/** Whether `key` is the table's scalar (`PermissionsBoundary`). */
export function isUndeclaredGrantScalarKey(key: string): boolean {
  return key === BOUNDARY_KEY;
}

/**
 * The identity of one member of list `key`: a managed policy's ARN, an inline
 * policy's `PolicyName`, a group's name (case-folded: IAM group names are
 * case-insensitive). `undefined` for a member of no recognisable shape.
 */
export function grantMemberIdentity(key: string, member: unknown): string | undefined {
  if (key === 'Policies') {
    const name = isPlainRecord(member) ? member['PolicyName'] : undefined;
    return typeof name === 'string' ? name : undefined;
  }
  if (typeof member !== 'string') return undefined;
  // Both sides of a comparison come from `ListGroupsForUser`, so they spell a
  // group alike; the fold matters for a hand-edited or `--accept`ed spelling
  // and for matching the sibling helpers' own case-insensitive group match.
  return key === 'Groups' ? member.toLowerCase() : member;
}

/** A scalar value meaning "no boundary": absent, `null` or `''`. */
function isNoBoundary(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The comparison (or revert) baseline for the undeclared `keys`, given the live
 * readback `aws`:
 *  - a LIST key the readback holds becomes, in the readback's order, the
 *    baseline's member of each live member's identity that the baseline holds
 *    (a baseline without the key holds none). So only a live member the
 *    baseline lacks differs, and a baseline member AWS no longer holds leaves.
 *    A live member of no recognisable identity is kept off the baseline, so it
 *    differs too.
 *  - the SCALAR key the readback holds and the baseline lacks becomes `''`,
 *    the readback's "no boundary".
 * Every other key, and a key the readback does not hold, is left as it is. The
 * input by identity when nothing changes; a copy otherwise.
 */
export function withUndeclaredGrantBaseline(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  let out = baseline;
  const set = (key: string, value: unknown): void => {
    if (out === baseline) out = { ...baseline };
    defineOwnKey(out, key, value);
  };
  for (const key of keys) {
    if (!hasOwnKey(aws, key)) continue;
    if (isUndeclaredGrantScalarKey(key)) {
      if (!hasOwnKey(baseline, key)) set(key, '');
      continue;
    }
    const live = aws[key];
    if (!Array.isArray(live)) continue;
    const recorded = hasOwnKey(baseline, key) ? baseline[key] : [];
    if (!Array.isArray(recorded)) continue;
    const byId = new Map<string, unknown>();
    for (const member of recorded) {
      const id = grantMemberIdentity(key, member);
      if (id !== undefined && !byId.has(id)) byId.set(id, member);
    }
    const projected: unknown[] = [];
    for (const member of live) {
      const id = grantMemberIdentity(key, member);
      if (id === undefined || !byId.has(id)) continue;
      projected.push(byId.get(id));
      byId.delete(id);
    }
    const same =
      hasOwnKey(baseline, key) &&
      projected.length === recorded.length &&
      projected.every((m, i) => m === recorded[i]);
    if (!same) set(key, projected);
  }
  return out;
}

/**
 * The undeclared `keys` drift must not compare on one resource: a key the
 * readback does not hold whose baseline is "none" too (no list, an empty one,
 * no boundary). A Cloud Control read omits an empty list or no boundary, so
 * the two agree. A baseline boundary the readback lacks is still compared (it
 * was removed); a baseline list member is never drift on its own (see the
 * module comment).
 */
export function undeclaredGrantIgnorePaths(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  keys: readonly string[]
): string[] {
  return keys.filter((key) => {
    if (hasOwnKey(aws, key)) return false;
    if (isUndeclaredGrantScalarKey(key)) {
      return !hasOwnKey(baseline, key) || isNoBoundary(baseline[key]);
    }
    return true;
  });
}

/**
 * `desired` for `--revert` with each undeclared SCALAR key meaning "no
 * boundary" left OUT, so the revert sends it absent (`absentMeansDefault`) and
 * the provider removes the live boundary: the SDK providers delete it for an
 * absent or `''` value alike, and a Cloud Control patch then removes the key
 * instead of writing `''`. Returns the bag (by identity when unchanged) and
 * the keys to send absent.
 */
export function withoutUndeclaredNoBoundary(
  desired: Record<string, unknown>,
  keys: readonly string[]
): { desired: Record<string, unknown>; absent: string[] } {
  const absent = keys.filter(
    (key) => isUndeclaredGrantScalarKey(key) && isNoBoundary(desired[key])
  );
  if (absent.length === 0) return { desired, absent };
  const out = { ...desired };
  for (const key of absent) delete out[key];
  return { desired: out, absent };
}

/** One member `--revert` removes under an undeclared key, for the plan. */
export interface RemovedGrantMember {
  key: string;
  /** What the plan names: the ARN, the inline policy's name, the group's name. */
  member: unknown;
}

/**
 * The members a revert of one drifted undeclared `key` removes: each live
 * member (`awsValue`) whose identity the baseline (`stateValue`) lacks, or the
 * live boundary when the baseline has none.
 */
export function removedGrantMembers(
  key: string,
  awsValue: unknown,
  stateValue: unknown
): RemovedGrantMember[] {
  if (isUndeclaredGrantScalarKey(key)) {
    return !isNoBoundary(awsValue) && isNoBoundary(stateValue) ? [{ key, member: awsValue }] : [];
  }
  if (!Array.isArray(awsValue)) return [];
  const kept = new Set(
    (Array.isArray(stateValue) ? stateValue : []).map((m) => grantMemberIdentity(key, m))
  );
  const out: RemovedGrantMember[] = [];
  for (const m of awsValue) {
    const id = grantMemberIdentity(key, m);
    if (id !== undefined && kept.has(id)) continue;
    // An inline policy is named by its `PolicyName`; one without a string
    // name is printed whole.
    const name = key === 'Policies' && isPlainRecord(m) ? m['PolicyName'] : undefined;
    out.push({ key, member: typeof name === 'string' ? name : m });
  }
  return out;
}
