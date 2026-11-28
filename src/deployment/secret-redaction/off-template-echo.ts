import { MIN_NEEDLE_LENGTH, isPlainObject } from './rules.js';
import { identityKeyFor } from './identity-keys.js';
import {
  canonicalCoordinates,
  isWhollyMask,
  maskAtCoordinates,
  noEchoLeavesOf,
  replaceAtCoordinates,
  valueAtCoordinate,
  type NoEchoCoordinate,
} from './noecho-leaves.js';
import { mentionsMask, opensDynamicReferenceTo } from './recorded-secrecy.js';
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

/** Does a token the record's `properties` hold stand for a secret? */
type SecretReferenceTest = (token: string) => boolean;

/**
 * The secret references of a record's persisted `properties`: every
 * `ssm-secure` / `secretsmanager` token, and every plain `ssm` token unless
 * `provenPublic` proves its parameter public (go-to-k/cdkd#7160).
 *
 * A plain `ssm` token is secret on the #1901 premise the value scan's
 * whole-token arm acts on: a deploy persists a `String` / `StringList`
 * parameter RESOLVED, so a token SURVIVING in a persisted bag names a
 * `SecureString` (`expressionMaySeedANeedle`). The premise is evidence the
 * record holds, not the token text: the same token in a template names a
 * public parameter as often as not. Only a LEGACY record breaks it (one
 * `cdkd import` wrote before the #2944 refusal marker, or a hand edit), and
 * there the cost is an over-mask in the safe direction: a template-absent key,
 * which CloudFormation never compares, reported as `maskedEcho`, until the
 * next write resolves the token and the entry lapses with the mask. Nothing
 * is sent from it (`--revert` sends AWS's own value at a masked position).
 * CloudFormation itself refuses the shape ("Non-secure ssm prefix was used
 * for secure parameter"); cdkd resolves it (#1901), so its plaintext reaches
 * the readback.
 */
