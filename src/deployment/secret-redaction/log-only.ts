import { type RecordedSecretValues, SECRET_MASK } from './pairs.js';
import { sideSetOf, wholeStringLeavesOf, type WalkedContainers } from './mask-only.js';
import { MIN_NEEDLE_LENGTH, buildNeedleRegex } from './rules.js';
import { type SecretMasker } from './mask-errors.js';

/**
 * The LOG-ONLY needles of a pass (go-to-k/cdkd#1998): values that must not be
 * PRINTED, but that cdkd has no business rewriting in anything it PERSISTS.
 * Keyed by the pass's map like {@link freshNoEchoValuesOf}.
 *
 * The resolver writes it for the value of a `NoEcho: true` template
 * PARAMETER at the point a `Ref` (or an `Fn::Sub` variable) serves it, for
 * the `Fn::Base64` encoding of text that embeds one, and for each `Fn::Split`
 * piece's share of one ({@link recordLogOnlySplitFragments}). So do a nested
 * child's carry ({@link carryLogOnlyValuesCarriedBy}) and the up-front callers
 * of {@link recordLogOnlyParameterValue} (the diff log masker, the export-name
 * seed). The deploy's UPDATE arm records a pre-v11 record's stored plaintext at
 * a `NoEcho` position its migration witness found different, which reaches the
 * provider as a previous value, into the resource's PRINT-ONLY derived-name
 * registry, never its resolution bag (go-to-k/cdkd#4741).
 *
 * WHY A SIDE SET AND NOT THE MAP. The map's VALUE is what a plaintext is
 * rewritten to on the way into state: an expression, or {@link SECRET_MASK}
 * for the mask-only class. A parameter's value has neither on the terms state
 * needs: a `Ref` is no expression a reader can re-resolve, and a mask would
 * change what cdkd persists and diffs against on every later deploy (the
 * resource's record, its outputs, the no-change skip). Maintainer decision on
 * #1998: persistence is unchanged. So nothing that PERSISTS reads this set —
 * {@link redactSecretsForState}, {@link scrubResourceRecord} and every
 * positioner walk the map alone — and the maskers that PRINT read both:
 * {@link maskSecretsInText}, {@link maskSecretsInError} and
 * {@link createSecretMasker}, the capability providers receive.
 *
 * A DETECTOR that decides what is persisted or sent must not read it either,
 * which is what {@link maskRecordedSecretsInText} is for: the resolver's
 * `Fn::Base64` recording and its unsupported-service refusal ask "did the
 * recorded needles change this text", and a log-only needle answering yes
 * there would put `***` into state or refuse a deploy that succeeds today.
 * ONE verdict is the exception, by design (go-to-k/cdkd#4043): the export-name
 * refusal (`exportNameSecretExposure`) reads this set through
 * {@link printingCorpusOf}, by containment only, because what it decides is
 * whether to WITHHOLD a key. A log-only needle answering yes there drops an
 * alias; it never rewrites anything persisted.
 *
 * THE FLOOR is {@link maskSecretsInText}'s own, unchanged: a whole text equal
 * to a log-only value is masked at any length, and an embedded one only at or
 * above {@link MIN_NEEDLE_LENGTH}. The mask-only class floors its RECORDING at
 * that length because its whole-value arm rewrites every equal leaf in state;
 * a log-only value rewrites nothing, so it is recorded at any length. It gets
 * the substring floor only, NOT the resolver's position twins (#3100), which
 * are built from the recorded needles: a 1-3 character `NoEcho` value embedded
 * in a longer string still prints.
 */
export const logOnlyValuesOf = new WeakMap<RecordedSecretValues, Set<string>>();

/**
 * Record `plaintext` as a LOG-ONLY needle of the pass that owns `secrets` (see
 * {@link logOnlyValuesOf}). The empty string is refused: it would mask every
 * empty text. Adds nothing to the map itself.
 */
export function recordLogOnlyValue(secrets: RecordedSecretValues, plaintext: string): void {
  if (plaintext === '') return;
  sideSetOf(logOnlyValuesOf, secrets).add(plaintext);
}

/**
 * Carry every log-only needle of `from` into `to`. For a caller that copies
 * one bag into another and then MASKS with the copy: a `new Map(...)` or an
 * entry-by-entry copy keeps the map and drops this set.
 */
