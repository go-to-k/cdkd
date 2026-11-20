/**
 * Carry AWS-defaulted NESTED create-only members into a Cloud Control patch
 * op that writes their whole parent object (go-to-k/cdkd#6294).
 *
 * `JsonPatchGenerator` diffs top-level keys only, so a change to any member
 * of an object property is sent as `replace /<Key>` with the template's
 * object. Cloud Control applies the patch to the model it READS, where AWS
 * filled in members the template never declared, so the written object drops
 * them. When such a member is create-only, Cloud Control sees it "changed" and
 * refuses the whole update (`NotUpdatableException: createOnlyProperties
 * [/properties/HealthCheckConfig/MeasureLatency] cannot be updated`), though
 * CloudFormation applies the same template change in place: its handler
 * compares the template models, where the member is absent on both sides.
 *
 * A nested READ-ONLY member is refused the same way (go-to-k/cdkd#6553:
 * `readOnlyProperties [/properties/Code/SourceLocationArn] cannot be updated`
 * on every canary script change), so those are carried too
 * ({@link nestedReadOnlyGaps}). A template cannot declare a read-only member,
 * so the live one is the only value it can have. A leaf whose parent object
 * the op still writes is carried alone; when an object above the leaf is
 * absent from the op AND from the previous properties (the template never
 * declared it, as an Athena workgroup's `EngineVersion`: go-to-k/cdkd#6561),
 * the whole live object is carried, so the patch leaves it as AWS holds it.
 * One the previous properties hold was REMOVED by the template: for a
 * MEASURED path only ({@link REMOVED_BLOCK_LEAF_CARRY}), the object is sent
 * as the measured writable defaults plus the live read-only leaf, the state
 * CloudFormation leaves; no removed value is written back.
 *
 * Only create-only members the DESIRED object omits are carried, and only
 * from the live model: a declared one is the template's (a change there is a
 * replacement the engine decided before this runs), and nothing else under
 * the key changes. A LEAF: no imports beyond the patch type.
 */

