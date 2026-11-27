import { MIN_NEEDLE_LENGTH, isPlainObject } from './rules.js';
import { identityKeyFor } from './identity-keys.js';
import {
  canonicalCoordinates,
  maskAtCoordinates,
  noEchoLeavesOf,
  replaceAtCoordinates,
  valueAtCoordinate,
  type NoEchoCoordinate,
} from './noecho-leaves.js';
import { holdsMaskLeaf, isMaskLeaf, mentionsMask } from './recorded-secrecy.js';
import { dynamicReferenceTokens } from './redact-path/reference-tokens.js';

/**
 * A secret echoed by a READBACK under a key the template lacks
 * (go-to-k/cdkd#7158, go-to-k/cdkd#7152).
 *
 * `observedProperties` is masked by POSITION (`noEchoLeaves`, the record's own
 * references) and by the value scan's needles. An AWS readback can also echo a
 * `NoEcho` value, or a secret reference's plaintext, under a key the template
 * does not set at all (a derived field, a second spelling of the same input).
 * That copy is at no position, and when no needle covers it (a value shorter
 * than the needle floor embedded in a longer leaf, an unchanged resource whose
 * pass resolved nothing, a reference inside a list, two references with one
 * plaintext) it used to be persisted in plaintext.
 *
 * {@link withOffTemplateEchoesMasked} learns each such value from the readback
 * itself, AT the positions the record marks as secret, and masks every string
 * leaf under a template-absent key that contains it. The masked coordinates
 * are recorded in `observedMaskedLeaves`, so `cdkd drift` reports them as not
 * compared (`maskedEcho`) instead of as drift, and `--accept` / `--revert`
 * re-mask them in the baselines they write.
 */

/** The record fields the pass reads and writes, structurally. */
export interface OffTemplateEchoRecord {
  properties?: Record<string, unknown>;
  observedProperties?: Record<string, unknown>;
  physicalId?: unknown;
  noEchoLeaves?: unknown;
  observedMaskedLeaves?: unknown;
}

/** Only these references stand for a secret; a public `ssm` parameter's value is no secret. */
const SECRET_REFERENCE = /^\{\{resolve:(?:ssm-secure|secretsmanager):/;

/**
 * Read a persisted `observedMaskedLeaves` field, tolerating a malformed one as
 * ABSENT, as {@link noEchoLeavesOf} reads its field.
 */
export function observedMaskedLeavesOf(record: {
  observedMaskedLeaves?: unknown;
}): NoEchoCoordinate[] | undefined {
  return noEchoLeavesOf({ noEchoLeaves: record.observedMaskedLeaves });
}

/**
 * `observed` with every coordinate the record names in `observedMaskedLeaves`
 * blanked to `null`, for a reader asking whether the bag holds a mask of
 * ANOTHER class (the #3595 re-capture selector).
 */
export function withoutObservedMaskedLeaves(
  observed: Record<string, unknown>,
  record: { observedMaskedLeaves?: unknown }
): Record<string, unknown> {
  const leaves = observedMaskedLeavesOf(record) ?? [];
  if (leaves.length === 0) return observed;
  return replaceAtCoordinates(
    observed,
    leaves.map((coordinate) => ({ coordinate, value: null }))
  );
}

/**
 * The plaintext a readback leaf holds for the secret reference(s) a recorded
 * leaf spells: the text between the literal prefix and suffix around ONE
 * token, else the whole readback leaf (it holds every plaintext the leaf
 * embeds). `undefined` when the readback does not line up with the template
 * text, or holds nothing but that text.
 */
function plaintextFor(recorded: string, readback: unknown): string | undefined {
  if (typeof readback !== 'string' || readback === recorded || mentionsMask(readback)) {
    return undefined;
  }
  const tokens = dynamicReferenceTokens(recorded);
  if (tokens.length === 1) {
    const at = recorded.indexOf(tokens[0]!);
    const prefix = recorded.slice(0, at);
    const suffix = recorded.slice(at + tokens[0]!.length);
    if (
      readback.length >= prefix.length + suffix.length &&
      readback.startsWith(prefix) &&
      readback.endsWith(suffix)
    ) {
      return readback.slice(prefix.length, readback.length - suffix.length);
    }
    return undefined;
  }
  return tokens.length > 1 ? readback : undefined;
}

/** Each coordinate of a string leaf of `bag` that holds a SECRET reference, with the leaf. */
function secretReferenceLeaves(
  bag: unknown
): Array<{ coordinate: (string | number)[]; text: string }> {
  const out: Array<{ coordinate: (string | number)[]; text: string }> = [];
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (typeof node === 'string') {
      if (dynamicReferenceTokens(node).some((token) => SECRET_REFERENCE.test(token))) {
        out.push({ coordinate: path, text: node });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, i]));
      return;
    }
    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
    }
  };
  walk(bag, []);
  return out;
}