export function carryLogOnlyValues(from: RecordedSecretValues, to: RecordedSecretValues): void {
  const values = logOnlyValuesOf.get(from);
  if (values === undefined || values.size === 0) return;
  const into = sideSetOf(logOnlyValuesOf, to);
  for (const value of values) into.add(value);
}

/**
 * Carry the log-only needles of `from` that `value` CARRIES into `to` — a
 * string leaf equal to one, or containing one at or above
 * {@link MIN_NEEDLE_LENGTH}. The nested-stack child's twin of the parent's
 * `Ref` recording: a child resource consuming a parameter the parent built
 * from a `NoEcho` value gets that value as a needle in its OWN bag, which is
 * the bag its provider's masker and its error / event masking read. A LIST
 * value also carries a needle its elements were split out of, with each
 * element's fragment ({@link carryListElementFragments}).
 */
export function carryLogOnlyValuesCarriedBy(
  from: RecordedSecretValues,
  to: RecordedSecretValues,
  value: unknown
): void {
  const values = logOnlyValuesOf.get(from);
  if (values === undefined || values.size === 0) return;
  const leaves = printedLeavesOf(value);
  if (leaves.size === 0) return;
  for (const needle of values) {
    for (const leaf of leaves) {
      if (leaf === needle || (needle.length >= MIN_NEEDLE_LENGTH && leaf.includes(needle))) {
        recordLogOnlyValue(to, needle);
        break;
      }
    }
  }
  carryListElementFragments(values, to, value);
}

/**
 * The list arm of {@link carryLogOnlyValuesCarriedBy} (go-to-k/cdkd#4049): a
 * child `CommaDelimitedList` / `List<...>` parameter fed a parent's `NoEcho`
 * STRING arrives split on `,` and space-trimmed, so no element equals or
 * contains a needle holding a comma, and each element prints in the clear.
 *
 * The coercion is undone on BOTH sides rather than guessed at: the elements
 * re-joined with `,`, and each needle split on `,`, trimmed and re-joined —
 * and for a list of NUMBERS (`List<Number>`) each piece also passed through
 * `Number()`, the coercion's own step, so `007,8080` meets `[7, 8080]`. A
 * needle found in the original string is then found here too, since the trim
 * removes only whitespace next to a comma (or at an edge), which both sides
 * lose alike; a comma-free needle with edge whitespace is covered the same
 * way. Each element's share of an occurrence is recorded as a LOG-ONLY needle,
 * with the needle itself, under {@link MIN_NEEDLE_LENGTH}'s rule measured on
 * the NORMALIZED needle: an occurrence counts whole at any length and embedded
 * only at the floor, and a fragment under the floor masks a text only when it
 * IS that text.
 */
