import { holdsMaskLeaf } from '../../../deployment/secret-redaction/recorded-secrecy.js';
import {
  canonicalCoordinates,
  isSingleDynamicReferenceToken,
  noEchoCoordinatesOf,
  noEchoLeavesOf,
  valueAtCoordinate,
  type NoEchoCoordinate,
  type NoEchoPositionSources,
} from '../../../deployment/secret-redaction.js';
import { noEchoAttributeNamesOf } from '../../../deployment/deploy-engine/noecho.js';
import { isSupersededResourceRecord } from '../../../deployment/superseded-resources.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import {
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { keepHeldTokenProvenance } from '../../../deployment/reference-provenance-record.js';
import {
  applyScrubNoEcho,
  scrubMigrationNeedles,
  withoutFnIf,
  type ScrubNoEchoPlan,
} from './noecho.js';
import type { UnpositionedMaskCounts } from './unpositioned.js';

/** A record `state.resources` does not hold: a rollback orphan or a superseded one. */
export interface StoredNoEchoRow {
  /** `orphanSecrets`' key: the orphan's index, or `superseded:<index>`. */
  readonly key: string;
  readonly kind: 'orphan record' | 'superseded record';
  readonly logicalId: string;
  readonly state: ResourceState;
}

/** A stored record whose `NoEcho` positions no evidence names (go-to-k/cdkd#7191). */
export interface UnverifiableNoEchoRecord {
  /** The row's {@link StoredNoEchoRow.key}, which `--mask-unpositioned` rewrites by. */
  readonly key: string;
  readonly kind: StoredNoEchoRow['kind'];
  readonly logicalId: string;
  readonly resourceType: string;
}

/**
 * The orphan and superseded rows, keyed as `orphanSecrets` is. The caller
 * hands both containers in, read below its own guards.
 */
export function storedNoEchoRows(
  orphans: StackState['orphans'] | undefined,
  supersededResources: StackState['supersededResources'] | undefined
): StoredNoEchoRow[] {
  const rows: StoredNoEchoRow[] = [];
  const readable = (record: unknown): record is ResourceState =>
    record !== null &&
    typeof record === 'object' &&
    typeof (record as ResourceState).resourceType === 'string';
  for (const [index, row] of (Array.isArray(orphans) ? orphans : []).entries()) {
    if (readable(row?.state) && typeof row.logicalId === 'string') {
      rows.push({
        key: String(index),
        kind: 'orphan record',
        logicalId: row.logicalId,
        state: row.state,
      });
    }
  }
  const superseded = Array.isArray(supersededResources) ? supersededResources : [];
  for (const [index, row] of superseded.entries()) {
    if (isSupersededResourceRecord(row) && readable(row.state)) {
      rows.push({
        key: `superseded:${index}`,
        kind: 'superseded record',
        logicalId: row.logicalId,
        state: row.state,
      });
    }
  }
  return rows;
}

const persisted = (value: unknown): boolean =>
  holdsMaskLeaf(value) || (typeof value === 'string' && isSingleDynamicReferenceToken(value));

/** Whether a bag holds a string leaf that is neither empty nor already the mask or a token. */
function holdsUnmaskedLeaf(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsUnmaskedLeaf);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(holdsUnmaskedLeaf);
  }
  // A string only: a `NoEcho` parameter serves a string (or a list of them).
  return typeof value === 'string' && value !== '' && !persisted(value);
}

