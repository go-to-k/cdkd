/**
 * go-to-k/cdkd#4821: the rollback-side reordering of a segment's replay so a
 * standalone inline policy's reversal runs after the writer that still holds
 * its name. Split out of `inline-policy-claims.ts` (go-to-k/cdkd#5835), which
 * re-exports `orderInlinePolicyReversals`.
 */
import type { InlinePolicyPrincipalKind } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import {
  ANY,
  POLICY_LIST_FIELDS,
  isStandaloneInlinePolicyType,
  nameKey,
  policiesNames,
  principalKindOf,
  standaloneInlinePolicyOf,
} from './names.js';

/**
 * The (principal, inline policy name) pairs a RECORD holds, as match keys
 * (lowercased; {@link ANY} for an unreadable name or principal). Empty for a
 * record of no inline-policy-writing type.
 */
function recordInlinePolicyKeys(record: ResourceState | undefined): string[] {
  if (record === undefined || record === null || typeof record !== 'object') return [];
  const props = record.properties ?? {};
  const keys: string[] = [];
  const add = (kind: InlinePolicyPrincipalKind, principal: unknown, name: unknown): void => {
    keys.push(JSON.stringify([kind, nameKey(principal), nameKey(name)]));
  };
  const standalone = standaloneInlinePolicyOf(record.resourceType, props);
  if (standalone !== undefined) {
    add(standalone.kind, standalone.principal, standalone.policyName);
    return keys;
  }
  if (record.resourceType === 'AWS::IAM::Policy') {
    const names = [
      props['PolicyName'],
      typeof record.physicalId === 'string' ? record.physicalId.split(':')[0] : record.physicalId,
    ];
    for (const kind of ['role', 'group', 'user'] as const) {
      const listed = props[POLICY_LIST_FIELDS[kind]];
      if (listed === undefined || listed === null) continue;
      const principals = Array.isArray(listed) ? (listed as unknown[]) : [undefined];
      for (const p of principals) for (const n of names) add(kind, p, n);
    }
    return keys;
  }
  const kind = principalKindOf(record.resourceType);
  if (kind === undefined) return keys;
  for (const name of policiesNames(props['Policies'])) add(kind, record.physicalId, name);
  return keys;
}

/**
 * go-to-k/cdkd#4821: the rollback twin of `orderInlinePolicyWriters`.
 * A rollback replays a segment's completed updates and replacements one at a
 * time, newest first (`replay`, in that order). Reversing a standalone inline
 * policy's replacement RE-CREATES its old name, which Cloud Control refuses
 * while another writer of the deploy (an `AWS::IAM::Policy`, or a role /
 * group / user's `Policies`) still holds that name — the forward order ran
 * that writer first, so newest-first reverses the standalone one first. Each
 * standalone op that shares a (principal, name) pair, read from its current
 * and its pre-deploy record, with a later non-standalone op therefore moves
 * to just after the last such op, never past an op it has a dependency with
 * either way (the scan stops there). Every other op keeps its place; with no standalone op among
 * two or more inline-policy writers, `replay` is returned as is.
 */
export function orderInlinePolicyReversals<
  T extends { logicalId: string; previousState?: ResourceState | undefined },
>(replay: readonly T[], stateResources: Readonly<Record<string, ResourceState>>): T[] {
  const current = (op: T): ResourceState | undefined =>
    Object.hasOwn(stateResources, op.logicalId) ? stateResources[op.logicalId] : undefined;
  const isStandalone = (op: T): boolean =>
    [current(op), op.previousState].some(
      (r) => r !== undefined && r !== null && isStandaloneInlinePolicyType(r.resourceType)
    );
  if (!replay.some(isStandalone)) return [...replay];
  const keysOf = new Map<T, Set<string>>();
  for (const op of replay) {
    const keys = [
      ...recordInlinePolicyKeys(current(op)),
      ...recordInlinePolicyKeys(op.previousState),
    ];
    if (keys.length > 0) keysOf.set(op, new Set(keys));
  }
  if (keysOf.size < 2) return [...replay];
  const meets = (a: string, b: string): boolean => a === ANY || b === ANY || a === b;
  const collide = (a: Set<string>, b: Set<string>): boolean => {
    for (const ka of a) {
      const [kindA, pA, nA] = JSON.parse(ka) as [string, string, string];
      for (const kb of b) {
        const [kindB, pB, nB] = JSON.parse(kb) as [string, string, string];
        if (kindA === kindB && meets(pA, pB) && meets(nA, nB)) return true;
      }
    }
    return false;
  };
  const dependsOn = (a: T, b: T): boolean =>
    [current(a), a.previousState].some(
      (r) => Array.isArray(r?.dependencies) && r.dependencies.includes(b.logicalId)
    );
  const order = [...replay];
  // Latest-first, so a standalone op moved past another one keeps its place
  // relative to it.
  for (const op of [...replay].reverse()) {
    if (!isStandalone(op)) continue;
    const mine = keysOf.get(op);
    if (mine === undefined) continue;
    const at = order.indexOf(op);
    let last = -1;
    for (let j = at + 1; j < order.length; j++) {
      const other = order[j]!;
      const theirs = keysOf.get(other);
      // Never past an op it has a dependency with, colliding or not.
      if (dependsOn(op, other) || dependsOn(other, op)) break;
      if (theirs === undefined || isStandalone(other)) continue;
      if (collide(mine, theirs)) last = j;
    }
    if (last < 0) continue;
    order.splice(at, 1);
    order.splice(last, 0, op);
  }
  return order;
}