function carryListElementFragments(
  needles: ReadonlySet<string>,
  to: RecordedSecretValues,
  value: unknown
): void {
  if (!Array.isArray(value) || value.length === 0) return;
  if (
    !value.every((e) => typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean')
  ) {
    return;
  }
  const numeric = value.every((element) => typeof element === 'number');
  const joined = value.map((element) => String(element)).join(',');
  // A snapshot: `to` can share `needles`' set (`shareLogOnlyValues`).
  for (const needle of [...needles]) {
    // A `List<Number>` element is EXACTLY `Number()` of its piece — `NaN` for
    // a word, `0` for an empty piece — so every piece is normalized the same
    // way. A needle is skipped only when EVERY piece is a word or empty: its
    // elements are all `NaN` / `0`, which print nothing of it, while matching
    // would carry it into any list of `NaN`s (a child fed some other word).
    // Skipping a needle with even one numeric piece would print that element.
    const pieces = needle.split(',').map((piece) => piece.trim());
    if (numeric && pieces.every((piece) => piece === '' || Number.isNaN(Number(piece)))) continue;
    const normalized = pieces.map((piece) => (numeric ? String(Number(piece)) : piece)).join(',');
    const fragments = fragmentsOfNeedleIn(joined, ',', normalized);
    if (fragments.size === 0) continue;
    recordLogOnlyValue(to, needle);
    for (const fragment of fragments) recordLogOnlyValue(to, fragment);
  }
}

/**
 * Record, as LOG-ONLY needles of `to`, each piece of `text` split by
 * `delimiter` that holds part of a log-only needle of one of `from`
 * (go-to-k/cdkd#4049): the resolver's `Fn::Split` over text carrying a
 * `NoEcho` value. The needle itself was already masked; its pieces were not,
 * so they printed on the `Resolved Fn::Split` line and wherever a consumer of
 * a piece echoed it.
 *
 * A piece's share of an occurrence is what is recorded, never the whole piece:
 * `pre-<v1>` of `pre-<v1>,<v2>` records `<v1>`, and the substring arm masks it
 * inside the piece once it clears {@link MIN_NEEDLE_LENGTH}. An occurrence
 * counts under the same rule as the masker's: the whole text at any length,
 * an embedded one at the floor. A needle lying whole inside one piece records
 * nothing new. LOG-ONLY, so nothing persisted moves; the one verdict reading
 * log-only needles, `exportNameSecretExposure`, reads these too. An empty
 * delimiter records nothing: it would make every character a needle, so
 * `resolveSplit` masks that line's pieces whole instead.
 */
export function recordLogOnlySplitFragments(
  from: ReadonlyArray<RecordedSecretValues | undefined>,
  to: RecordedSecretValues,
  text: string,
  delimiter: string
): void {
  if (delimiter === '') return;
  for (const bag of from) {
    if (bag === undefined) continue;
    // A snapshot: `to` is usually one of `from`, and a fragment recorded
    // mid-walk must not be re-scanned as a needle of this call.
    for (const needle of [...(logOnlyValuesOf.get(bag) ?? [])]) {
      for (const fragment of fragmentsOfNeedleIn(text, delimiter, needle)) {
        if (fragment !== needle) recordLogOnlyValue(to, fragment);
      }
    }
  }
}

/**
 * The parts of `needle`'s occurrences in `text` that fall in each piece of
 * `text.split(delimiter)`. An occurrence is the whole text at any length, or
 * an embedded one at or above {@link MIN_NEEDLE_LENGTH}. Empty when the
 * needle does not occur.
 */
function fragmentsOfNeedleIn(text: string, delimiter: string, needle: string): Set<string> {
  const fragments = new Set<string>();
  if (needle === '') return fragments;
  const starts: number[] = [];
  if (text === needle) starts.push(0);
  else if (needle.length >= MIN_NEEDLE_LENGTH) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      starts.push(at);
    }
  }
  if (starts.length === 0) return fragments;
  const spans: Array<[number, number]> = [];
  let offset = 0;
  for (const piece of text.split(delimiter)) {
    spans.push([offset, offset + piece.length]);
    offset += piece.length + delimiter.length;
  }
  for (const start of starts) {
    const end = start + needle.length;
    for (const [pieceStart, pieceEnd] of spans) {
      const from = Math.max(pieceStart, start);
      const to = Math.min(pieceEnd, end);
      if (from < to) fragments.add(text.slice(from, to));
    }
  }
  return fragments;
}

/**
 * Every leaf of `value` as a log line spells it: each string, and the
 * `String()` form of each number and boolean, arrays included — the spellings
 * `recordNoEchoParameterValue` records. A child parameter declared `Number`
 * turns the parent's `"7391"` into `7391` before it is consumed, and a
 * string-only walk would carry nothing for it.
 */
function printedLeavesOf(value: unknown): Set<string> {
  const leaves = wholeStringLeavesOf(value);
  const seen: WalkedContainers = new Set();
  const walk = (node: unknown): void => {
    if (typeof node === 'number' || typeof node === 'boolean') {
      leaves.add(String(node));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child);
  };
  walk(value);
  return leaves;
}

/**
 * Make `view` SHARE `target`'s log-only side set, so a needle recorded
 * through the view at any time — late, or on a path that throws — lands in
 * `target`'s set. For a recording VIEW or write-through map built over a pass
 * map (`ForwardingSecrets`, `SharedEntriesSecrets`): the side set is keyed by
 * the bag INSTANCE, so without this every record through the view stays on
 * the view. Call it at the view's creation, before anything records.
 */
export function shareLogOnlyValues(view: RecordedSecretValues, target: RecordedSecretValues): void {
  logOnlyValuesOf.set(view, sideSetOf(logOnlyValuesOf, target));
}

