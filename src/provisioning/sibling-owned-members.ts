/**
 * go-to-k/cdkd#6610: the ONE table of resource types that write into ANOTHER
 * resource's property, and the drift path every such pair goes through.
 *
 * A CloudFormation type such as `AWS::SNS::Subscription` or
 * `AWS::ECS::ClusterCapacityProviderAssociations` is its own resource, yet it
 * writes members of a PARENT's property (a topic's `Subscription`, a cluster's
 * `CapacityProviders`). When cdkd reads the parent for its drift baseline or
 * for `cdkd drift`, the child's members show up on the parent, so drift
 * reported them as the parent's drift and `drift --revert` sent the parent's
 * baseline back, removing what the sibling attached.
 *
 * {@link SIBLING_WRITE_PAIRS} records EVERY such pair the audit found, with
 * one of three verdicts:
 *  - `table`: handled here, by a row of {@link SIBLING_OWNED_ROWS};
 *  - `helper`: handled by a per-pair module that predates this table and also
 *    filters the parent's own readback and deploy-time capture
 *    (`iam-sibling-managed-policies.ts`, `sg-sibling-rules.ts`, or an
 *    `undeclaredUncomparedDriftKeys` entry in `cli/commands/drift/baseline-keys.ts`);
 *  - `none`: the parent's drift read never returns the child's members, so
 *    the pair does not collide (the evidence names the read).
 * A new colliding pair is a row of {@link SIBLING_OWNED_ROWS}, not new code.
 *
 * What a row does, always from the stack's OWN state records (no AWS call):
 *  - DETECTION ({@link stripSiblingOwnedParentMembers}): a member a sibling
 *    record of the stack writes is dropped from BOTH comparison sides, unless
 *    the parent's own template declares it too (then the parent owns it as
 *    well). A member nothing in the stack writes is still compared, so an
 *    out-of-band addition still reports, and `--revert` still removes it.
 *  - REVERT ({@link siblingOwnedRevertDesired}): the desired bag drops the same
 *    members, then takes back the LIVE ones from the readback, which is also
 *    `update()`'s previous side: the provider sees each sibling-owned member on
 *    both sides and neither removes nor re-adds it, on the SDK route and on
 *    Cloud Control, whose readback is not filtered.
 *  - DEPLOY ({@link tableMembersSiblingsStoppedWriting}): when a deploy makes a
 *    sibling stop writing a member (the child removed or changed), the parent's
 *    recorded baseline drops it, so drift does not report it as lost and
 *    `--revert` does not put it back.
 *
 * A WHOLE-KEY row (no `identity`) is a child that owns the parent's entire
 * property: `PutClusterCapacityProviders` replaces a cluster's whole set, so a
 * cluster whose template declares neither list holds only what its
 * association wrote.
 */
import type { ReadCurrentStateContext } from '../types/resource.js';
import { hasOwnKey } from '../utils/own-keys.js';
import { injectiveKey } from '../state/record-keys.js';
import {
  previousMaySurvive,
  stripSiblingOwnedMembers,
  type TemplatePolicies,
  type WriterRecord,
} from './iam-sibling-managed-policies.js';
import { stripSiblingOwnedSgRules } from './sg-sibling-rules.js';
import {
  isPlainRecord,
  SIBLING_OWNED_ROWS,
  type MemberCounts,
  type SiblingOwnedRow,
  type SiblingWrite,
} from './sibling-owned-members/rows.js';

export { SIBLING_OWNED_ROWS } from './sibling-owned-members/rows.js';
export { SIBLING_WRITE_PAIRS, type SiblingWritePair } from './sibling-owned-members/pairs.js';

/** Marker for {@link setAt}: remove the key. */
const REMOVE: unique symbol = Symbol('remove');

