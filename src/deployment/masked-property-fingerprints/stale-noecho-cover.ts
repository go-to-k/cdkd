import { holdsMaskLeaf } from '../secret-redaction/recorded-secrecy.js';
/**
 * go-to-k/cdkd#7050 review: the input fingerprint of a masked key holding a
 * STALE `NoEcho` leaf (the record holds the mask where no `NoEcho` source
 * serves the leaf any more: its parameter's `NoEcho` was removed). The record
 * hashed that parameter as written; today hashes its value, so the key-wide
 * fingerprint differs whatever moved. Re-hashed with the stale leaf's
 * parameters kept as written again, it says whether anything ELSE moved.
 */
import { noEchoParameterNodesAt, noEchoParametersReadBy } from '../secret-redaction.js';
import type { NoEchoCoordinate, NoEchoPositionSources } from '../secret-redaction.js';
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
 * only a stale `NoEcho` leaf's input-fingerprint non-proof, for the deploy
 * (the plan reports such a key from its masked record anyway). A key whose TEXT fingerprint moved, or whose passed-secret
 * MAC proves a move, keeps it. Of the rest, a key holding no masked leaf but
 * stale ones is `unmoved` (the readback decides them); one holding another
 * masked leaf is `unmoved` and `proven` when {@link staleLeafInputsVerdict}
 * proves its other inputs unmoved, `unmoved` and `unprovable` when it can
 * prove neither (the caller warns of it on every deploy and never re-stamps
 * it), and keeps its move (go-to-k/cdkd#4543) otherwise. A `proven` key's
 * fingerprint is re-stamped once its stale leaves settle, since only a send
 * stamps one.
 */
export async function staleNoEchoNonProofs(args: {
  record: { properties?: unknown };
  templateProps: Record<string, unknown>;
  resolvedProps: unknown;
  staleCoordinates: readonly NoEchoCoordinate[];
  moved: Iterable<string>;
  fingerprinter: InputFingerprinter | undefined;
  sources: MaskedInputSources | undefined;
}): Promise<{ unmoved: Set<string>; proven: Set<string>; unprovable: Set<string> }> {
  const { record, templateProps, staleCoordinates, fingerprinter, sources } = args;
  const unmoved = new Set<string>();
  const proven = new Set<string>();
  const unprovable = new Set<string>();
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
    } else if (sources !== undefined) {
      const verdict = await staleLeafInputsVerdict({
        record,
        key,
        templateProps,
        resolvedProps: args.resolvedProps,
        staleCoordinates,
        sources,
      });
      if (verdict === 'moved') continue;
      unmoved.add(key);
      (verdict === 'proven' ? proven : unprovable).add(key);
    }
  }
  return { unmoved, proven, unprovable };
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
  return !holdsMaskLeaf(node);
}

/**
 * The most re-hashes one {@link staleLeafInputsVerdict} spends (each resolve is
 * memoized, so a re-hash walks the key alone): every subset of up to 10
 * parameters, and the largest subsets of more. Past it the key reads `moved`.
 */
export const MAX_STALE_REHASHES = 2 ** 10;

/**
 * What {@link staleLeafInputsVerdict} proves of a key's inputs other than its
 * stale leaves: `proven` unmoved, `moved` (or nothing to compare, or past the
 * re-hash budget), or `unprovable` (no evidence either way).
 */
export type StaleLeafInputsVerdict = 'proven' | 'moved' | 'unprovable';

/**
 * Whether `key`'s recorded input fingerprint equals today's re-hashed with
 * some of the parameters its stale leaves read kept as written (as the record
 * hashed the ones that were `NoEcho` then). The record does not say which of
 * those parameters were `NoEcho`, a plain one beside it was hashed as its
 * value, so subsets of them are tried, largest first (the usual record had
 * every one of them `NoEcho`), up to {@link MAX_STALE_REHASHES} re-hashes. A
 * matching subset none of whose parameters the key reads outside its stale
 * leaves is `proven`: the inputs it leaves uncovered are proven equal, and the
 * covered ones are read only at the stale leaves, whose readback compares them.
 *
 * A parameter the key also reads outside its stale leaves (a live `NoEcho`
 * sibling's, where no readback compares it, and a lossy stale leaf such as
 * `Fn::Select` of an `Fn::Split` would hide its move) is never covered on the
 * hash's word: a match only with it covered leaves its value unseen, so the key
 * is `unprovable`. (A value MAC never decides it: a parameter's MAC is recorded
 * only while it is `NoEcho`, and a stale one is not `NoEcho` any more.)
 *
 * No subset matching is `moved`: a plain input moved, and the caller keeps the
 * move, as the plan does. So is running out of the budget before any matched:
 * failing toward a visible change (refused, or sent), never toward reading a
 * real move unmoved. The whole set, with and without the parameters read
 * outside, is always tried (outside the budget), so only a key whose stale
 * leaves read so many parameters, some of them plain then, that the matching
 * subset is a strict one past the budget is refused
 * (create-only) or sent on every deploy: a known limit, out of any realistic
 * template's reach. `moved` also stands for nothing to compare (no recorded
 * fingerprint, a stale leaf whose template node is not found or reads no
 * parameter, or an input unknown today in every set tried): the caller keeps
 * its verdict. A walk over a set that covers an unknown parameter as written
 * can still match, so an unknown inside parameter may yield `unprovable`
 * (unmoved and warned, its stale leaf compared by the readback), never
 * `proven`.
 */