/**
 * Record `value`, a `NoEcho` parameter's value, as LOG-ONLY needles of
 * `secrets` in every spelling a log line can carry it: a string itself, the
 * `String()` form of a number or boolean, and for a list each element plus
 * the comma-joined whole. The ONE spelling rule: the resolver's
 * `recordNoEchoParameterValue` calls it when a `Ref` serves the parameter, and
 * the deploy's diff log masker calls it up front, before any `Ref` resolves
 * (go-to-k/cdkd#4049).
 *
 * `splitDelimiters` ({@link literalSplitDelimitersOf} over the template) adds
 * the pieces of each string spelling split by each delimiter, for an UP-FRONT
 * caller: a piece is otherwise recorded only when `Fn::Split` runs, so a
 * property that STOPPED reading one would print the old piece from state.
 * Only those callers pass it, into a bag that only PRINTS: never the
 * resolver's pass bag, which feeds the export-name verdict, and never a corpus
 * `cdkd diff` hands a nested child, whose carry would move a piece into the
 * child's Outputs-pass bag and its export-name preview.
 */
export function recordLogOnlyParameterValue(
  secrets: RecordedSecretValues,
  value: unknown,
  splitDelimiters?: ReadonlySet<string>
): void {
  const record = (leaf: unknown): void => {
    const spelled =
      typeof leaf === 'string'
        ? leaf
        : typeof leaf === 'number' || typeof leaf === 'boolean'
          ? String(leaf)
          : undefined;
    if (spelled === undefined) return;
    recordLogOnlyValue(secrets, spelled);
    for (const delimiter of splitDelimiters ?? []) {
      if (delimiter === '' || !spelled.includes(delimiter)) continue;
      for (const piece of spelled.split(delimiter)) recordLogOnlyValue(secrets, piece);
    }
  };
  if (Array.isArray(value)) {
    for (const element of value) record(element);
    record(value.map((element: unknown) => String(element)).join(','));
    return;
  }
  record(value);
}

/**
 * Every LITERAL delimiter an `Fn::Split` in `template` splits a value READING
 * one of `parameters` by (go-to-k/cdkd#4049), for
 * {@link recordLogOnlyParameterValue}'s up-front callers. READING is a `Ref`
 * to the parameter, or any string naming it as `${Name}` (an `Fn::Sub`; a
 * match elsewhere only over-masks), anywhere
 * under the split's value operand: a delimiter no split applies to the value
 * would only record unrelated words (`postgres` of a URL split by `:`). A
 * delimiter that is itself an intrinsic is left out: it has no value before
 * resolution, and the resolver records that split's pieces when it runs.
 * Cycle-safe, and bounded by the template.
 *
 * BOUNDS of the up-front record it feeds: it sees only the splits of the
 * template it is given (the NEW one), a CDK nested child declares no `NoEcho`
 * and so records nothing up front, and a split reading the value INDIRECTLY
 * (`Fn::GetAtt`, `Fn::FindInMap`) is not collected, its pieces left to the
 * resolver, which records none when that resolution fails.
 */
export function literalSplitDelimitersOf(
  template: unknown,
  parameters: ReadonlySet<string>
): Set<string> {
  const delimiters = new Set<string>();
  if (parameters.size === 0) return delimiters;
  const reads = (node: unknown, seen: WalkedContainers): boolean => {
    if (typeof node === 'string') {
      for (const name of parameters) if (node.includes(`\${${name}}`)) return true;
      return false;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (!Array.isArray(node)) {
      const ref = (node as Record<string, unknown>)['Ref'];
      if (typeof ref === 'string' && parameters.has(ref)) return true;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (reads(child, seen)) return true;
    }
    return false;
  };
  const seen: WalkedContainers = new Set();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (
        key === 'Fn::Split' &&
        Array.isArray(child) &&
        typeof child[0] === 'string' &&
        reads(child[1], new Set())
      ) {
        delimiters.add(child[0]);
      }
      walk(child);
    }
  };
  walk(template);
  return delimiters;
}

/**
 * `secrets` as a PRINTING corpus (go-to-k/cdkd#4049): its map entries plus
 * each of its log-only needles as an entry masked to {@link SECRET_MASK}, for
 * a printer that tests a name against a map rather than calling
 * {@link maskSecretsInText} (`outputs-export-alias.ts`'s warnings). Returns
 * `secrets` itself when it holds no log-only needle. A NEW map otherwise, so
 * never hand it to anything that persists or positions: those read the map
 * alone. The one verdict that takes it is the export-name refusal
 * (go-to-k/cdkd#4043), which only withholds a key.
 */