function secretReferenceTest(provenPublic?: (token: string) => boolean): SecretReferenceTest {
  return (token) =>
    opensDynamicReferenceTo(token, 'ssm-secure') ||
    opensDynamicReferenceTo(token, 'secretsmanager') ||
    (opensDynamicReferenceTo(token, 'ssm') && provenPublic?.(token) !== true);
}

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
  bag: unknown,
  isSecretReference: SecretReferenceTest
): Array<{ coordinate: (string | number)[]; text: string }> {
  const out: Array<{ coordinate: (string | number)[]; text: string }> = [];
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (typeof node === 'string') {
      if (dynamicReferenceTokens(node).some((token) => isSecretReference(token))) {
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
function corroborates(
  live: unknown,
  recorded: unknown,
  isSecretReference: SecretReferenceTest
): boolean {
  if (typeof recorded === 'string') {
    // The recorded side holding the mask is a position being learned.
    if (mentionsMask(recorded)) return true;
    if (dynamicReferenceTokens(recorded).some((token) => isSecretReference(token))) {
      return typeof live === 'string';
    }
    return live === recorded;
  }
  if (Array.isArray(recorded)) {
    return (
      Array.isArray(live) &&
      live.length === recorded.length &&
      recorded.every((item, i) => corroborates(live[i], item, isSecretReference))
    );
  }
  if (isPlainObject(recorded)) {
    return (
      isPlainObject(live) &&
      Object.entries(recorded).every(
        ([key, value]) =>
          Object.hasOwn(live, key) && corroborates(live[key], value, isSecretReference)
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
  recorded: readonly unknown[],
  isSecretReference: SecretReferenceTest
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
  if (
    live.length === recorded.length &&
    recorded.every((item, i) => corroborates(live[i], item, isSecretReference))
  ) {
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
  coordinate: NoEchoCoordinate,
  isSecretReference: SecretReferenceTest
): unknown {
  let live = readback;
  let recorded = properties;
  for (const segment of coordinate) {
    if (typeof segment === 'number') {
      if (!Array.isArray(live) || !Array.isArray(recorded)) return undefined;
      const index = listPairing(live, recorded, isSecretReference)?.(segment);
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
  needles: readonly string[],
  isSecretReference: SecretReferenceTest
): (string | number)[][] {
  const hits: (string | number)[][] = [];
  const walk = (
    node: unknown,
    source: unknown,
    path: (string | number)[],
    offTemplate: boolean
  ): void => {
    if (typeof node === 'string') {
      if (offTemplate && needles.some((needle) => node.includes(needle))) {
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
      const pairing = listPairing(node, source, isSecretReference);
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
 * Is `coordinate` of `observed` under a key `properties` does not set? The
 * coordinate's indices are READBACK indices (as {@link offTemplateEchoes}
 * records them), so a list the template also holds is entered through
 * {@link listPairing}, never by bare index: an identity-paired element can sit
 * at another index, or past the end of the template list. An element nothing
 * pairs is a template position.
 */
function isOffTemplate(
  observed: unknown,
  properties: unknown,
  coordinate: NoEchoCoordinate,
  isSecretReference: SecretReferenceTest
): boolean {
  let live = observed;
  let source = properties;
  for (const segment of coordinate) {
    if (typeof segment === 'number') {
      if (!Array.isArray(live) || !Array.isArray(source)) return false;
      const pairing = listPairing(live, source, isSecretReference);
      if (pairing === undefined) return false;
      const recordedIndex = source.findIndex((_, i) => pairing(i) === segment);
      if (recordedIndex < 0) return false;
      live = live[segment];
      source = source[recordedIndex];
      continue;
    }
    if (!isPlainObject(source)) return false;
    if (!Object.hasOwn(source, segment)) return true;
    live = isPlainObject(live) ? live[segment] : undefined;
    source = source[segment];
  }
  return false;
}

/** What {@link maskOffTemplateEchoes} reads. */
export interface OffTemplateEchoInput {
  /** The bag being written, the readback as this writer redacted it. */
  readonly bag: Record<string, unknown>;
  /** The same readback before any redaction; `bag` when the writer has no other. */
  readonly readback?: Record<string, unknown>;
  /** The record's `properties` as persisted (references, masks). */
  readonly properties: Record<string, unknown>;
  /** The resolved `properties` this deploy sent, when it wrote the record. */
  readonly resolvedProperties?: Record<string, unknown>;
  readonly noEchoLeaves?: unknown;
  readonly physicalId?: unknown;
  /** The record's `observedMaskedLeaves` before this write. */
  readonly previous?: unknown;
  /** Values that name nothing secret (the region, the stack name). */
  readonly publicTokens?: ReadonlySet<string> | undefined;
  /**
   * A plain `ssm` token this writer PROVED public (`PublicSsmProver`), which
   * then teaches nothing (go-to-k/cdkd#7160).
   */
  readonly provenPublic?: ((token: string) => boolean) | undefined;
}

/**
 * Mask, in `bag`, every string leaf under a key the template lacks that
 * echoes a value the record marks as secret, and return where
 * (`observedMaskedLeaves`, empty for none).
 *
 * The values are read off the RAW `readback` and the `resolvedProperties`:
 * - at each `noEchoLeaves` coordinate: the readback's leaf (through
 *   {@link listPairing}) and the resolved leaf, each WHOLE, so a sub-floor
 *   value embedded in a longer leaf is covered by that leaf;
 * - at each leaf of `properties` holding a secret reference
 *   ({@link secretReferenceTest}: an `ssm-secure` / `secretsmanager` one, or a
 *   plain `ssm` one no proof calls public): the readback's plaintext for it
 *   (the text between the template's literal prefix and suffix).
 *
 * A value is no needle when it is shorter than the needle floor, equals one of
 * `publicTokens`, or is contained in the physical id, which AWS publishes and
 * state keeps in the clear.
 *
 * The echoes are FOUND in the raw readback too, so one this write already
 * masked (a needle of the value scan) is named as well: a mask no field names
 * is phantom drift. A leaf the scan rewrote into its reference keeps it (drift
 * resolves it). A `previous` entry is kept while the leaf there, or an
 * ancestor (a list a writer masked whole), still holds the mask.
 */
export function maskOffTemplateEchoes(input: OffTemplateEchoInput): {
  bag: Record<string, unknown>;
  leaves: (string | number)[][];
} {
  const { bag, properties, publicTokens } = input;
  const readback = input.readback ?? bag;
  const resolved = input.resolvedProperties ?? properties;
  const physicalId = typeof input.physicalId === 'string' ? input.physicalId : '';
  const isSecretReference = secretReferenceTest(input.provenPublic);
  const needles = new Set<string>();
  // Known limits of what is learned:
  // - a secret of MIN_NEEDLE_LENGTH or more characters that is, by
  //   coincidence, a substring of the physical id is not learned, so its
  //   off-template echo stays in the clear;
  // - a value under MIN_NEEDLE_LENGTH is not learned either, so one echoed
  //   WHOLE stays in the clear. This follows the floor go-to-k/cdkd#7151
  //   names; a sub-floor value embedded in a longer leaf is covered by the
  //   noEchoLeaves arm, which learns that leaf whole.
  const learn = (value: unknown): void => {
    if (typeof value !== 'string' || value.length < MIN_NEEDLE_LENGTH) return;
    // A readback or resolved leaf, never a record bag: one carrying the mask
    // already teaches nothing.
    if (mentionsMask(value)) return;
    if (publicTokens?.has(value) === true || physicalId.includes(value)) return;
    needles.add(value);
  };
  for (const coordinate of noEchoLeavesOf({ noEchoLeaves: input.noEchoLeaves }) ?? []) {
    learn(readbackValueAt(readback, resolved, coordinate, isSecretReference));
    learn(valueAtCoordinate(resolved, coordinate));
  }
  for (const { coordinate, text } of secretReferenceLeaves(properties, isSecretReference)) {
    learn(plaintextFor(text, readbackValueAt(readback, properties, coordinate, isSecretReference)));
    learn(plaintextFor(text, valueAtCoordinate(resolved, coordinate)));
  }
  const found =
    needles.size === 0
      ? []
      : offTemplateEchoes(readback, properties, [...needles], isSecretReference);
  const hits = found.filter((coordinate) => {
    const leaf = valueAtCoordinate(bag, coordinate);
    if (leaf === undefined) return false;
    return !(
      typeof leaf === 'string' &&
      !mentionsMask(leaf) &&
      dynamicReferenceTokens(leaf).length > 0
    );
  });
  const masked = hits.length === 0 ? bag : maskAtCoordinates(bag, hits);
  // Kept while still under a key the template lacks (a template that now sets
  // the key owns the position) and while the leaf, or an ancestor a writer
  // masked whole, still holds the mask.
  const kept = (observedMaskedLeavesOf({ observedMaskedLeaves: input.previous }) ?? []).filter(
    (coordinate) =>
      isOffTemplate(masked, properties, coordinate, isSecretReference) &&
      coordinate.some((_, i) => isWhollyMask(valueAtCoordinate(masked, coordinate.slice(0, i + 1))))
  );
  return { bag: masked, leaves: canonicalCoordinates([...kept, ...hits]) };
}

/**
 * {@link maskOffTemplateEchoes} over a whole record about to be persisted:
 * `record` is the redacted one, `raw` the same record before this save's
 * redaction (its fresh readback and, on a write, the resolved `properties`).
 * Sets `observedMaskedLeaves`, omitted when empty and dropped with the
 * readback. Returns `record` by identity when nothing changed.
 */
export function withOffTemplateEchoesMasked<R extends OffTemplateEchoRecord>(
  record: R,
  raw: {
    readonly properties?: Record<string, unknown>;
    readonly readback?: Record<string, unknown>;
  },
  publicTokens?: ReadonlySet<string>
): R {
  const observed = record.observedProperties;
  if (observed === undefined) {
    if (record.observedMaskedLeaves === undefined) return record;
    const next = { ...record };
    delete next.observedMaskedLeaves;
    return next;
  }
  const { bag, leaves } = maskOffTemplateEchoes({
    bag: observed,
    ...(raw.readback !== undefined && { readback: raw.readback }),
    properties: record.properties ?? {},
    ...(raw.properties !== undefined && { resolvedProperties: raw.properties }),
    noEchoLeaves: record.noEchoLeaves,
    physicalId: record.physicalId,
    previous: record.observedMaskedLeaves,
    publicTokens,
  });
  const previous = JSON.stringify(observedMaskedLeavesOf(record) ?? []);
  if (bag === observed && JSON.stringify(leaves) === previous) {
    if (leaves.length === 0 && record.observedMaskedLeaves !== undefined) {
      const next = { ...record };
      delete next.observedMaskedLeaves;
      return next;
    }
    return record;
  }
  // The bag `maskOffTemplateEchoes` returns is `observed` with leaves masked.
  const next = { ...record, observedProperties: bag };
  if (leaves.length > 0) next.observedMaskedLeaves = leaves;
  else delete next.observedMaskedLeaves;
  return next;
}