export async function staleLeafInputsVerdict(args: {
  record: unknown;
  key: string;
  /** The template (unresolved) properties. */
  templateProps: Record<string, unknown>;
  /** The resolved properties, the shape the coordinates are read against. */
  resolvedProps: unknown;
  /** The record's stale `NoEcho` coordinates (any key's). */
  staleCoordinates: readonly NoEchoCoordinate[];
  sources: MaskedInputSources;
}): Promise<StaleLeafInputsVerdict> {
  const { record, key, templateProps, resolvedProps, sources } = args;
  const bound = maskedPropertyInputFingerprintsOf(record).get(key);
  if (bound === undefined || !Object.hasOwn(templateProps, key)) return 'moved';
  const stale = args.staleCoordinates.filter((coordinate) => coordinate[0] === key);
  if (stale.length === 0) return 'moved';
  const declared = new Set(
    isPlainObject(sources.template.Parameters) ? Object.keys(sources.template.Parameters) : []
  );
  const readSources = (parameters: ReadonlySet<string>): NoEchoPositionSources => ({
    parameters,
    ...(sources.conditions !== undefined && { conditions: sources.conditions }),
  });
  const nodes = [
    ...noEchoParameterNodesAt(templateProps, resolvedProps, declared, sources.conditions).values(),
  ];
  const staleNodes = new Set<unknown>();
  const read = new Set<string>();
  for (const coordinate of stale) {
    const at = nodes.find(
      (entry) => JSON.stringify(entry.coordinate) === JSON.stringify(coordinate)
    );
    if (at === undefined) return 'moved';
    const names = noEchoParametersReadBy(at.node, readSources(declared));
    if (names.length === 0) return 'moved';
    staleNodes.add(at.node);
    for (const name of names) read.add(name);
  }
  // A parameter the key also reads outside its stale leaves is never covered
  // on the hash's word.
  const outside = new Set(
    noEchoParametersReadBy(withoutNodes(templateProps[key], staleNodes), readSources(read))
  );
  const resolved = new Map<unknown, ReturnType<MaskedInputSources['resolve']>>();
  const resolve: MaskedInputSources['resolve'] = (node) => {
    if (!resolved.has(node)) resolved.set(node, sources.resolve(node));
    return resolved.get(node)!;
  };
  // One child template load per row across every subset walk (a nested
  // output's class depends on the covered parameters, so it is walked anew).
  const loadChild = sources.childTemplate;
  const children = new Map<string, ReturnType<NonNullable<typeof loadChild>>>();
  const childTemplate =
    loadChild &&
    ((logicalId: string) => {
      if (!children.has(logicalId)) children.set(logicalId, loadChild(logicalId));
      return children.get(logicalId);
    });
  const recorded = splitInputFingerprint(bound).input;
  /** Does the key re-hash to the recorded fingerprint with `covered` kept as written? `undefined`: unknown input. */
  const matches = async (covered: ReadonlySet<string>): Promise<boolean | undefined> => {
    const asWritten: MaskedInputSources = {
      ...sources,
      resolve,
      ...(childTemplate !== undefined && { childTemplate }),
      parameterInput: (name) =>
        covered.has(name) ? { kind: 'secret' } : sources.parameterInput(name),
    };
    const now = await maskedInputWalk(templateProps[key], asWritten).catch(() => undefined);
    if (now === undefined) return undefined;
    return splitInputFingerprint(now.fingerprint).input === recorded;
  };
  // Proven: some subset of the parameters read only at the stale leaves. Then,
  // with one read outside covered: a match leaves its value unseen, so
  // unprovable. Each phase's whole set (the usual record) is tried first,
  // outside the budget, so the first phase's enumeration never starves the
  // second's whole set. Every other re-hash (a skipped subset too) counts
  // against one budget; past it, moved.
  const candidates = [...read].filter((name) => !outside.has(name));
  const whole = await matches(new Set(candidates));
  if (whole === undefined) return 'moved';
  if (whole) return 'proven';
  if (outside.size > 0) {
    const wholeRead = await matches(read);
    if (wholeRead === undefined) return 'moved';
    if (wholeRead) return 'unprovable';
  }
  let budget = MAX_STALE_REHASHES;
  for (const subset of subsetsLargestFirst(candidates)) {
    if (subset.length === candidates.length) continue;
    if (budget-- <= 0) return 'moved';
    const matched = await matches(new Set(subset));
    if (matched === undefined) return 'moved';
    if (matched) return 'proven';
  }
  if (outside.size > 0) {
    for (const subset of subsetsLargestFirst([...read])) {
      if (subset.length === read.size) continue;
      if (budget-- <= 0) return 'moved';
      if (!subset.some((name) => outside.has(name))) continue;
      const matched = await matches(new Set(subset));
      if (matched === undefined) return 'moved';
      if (matched) return 'unprovable';
    }
  }
  // No subset matched: a plain input moved.
  return 'moved';
}

/** Every subset of `names`, largest first (by index order within a size), generated lazily. */
function* subsetsLargestFirst(names: readonly string[]): Generator<string[]> {
  const n = names.length;
  for (let size = n; size >= 0; size--) {
    const at = Array.from({ length: size }, (_, i) => i);
    for (;;) {
      yield at.map((i) => names[i]!);
      let i = size - 1;
      while (i >= 0 && at[i] === n - size + i) i--;
      if (i < 0) break;
      at[i]!++;
      for (let j = i + 1; j < size; j++) at[j] = at[j - 1]! + 1;
    }
  }
}

/** `value` with each of `nodes` (by identity) replaced by `null`. */
function withoutNodes(value: unknown, nodes: ReadonlySet<unknown>): unknown {
  if (nodes.has(value)) return null;
  if (Array.isArray(value)) return value.map((item) => withoutNodes(item, nodes));
  if (isPlainObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([child, item]) => [child, withoutNodes(item, nodes)])
    );
  return value;
}