export function printingCorpusOf(secrets: RecordedSecretValues): RecordedSecretValues {
  const logOnly = logOnlyValuesOf.get(secrets);
  if (logOnly === undefined || logOnly.size === 0) return secrets;
  const corpus: RecordedSecretValues = new Map(secrets);
  for (const needle of logOnly) if (!corpus.has(needle)) corpus.set(needle, SECRET_MASK);
  return corpus;
}

/**
 * How many LOG-ONLY needles `secrets` holds: a change stamp for a caller
 * caching a union of bags (go-to-k/cdkd#4049). The set only grows.
 */
export function logOnlyValueCount(secrets: RecordedSecretValues): number {
  return logOnlyValuesOf.get(secrets)?.size ?? 0;
}

/**
 * The union of `bags` as ONE new bag, log-only needles included, for a caller
 * that must mask an ERROR with several bags in one pass
 * ({@link maskSecretsInError} takes one bag). Printing only.
 */
export function unionOfSecretBags(
  bags: ReadonlyArray<RecordedSecretValues | undefined>
): RecordedSecretValues {
  const union: RecordedSecretValues = new Map();
  for (const bag of bags) {
    if (bag === undefined) continue;
    for (const [plaintext, expression] of bag)
      if (!union.has(plaintext)) union.set(plaintext, expression);
    carryLogOnlyValues(bag, union);
  }
  return union;
}

/**
 * ONE printing masker over several bags (go-to-k/cdkd#4049): their map
 * entries and log-only needles as a single union, masked in one
 * {@link maskSecretsInText} call. Masking bag by bag lets one bag's shorter
 * needle cut a longer needle another bag holds, printing the rest of it,
 * since longest-first holds only within one call. The bags are read by
 * reference; the needle set and its regex are rebuilt only when a bag's map
 * or log-only set changed size, which is sound because a pass's bags only
 * GROW. Do not hand it a bag that is cleared and refilled.
 */
export function createUnionSecretMasker(
  bags: ReadonlyArray<RecordedSecretValues | undefined>
): SecretMasker {
  const present = bags.filter((bag): bag is RecordedSecretValues => bag !== undefined);
  let stamp: string | undefined;
  let needles = new Set<string>();
  let regex: RegExp | undefined;
  return (text: string) => {
    const now = present.map((bag) => `${bag.size}:${logOnlyValueCount(bag)}`).join(',');
    if (now !== stamp) {
      needles = new Set<string>();
      for (const bag of present) {
        for (const plaintext of bag.keys()) needles.add(plaintext);
        for (const plaintext of logOnlyValuesOf.get(bag) ?? []) needles.add(plaintext);
      }
      regex = buildNeedleRegex(needles);
      stamp = now;
    }
    // {@link maskSecretsInText}'s two arms over the union: a whole text equal
    // to a needle at any length, then the substring scan, longest first.
    if (text !== '' && needles.has(text)) return SECRET_MASK;
    return regex ? text.replace(regex, SECRET_MASK) : text;
  };
}

/**
 * Is there at least one LOG-ONLY needle in `secrets`? The cheap test a
 * printing path asks before building the combined regex.
 */
export function hasLogOnlyValues(secrets: RecordedSecretValues | undefined): boolean {
  if (secrets === undefined) return false;
  const logOnly = logOnlyValuesOf.get(secrets);
  return logOnly !== undefined && logOnly.size > 0;
}

/**
 * Does `secrets` hold anything a MASKER would act on — a map entry or a
 * log-only needle? The test a masking site's empty-bag short-circuit must ask
 * instead of `secrets.size === 0`, which reads a bag holding only log-only
 * needles as empty. A PERSISTENCE site keeps asking `size`.
 */
export function hasMaskableValues(secrets: RecordedSecretValues | undefined): boolean {
  if (secrets === undefined) return false;
  if (secrets.size > 0) return true;
  const logOnly = logOnlyValuesOf.get(secrets);
  return logOnly !== undefined && logOnly.size > 0;
}
