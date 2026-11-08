/**
 * go-to-k/cdkd#4227 / #4821: the dispatch-time ordering of the create / update
 * rows that may write the same inline policy name on one principal, read from
 * the diff, the template and the pre-deploy records. Split out of
 * `inline-policy-claims.ts` (go-to-k/cdkd#5835), which re-exports
 * `orderInlinePolicyWriters`.
 */
import type { InlinePolicyPrincipalKind, TemplateResource } from '../../types/resource.js';
import type { ResourceChange, ResourceState } from '../../types/state.js';
import {
  ANY,
  POLICY_LIST_FIELDS,
  PRINCIPAL_NAME_FIELDS,
  isInlinePolicyPrincipalType,
  isStandaloneInlinePolicyType,
  nameKey,
  ownPoliciesChange,
  policiesNames,
  principalKindOf,
  standaloneInlinePolicyOf,
} from './names.js';

/**
 * The keys one TEMPLATE entry of a policy's principal list may name. A `Ref`
 * to a principal of this stack keys by the logical id (`ref:` cannot occur in
 * an IAM name) plus every name it can resolve to: its template name and its
 * recorded physical id. Anything else that is not a literal name is {@link ANY}.
 */
function templatePrincipalKeys(
  entry: unknown,
  kind: InlinePolicyPrincipalKind,
  templateResources: Readonly<Record<string, TemplateResource>>,
  stateResources: Readonly<Record<string, ResourceState>>
): string[] {
  if (typeof entry === 'string') return [nameKey(entry)];
  const ref =
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)['Ref']
      : undefined;
  if (typeof ref !== 'string' || !Object.hasOwn(templateResources, ref)) return [ANY];
  const target = templateResources[ref]!;
  if (principalKindOf(target.Type) !== kind) return [ANY];
  return principalSelfKeys(ref, kind, target, stateResources);
}

/** The keys a principal of this stack is known by (see {@link templatePrincipalKeys}). */
function principalSelfKeys(
  logicalId: string,
  kind: InlinePolicyPrincipalKind,
  template: TemplateResource | undefined,
  stateResources: Readonly<Record<string, ResourceState>>
): string[] {
  const keys = [`ref:${logicalId}`];
  // A declared name read only when literal: an unreadable one (a token such as
  // `${stackName}-fn`) names THIS principal, so it must not key as ANY and
  // meet every other principal's policies — the logical id already keys it.
  const declared = template?.Properties?.[PRINCIPAL_NAME_FIELDS[kind]];
  const declaredKey = nameKey(declared);
  if (declaredKey !== ANY) keys.push(declaredKey);
  const record = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
  if (record !== undefined && principalKindOf(record.resourceType) === kind) {
    const recordedKey = nameKey(record.physicalId);
    if (recordedKey !== ANY) keys.push(recordedKey);
  }
  return keys;
}

interface InlinePolicyClaim {
  kind: InlinePolicyPrincipalKind;
  principal: string;
  name: string;
}

/**
 * go-to-k/cdkd#4821: the pairs a standalone inline policy row PUTS (`desired`:
 * a create, or the create of a replacement) and REMOVES (`old`: the
 * replacement's delete of its old copy), each its principal with its own
 * name. `undefined` for every other type.
 */
function standaloneClaimSides(
  logicalId: string,
  change: ResourceChange,
  templateResources: Readonly<Record<string, TemplateResource>>,
  stateResources: Readonly<Record<string, ResourceState>>
): { desired: InlinePolicyClaim[]; old: InlinePolicyClaim[] } | undefined {
  const template = Object.hasOwn(templateResources, logicalId)
    ? templateResources[logicalId]
    : undefined;
  const desired = standaloneInlinePolicyOf(change.resourceType, template?.Properties ?? {});
  if (desired === undefined) return undefined;
  const { kind } = desired;
  const name = nameKey(desired.policyName);
  const sides = {
    desired: templatePrincipalKeys(desired.principal, kind, templateResources, stateResources).map(
      (principal) => ({ kind, principal, name })
    ),
    old: [] as InlinePolicyClaim[],
  };
  const record = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
  if (record?.resourceType === change.resourceType) {
    const old = standaloneInlinePolicyOf(change.resourceType, record.properties)!;
    sides.old.push({ kind, principal: nameKey(old.principal), name: nameKey(old.policyName) });
  }
  return sides;
}

/**
 * Every (principal, inline policy name) pair a create / update row may PUT or
 * REMOVE, read before dispatch from its template entry and its pre-deploy
 * record. Over-approximates: what it cannot read keys as {@link ANY}, which
 * only orders more writers, never fewer. Empty for a row that writes none.
 */
