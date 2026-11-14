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
