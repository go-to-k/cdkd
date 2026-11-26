/**
 * go-to-k/cdkd#7050 review: the input fingerprint of a masked key holding a
 * STALE `NoEcho` leaf (the record holds the mask where no `NoEcho` source
 * serves the leaf any more: its parameter's `NoEcho` was removed). The record
 * hashed that parameter as written; today hashes its value, so the key-wide
 * fingerprint differs whatever moved. Re-hashed with the stale leaf's
 * parameters kept as written again, it says whether anything ELSE moved.
 */
import {
  carriesSecretMask,
  noEchoParameterNodesAt,
  noEchoParametersReadBy,
} from '../secret-redaction.js';
import type { NoEchoCoordinate } from '../secret-redaction.js';
import { maskedPropertyFingerprint, splitInputFingerprint } from './core.js';
import { isPlainObject, type MaskedInputSources } from './input-walk.js';
import { maskedInputWalk } from './nested-outputs.js';
import {
  type InputFingerprinter,
  maskedPropertyFingerprintsOf,
  maskedPropertyInputFingerprintsOf,
  passedSecretVerdictOf,
} from './records.js';

/**
 * The keys of `moved` (what `movedMaskedProperties` reported) whose move is
 * only a stale `NoEcho` leaf's input-fingerprint non-proof, for the plan and
 * the deploy alike. A key whose TEXT fingerprint moved, or whose passed-secret
 * MAC proves a move, keeps it. Of the rest, a key holding no masked leaf but
 * stale ones is `unmoved` (the readback decides them); one holding another
 * masked leaf is `unmoved` and `proven` when {@link staleLeafInputsUnmoved}
 * proves its other inputs unmoved, and keeps its move (go-to-k/cdkd#4543)
 * otherwise. A `proven` key's fingerprint is re-stamped once its stale leaves
 * settle, since only a send stamps one.
 */
export async function staleNoEchoNonProofs(args: {
  record: { properties?: unknown };
  templateProps: Record<string, unknown>;
  resolvedProps: unknown;
  staleCoordinates: readonly NoEchoCoordinate[];
  moved: Iterable<string>;
  fingerprinter: InputFingerprinter | undefined;
  sources: MaskedInputSources | undefined;
}): Promise<{ unmoved: Set<string>; proven: Set<string> }> {
  const { record, templateProps, staleCoordinates, fingerprinter, sources } = args;
  const unmoved = new Set<string>();
  const proven = new Set<string>();
  const moved = new Set(args.moved);
  const recordedText = maskedPropertyFingerprintsOf(record);
  const recordedProps = (isPlainObject(record.properties) ? record.properties : {}) as Record<
    string,
    unknown
  >;
  for (const key of new Set(staleCoordinates.map((coordinate) => coordinate[0]))) {
    if (typeof key !== 'string' || !moved.has(key) || !Object.hasOwn(templateProps, key)) continue;
    if (maskedPropertyFingerprint(templateProps[key]) !== recordedText.get(key)) continue;
    if ((await passedSecretVerdictOf(fingerprinter, key, record)) === 'changed') continue;
    if (everyMaskedLeafIsStale(recordedProps[key], [key], staleCoordinates)) {
      unmoved.add(key);
    } else if (
      sources !== undefined &&
      (await staleLeafInputsUnmoved({
        record,
        key,
        templateProps,
        resolvedProps: args.resolvedProps,
        staleCoordinates,
        sources,
      }))
    ) {
      unmoved.add(key);
      proven.add(key);
    }
  }
  return { unmoved, proven };
}

/** Is every leaf of `node` (the record's value at `path`) that carries the mask at or under one of `stale`? */
function everyMaskedLeafIsStale(
  node: unknown,
  path: readonly (string | number)[],
  stale: readonly NoEchoCoordinate[]
): boolean {
  if (stale.some((coordinate) => JSON.stringify(coordinate) === JSON.stringify(path))) return true;
  if (Array.isArray(node))
    return node.every((item, index) => everyMaskedLeafIsStale(item, [...path, index], stale));
  if (node !== null && typeof node === 'object')
    return Object.entries(node).every(([child, value]) =>
      everyMaskedLeafIsStale(value, [...path, child], stale)
    );
  return !carriesSecretMask(node);
}

/**
 * Whether `key`'s recorded input fingerprint equals today's re-hashed with
 * the parameters its stale leaves read kept as written (as the record hashed
 * them while they were `NoEcho`). `true` proves every other input of the key
 * unmoved, and the stale leaves are then the readback's to decide; `false`
 * (a move, or nothing to compare: no recorded fingerprint, a stale leaf whose
 * template node is not found or reads no parameter, an input unknown today)
 * proves nothing, and the caller keeps its verdict.
 */
export async function staleLeafInputsUnmoved(args: {
  record: unknown;
  key: string;
  /** The template (unresolved) properties. */
  templateProps: Record<string, unknown>;
  /** The resolved properties, the shape the coordinates are read against. */
  resolvedProps: unknown;
  /** The record's stale `NoEcho` coordinates (any key's). */
  staleCoordinates: readonly NoEchoCoordinate[];
  sources: MaskedInputSources;
}): Promise<boolean> {
  const { record, key, templateProps, resolvedProps, sources } = args;
  const bound = maskedPropertyInputFingerprintsOf(record).get(key);
  if (bound === undefined || !Object.hasOwn(templateProps, key)) return false;
  const stale = args.staleCoordinates.filter((coordinate) => coordinate[0] === key);
  if (stale.length === 0) return false;
  const declared = new Set(
    isPlainObject(sources.template.Parameters) ? Object.keys(sources.template.Parameters) : []
  );
  const nodes = [
    ...noEchoParameterNodesAt(templateProps, resolvedProps, declared, sources.conditions).values(),
  ];
  const covered = new Set<string>();
  for (const coordinate of stale) {
    const at = nodes.find(
      (entry) => JSON.stringify(entry.coordinate) === JSON.stringify(coordinate)
    );
    if (at === undefined) return false;
    const names = noEchoParametersReadBy(at.node, {
      parameters: declared,
      ...(sources.conditions !== undefined && { conditions: sources.conditions }),
    });
    if (names.length === 0) return false;
    for (const name of names) covered.add(name);
  }
  const asWritten: MaskedInputSources = {
    ...sources,
    parameterInput: (name) =>
      covered.has(name) ? { kind: 'secret' } : sources.parameterInput(name),
  };
  const now = await maskedInputWalk(templateProps[key], asWritten).catch(() => undefined);
  return (
    now !== undefined &&
    splitInputFingerprint(now.fingerprint).input === splitInputFingerprint(bound).input
  );
}
