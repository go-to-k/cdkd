/**
 * Did THIS create make the resource, for a create API that answers success
 * with a resource already holding the name (go-to-k/cdkd#4403)?
 *
 * ELBv2 `CreateLoadBalancer` / `CreateTargetGroup` (identical settings), SNS
 * `CreateTopic` and EventBridge `PutRule` (which overwrites) hand back or
 * reuse a resource that already held the name. A provider's partial-create
 * cleanup deletes what the create returned when a later wiring step fails,
 * so on such a hand-back it deleted someone else's resource. The answer comes
 * from a lookup of the name BEFORE the create, with three outcomes kept
 * apart: only `free` licenses the cleanup; `held` (it existed) and `unknown`
 * (the lookup could not answer) both leave the resource in place, since a
 * lookup that did not answer must never read as "this create made it".
 *
 * The lookup and the create are two calls, so a resource created under the
 * name between them still reads as `free`: the check narrows the window, it
 * cannot close it. A LEAF: imports nothing.
 */
export type NameHeldBefore = 'free' | 'held' | 'unknown';

/**
 * Run `lookup` (true when a resource holds the name) and classify its
 * failure with `isAbsent`, which must match ONLY the service's own
 * not-found answer; every other failure is `unknown`.
 */
export async function nameHeldBefore(
  lookup: () => Promise<boolean>,
  isAbsent: (error: unknown) => boolean
): Promise<NameHeldBefore> {
  try {
    return (await lookup()) ? 'held' : 'free';
  } catch (error) {
    return isAbsent(error) ? 'free' : 'unknown';
  }
}

/** Does `error` carry one of `names` as its error name? */
export function hasErrorName(error: unknown, names: readonly string[]): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' && names.includes(name);
}

/**
 * The sentence a cleanup that was NOT run logs instead (`held` or
 * `unknown`). `what` names the resource, `command` is the rendered manual
 * delete command: for `unknown` in case this create made it; for `held` only
 * after the reader confirms the holder is no one else's, since a held name
 * may be an earlier attempt of this deploy, another stack's or a stranger's
 * (the EventBridge command removes every target before the rule).
 */
export function skippedCleanupText(
  heldBefore: Exclude<NameHeldBefore, 'free'>,
  what: string,
  command: string
): string {
  return heldBefore === 'held'
    ? `${what} already existed before this create attempt (it may be an earlier attempt of ` +
        `this same deploy, an earlier failed deploy, or another stack's or someone else's ` +
        `resource), and the create handed it back, so cdkd did not delete it after the wiring ` +
        `failure; this deploy may have changed its configuration. A resource under a ` +
        `cdkd-generated name is adopted by the next deploy if its create-time settings are ` +
        `unchanged, so it needs no action if it is this stack's. Delete it only after confirming ` +
        `from its tags and creation time that no one else uses it: ${command}`
    : `cdkd could not tell whether this create made ${what} (the lookup before the create did ` +
        `not answer), so it was not deleted after the wiring failure. If this deploy created it, ` +
        `delete it before the next deploy: ${command}`;
}