import type { JsonPatchOp } from './json-patch-generator.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The top-level key a whole-object op writes, or `undefined`. */
function topLevelKeyOf(op: JsonPatchOp): string | undefined {
  if (op.op !== 'add' && op.op !== 'replace') return undefined;
  const pointer = op.path.slice(1);
  if (!op.path.startsWith('/') || pointer.includes('/')) return undefined;
  return pointer.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Whether any op of `patch` writes a whole top-level object. */
export function writesTopLevelObject(patch: readonly JsonPatchOp[]): boolean {
  return patch.some((op) => topLevelKeyOf(op) !== undefined && isPlainObject(op.value));
}

/**
 * Whether `root` omits `path`: every node down to the first absent one is a
 * plain object, and some node on the path is absent.
 */
function omitsThroughObjects(root: Record<string, unknown>, path: readonly string[]): boolean {
  let node: Record<string, unknown> = root;
  for (const segment of path) {
    if (!Object.hasOwn(node, segment)) return true;
    const next = node[segment];
    if (!isPlainObject(next)) return false;
    node = next;
  }
  return false;
}

/** The value at `path` under `root`, through plain objects only. */
function valueAt(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const segment of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Each nested create-only path (below a top-level key) that an `add` /
 * `replace` op of `patch` writes an object for WITHOUT declaring it: the
 * paths whose live value must be carried. Empty means no read is needed.
 * A member is omitted when it, or an object above it, is absent; a path
 * through an array (a `*` segment) or another non-object is never listed.
 */
export function nestedCreateOnlyGaps(
  patch: readonly JsonPatchOp[],
  createOnlyPaths: ReadonlyArray<readonly string[]>
): string[][] {
  const gaps: string[][] = [];
  for (const op of patch) {
    const key = topLevelKeyOf(op);
    if (key === undefined || !isPlainObject(op.value)) continue;
    for (const path of createOnlyPaths) {
      if (path.length < 2 || path[0] !== key) continue;
      if (omitsThroughObjects(op.value, path.slice(1))) gaps.push([...path]);
    }
  }
  return gaps;
}

/**
 * The index in `path` of the first segment `root` lacks, walking plain
 * objects only; `-1` when every segment is present or a non-object stops
 * the walk first.
 */
function firstAbsentIndex(root: Record<string, unknown>, path: readonly string[]): number {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!;
    if (!Object.hasOwn(node, segment)) return i;
    const next = node[segment];
    if (!isPlainObject(next)) return -1;
    node = next;
  }
  return -1;
}

/**
 * Nested read-only leaves (dotted, top-level key first) carried when the
 * template REMOVED the object holding them, each with the WRITABLE defaults
 * that object is sent with. Cloud Control refuses the op unless the
 * AWS-owned leaf survives, and the type's handler may refuse an object
 * holding the leaf alone, so neither part is knowable from the schema: an
 * entry joins only after a CloudFormation A/B measurement of BOTH the leaf
 * and the defaults, which make the op write the state CloudFormation leaves.
 *
 * Athena (go-to-k/cdkd#6561, measured, not inferred): after removing a
 * declared `EngineVersion`, CloudFormation leaves
 * `{ SelectedEngineVersion: 'AUTO', EffectiveEngineVersion: <unchanged> }`;
 * the leaf alone was refused (`The selected engine version is not valid`).
 */
export const REMOVED_BLOCK_LEAF_CARRY: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
> = {
  'AWS::Athena::WorkGroup': {
    'WorkGroupConfiguration.EngineVersion.EffectiveEngineVersion': {
      SelectedEngineVersion: 'AUTO',
    },
  },
};

/** The measured removed-block entries of `resourceType`, by own key only. */
function removedBlockEntries(
  resourceType: string | undefined
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  // Own keys only: a template `Type` such as `constructor` must not read the
  // prototype.
  return resourceType !== undefined && Object.hasOwn(REMOVED_BLOCK_LEAF_CARRY, resourceType)
    ? REMOVED_BLOCK_LEAF_CARRY[resourceType]!
    : {};
}

/**
 * `patch` with the measured writable defaults
 * ({@link REMOVED_BLOCK_LEAF_CARRY}) set as the object holding each listed
 * leaf, where an op writes that leaf's top-level key without the object
 * and `previous` holds it (the template removed it). Run on the patch the
 * gaps were found in, before {@link withCarriedCreateOnlyMembers} adds the
 * live leaf into the object. The ops are copied, never mutated.
 */
export function withRemovedBlockDefaults(
  patch: readonly JsonPatchOp[],
  previous: Record<string, unknown>,
  resourceType: string
): JsonPatchOp[] {
  const entries = Object.entries(removedBlockEntries(resourceType));
  if (entries.length === 0) return [...patch];
  return patch.map((op) => {
    const key = topLevelKeyOf(op);
    if (key === undefined || !isPlainObject(op.value)) return op;
    let value: Record<string, unknown> | undefined;
    for (const [leaf, defaults] of entries) {
      const object = leaf.split('.').slice(0, -1);
      if (object.length < 2 || object[0] !== key) continue;
      if (valueAt(previous, object) === undefined) continue;
      if (firstAbsentIndex(value ?? op.value, object.slice(1)) === -1) continue;
      value ??= structuredClone(op.value);
      let parent = value;
      for (const segment of object.slice(1, -1)) {
        if (!isPlainObject(parent[segment])) parent[segment] = {};
        parent = parent[segment] as Record<string, unknown>;
      }
      parent[object[object.length - 1]!] = structuredClone(defaults);
    }
    return value === undefined ? op : { ...op, value };
  });
}

/**
 * Top-level properties, per type, whose REMOVAL Cloud Control refuses
 * because a read-only member lives directly under them, and which the type's
 * handler clears when sent as an empty object instead. Each entry is
 * MEASURED: Route 53 (go-to-k/cdkd#6690, us-east-1) refused
 * `remove /HostedZoneFeatures` and a `replace` without `ChangeHistory`
 * (`readOnlyProperties [/properties/HostedZoneFeatures/ChangeHistory] cannot
 * be updated`), and applied `replace /HostedZoneFeatures` holding only the
 * live `ChangeHistory`, disabling the change guardrails it had enabled.
 */
export const REMOVED_TOP_LEVEL_AS_EMPTY: Readonly<Record<string, readonly string[]>> = {
  'AWS::Route53::HostedZone': ['HostedZoneFeatures'],
};

/**
 * `patch` with each measured top-level `remove` ({@link REMOVED_TOP_LEVEL_AS_EMPTY})
 * sent as `replace` with an empty object, so {@link nestedReadOnlyGaps}
 * carries the live read-only member into it. The ops are copied, never mutated.
 */
export function withMeasuredRemovalsAsEmpty(
  patch: readonly JsonPatchOp[],
  resourceType: string
): JsonPatchOp[] {
  const keys = Object.hasOwn(REMOVED_TOP_LEVEL_AS_EMPTY, resourceType)
    ? REMOVED_TOP_LEVEL_AS_EMPTY[resourceType]!
    : [];
  if (keys.length === 0) return [...patch];
  return patch.map((op) =>
    op.op === 'remove' && keys.some((key) => op.path === `/${key}`)
      ? { op: 'replace', path: op.path, value: {} }
      : op
  );
}

/**
 * The paths a whole-object `add` / `replace` op of `patch` must carry from
 * the live model for each nested READ-ONLY path (go-to-k/cdkd#6553):
 *
 * - every object above the leaf is present in the op's value and the leaf is
 *   not: the leaf itself;
 * - an object above the leaf is absent from the op's value AND from
 *   `previous` (go-to-k/cdkd#6561): that topmost absent object, whole. The
 *   template never declared it on either side, so CloudFormation leaves it
 *   as AWS holds it; carrying the live object is what does that here. The
 *   leaf alone would drop the object's writable members AWS holds (an
 *   Athena workgroup's `EngineVersion.SelectedEngineVersion`) — a change no
 *   template asked for.
 *
 * - an object above the leaf is absent from the op's value but present in
 *   `previous`: the template REMOVED it. For a `resourceType` + leaf listed
 *   in {@link REMOVED_BLOCK_LEAF_CARRY}, the leaf itself, carried into the
 *   object {@link withRemovedBlockDefaults} writes with the measured
 *   defaults; for any other, nothing (#6554), and Cloud Control refuses the
 *   op loudly.
 *
 * Without `previous` only the first rule applies. Each path is listed once.
 */
export function nestedReadOnlyGaps(
  patch: readonly JsonPatchOp[],
  readOnlyPaths: ReadonlyArray<readonly string[]>,
  previous?: Record<string, unknown>,
  resourceType?: string
): string[][] {
  const measured = new Set(Object.keys(removedBlockEntries(resourceType)));
  const gaps: string[][] = [];
  const listed = new Set<string>();
  const list = (gap: string[]): void => {
    const id = JSON.stringify(gap);
    if (listed.has(id)) return;
    listed.add(id);
    gaps.push(gap);
  };
  for (const op of patch) {
    const key = topLevelKeyOf(op);
    if (key === undefined || !isPlainObject(op.value)) continue;
    for (const path of readOnlyPaths) {
      if (path.length < 2 || path[0] !== key) continue;
      const absent = firstAbsentIndex(op.value, path.slice(1));
      if (absent === -1) continue;
      if (absent === path.length - 2) {
        list([...path]);
        continue;
      }
      // Absent on both sides: carried whole. That CloudFormation leaves such
      // an object as AWS holds it was MEASURED for Athena only (A/B in
      // go-to-k/cdkd#6561); for other types it is inferred from the same
      // model comparison. Residual: an op that declares part of a property
      // while AWS defaulted a sibling object (an MWAA `LoggingConfiguration`
      // omitting `TaskLogs`) now carries that sibling from the live model, at
      // the cost of one `GetResource`.
      if (previous === undefined) continue;
      const object = path.slice(0, absent + 2);
      if (valueAt(previous, object) === undefined) list(object);
      else if (measured.has(path.join('.'))) list([...path]);
    }
  }
  return gaps;
}

/**
 * `patch` with each gap's LIVE value set into the op writing it, creating
 * any object above it the op omits. A gap the live model does not hold is
 * left absent (nothing to carry); the ops are copied, never mutated.
 */
export function withCarriedCreateOnlyMembers(
  patch: readonly JsonPatchOp[],
  gaps: ReadonlyArray<readonly string[]>,
  liveModel: Record<string, unknown>
): JsonPatchOp[] {
  return patch.map((op) => {
    const key = topLevelKeyOf(op);
    if (key === undefined || !isPlainObject(op.value)) return op;
    let value: Record<string, unknown> | undefined;
    for (const path of gaps) {
      if (path[0] !== key) continue;
      const live = valueAt(liveModel, path);
      if (live === undefined) continue;
      value ??= structuredClone(op.value);
      const rest = path.slice(1);
      let parent = value;
      for (const segment of rest.slice(0, -1)) {
        if (!isPlainObject(parent[segment])) parent[segment] = {};
        parent = parent[segment] as Record<string, unknown>;
      }
      parent[rest[rest.length - 1]!] = live;
    }
    return value === undefined ? op : { ...op, value };
  });
}