/**
 * Does a readback element line up, BY POSITION, with the recorded one? Every
 * leaf must be equal, except a leaf the record holds as a secret (the mask, a
 * value carrying it, a secret reference): those are the positions being
 * learned. A key the readback lacks, or a shape that differs, refuses.
 */
function corroborates(live: unknown, recorded: unknown): boolean {
  if (typeof recorded === 'string') {
    if (mentionsMask(recorded)) return true;
    if (dynamicReferenceTokens(recorded).some((token) => SECRET_REFERENCE.test(token))) {
      return typeof live === 'string';
    }
    return live === recorded;
  }
  if (Array.isArray(recorded)) {
    return (
      Array.isArray(live) &&
      live.length === recorded.length &&
      recorded.every((item, i) => corroborates(live[i], item))
    );
  }
  if (isPlainObject(recorded)) {
    return (
      isPlainObject(live) &&
      Object.entries(recorded).every(
        ([key, value]) => Object.hasOwn(live, key) && corroborates(live[key], value)
      )
    );
  }
  return live === recorded;
}

/**
 * How a readback list pairs with the recorded one: through the identity field
 * the two share, else by POSITION when every element corroborates
 * ({@link corroborates}: a reorder moves a public leaf onto a recorded one it
 * differs from, so it refuses). `undefined` when neither holds: a reordered
 * list would otherwise hand over another item's public value.
 */
function listPairing(
  live: readonly unknown[],
  recorded: readonly unknown[]
): ((recordedIndex: number) => number | undefined) | undefined {
  const key = identityKeyFor(live, recorded);
  if (key !== undefined) {
    return (index) => {
      const element = recorded[index];
      if (!isPlainObject(element)) return undefined;
      const found = live.findIndex((item) => isPlainObject(item) && item[key] === element[key]);
      return found < 0 ? undefined : found;
    };
  }
  if (live.length === recorded.length && recorded.every((item, i) => corroborates(live[i], item))) {
    return (index) => index;
  }
  return undefined;
}

/**
 * The value a readback holds at `coordinate` of `properties`, each list
 * entered through {@link listPairing}, never a bare index. `undefined` where
 * nothing pairs.
 */
function readbackValueAt(
  readback: unknown,
  properties: unknown,
  coordinate: NoEchoCoordinate
): unknown {
  let live = readback;
  let recorded = properties;
  for (const segment of coordinate) {
    if (typeof segment === 'number') {
      if (!Array.isArray(live) || !Array.isArray(recorded)) return undefined;
      const index = listPairing(live, recorded)?.(segment);
      if (index === undefined) return undefined;
      live = live[index];
      recorded = recorded[segment];
      continue;
    }
    if (!isPlainObject(live) || !Object.hasOwn(live, segment)) return undefined;
    live = live[segment];
    recorded = isPlainObject(recorded) ? recorded[segment] : undefined;
  }
  return live;
}

/**
 * The coordinates of `observed`'s string leaves under a key `properties` lacks
 * that contain one of `needles`. A list the template also holds is entered
 * only through {@link listPairing}; an unpaired element is a template
 * position, never an off-template one.
 */
function offTemplateEchoes(
  observed: Record<string, unknown>,
  properties: Record<string, unknown>,
  needles: readonly string[]
): (string | number)[][] {
  const hits: (string | number)[][] = [];
  const walk = (
    node: unknown,
    source: unknown,
    path: (string | number)[],
    offTemplate: boolean
  ): void => {
    if (typeof node === 'string') {
      if (offTemplate && !isMaskLeaf(node) && needles.some((needle) => node.includes(needle))) {
        hits.push(path);
      }
      return;
    }
    if (Array.isArray(node)) {
      if (offTemplate) {
        node.forEach((item, i) => walk(item, undefined, [...path, i], true));
        return;
      }
      if (!Array.isArray(source)) return;
      const pairing = listPairing(node, source);
      if (pairing === undefined) return;
      source.forEach((item, i) => {
        const index = pairing(i);
        if (index !== undefined) walk(node[index], item, [...path, index], false);
      });
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const absent = isPlainObject(source) && !Object.hasOwn(source, key);
      walk(
        value,
        isPlainObject(source) ? source[key] : undefined,
        [...path, key],
        offTemplate || absent
      );
    }
  };
  walk(observed, properties, [], false);
  return hits;
}

