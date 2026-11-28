import { SECRET_MASK } from '../../../deployment/secret-redaction/pairs.js';
import { holdsMaskLeaf } from '../../../deployment/secret-redaction/recorded-secrecy.js';
import {
  canonicalCoordinates,
  isSingleDynamicReferenceToken,
  observedMaskedLeavesOf,
  type NoEchoCoordinate,
} from '../../../deployment/secret-redaction.js';
import {
  noEchoAttributeNamesOf,
  withAttemptedItemsMasked,
} from '../../../deployment/deploy-engine/noecho.js';
import type { ResourceState } from '../../../types/state.js';
import {
  unpositionedMaskDoneNote,
  unpositionedMaskPlanNote,
  unverifiableNoEchoRecordWarning,
  type StoredNoEchoRow,
  type UnverifiableNoEchoRecord,
} from './noecho-stored.js';

/**
 * `cdkd scrub --mask-unpositioned` (go-to-k/cdkd#7194): the rewrite of an
 * orphan or superseded record scrub reports as UNVERIFIABLE (no
 * `noEchoLeaves`, its logical id gone from the template or of another type
 * there, no live record to learn from). Nothing says which leaf a `NoEcho`
 * value sat at, so EVERY string leaf that may hold one is masked: in
 * `properties`, `observedProperties` and `attributes`, at any depth, and an
 * attempted item name built from one of the masked `properties` values, as
 * the deploy's `NoEcho` arm masks one. Keys, the type, the physical id and
 * every other field stay as they are.
 *
 * The masked `properties` positions become the record's `noEchoLeaves`, so
 * the record reads as positioned (`--fail` passes) and every reader treats
 * the mask there as a `NoEcho` mask; an `observedProperties` position outside
 * them joins `observedMaskedLeaves`, and a masked top-level string attribute
 * joins `noEchoAttributeNames`. The cost: those values are gone from state, so
 * a later adoption of the record compares and re-sends without them, and a
 * delete that reads one of them from the record (a custom resource's `Delete`
 * payload) cannot use it.
 */

/** A leaf the option masks: the same leaves the unverifiable finding counts. */
export function isUnpositionedStringLeaf(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !holdsMaskLeaf(value) &&
    !isSingleDynamicReferenceToken(value)
  );
}

/** `value` with every {@link isUnpositionedStringLeaf} masked, and where. */
function maskStringLeaves(
  value: unknown,
  at: NoEchoCoordinate,
  out: NoEchoCoordinate[],
  values?: string[]
): unknown {
  if (isUnpositionedStringLeaf(value)) {
    out.push([...at]);
    values?.push(value);
    return SECRET_MASK;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => maskStringLeaves(item, [...at, index], out, values));
  }
  if (value !== null && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      next[key] = maskStringLeaves(item, [...at, key], out, values);
    }
    return next;
  }
  return value;
}

/** How many leaves {@link maskUnpositionedRecord} masks in each field. Counts only, never a value or a key. */
export interface UnpositionedMaskCounts {
  readonly properties: number;
  /** In the readback bag (`observedProperties`). */
  readonly observed: number;
  readonly attributes: number;
}

/** The record with every string leaf masked and positioned, plus the counts. */
export function maskUnpositionedRecord(record: ResourceState): {
  record: ResourceState;
  counts: UnpositionedMaskCounts;
} {
  const propertyLeaves: NoEchoCoordinate[] = [];
  const observedLeaves: NoEchoCoordinate[] = [];
  const attributeLeaves: NoEchoCoordinate[] = [];
  const readback = record.observedProperties;
  const next: ResourceState = {
    ...record,
    // Every string leaf of the readback bag is masked: no value of it is kept.
    ...(readback !== undefined && {
      observedProperties: maskStringLeaves(readback, [], observedLeaves) as typeof readback,
    }),
  };
  const maskedValues: string[] = [];
  if (record.properties !== undefined) {
    next.properties = maskStringLeaves(
      record.properties,
      [],
      propertyLeaves,
      maskedValues
    ) as Record<string, unknown>;
  }
  if (record.attributes !== undefined) {
    next.attributes = maskStringLeaves(
      record.attributes,
      [],
      attributeLeaves
    ) as typeof record.attributes;
  }
  next.noEchoLeaves = canonicalCoordinates(propertyLeaves).map((coordinate) => [...coordinate]);
  const marked = new Set(next.noEchoLeaves.map((coordinate) => JSON.stringify(coordinate)));
  const observedOnly = [
    ...(observedMaskedLeavesOf(record) ?? []),
    ...observedLeaves.filter((coordinate) => !marked.has(JSON.stringify(coordinate))),
  ];
  if (observedOnly.length > 0) {
    next.observedMaskedLeaves = canonicalCoordinates(observedOnly).map((coordinate) => [
      ...coordinate,
    ]);
  }
  const names = new Set(noEchoAttributeNamesOf(record) ?? []);
  for (const coordinate of attributeLeaves) {
    if (coordinate.length === 1 && typeof coordinate[0] === 'string') names.add(coordinate[0]);
  }
  if (names.size > 0) next.noEchoAttributeNames = [...names].sort();
  return {
    record: withAttemptedItemsMasked(next, maskedValues),
    counts: {
      properties: propertyLeaves.length,
      observed: observedLeaves.length,
      attributes: attributeLeaves.length,
    },
  };
}

/**
 * The `--mask-unpositioned` plan of one stack (go-to-k/cdkd#7194), over the
 * records `planScrubStoredNoEcho` reported as unverifiable:
 *
 * - without the option, each is warned about, naming the option, and counted;
 * - with it, each is masked (`masked`, by row key) and no longer counted,
 *   except under `dryRun`, where nothing is written: the counts are printed
 *   and the record still counts, since state still holds it unmasked.
 */
export function planUnpositionedMasks(
  rows: readonly StoredNoEchoRow[],
  unverifiable: readonly UnverifiableNoEchoRecord[],
  opts: { readonly dryRun: boolean; readonly maskUnpositioned?: boolean | undefined },
  logger: { warn(message: string): void; info(message: string): void },
  shownStack: string
): { masked: Map<string, ResourceState>; unverifiable: number } {
  const masked = new Map<string, ResourceState>();
  if (opts.maskUnpositioned !== true) {
    for (const record of unverifiable) {
      logger.warn(unverifiableNoEchoRecordWarning(shownStack, record));
    }
    return { masked, unverifiable: unverifiable.length };
  }
  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const record of unverifiable) {
    const row = byKey.get(record.key);
    if (row === undefined) continue;
    const plan = maskUnpositionedRecord(row.state);
    masked.set(record.key, plan.record);
    if (opts.dryRun) logger.info(unpositionedMaskPlanNote(shownStack, record, plan.counts));
    else logger.info(unpositionedMaskDoneNote(shownStack, record, plan.counts));
  }
  return {
    masked,
    unverifiable: opts.dryRun ? unverifiable.length : unverifiable.length - masked.size,
  };
}