function inlinePolicyClaimsOf(
  logicalId: string,
  change: ResourceChange,
  templateResources: Readonly<Record<string, TemplateResource>>,
  stateResources: Readonly<Record<string, ResourceState>>
): InlinePolicyClaim[] {
  const template = Object.hasOwn(templateResources, logicalId)
    ? templateResources[logicalId]
    : undefined;
  const record = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
  const recorded = record?.resourceType === change.resourceType ? record : undefined;
  const claims: InlinePolicyClaim[] = [];
  const cross = (kind: InlinePolicyPrincipalKind, principals: string[], names: string[]): void => {
    for (const principal of new Set(principals)) {
      for (const name of new Set(names)) claims.push({ kind, principal, name });
    }
  };
  const standalone = standaloneClaimSides(logicalId, change, templateResources, stateResources);
  if (standalone !== undefined) return [...standalone.desired, ...standalone.old];
  if (change.resourceType === 'AWS::IAM::Policy') {
    const desired = template?.Properties ?? {};
    const old = recorded?.properties ?? {};
    const names: string[] = [];
    if (desired['PolicyName'] !== undefined) names.push(nameKey(desired['PolicyName']));
    if (old['PolicyName'] !== undefined) names.push(nameKey(old['PolicyName']));
    // The physical id is the name, or `<name>:<role>` in the provider's old
    // format, which it reads the same way.
    if (recorded !== undefined)
      names.push(
        nameKey(
          typeof recorded.physicalId === 'string'
            ? recorded.physicalId.split(':')[0]
            : recorded.physicalId
        )
      );
    if (names.length === 0) return claims;
    for (const kind of ['role', 'group', 'user'] as const) {
      const field = POLICY_LIST_FIELDS[kind];
      const principals: string[] = [];
      const listed = desired[field];
      if (Array.isArray(listed)) {
        for (const entry of listed) {
          principals.push(...templatePrincipalKeys(entry, kind, templateResources, stateResources));
        }
      } else if (listed !== undefined) {
        principals.push(ANY);
      }
      const held = old[field];
      if (Array.isArray(held)) principals.push(...held.map(nameKey));
      else if (held !== undefined && held !== null) principals.push(ANY);
      cross(kind, principals, names);
    }
    return claims;
  }
  const kind = principalKindOf(change.resourceType);
  if (kind === undefined) return claims;
  // A principal puts or removes inline policies only on a create, a
  // replacement (the create of the new principal), or an update whose own
  // diff changed `Policies` — the rule the claim predicate reads.
  const writesPolicies =
    change.changeType === 'CREATE' ||
    (change.propertyChanges ?? []).some((c) => c.requiresReplacement) ||
    ownPoliciesChange(change);
  if (!writesPolicies) return claims;
  cross(kind, principalSelfKeys(logicalId, kind, template, stateResources), [
    ...policiesNames(template?.Properties?.['Policies']),
    ...policiesNames(recorded?.properties?.['Policies']),
  ]);
  return claims;
}

/**
 * go-to-k/cdkd#4227: order the create / update rows that write the same
 * inline policy name on the same IAM principal, so none of them runs while
 * another is in flight.
 *
 * The claim predicate ({@link isInlinePolicyClaimedByCompletedWriter}) keeps a
 * name only once its other writer has COMPLETED. Two writers with no
 * dependency between them (two `iam.Policy` constructs on one role swapping
 * names, or one renamed away from a name a new one takes) ran concurrently,
 * so each removal could miss the other's put and the role kept neither
 * policy. In sequence, either order is correct: the second writer sees the
 * first one's completed write, or removes only what the first then re-puts.
 *
 * Only the colliding rows are ordered, derived from the diff before dispatch:
 * a row that shares no (principal, name) pair with another gets no edge, and a
 * stack with fewer than two inline-policy writers costs one pass over its rows.
 * Each added edge makes the later of the pair (by `rank`, then logical id;
 * a standalone `AWS::IAM::RolePolicy` / `GroupPolicy` / `UserPolicy` paired
 * with another kind of writer is always the later, go-to-k/cdkd#4821)
 * depend on the earlier one, and only when neither already depends on the
 * other through `dependencies`, so it can never close a cycle: an edge `u -> v`
 * closes one only when `v` already reaches `u`.
 *
 * `dependencies` (each row's direct dependencies, among `writes` only) is
 * updated in place; the added edges are returned.
 */