/**
 * Plan the `NoEcho` arms of every rollback-orphan and superseded record
 * (go-to-k/cdkd#7191), which `planScrubNoEcho` leaves out: it positions only
 * `state.resources`. The coordinates come from the first evidence that names
 * them, never from a value match:
 *
 * 1. the record's own `noEchoLeaves`, when it names a position (a v11+
 *    writer recorded them);
 * 2. else today's template, where it still declares the logical id as the
 *    record's type, read over the STORED properties (as for a live record);
 * 3. else the live record of the same logical id and type, when its
 *    `noEchoLeaves` name a position (a v11+ deploy positioned that type there);
 * 4. else the record's own EMPTY `noEchoLeaves` (go-to-k/cdkd#7194): a writer
 *    evaluated the record and found no position, so it is positioned, with
 *    none. A live record's empty field is no evidence for this one: it
 *    describes another generation of the logical id.
 *
 * A record none of them positions, that holds an unmasked leaf, in a stack
 * with any `NoEcho` evidence at all, is UNVERIFIABLE: a pre-v11 record whose
 * logical id has left the template keeps no trace of which leaf a `NoEcho`
 * parameter served, so scrub must not call it clean. It is not masked by
 * value: a short value would rewrite unrelated literals.
 *
 * Fn::If is read on both branches (`sources` carries no condition verdicts):
 * the verdicts that wrote an old record are unknown, and masking the other
 * branch's position is the safe direction for state at rest. For the same
 * reason a TEMPLATE coordinate is a migration needle only when a `NoEcho`
 * source fills it under EVERY verdict of its `Fn::If` conditions (an
 * `AWS::NoValue` branch counting as the other branch); the live record's
 * positions, taken as they are, stay needles. Under a verdict that fills it
 * from a public value, the stored value may be that value, and a needle would
 * mask its copies elsewhere in the record by value.
 */
export function planScrubStoredNoEcho(
  state: Pick<StackState, 'resources'>,
  rows: readonly StoredNoEchoRow[],
  template: CloudFormationTemplate,
  sources: NoEchoPositionSources,
  needleSources: NoEchoPositionSources
): {
  byKey: Map<string, ScrubNoEchoPlan>;
  changesAny: boolean;
  unverifiable: UnverifiableNoEchoRecord[];
} {
  const byKey = new Map<string, ScrubNoEchoPlan>();
  const unverifiable: UnverifiableNoEchoRecord[] = [];
  let changesAny = false;
  if (rows.length === 0) return { byKey, changesAny, unverifiable };
  const resources = state.resources ?? {};
  const templateResources = template.Resources ?? {};
  const recordsHoldEvidence = [...Object.values(resources), ...rows.map((row) => row.state)].some(
    (record) =>
      (noEchoLeavesOf(record ?? {})?.length ?? 0) > 0 ||
      (noEchoAttributeNamesOf(record)?.length ?? 0) > 0
  );
  const stackHoldsEvidence = sources.parameters.size > 0 || recordsHoldEvidence;
  for (const row of rows) {
    const record = row.state;
    const own = noEchoLeavesOf(record);
    const definition = Object.hasOwn(templateResources, row.logicalId)
      ? templateResources[row.logicalId]
      : undefined;
    const live = Object.hasOwn(resources, row.logicalId) ? resources[row.logicalId] : undefined;
    const liveLeaves =
      live?.resourceType === record.resourceType ? noEchoLeavesOf(live) : undefined;
    let leaves: NoEchoCoordinate[] | undefined;
    let needleAt: ((coordinate: NoEchoCoordinate) => boolean) | undefined;
    if (own !== undefined && own.length > 0) {
      leaves = canonicalCoordinates(own);
    } else if (definition?.Type === record.resourceType) {
      leaves = canonicalCoordinates(
        noEchoCoordinatesOf(definition.Properties, record.properties, sources, undefined, {
          maskedAt: record.properties,
        })
      );
      const needles = needleCoordinatesOf(definition.Properties, record.properties, needleSources);
      needleAt = (coordinate) => needles.has(JSON.stringify(coordinate));
    } else if (liveLeaves !== undefined && liveLeaves.length > 0) {
      leaves = canonicalCoordinates(liveLeaves);
    } else if (own !== undefined) {
      leaves = [];
    }
    if (leaves === undefined) {
      if (stackHoldsEvidence && holdsUnmaskedLeaf(record.properties)) {
        unverifiable.push({
          key: row.key,
          kind: row.kind,
          logicalId: row.logicalId,
          resourceType: record.resourceType,
        });
      }
      continue;
    }
    const names = new Set(noEchoAttributeNamesOf(record) ?? []);
    for (const [name, attribute] of Object.entries(record.attributes ?? {})) {
      if (attribute === record.physicalId || persisted(attribute)) continue;
      const echoes = leaves.some(
        (coordinate) =>
          coordinate[0] === name &&
          JSON.stringify(valueAtCoordinate(record.properties, coordinate)) ===
            JSON.stringify(attribute)
      );
      if (echoes) names.add(name);
    }
    const attributeNames = [...names].sort();
    if (leaves.length === 0 && attributeNames.length === 0) continue;
    const stored: Array<{ coordinate: NoEchoCoordinate; value: unknown; needle: boolean }> = [];
    for (const coordinate of leaves) {
      const value = valueAtCoordinate(record.properties, coordinate);
      if (value === undefined || value === null || persisted(value)) continue;
      stored.push({
        coordinate,
        value,
        needle: needleAt === undefined || needleAt(coordinate),
      });
    }
    byKey.set(row.key, { leaves, stored, attributeNames });
    const unmaskedAttribute = attributeNames.some(
      (name) => Object.hasOwn(record.attributes ?? {}, name) && !persisted(record.attributes![name])
    );
    if (
      stored.length > 0 ||
      unmaskedAttribute ||
      (leaves.length > 0 && JSON.stringify(record.noEchoLeaves) !== JSON.stringify(leaves))
    ) {
      changesAny = true;
    }
  }
  return { byKey, changesAny, unverifiable };
}

