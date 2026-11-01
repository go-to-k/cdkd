/**
 * `VectorIndexes` on `AWS::DynamoDB::Table` and `AWS::DynamoDB::GlobalTable`
 * (go-to-k/cdkd#2762): the CFn entry's wire shape, the comparison that decides
 * whether a same-name index changed, the per-`UpdateTable` plan, and the
 * readback.
 *
 * The CFn `VectorIndex` and the SDK's `VectorIndex` / `CreateVectorIndexAction`
 * share every member name (`IndexName`, `VectorAttribute.AttributeName`,
 * `Dimensions`, `DistanceFunction`, `Projection`, `SearchSchema[]
 * .{AttributeName, SearchSchemaElementType}`), so the entry is forwarded member
 * by member, with `Dimensions` read on CloudFormation's Integer grammar.
 *
 * `UpdateTable` takes `VectorIndexUpdates[]` of `Create` / `Delete` only — no
 * in-place modify — and adds or removes ONE vector index per call (the SDK
 * model's `UpdateTableInput.VectorIndexUpdates` documentation), the GSI rule.
 * So a same-name index whose definition changed cannot be applied; `update()`
 * refuses it before any call, as it does a changed GSI `KeySchema` /
 * `Projection`.
 */

import type {
  CreateVectorIndexAction,
  VectorIndex,
  VectorIndexDescription,
  VectorIndexUpdate,
} from '@aws-sdk/client-dynamodb';
import { coerceCfnInteger } from './config-shape.js';

type Entry = Record<string, unknown>;

/** The entries of a `VectorIndexes` value, keyed by a string `IndexName`. */
export function vectorIndexesByName(value: unknown): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (!Array.isArray(value)) return out;
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const name = (entry as Entry)['IndexName'];
    if (typeof name === 'string') out.set(name, entry as Entry);
  }
  return out;
}

/**
 * Why a declared `VectorIndexes` value cannot be planned, or `undefined`: a
 * value that is no list, or an entry with no string `IndexName`.
 * {@link vectorIndexesByName} reads either as "not declared", so a plan built on
 * it would delete every recorded index. Both providers' `update()` refuse on it
 * on the template path and warn with no plan on a state-borne bag.
 */
export function vectorIndexesShapeDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return `VectorIndexes must be a list, got ${value === null ? 'null' : typeof value}`;
  }
  const named = (value as unknown[]).every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      typeof (entry as Entry)['IndexName'] === 'string'
  );
  return named ? undefined : `every VectorIndexes entry must carry a string IndexName`;
}

/**
 * The SDK shape of one CFn `VectorIndex` entry. Members are forwarded by name;
 * an absent optional one stays absent. `Dimensions` is coerced onto the
 * Integer grammar (a template may spell it `"1024"`); a value that is no
 * integer goes out as written, for AWS to reject by name — the fail-open
 * direction the GSI forwarders take.
 */
export function vectorIndexForSend(entry: Entry): VectorIndex & CreateVectorIndexAction {
  const out: Entry = {};
  for (const key of ['IndexName', 'VectorAttribute', 'Projection', 'DistanceFunction']) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  if (entry['Dimensions'] !== undefined) {
    out['Dimensions'] = coerceCfnInteger(entry['Dimensions']) ?? entry['Dimensions'];
  }
  if (entry['SearchSchema'] !== undefined) out['SearchSchema'] = entry['SearchSchema'];
  return out as unknown as VectorIndex & CreateVectorIndexAction;
}

/** `CreateTable.VectorIndexes` for a declared list; a non-array passes through for AWS to reject. */
export function vectorIndexesForCreate(value: unknown): VectorIndex[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return value as VectorIndex[];
  return (value as unknown[]).map((entry) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? vectorIndexForSend(entry as Entry)
      : (entry as VectorIndex)
  );
}