export function orderInlinePolicyWriters(args: {
  /** The rows of the create / update phase. */
  writes: readonly string[];
  changes: ReadonlyMap<string, ResourceChange>;
  templateResources: Readonly<Record<string, TemplateResource>>;
  /** The pre-deploy records. */
  stateResources: Readonly<Record<string, ResourceState>>;
  dependencies: Map<string, Set<string>>;
  /** A row's execution level: an edge goes from the lower to the higher. */
  rank: (logicalId: string) => number;
}): Array<{ before: string; after: string }> {
  const { writes, changes, templateResources, stateResources, dependencies, rank } = args;
  const writers = writes.filter((id) => {
    const type = changes.get(id)?.resourceType;
    return (
      type === 'AWS::IAM::Policy' ||
      (type !== undefined &&
        (isInlinePolicyPrincipalType(type) || isStandaloneInlinePolicyType(type)))
    );
  });
  if (writers.length < 2) return [];

  const exact = new Map<string, Set<string>>();
  const loose: Array<{ id: string; claim: InlinePolicyClaim }> = [];
  const all: Array<{ id: string; claim: InlinePolicyClaim }> = [];
  for (const id of writers) {
    for (const claim of inlinePolicyClaimsOf(
      id,
      changes.get(id)!,
      templateResources,
      stateResources
    )) {
      all.push({ id, claim });
      if (claim.principal === ANY || claim.name === ANY) {
        loose.push({ id, claim });
        continue;
      }
      const key = JSON.stringify([claim.kind, claim.principal, claim.name]);
      const ids = exact.get(key) ?? new Set<string>();
      ids.add(id);
      exact.set(key, ids);
    }
  }

  // Two principals of the stack are never the same principal, so a name one
  // of them cannot read before resolving does not make it collide with another.
  const principalRows = new Set(
    writers.filter((id) => isInlinePolicyPrincipalType(changes.get(id)!.resourceType))
  );
  const standaloneRows = new Set(
    writers.filter((id) => isStandaloneInlinePolicyType(changes.get(id)!.resourceType))
  );
  const sides = new Map(
    [...standaloneRows].map((id) => [
      id,
      standaloneClaimSides(id, changes.get(id)!, templateResources, stateResources)!,
    ])
  );
  const sameClaim = (p: InlinePolicyClaim, q: InlinePolicyClaim): boolean =>
    p.kind === q.kind &&
    (p.principal === ANY || q.principal === ANY || p.principal === q.principal) &&
    (p.name === ANY || q.name === ANY || p.name === q.name);
  /** Whether standalone row `a`'s old copy holds a pair standalone row `b` creates. */
  const releasesFor = (a: string, b: string): boolean =>
    sides.get(a)!.old.some((o) => sides.get(b)!.desired.some((d) => sameClaim(o, d)));
  const pairs = new Map<string, [string, string]>();
  const pair = (a: string, b: string): void => {
    if (a === b || (principalRows.has(a) && principalRows.has(b))) return;
    // go-to-k/cdkd#4821: a standalone inline policy's create is refused while
    // its name is on the principal, so the other writer, which may be
    // releasing that name, goes first. Its delete of a replaced old name then
    // leaves the name the other writer has put there (the claim predicate).
    // Two standalone ones: the one replaced AWAY from a name the other
    // creates releases it first, when only one of them does.
    const sa = standaloneRows.has(a);
    const sb = standaloneRows.has(b);
    let first: string | undefined;
    if (sa !== sb) first = sa ? b : a;
    else if (sa && sb) {
      const aReleases = releasesFor(a, b);
      const bReleases = releasesFor(b, a);
      if (aReleases !== bReleases) first = aReleases ? a : b;
    }
    first ??= rank(a) < rank(b) || (rank(a) === rank(b) && a < b) ? a : b;
    const [x, y] = first === a ? [a, b] : [b, a];
    pairs.set(JSON.stringify([x, y]), [x, y]);
  };
  for (const ids of exact.values()) {
    const list = [...ids];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) pair(list[i]!, list[j]!);
    }
  }
  const meets = (a: string, b: string): boolean => a === ANY || b === ANY || a === b;
  for (const { id, claim } of loose) {
    for (const other of all) {
      if (other.claim.kind !== claim.kind) continue;
      if (meets(claim.principal, other.claim.principal) && meets(claim.name, other.claim.name)) {
        pair(id, other.id);
      }
    }
  }
  if (pairs.size === 0) return [];

  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of dependencies.get(id) ?? []) stack.push(dep);
    }
    return false;
  };
  const added: Array<{ before: string; after: string }> = [];
  for (const [before, after] of pairs.values()) {
    if (reaches(after, before) || reaches(before, after)) continue;
    const deps = dependencies.get(after) ?? new Set<string>();
    deps.add(before);
    dependencies.set(after, deps);
    added.push({ before, after });
  }
  return added;
}