/**
 * Mask, in `record.observedProperties`, every string leaf under a key the
 * template lacks that echoes a value the record marks as secret, and record
 * where (`observedMaskedLeaves`). `raw` is the same record before this save's
 * redaction (its readback and, on a write, the resolved `properties`), which
 * is where the values are read; `record` is the redacted one being persisted.
 *
 * The values learned:
 * - at each `noEchoLeaves` coordinate: the readback's leaf (through the list
 *   identity pairing) and the resolved leaf `raw` holds, each WHOLE, so a
 *   sub-floor value embedded in a longer leaf is covered by that leaf;
 * - at each leaf of `properties` holding an `ssm-secure` / `secretsmanager`
 *   reference: the readback's plaintext for it (the text between the
 *   template's literal prefix and suffix). A public `ssm` reference teaches
 *   nothing.
 *
 * A value is no needle when it is shorter than the needle floor, equals one of
 * `publicTokens` (the region, the stack name), or is contained in the
 * record's physical id, which AWS publishes and state keeps in the clear.
 *
 * Every entry the record already holds is kept while the leaf there is still
 * the mask; the field is omitted when empty, and dropped with the readback.
 */
export function withOffTemplateEchoesMasked<R extends OffTemplateEchoRecord>(
  record: R,
  raw: OffTemplateEchoRecord,
  publicTokens?: ReadonlySet<string>
): R {
  const observed = record.observedProperties;
  if (observed === undefined) {
    if (record.observedMaskedLeaves === undefined) return record;
    const next = { ...record };
    delete next.observedMaskedLeaves;
    return next;
  }
  const properties = record.properties ?? {};
  const rawObserved = raw.observedProperties ?? observed;
  const rawProperties = raw.properties ?? properties;
  const physicalId = typeof record.physicalId === 'string' ? record.physicalId : '';
  const needles = new Set<string>();
  const learn = (value: unknown): void => {
    if (typeof value !== 'string' || value.length < MIN_NEEDLE_LENGTH) return;
    if (holdsMaskLeaf(value) || mentionsMask(value)) return;
    if (publicTokens?.has(value) === true || physicalId.includes(value)) return;
    needles.add(value);
  };
  for (const coordinate of noEchoLeavesOf(record) ?? []) {
    learn(readbackValueAt(rawObserved, rawProperties, coordinate));
    learn(valueAtCoordinate(rawProperties, coordinate));
  }
  for (const { coordinate, text } of secretReferenceLeaves(properties)) {
    learn(plaintextFor(text, readbackValueAt(rawObserved, properties, coordinate)));
    learn(plaintextFor(text, valueAtCoordinate(rawProperties, coordinate)));
  }
  const hits = needles.size === 0 ? [] : offTemplateEchoes(observed, properties, [...needles]);
  const masked = hits.length === 0 ? observed : maskAtCoordinates(observed, hits);
  // At the coordinate or an ancestor: a writer that could not pair a list
  // masks it whole (the drift baseline writers), and the entry still names it.
  const kept = (observedMaskedLeavesOf(record) ?? []).filter((coordinate) =>
    coordinate.some((_, i) => isMaskLeaf(valueAtCoordinate(masked, coordinate.slice(0, i + 1))))
  );
  const leaves = canonicalCoordinates([...kept, ...hits]);
  const previous = JSON.stringify(observedMaskedLeavesOf(record) ?? []);
  if (hits.length === 0 && JSON.stringify(leaves) === previous) {
    if (leaves.length === 0 && record.observedMaskedLeaves !== undefined) {
      const next = { ...record };
      delete next.observedMaskedLeaves;
      return next;
    }
    return record;
  }
  const next = { ...record, observedProperties: masked };
  if (leaves.length > 0) next.observedMaskedLeaves = leaves;
  else delete next.observedMaskedLeaves;
  return next;
}
