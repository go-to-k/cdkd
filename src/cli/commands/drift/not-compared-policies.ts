/**
 * go-to-k/cdkd#6697: which of a stack's `AWS::IAM::ManagedPolicy` records a
 * drift run did NOT compare.
 *
 * A same-stack managed policy whose template declares the `Roles` / `Users` /
 * `Groups` list reports and reverts its own attachments, so an IAM principal's
 * undeclared `ManagedPolicyArns` leaves that policy's ARN out
 * (`managedPoliciesDeclaringAttachments`, go-to-k/cdkd#6627). That holds only
 * when the policy's own comparison ran: a policy whose read failed or was
 * aborted, whose baseline was refused, or whose record could not be read
 * reports nothing, and an out-of-band attach of it to another principal was
 * reported on neither resource. The principal keeps such an ARN for that run.
 *
 * Detection therefore compares the stack's managed policies BEFORE every other
 * resource ({@link managedPoliciesFirst}), so each principal's comparison sees
 * the outcomes of all of them; `--revert` reads the same outcomes off the
 * report. The report keeps the template's resource order.
 */
import type { ResourceState } from '../../../types/state.js';
import type { DriftOutcome } from './outcome.js';

export const MANAGED_POLICY_TYPE = 'AWS::IAM::ManagedPolicy';

/**
 * The ARNs (physical ids) of the stack's managed policies whose outcome in this
 * run is neither `clean` nor `drifted`, or which have no outcome at all. A
 * `drifted` outcome that was only partially compared still compared the
 * attachment lists: `managedPoliciesDeclaringAttachments` takes a policy only
 * when each list holds plain names, which nothing leaves uncompared.
 */
export function notComparedManagedPolicyArns(
  resources: Readonly<Record<string, ResourceState>> | undefined,
  outcomes: readonly DriftOutcome[]
): Set<string> {
  const compared = new Set<string>();
  for (const o of outcomes) {
    if (o.kind === 'clean' || o.kind === 'drifted') compared.add(o.logicalId);
  }
  const out = new Set<string>();
  for (const [logicalId, record] of Object.entries(resources ?? {})) {
    if (record?.resourceType !== MANAGED_POLICY_TYPE) continue;
    const arn = record.physicalId;
    if (typeof arn !== 'string' || arn === '' || compared.has(logicalId)) continue;
    out.add(arn);
  }
  return out;
}

/**
 * `entries` with every managed policy moved to the front, each group keeping
 * its order, so the principals compared after them can read their outcomes.
 */
export function managedPoliciesFirst<T extends readonly [string, ResourceState]>(
  entries: readonly T[]
): T[] {
  const isPolicy = (e: T): boolean => e[1]?.resourceType === MANAGED_POLICY_TYPE;
  return [...entries.filter(isPolicy), ...entries.filter((e) => !isPolicy(e))];
}

/**
 * Puts `outcomes[from..]` back in the order of `entries` (by logical id),
 * stable, so a run that compared in {@link managedPoliciesFirst} order still
 * reports in the template's order. Outcomes before `from` stay where they are.
 */
export function restoreEntryOrder(
  outcomes: DriftOutcome[],
  from: number,
  entries: readonly (readonly [string, unknown])[]
): void {
  const rank = new Map<string, number>();
  entries.forEach(([logicalId], i) => rank.set(logicalId, i));
  const tail = outcomes
    .slice(from)
    .map((o, i) => ({ o, i, r: rank.get(o.logicalId) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ o }) => o);
  outcomes.splice(from, tail.length, ...tail);
}