/** Past this many `Fn::If` condition names, no position reached through one is a needle. */
const MAX_NEEDLE_CONDITIONS = 6;

/**
 * The coordinates (JSON keys) a `NoEcho` source fills under EVERY verdict of
 * the `Fn::If` conditions in `properties`: a position some verdict fills from
 * a public value (a literal, a public parameter, an attribute) is no needle.
 * An `AWS::NoValue` branch of a whole value (not a list item) takes the other
 * branch, as that verdict leaves the property absent and the record holds a
 * value there.
 */
function needleCoordinatesOf(
  properties: unknown,
  stored: unknown,
  sources: NoEchoPositionSources
): Set<string> {
  const names = new Set<string>();
  const collapsed = collapseNoValueBranches(properties, names);
  const keysUnder = (template: unknown, conditions?: Record<string, boolean>): Set<string> =>
    new Set(
      canonicalCoordinates(
        noEchoCoordinatesOf(
          template,
          stored,
          conditions === undefined ? sources : { ...sources, conditions },
          undefined,
          { maskedAt: stored }
        )
      ).map((coordinate) => JSON.stringify(coordinate))
    );
  if (names.size > MAX_NEEDLE_CONDITIONS) return keysUnder(withoutFnIf(collapsed));
  const list = [...names];
  let needles: Set<string> | undefined;
  for (let verdicts = 0; verdicts < 2 ** list.length; verdicts++) {
    const conditions = Object.fromEntries(
      list.map((name, i) => [name, (verdicts & (1 << i)) !== 0])
    );
    const keys = keysUnder(collapsed, conditions);
    needles = needles === undefined ? keys : new Set([...needles].filter((key) => keys.has(key)));
  }
  return needles!;
}

/**
 * `node` with an `Fn::If` one of whose branches is `{ Ref: 'AWS::NoValue' }`
 * replaced by its other branch where it is a whole value (not a list item);
 * every condition name an `Fn::If` reads is added to `names`, and one that
 * names none by a string is dropped (`null`).
 */
