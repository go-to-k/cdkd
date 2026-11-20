/**
 * What a resource's own write REMOVED from a list member, for the post-write
 * drift baseline (`ReadCurrentStateContext.afterOwnWrite`, go-to-k/cdkd#6609).
 *
 * The capture settles a list member once every declared entry reads back. A
 * read that still shows an entry the write just detached / deleted / revoked
 * would pass that test, and the stale entry would land in the baseline: a
 * later out-of-band re-add of the same grant then equals the baseline, and
 * `cdkd drift` never reports it. So each provider notes, right after a
 * removal call SUCCEEDS (a "not found" it tolerates included), the removed
 * entry's IDENTITY, and the capture also waits for those to be gone
 * (`settle-own-write-members.ts`). No such lag was measured (us-east-1,
 * 2026-11-21: Detach/DeleteRolePolicy, RemoveRoleFromInstanceProfile and
 * security group revokes, 0 stale reads in 6 rounds each); this is a defence,
 * free when the first read agrees.
 *
 * A note holds identities only: a managed policy ARN, a principal or policy
 * name, a permissions boundary ARN, a security group rule's removal key. Never
 * a policy document or a rule description. Held in memory, never logged or
 * persisted.
 *
 * Notes are keyed by type and physical id only, not by account or region: two
 * same-named IAM principals of different accounts deployed in one process
 * could meet each other's note. That fails safe: a foreign note only makes a
 * capture wait for, or leave out, an entry this write did not remove, which
 * can only make drift report more, never hide a grant.
 *
 * Lifecycle:
 *  - recorded by the removal call that succeeded, after any skip that keeps
 *    the entry (go-to-k/cdkd#4225, go-to-k/cdkd#4492), so a call that throws
 *    records nothing;
 *  - cleared at the start of the resource's next update: an update that threw
 *    is followed by no capture, and its note left behind must not make the
 *    next capture wait;
 *  - taken by the capture BEFORE its first await. The capture is fire-and-
 *    forget and a failed deploy does not drain it, so a rollback's revert of
 *    the same resource can run while it is in flight; taken synchronously, the
 *    forward note is gone before the revert records its own. A capture that
 *    still met a revert's note would be harmless: a revert removes only what
 *    the failed update added, which that update's template declares, and a
 *    removed entry the template declares is never required absent.
 */

/** Per member key, the identities a resource's own write removed. */
export type OwnWriteRemovals = ReadonlyMap<string, ReadonlySet<string>>;

/** Per resource type, per physical id, per member key. */
const removals = new Map<string, Map<string, Map<string, Set<string>>>>();

/** Note that the removal call for `identity` on `resourceType` `id`'s `memberKey` just succeeded. */
export function recordOwnWriteRemoval(
  resourceType: string,
  id: string,
  memberKey: string,
  identity: string
): void {
  let byId = removals.get(resourceType);
  if (byId === undefined) {
    byId = new Map();
    removals.set(resourceType, byId);
  }
  let byMember = byId.get(id);
  if (byMember === undefined) {
    byMember = new Map();
    byId.set(id, byMember);
  }
  let entries = byMember.get(memberKey);
  if (entries === undefined) {
    entries = new Set();
    byMember.set(memberKey, entries);
  }
  entries.add(identity);
}

/** The removals noted for `id`, consumed by the capture that reads it. */
export function takeOwnWriteRemovals(
  resourceType: string,
  id: string
): OwnWriteRemovals | undefined {
  const byId = removals.get(resourceType);
  const noted = byId?.get(id);
  byId?.delete(id);
  return noted;
}

/**
 * Put back what a capture took when its read found no resource yet and will
 * be retried: the retry still settles on it.
 */
export function restoreOwnWriteRemovals(
  resourceType: string,
  id: string,
  noted: OwnWriteRemovals
): void {
  for (const [memberKey, identities] of noted) {
    for (const identity of identities) recordOwnWriteRemoval(resourceType, id, memberKey, identity);
  }
}

/** Drop what was noted for `id`; each update calls it before any write. */
export function clearOwnWriteRemovals(resourceType: string, id: string): void {
  removals.get(resourceType)?.delete(id);
}