/** Sort a list of strings / objects by its JSON spelling (CFn `insertionOrder: false`). */
function sortedByJson(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return [...(list as unknown[])].sort((a, b) => {
    const x = JSON.stringify(a) ?? '';
    const y = JSON.stringify(b) ?? '';
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * The comparison key of one index's definition: every member, `Dimensions`
 * coerced, and the two unordered lists (`SearchSchema`, CFn
 * `insertionOrder: false`, and `Projection.NonKeyAttributes`) sorted. Two
 * entries with the same key describe the same index.
 */
export function vectorIndexKey(entry: Entry | VectorIndexDescription): string {
  const e = entry as Entry;
  const projection = e['Projection'];
  const normalizedProjection =
    typeof projection === 'object' && projection !== null && !Array.isArray(projection)
      ? {
          ProjectionType: (projection as Entry)['ProjectionType'],
          NonKeyAttributes: sortedByJson(nonEmpty((projection as Entry)['NonKeyAttributes'])),
        }
      : projection;
  const attribute = e['VectorAttribute'];
  return JSON.stringify([
    e['IndexName'],
    typeof attribute === 'object' && attribute !== null
      ? (attribute as Entry)['AttributeName']
      : attribute,
    coerceCfnInteger(e['Dimensions']) ?? e['Dimensions'],
    e['DistanceFunction'],
    normalizedProjection,
    sortedByJson(
      Array.isArray(e['SearchSchema']) && (e['SearchSchema'] as unknown[]).length > 0
        ? (e['SearchSchema'] as unknown[]).map((s) =>
            typeof s === 'object' && s !== null
              ? {
                  AttributeName: (s as Entry)['AttributeName'],
                  SearchSchemaElementType: (s as Entry)['SearchSchemaElementType'],
                }
              : s
          )
        : nonEmpty(e['SearchSchema'])
    ),
  ]);
}

/**
 * An empty list reads as absent: AWS may report `[]` where the template omits
 * the member, and the readback drops an empty `SearchSchema`, so a recorded or
 * live `[]` must not read as a definition change (a retried deploy would then
 * refuse instead of adopting).
 */
function nonEmpty(value: unknown): unknown {
  return Array.isArray(value) && value.length === 0 ? undefined : value;
}

/** The outcome of {@link planVectorIndexUpdates}. */
export interface VectorIndexPlan {
  /** One `VectorIndexUpdates` op per `UpdateTable`: every Delete, then every Create. */
  ops: VectorIndexUpdate[];
  /** Same-name indexes whose definition changed and AWS does not already hold: refused. */
  changed: string[];
  /** Added names AWS already holds with the desired definition: Create skipped. */
  adopted: string[];
  /** Removed names AWS no longer holds: Delete skipped. */
  alreadyGone: string[];
}

/**
 * Plan the vector-index ops for an update, keyed by `IndexName`.
 *
 * `live` is the `DescribeTable` snapshot's `VectorIndexes`, or `undefined` for
 * no snapshot (which disables both idempotency arms). A `DELETING` live index
 * counts as absent: a Create re-creates it, and its Delete is not re-sent.
 *
 * - A name the previous side has and the desired side lacks is deleted, unless
 *   AWS no longer has it (or is already deleting it) (an index the record names but AWS lost would
 *   otherwise fail every deploy with `ResourceNotFoundException`).
 * - A name the desired side adds is created, unless AWS already holds it (an
 *   earlier deploy created it and failed before state was written): then the
 *   live definition must equal the desired one, or the name is `changed`.
 * - A name on both sides whose definition changed is `changed`, unless AWS
 *   already holds the desired definition (a record that lags AWS).
 */
export function planVectorIndexUpdates(
  previous: unknown,
  desired: unknown,
  live: readonly VectorIndexDescription[] | undefined
): VectorIndexPlan {
  const prevByName = vectorIndexesByName(previous);
  const desiredByName = vectorIndexesByName(desired);
  const liveByName =
    live === undefined
      ? undefined
      : new Map(
          live
            .filter((d) => typeof d.IndexName === 'string')
            .map((d) => [d.IndexName as string, d] as const)
        );
  const plan: VectorIndexPlan = { ops: [], changed: [], adopted: [], alreadyGone: [] };
  const liveHolds = (name: string, entry: Entry): boolean => {
    const l = liveByName?.get(name);
    return (
      l !== undefined && l.IndexStatus !== 'DELETING' && vectorIndexKey(l) === vectorIndexKey(entry)
    );
  };

  for (const name of prevByName.keys()) {
    if (desiredByName.has(name)) continue;
    const l = liveByName?.get(name);
    // A DELETING index is already on its way out (a Delete an earlier,
    // failed deploy issued): a second Delete is refused once it is gone.
    if (liveByName !== undefined && (l === undefined || l.IndexStatus === 'DELETING')) {
      plan.alreadyGone.push(name);
      continue;
    }
    plan.ops.push({ Delete: { IndexName: name } });
  }
  for (const [name, entry] of desiredByName) {
    const before = prevByName.get(name);
    if (before === undefined) {
      const l = liveByName?.get(name);
      if (l === undefined || l.IndexStatus === 'DELETING') {
        plan.ops.push({ Create: vectorIndexForSend(entry) });
      } else if (liveHolds(name, entry)) {
        plan.adopted.push(name);
      } else {
        plan.changed.push(name);
      }
      continue;
    }
    if (vectorIndexKey(before) === vectorIndexKey(entry)) continue;
    if (!liveHolds(name, entry)) plan.changed.push(name);
  }
  return plan;
}

/**
 * The live `VectorIndexes` in their CFn shape, or `undefined` when AWS reports
 * none (an absent list, never a `[]` placeholder that would read back as
 * "remove every index"). Only the CFn members are kept: `IndexStatus`,
 * `Backfilling` and `IndexSizeBytes` are AWS-managed.
 */
export function readbackVectorIndexes(
  live: readonly VectorIndexDescription[] | undefined
): Entry[] | undefined {
  if (live === undefined || live.length === 0) return undefined;
  return live.map((d) => {
    const out: Entry = {};
    if (d.IndexName !== undefined) out['IndexName'] = d.IndexName;
    if (d.VectorAttribute !== undefined) out['VectorAttribute'] = d.VectorAttribute;
    if (d.Dimensions !== undefined) out['Dimensions'] = d.Dimensions;
    if (d.DistanceFunction !== undefined) out['DistanceFunction'] = d.DistanceFunction;
    if (d.Projection !== undefined) out['Projection'] = d.Projection;
    if (d.SearchSchema !== undefined && d.SearchSchema.length > 0) {
      out['SearchSchema'] = d.SearchSchema;
    }
    return out;
  });
}

/** Whether every live vector index has settled (none CREATING / UPDATING / DELETING). */
export function vectorIndexesSettled(live: readonly VectorIndexDescription[] | undefined): boolean {
  return (live ?? []).every((d) => d.IndexStatus === undefined || d.IndexStatus === 'ACTIVE');
}