/** The value at `path` in `bag`, `undefined` when any segment is missing or not an object. */
function getAt(bag: unknown, path: readonly string[]): unknown {
  let node: unknown = bag;
  for (const segment of path) {
    if (!isPlainRecord(node) || !hasOwnKey(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Whether `bag` holds `path` (own keys, every segment). */
function hasAt(bag: unknown, path: readonly string[]): boolean {
  let node: unknown = bag;
  for (const segment of path) {
    if (!isPlainRecord(node) || !hasOwnKey(node, segment)) return false;
    node = node[segment];
  }
  return true;
}

/** `bag` with `value` at `path` (copy-on-write along the path); `path`'s containers must exist. */
function setAt(
  bag: Record<string, unknown>,
  path: readonly string[],
  value: unknown
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return bag;
  if (rest.length === 0) {
    if (value !== REMOVE) return { ...bag, [head]: value };
    const { [head]: _removed, ...kept } = bag;
    return kept;
  }
  const child = bag[head];
  return isPlainRecord(child) ? { ...bag, [head]: setAt(child, rest, value) } : bag;
}

const pathOf = (row: SiblingOwnedRow): string[] => row.key.split('.');

/** The ids `row`'s children may name a parent of `physicalId` by. */
function parentIdsOf(row: SiblingOwnedRow, physicalId: string): string[] {
  return row.parentIds ? row.parentIds(physicalId) : [physicalId];
}

/** For one parent, each row with sibling writes onto it and the members they write (`undefined`: the whole key). */
function ownedByRow(
  resourceType: string,
  physicalId: string | undefined,
  context: ReadCurrentStateContext | undefined
): Array<[SiblingOwnedRow, MemberCounts | undefined]> {
  if (typeof physicalId !== 'string' || physicalId === '') return [];
  const out: Array<[SiblingOwnedRow, MemberCounts | undefined]> = [];
  for (const row of SIBLING_OWNED_ROWS) {
    if (row.parent !== resourceType) continue;
    const ids = new Set(parentIdsOf(row, physicalId));
    const members = new Map<string, number>();
    let any = false;
    for (const sibling of Object.values(context?.siblings ?? {})) {
      if (sibling.resourceType !== row.child || !isPlainRecord(sibling.properties)) continue;
      for (const w of row.writes(sibling.properties, sibling.physicalId)) {
        if (!ids.has(w.parent)) continue;
        any = true;
        if (w.member !== undefined) members.set(w.member, (members.get(w.member) ?? 0) + 1);
      }
    }
    if (any) out.push([row, row.identity ? members : undefined]);
  }
  return out;
}

/**
 * `owned` minus the members the parent's own `properties` declare under
 * `row.key` (one declared copy cancels one written copy): those the parent
 * owns as well, so they stay compared.
 */
function effectiveDrop(
  row: SiblingOwnedRow,
  owned: MemberCounts | undefined,
  properties: Record<string, unknown> | undefined
): Map<string, number> {
  const drop = new Map(owned ?? []);
  const identity = row.identity;
  const own = getAt(properties, pathOf(row));
  if (identity === undefined || drop.size === 0 || !Array.isArray(own)) return drop;
  for (const entry of own) {
    const id = identity(entry);
    const n = id === undefined ? undefined : drop.get(id);
    if (n === undefined) continue;
    if (n <= 1) drop.delete(id!);
    else drop.set(id!, n - 1);
  }
  return drop;
}

/**
 * For a {@link SiblingOwnedRow.nameOf} row and a BASELINE bag (`readback`
 * given): the names a sibling writes that the readback holds no member of and
 * the parent's template does not declare. The parent's own readback dropped
 * such a member by name (the IAM readers'
 * `collectInlinePolicyNamesManagedBySiblings`), so a baseline copy of it under
 * any document is the sibling's.
 */
function namesDroppedFromBaseline(
  row: SiblingOwnedRow,
  drop: MemberCounts,
  properties: Record<string, unknown> | undefined,
  readback: Record<string, unknown> | undefined
): Set<string> {
  const { nameOf, memberName } = row;
  if (nameOf === undefined || memberName === undefined || readback === undefined) return new Set();
  const liveList = getAt(readback, pathOf(row));
  const live = new Set(Array.isArray(liveList) ? liveList.map((m) => nameOf(m)) : []);
  const own = getAt(properties, pathOf(row));
  const declared = new Set(Array.isArray(own) ? own.map((m) => nameOf(m)) : []);
  const names = new Set<string>();
  for (const id of drop.keys()) {
    const name = memberName(id);
    if (name !== undefined && !live.has(name) && !declared.has(name)) names.add(name);
  }
  return names;
}

/**
 * `bag` without `row`'s members in `owned` (all of `row.key` for a whole-key
 * row) that the parent's own `properties` do not declare. Returned by identity
 * when nothing is dropped.
 */
function withoutOwned(
  bag: Record<string, unknown>,
  row: SiblingOwnedRow,
  owned: MemberCounts | undefined,
  properties: Record<string, unknown> | undefined,
  readback?: Record<string, unknown>
): Record<string, unknown> {
  const path = pathOf(row);
  if (!hasAt(bag, path)) return bag;
  const declared = hasAt(properties, path);
  if (row.identity === undefined) return declared ? bag : setAt(bag, path, REMOVE);
  const list = getAt(bag, path);
  if (!Array.isArray(list)) return bag;
  const identity = row.identity;
  const drop = effectiveDrop(row, owned, properties);
  if (drop.size === 0) return bag;
  const byName = namesDroppedFromBaseline(row, drop, properties, readback);
  // Each written copy drops ONE matching member: a second member of the same
  // identity (two same-named EMR groups) is nobody's, so it stays compared.
  const left = new Map(drop);
  const kept = list.filter((m) => {
    const id = identity(m);
    const n = id === undefined ? undefined : left.get(id);
    if (n !== undefined && n > 0) {
      left.set(id!, n - 1);
      return false;
    }
    const name = row.nameOf?.(m);
    return name === undefined || !byName.has(name);
  });
  if (kept.length === list.length) return bag;
  return setAt(bag, path, kept.length === 0 && row.emptyMeansAbsent && !declared ? REMOVE : kept);
}

/**
 * The detection pass: `baseline` and `aws` without every member a SIBLING
 * record of the stack writes onto this resource — the IAM attachment lists
 * (`stripSiblingOwnedMembers`), a security group's inline rules
 * (`stripSiblingOwnedSgRules`) and every {@link SIBLING_OWNED_ROWS} row. A
 * member the resource's own template declares stays compared. Non-mutating;
 * each bag is returned by identity when it has nothing to drop.
 */
export function stripSiblingOwnedParentMembers(
  resourceType: string,
  physicalId: string | undefined,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): { baseline: Record<string, unknown>; aws: Record<string, unknown> } {
  const members = stripSiblingOwnedMembers(
    resourceType,
    physicalId,
    baseline,
    aws,
    properties,
    context
  );
  let out = stripSiblingOwnedSgRules(
    resourceType,
    physicalId,
    members.baseline,
    members.aws,
    properties,
    context
  );
  for (const [row, owned] of ownedByRow(resourceType, physicalId, context)) {
    out = {
      baseline: withoutOwned(out.baseline, row, owned, properties, out.aws),
      aws: withoutOwned(out.aws, row, owned, properties),
    };
  }
  return out;
}

/**
 * The revert pass over the DESIRED bag (the recorded baseline): the members
 * {@link stripSiblingOwnedParentMembers} dropped leave it, and for a
 * {@link SIBLING_OWNED_ROWS} row the LIVE sibling-owned members of `aws` (the
 * raw readback, `update()`'s previous side) come back in. A provider then
 * finds each such member on both sides and neither removes nor re-adds it,
 * whether or not its own readback filtered it. The two older helpers' members
 * need no re-add: their providers' readbacks never carry them.
 */
export function siblingOwnedRevertDesired(
  resourceType: string,
  physicalId: string | undefined,
  desired: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): Record<string, unknown> {
  let out = stripSiblingOwnedMembers(
    resourceType,
    physicalId,
    desired,
    aws,
    properties,
    context
  ).baseline;
  out = stripSiblingOwnedSgRules(resourceType, physicalId, out, aws, properties, context).baseline;
  for (const [row, owned] of ownedByRow(resourceType, physicalId, context)) {
    const path = pathOf(row);
    const stripped = withoutOwned(out, row, owned, properties, aws);
    const live = getAt(aws, path);
    if (row.identity === undefined) {
      // Whole key: it never drifts (both sides drop it), so the overlay sends
      // the live value and the desired bag needs none.
      out = stripped;
      continue;
    }
    const drop = effectiveDrop(row, owned, properties);
    if (!Array.isArray(live) || drop.size === 0) {
      out = stripped;
      continue;
    }
    const identity = row.identity;
    const strippedList = getAt(stripped, path);
    // A list the parent's read omits when empty (`emptyMeansAbsent`) may be
    // absent from the desired bag, removed by the strip or never captured:
    // the live members still go back, into the container the desired bag
    // holds. A desired bag without that container is left alone.
    const kept = Array.isArray(strippedList)
      ? strippedList
      : row.emptyMeansAbsent && strippedList === undefined
        ? []
        : undefined;
    if (kept === undefined || !hasAt(stripped, path.slice(0, -1))) {
      out = stripped;
      continue;
    }
    // Each live sibling-owned member goes back at its live position, so a
    // provider that pairs list items by position sees them where they are.
    const result = [...kept];
    // Up to the written count of each identity: the strip took exactly that
    // many copies out, so a copy still in `result` is NOT a sibling's (a
    // second same-identity member) and does not count against the re-add.
    const room = new Map(drop);
    live.forEach((m, index) => {
      const id = identity(m);
      const n = id === undefined ? undefined : room.get(id);
      if (n === undefined || n <= 0) return;
      result.splice(Math.min(index, result.length), 0, m);
      room.set(id!, n - 1);
    });
    out =
      result.length === kept.length && Array.isArray(strippedList)
        ? stripped
        : setAt(stripped, path, result);
  }
  return out;
}

/** A {@link SIBLING_OWNED_ROWS} key of one record and what to drop from its baseline (`undefined`: the whole key). */
export interface StoppedTableMembers {
  row: SiblingOwnedRow;
  members: MemberCounts | undefined;
}

/**
 * go-to-k/cdkd#6610, the {@link SIBLING_OWNED_ROWS} twin of
 * `membersSiblingsStoppedWriting` (go-to-k/cdkd#6343): per logical id of
 * `next`, the members a sibling record wrote onto it before this deploy
 * (`previous`) and no longer writes after it. The deploy's own operation on
 * that sibling (its delete, or its update) has just removed them from AWS, so
 * a parent baseline still holding one would read as lost and `--revert` would
 * put it back. The evidence is the sibling's RECORDED write; a sibling whose
 * previous resource may survive the deploy (`previousMaySurvive`) stopped
 * nothing. In memory only; no AWS call.
 */
export function tableMembersSiblingsStoppedWriting(
  previous: Readonly<Record<string, WriterRecord>>,
  next: Readonly<Record<string, WriterRecord>>,
  oldMaySurvive: (logicalId: string) => boolean = () => false,
  templatePolicies?: TemplatePolicies
): Map<string, StoppedTableMembers[]> {
  const encode = (row: number, parent: string, member: string | undefined): string =>
    injectiveKey(row, parent, member === undefined ? '' : `m:${member}`);
  const writesOf = (record: WriterRecord): Array<[number, SiblingWrite]> => {
    const props = record.properties;
    if (!isPlainRecord(props)) return [];
    const out: Array<[number, SiblingWrite]> = [];
    SIBLING_OWNED_ROWS.forEach((row, index) => {
      if (row.child !== record.resourceType) return;
      for (const w of row.writes(props, record.physicalId)) out.push([index, w]);
    });
    return out;
  };
  const count = (into: Map<string, number>, key: string): void => {
    into.set(key, (into.get(key) ?? 0) + 1);
  };
  // How many records write each (row, parent id, member) after the deploy.
  const nextCount = new Map<string, number>();
  for (const record of Object.values(next)) {
    for (const [i, w] of writesOf(record)) count(nextCount, encode(i, w.parent, w.member));
  }
  // ...and how many wrote it before, among the records whose previous AWS
  // resource is gone (a survivor still writes what it wrote).
  const prevCount = new Map<string, number>();
  // injectiveKey(row index, parent id) -> the members written there (whole key: none)
  const touched = new Map<string, { row: number; members: Set<string> | undefined }>();
  for (const [logicalId, record] of Object.entries(previous)) {
    const writes = writesOf(record);
    if (writes.length === 0) continue;
    if (previousMaySurvive(logicalId, record, next, oldMaySurvive, templatePolicies)) continue;
    for (const [i, w] of writes) {
      count(prevCount, encode(i, w.parent, w.member));
      const target = injectiveKey(i, w.parent);
      let entry = touched.get(target);
      if (entry === undefined) {
        entry = { row: i, members: w.member === undefined ? undefined : new Set() };
        touched.set(target, entry);
      }
      if (w.member !== undefined) entry.members?.add(w.member);
    }
  }
  const result = new Map<string, StoppedTableMembers[]>();
  if (touched.size === 0) return result;
  for (const [logicalId, record] of Object.entries(next)) {
    const id = record.physicalId;
    if (typeof id !== 'string' || id === '') continue;
    const entries: StoppedTableMembers[] = [];
    SIBLING_OWNED_ROWS.forEach((row, index) => {
      if (row.parent !== record.resourceType) return;
      // Every id the parent answers to: a sibling writing under ANY of them
      // (an association replaced by one naming the address the other way)
      // counts as still writing.
      const ids = [...new Set(parentIdsOf(row, id))];
      const sum = (counts: Map<string, number>, member: string | undefined): number =>
        ids.reduce((n, pid) => n + (counts.get(encode(index, pid, member)) ?? 0), 0);
      const members = new Set<string>();
      let wholeKey = false;
      for (const pid of ids) {
        const entry = touched.get(injectiveKey(index, pid));
        if (entry === undefined) continue;
        if (entry.members === undefined) wholeKey = true;
        else for (const m of entry.members) members.add(m);
      }
      if (wholeKey) {
        // The whole key is a writer's until the LAST writer stops.
        if (sum(nextCount, undefined) === 0) entries.push({ row, members: undefined });
        return;
      }
      // A member stops as many times as its writers dropped: two same-named
      // EMR groups of which one is removed stop one copy, not both.
      const stopped = new Map<string, number>();
      for (const m of members) {
        const n = sum(prevCount, m) - sum(nextCount, m);
        if (n > 0) stopped.set(m, n);
      }
      if (stopped.size > 0) entries.push({ row, members: stopped });
    });
    if (entries.length > 0) result.set(logicalId, entries);
  }
  return result;
}

/**
 * `bag` without the {@link tableMembersSiblingsStoppedWriting} members the
 * resource's own `properties` do not declare. A whole-key LIST is left EMPTY
 * (`[]`), what the parent reads once its writer is gone; a whole-key scalar
 * (an EIP's `InstanceId`) leaves the bag, as a read of an unassociated address
 * omits it. Returned by identity when nothing changes.
 */
export function withoutStoppedTableMembers(
  bag: Record<string, unknown>,
  stopped: readonly StoppedTableMembers[],
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  let out = bag;
  for (const { row, members } of stopped) {
    if (row.identity !== undefined) {
      out = withoutOwned(out, row, members, properties);
      continue;
    }
    const path = pathOf(row);
    const value = getAt(out, path);
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    if (hasAt(properties, path)) continue;
    out = setAt(out, path, Array.isArray(value) ? [] : REMOVE);
  }
  return out;
}