function collapseNoValueBranches(node: unknown, names: Set<string>, asValue = true): unknown {
  if (Array.isArray(node)) return node.map((item) => collapseNoValueBranches(item, names, false));
  if (node === null || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  const branches = record['Fn::If'];
  if (Object.keys(record).length === 1 && Array.isArray(branches)) {
    const [condition, whenTrue, whenFalse] = branches as unknown[];
    if (typeof condition !== 'string' || branches.length !== 3) return null;
    const noValue = (branch: unknown): boolean =>
      branch !== null &&
      typeof branch === 'object' &&
      (branch as Record<string, unknown>)['Ref'] === 'AWS::NoValue';
    // Only a whole value: in a list the NoValue verdict drops the element and
    // the record holds the rest, so the branch stays to be enumerated.
    if (asValue && noValue(whenFalse)) return collapseNoValueBranches(whenTrue, names);
    if (asValue && noValue(whenTrue)) return collapseNoValueBranches(whenFalse, names);
    names.add(condition);
    return {
      'Fn::If': [
        condition,
        collapseNoValueBranches(whenTrue, names, asValue),
        collapseNoValueBranches(whenFalse, names, asValue),
      ],
    };
  }
  const out: Record<string, unknown> = nullPrototypeRecord();
  for (const [key, inner] of Object.entries(record)) {
    out[key] = collapseNoValueBranches(inner, names);
  }
  return out;
}

/** The per-record warning for an {@link UnverifiableNoEchoRecord}. Names no value. */
export function unverifiableNoEchoRecordWarning(
  shownStack: string,
  record: UnverifiableNoEchoRecord
): string {
  return safeMsg`The ${record.kind} ${record.logicalId} (${record.resourceType}) in ${shownStack} names no NoEcho positions, and today's template no longer declares its logical id as that type: if a cdkd older than state schema v11 wrote it, a NoEcho value may sit in its properties in plaintext, and scrub cannot tell which leaf, so this stack is not reported clean and --fail exits non-zero. ${UNPOSITIONED_REMEDY}`;
}

/**
 * The remedy every unverifiable-record warning names (go-to-k/cdkd#7194):
 * the option, what it does and what it costs.
 */
export const UNPOSITIONED_REMEDY =
  'Re-run scrub with --mask-unpositioned to mask every string value in that record (its properties, observed properties and attributes) and record those positions as NoEcho, which clears this finding. The cost: those values are lost from state, so a later adoption of the record compares and re-sends without them.';

/** The `--dry-run --mask-unpositioned` line for one such record. Counts only, never a value or a key. */
export function unpositionedMaskPlanNote(
  shownStack: string,
  record: UnverifiableNoEchoRecord,
  counts: UnpositionedMaskCounts
): string {
  return safeMsg`--mask-unpositioned would mask, in the ${record.kind} ${record.logicalId} (${record.resourceType}) in ${shownStack}, ${String(counts.properties)} string value(s) in properties, ${String(counts.observed)} in the readback (observed properties) and ${String(counts.attributes)} in attributes (--dry-run, nothing written).`;
}

/** The `--mask-unpositioned` line for one record it masked. Counts only, never a value or a key. */
export function unpositionedMaskDoneNote(
  shownStack: string,
  record: UnverifiableNoEchoRecord,
  counts: UnpositionedMaskCounts
): string {
  return safeMsg`--mask-unpositioned: masked, in the ${record.kind} ${record.logicalId} (${record.resourceType}) in ${shownStack}, ${String(counts.properties)} string value(s) in properties, ${String(counts.observed)} in the readback (observed properties) and ${String(counts.attributes)} in attributes, and recorded those positions as NoEcho.`;
}

/**
 * One orphan or superseded record's rewrite (go-to-k/cdkd#2943 / #5111 /
 * #7191): this run's `needles` by value, then its `NoEcho` plan, the plaintext
 * found at a position a needle of a second pass over this record alone (the
 * live arm's migration rule). `finish` is the stored-record finisher bound to
 * the record as read.
 */
export function scrubStoredRecord(
  state: ResourceState,
  needles: RecordedSecretValues,
  plan: ScrubNoEchoPlan | undefined,
  publicTokens: ReadonlySet<string>,
  finish: (record: ResourceState, needles: RecordedSecretValues) => ResourceState
): ResourceState {
  const migrationNeedles = scrubMigrationNeedles(plan, publicTokens);
  const walk = (bag: RecordedSecretValues, from: ResourceState): ResourceState =>
    scrubResourceRecord(from, bag, undefined, 'state-cross-generation', {
      properties: 'unproven',
      observed: 'unproven',
    });
  let next = needles.size === 0 ? state : walk(needles, state);
  if (migrationNeedles !== undefined) next = walk(migrationNeedles, next);
  if (plan === undefined) {
    return finish(needles.size > 0 ? keepHeldTokenProvenance(next) : next, needles);
  }
  // The finish FIRST, over the record as read (its values) and handed the
  // plan's positions: a pre-v11 record names none, and the finish learns a
  // value too short for a needle only at `noEchoLeaves` (#7188), while the
  // plan's mask would hide that value from the attribute-key drop. The plan
  // then masks, keeping every attribute name the finish declared.
  const positioned =
    plan.leaves.length > 0
      ? { ...next, noEchoLeaves: plan.leaves.map((coordinate) => [...coordinate]) }
      : next;
  const finished = finish(positioned, new Map([...needles, ...(migrationNeedles ?? [])]));
  const attributeNames = [
    ...new Set([...plan.attributeNames, ...(noEchoAttributeNamesOf(finished) ?? [])]),
  ].sort();
  return keepHeldTokenProvenance(applyScrubNoEcho(finished, state, { ...plan, attributeNames }));
}
