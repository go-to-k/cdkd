import { carryMaskOnlyMarks } from './mask-only.js';
import { singleSpanFrame } from './positions.js';

/**
 * Map of resolved plaintext secret value -> the original `{{resolve:...}}`
 * expression it was substituted from. Populated by the resolver during a
 * resolution pass and read by the persistence / masking helpers below.
 */
export type RecordedSecretValues = Map<string, string>;

/** Fixed marker substituted for a secret value in log / error output. */
export const SECRET_MASK = '***';

/**
 * The UNCOLLAPSED companion of a {@link RecordedSecretValues} map: for each map
 * instance, every `expression -> plaintext` pair the resolver recorded INTO IT,
 * keyed by EXPRESSION (issue [#2485](https://github.com/go-to-k/cdkd/issues/2485)).
 *
 * WHY IT EXISTS. The map is keyed by PLAINTEXT, so two expressions resolving to
 * one value keep ONE entry — whichever the resolver recorded last. A WHOLE-token
 * leaf is immune (the position pass copies its own source), but a leaf that
 * EMBEDS a token in a literal string is redacted by the value scan, which can
 * only write the map's surviving expression: the versioned sibling's, for a
 * template that spells the un-versioned one, and the next deploy diffs that
 * leaf forever. Recovering the losing expression needs evidence the map has
 * discarded, and it has to be PASS-LOCAL: `recordedSecretExpressions` is
 * process-wide and says only that an expression IS secret, never what it
 * resolved to in THIS resource — so it cannot tell "the source token lost the
 * map slot to its sibling" from "the source token was never resolved here"
 * (a previous generation's bag, where writing today's expression over the
 * framed value would record something that was never deployed).
 *
 * Keyed by the map INSTANCE, so the evidence is exactly as pass-local as the
 * map itself: a map the resolver populated (the deploy's `perResourceSecrets`
 * entry, and equally the map drift / scrub / import hand their own resolution)
 * carries the pairs of THAT resolution, while a map the resolver did not
 * populate — a derived needle map, a nested-stack inheritance copy, a
 * `new Map(secrets)` copy — starts with no entries here and takes the
 * pre-#2485 fall-through, the safe direction. A copy loses the evidence
 * deliberately: a copy is not the pass that resolved anything.
 *
 * `CONFLICTING_PLAINTEXT` marks an expression this map saw resolve to TWO
 * values (a region-pinned re-resolution of one spelling, say); it then vouches
 * for nothing, which is the same "answer nothing you cannot prove" rule
 * {@link plaintextIndexOf} applies to the collapsed map's reverse index.
 */
const resolvedPairsOf = new WeakMap<RecordedSecretValues, Map<string, string | symbol>>();

/** Poison for an expression this pass recorded against two different plaintexts. */
export const CONFLICTING_PLAINTEXT = Symbol('conflicting plaintext');

/**
 * The pair table of the pass that owns `secrets`, created on first use. One
 * place for the lazy init, so no writer can create the table and forget to
 * `set` it — a table that is never registered records evidence nobody reads.
 */
function pairsFor(secrets: RecordedSecretValues): Map<string, string | symbol> {
  let pairs = resolvedPairsOf.get(secrets);
  if (pairs === undefined) {
    pairs = new Map();
    resolvedPairsOf.set(secrets, pairs);
  }
  return pairs;
}

/**
 * Record that `expression` resolved to `plaintext` in the pass that owns
 * `secrets` — the resolver's recording seam calls this beside its
 * `secrets.set(plaintext, expression)`, so the two never disagree about which
 * pass the evidence belongs to. Mask-only map entries (value `SECRET_MASK`)
 * never pass through that seam — they came from no `{{resolve:...}}` token —
 * so nothing here special-cases the mask string: a secret whose plaintext
 * happens to BE `***` is a secret like any other.
 */
export function recordResolvedPair(
  secrets: RecordedSecretValues,
  expression: string,
  plaintext: string
): void {
  const pairs = pairsFor(secrets);
  const previous = pairs.get(expression);
  if (previous === undefined) pairs.set(expression, plaintext);
  else if (previous !== plaintext) pairs.set(expression, CONFLICTING_PLAINTEXT);
}

/**
 * Carry the resolved pairs of `from` into `to`, for the one copy of a
 * resolver-populated map that POSITIONS anything: the deploy engine accumulates
 * each stack's output resolution into its `outputSecrets` bag entry by entry,
 * and without this the copy would keep the collapsed entries while dropping the
 * evidence — so a literal `Output` embedding one of two same-plaintext
 * references would fall back to the value scan and persist the sibling's
 * expression. The engine's other entry-by-entry copy — an `Export.Name`'s
 * secrets into the pass map — deliberately does NOT call this (and `cdkd
 * scrub`'s name loop resolves through a VIEW whose pairs never reach the pass
 * map at all, issue #2531): a name never
 * positions a leaf, a value re-using the same token records its own pair at
 * the seam, and the only thing the merge could add is a CONFLICT (a
 * non-cacheable `{{resolve:ssm:X}}` whose value moved between the value pass
 * and the name's resolution), which would destroy positioning the value pass
 * had earned. A pair that conflicts across the two maps is marked conflicting
 * in `to`, the same rule {@link recordResolvedPair} applies within one map.
 *
 * Deliberately NOT a general "copy the map" helper: every other new map is a
 * different PASS, and starting it without evidence is the safe direction.
 *
 * It also carries the two mask-only side sets ({@link freshNoEchoValuesOf},
 * {@link containmentValuesOf}) for every plaintext `to` holds as mask-only
 * (go-to-k/cdkd#2453). The outputs bag is the caller that needs them: an
 * output EMBEDDING a `NoEcho` value is masked only through the containment
 * arm, which reads the mark off the map the bag is redacted with.
 */
export function mergeResolvedPairs(from: RecordedSecretValues, to: RecordedSecretValues): void {
  carryMaskOnlyMarks(from, to);
  const pairs = resolvedPairsOf.get(from);
  if (pairs === undefined) return;
  for (const [expression, plaintext] of pairs) {
    if (typeof plaintext === 'string') recordResolvedPair(to, expression, plaintext);
    else pairsFor(to).set(expression, CONFLICTING_PLAINTEXT);
  }
}

/**
 * The plaintext `expression` resolved to in the pass that owns `secrets`, or
 * `undefined` when that pass recorded nothing for it (or two different values).
 */
export function resolvedPlaintextOf(
  secrets: RecordedSecretValues,
  expression: string
): string | undefined {
  const recorded = resolvedPairsOf.get(secrets)?.get(expression);
  return typeof recorded === 'string' ? recorded : undefined;
}

/**
 * Every expression the pass that owns `secrets` resolved — the pair table's
 * keys, a CONFLICTING one included (it is still an expression this pass saw,
 * and a second sighting is what a uniqueness rule must count). The map's own
 * values name only the SURVIVOR per plaintext; this names the losers too.
 */
export function resolvedExpressionsOf(secrets: RecordedSecretValues): string[] {
  return [...(resolvedPairsOf.get(secrets)?.keys() ?? [])];
}

/**
 * One `{{resolve:...}}` token the resolver REPLACED, with the verdict THAT
 * replacement took (issue [#3156](https://github.com/go-to-k/cdkd/issues/3156)):
 * the fresh lookup's, the cache entry's own, or a region-pinned sibling's.
 */
export interface DynamicReferenceSubstitution {
  readonly token: string;
  readonly value: string;
  readonly secret: boolean;
}

/**
 * What resolving ONE `Fn::Join` / `Fn::Sub` / `Fn::If` object did to its
 * dynamic references (issue [#3156](https://github.com/go-to-k/cdkd/issues/3156)).
 * `input` is the text the object's references were replaced in: for a Join,
 * its parts joined with every string part RAW, every nested part that has a
 * record of its own as that record's `input`, and every other part resolved;
 * for a Sub, the template with each USED variable as its raw text (a string)
 * or as a nested part (an intrinsic) and every other placeholder substituted.
 * `substitutions` lists every replacement made while resolving the object --
 * a Join's string parts, the lending nested parts and its joined string, a
 * Sub's used variables and its substituted template -- in order; `complete`
 * is false when any of those passes left a token unreplaced. An `Fn::If`
 * holds its selected branch's (issue
 * [#3306](https://github.com/go-to-k/cdkd/issues/3306)): a string branch
 * records its own pass, an object branch lends the record it has, and any
 * other branch poisons the `Fn::If`.
 */
export interface IntrinsicLeafResolution {
  readonly input: string;
  readonly output: string;
  readonly substitutions: readonly DynamicReferenceSubstitution[];
  readonly complete: boolean;
}

/** Poison for an intrinsic object one pass resolved two different ways. */
const CONFLICTING_LEAF_RESOLUTION = Symbol('conflicting leaf resolution');

/**
 * {@link IntrinsicLeafResolution}s per pass bag, keyed by the template OBJECT
 * that was resolved (issue [#3156](https://github.com/go-to-k/cdkd/issues/3156)).
 * The carry in {@link recordNestedStackParameterExpressions} reads it for the
 * very object the deploy engine handed the resolver, so its evidence is THIS
 * leaf's own resolution: no other leaf's substitution, however equal its value,
 * can answer for it, and each substitution carries its own verdict, which the
 * secret-only pair table cannot (an unclassifiable `ssm` answer recorded as a
 * pair looks the same as a later public answer with the same plaintext).
 * Both keys are weak, so a record lives as long as its bag and its template.
 */
const intrinsicLeafResolutionsOf = new WeakMap<
  RecordedSecretValues,
  WeakMap<object, IntrinsicLeafResolution | typeof CONFLICTING_LEAF_RESOLUTION>
>();

/**
 * Record how the pass that owns `secrets` resolved the intrinsic object
 * `source`. A second resolution of the same object that differs in any field
 * poisons it for the pass, and the poison is never lifted; an identical one
 * changes nothing.
 */
export function recordIntrinsicLeafResolution(
  secrets: RecordedSecretValues,
  source: object,
  resolution: IntrinsicLeafResolution
): void {
  let leaves = intrinsicLeafResolutionsOf.get(secrets);
  if (leaves === undefined) {
    leaves = new WeakMap();
    intrinsicLeafResolutionsOf.set(secrets, leaves);
  }
  const copy: IntrinsicLeafResolution = {
    input: resolution.input,
    output: resolution.output,
    substitutions: resolution.substitutions.map(({ token, value, secret }) => ({
      token,
      value,
      secret,
    })),
    complete: resolution.complete,
  };
  const previous = leaves.get(source);
  if (previous === undefined) leaves.set(source, copy);
  else if (previous === CONFLICTING_LEAF_RESOLUTION || !sameLeafResolution(previous, copy)) {
    leaves.set(source, CONFLICTING_LEAF_RESOLUTION);
  }
}

/**
 * How the pass that owns `secrets` resolved the intrinsic object `source`, or
 * `undefined` when it recorded nothing for it or resolved it two different
 * ways (issue [#3306](https://github.com/go-to-k/cdkd/issues/3306)). The
 * resolver reads it to assemble an OUTER object's record from a nested part's.
 */
export function intrinsicLeafResolutionOf(
  secrets: RecordedSecretValues,
  source: object
): IntrinsicLeafResolution | undefined {
  const resolution = intrinsicLeafResolutionsOf.get(secrets)?.get(source);
  return resolution === CONFLICTING_LEAF_RESOLUTION ? undefined : resolution;
}

/**
 * Record `branch`'s resolution as `source`'s too: an `Fn::If` resolves to
 * the branch it selects, so the carry reading the `Fn::If` object finds the
 * selected branch's record (issue
 * [#3306](https://github.com/go-to-k/cdkd/issues/3306)). A branch with no
 * record, or a poisoned one, poisons `source`, whichever order its
 * resolutions came in: `source` never keeps a record one of its resolutions
 * did not produce, and a poisoned record reads as none.
 */
export function recordIntrinsicLeafResolutionAs(
  secrets: RecordedSecretValues,
  source: object,
  branch: unknown
): void {
  let leaves = intrinsicLeafResolutionsOf.get(secrets);
  const resolution =
    typeof branch === 'object' && branch !== null ? leaves?.get(branch) : undefined;
  if (resolution === undefined || resolution === CONFLICTING_LEAF_RESOLUTION) {
    if (leaves === undefined) {
      leaves = new WeakMap();
      intrinsicLeafResolutionsOf.set(secrets, leaves);
    }
    leaves.set(source, CONFLICTING_LEAF_RESOLUTION);
    return;
  }
  recordIntrinsicLeafResolution(secrets, source, resolution);
}

function sameLeafResolution(a: IntrinsicLeafResolution, b: IntrinsicLeafResolution): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.complete === b.complete &&
    a.substitutions.length === b.substitutions.length &&
    a.substitutions.every(
      (s, i) =>
        s.token === b.substitutions[i]!.token &&
        s.value === b.substitutions[i]!.value &&
        s.secret === b.substitutions[i]!.secret
    )
  );
}

/**
 * The spelling `source`'s own resolution in this pass proves for
 * `resolvedValue`, or `undefined` (issue
 * [#3156](https://github.com/go-to-k/cdkd/issues/3156)). Certified only when
 * the resolution replaced every token it met, replaced exactly ONE, took a
 * SECRET verdict for it, and produced `resolvedValue` from `input` by that one
 * replacement ({@link singleSpanFrame} over `input` with the token and value
 * equal). That is the observed equation `resolvedValue = input[token := value]`;
 * it says nothing about what a later lookup of the token returns.
 *
 * The COUNT and the token and value tests refuse what `singleSpanFrame`
 * alone does not: a secret whose value is itself reference text, which the
 * object's final pass resolves again (`port:${V}` with `V` a token whose value
 * is another token), lists TWO replacements over ONE span of `input`, and the
 * span's token and value are the first stage's, not the frame's. The
 * `port:T${V}` shape (a used variable holding the template's own token), which
 * the count alone refused while a variable left its plaintext in `input`, is a
 * second span since a used variable lends its raw text (issue
 * [#3306](https://github.com/go-to-k/cdkd/issues/3306)). `complete` and
 * `output` are implied, for every shape the resolver records, by
 * `singleSpanFrame` over `input`: a token left unreplaced in `input` is a
 * second span, and a frame that fits `input` around the one replacement fixes
 * the output it produces. They are kept so a recorder that is not faithful
 * refuses rather than certifies, and are pinned by hand-built records only.
 */
export function substitutedSpellingOf(
  secrets: RecordedSecretValues,
  source: object,
  resolvedValue: string
): string | undefined {
  const resolution = intrinsicLeafResolutionsOf.get(secrets)?.get(source);
  if (resolution === undefined || resolution === CONFLICTING_LEAF_RESOLUTION) return undefined;
  if (!resolution.complete || resolution.output !== resolvedValue) return undefined;
  if (resolution.substitutions.length !== 1) return undefined;
  const [substitution] = resolution.substitutions as [DynamicReferenceSubstitution];
  if (!substitution.secret) return undefined;
  const frame = singleSpanFrame(resolvedValue, resolution.input);
  if (frame === undefined) return undefined;
  if (frame.token !== substitution.token || frame.middle !== substitution.value) return undefined;
  // A RECORDED SECRET ANYWHERE IN THE SPELLING. A non-literal part of the
  // object contributes its RESOLVED text to `input`: a part with no record of
  // its own (a `Ref`, an `Fn::Select`, an intrinsic Sub variable with none) in
  // full, and a `${X}` / `Ref` inside a part that lends its record (issue
  // #3306) or inside the object's own `Fn::Sub` template, into that text,
  // which can be the frame's TOKEN (`{{resolve:ssm:/app/${Name}}}` with `Name`
  // a secret). A replacement made while resolving such a part is not listed
  // in this record, so the prefix, the token and the suffix can each hold
  // another secret this pass recorded, which the spelling would carry
  // verbatim as though it were an expression (the #4130 review's M0). Refused
  // at any length, over-refusing toward the value scan's answer: a plaintext
  // the bag holds anywhere in `input` -- except the frame's OWN value inside
  // its token. That value is in the bag by construction, and a 1-3 character
  // one is often a substring of the token's literal text (`in` in
  // `{{resolve:ssm:/app/kin}}`), so scanning the token for it refused the
  // #3156 carry itself (the review's M2). It is still refused in the affix.
  // Another short secret that merely coincides with the token's literal text
  // is still over-refused; the scan cannot tell where the text came from.
  for (const plaintext of secrets.keys()) {
    if (plaintext === '') continue;
    const outsideToken = frame.prefix.includes(plaintext) || frame.suffix.includes(plaintext);
    if (plaintext === substitution.value ? outsideToken : resolution.input.includes(plaintext)) {
      return undefined;
    }
  }
  return resolution.input;
}

/**
 * The bag OBJECTS a deploy pass produced ITSELF and installed on a success
 * path — the fact the resolved-pair evidence above cannot state (issue
 * [#2516](https://github.com/go-to-k/cdkd/issues/2516)).
 *
 * A pair proves that THIS pass resolved a token to a plaintext; it says nothing
 * about which bag is being walked. The deploy engine's persist choke point
 * walks EVERY record in the state map against today's template, and a record
 * that merely ENTERED the create/update arm is still the PREVIOUS generation
 * until its provider call succeeds (an intermediate save, a pre/post-rollback
 * save, Ctrl-C — the same population the `sourceIsSameGeneration` note on
 * {@link PathSourceRules} names). One record also carries two bags of
 * different provenance: `properties`, this pass's resolved bag once the
 * provider succeeded, and `observedProperties`, an AWS readback installed
 * separately. So the fact is BAG-specific, not caller- or record-level, and it
 * is carried on the object: {@link markSameGenerationBag} at the moment the
 * successful result is installed, consulted by {@link redactSecretsForState}
 * for the object it is handed. A copy of the bag, a derived needle map, a
 * previous generation's record, a scrub / drift walk and a bag nobody marked
 * all answer `false` and keep the fall-through. `cdkd import` marks the one
 * bag its own resolver produced (the sixth site below, issue #2745), and the
 * nested-stack recorder marks the COPY it positions (the seventh, same issue).
 *
 * A `WeakSet` for the reason {@link resolvedPairsOf} is a `WeakMap`: the mark
 * dies with the object it is on, and nothing has to clear it.
 */
const sameGenerationBags = new WeakSet<object>();

/**
 * Mark `bag` as an object THIS pass is entitled to speak for, and return it.
 * The one evidence {@link positionByEmbeddedSpan} needs beyond a resolved pair
 * to write a middle SHORTER than {@link MIN_NEEDLE_LENGTH} — see the arm.
 *
 * Deliberately NOT "produced by resolving today's template, read back from a
 * resource it just wrote, and about to be installed on a success path": each
 * of those three was in this sentence and each is false at one site (an
 * unchanged resource's auto-refresh resolves nothing; the no-change re-check
 * and the journal are never installed on the record). The conditions are per
 * site and are listed below.
 *
 * WHAT THE MARK CLAIMS, which is the only thing every site shares: the object
 * is one THIS PASS is entitled to speak for, so a sub-floor middle in it may
 * be written as the token this pass recorded. What never qualifies is a bag of
 * MIXED provenance: a provider's `effectiveProperties` replacement may carry
 * previous-state values IN, so an object-level mark on it would prove nothing
 * for those leaves — it stays unmarked and keeps the residual. Nor does an
 * object marked INSIDE the resolver, at resolution time: whether that object,
 * a narrowed copy of it or a provider's replacement is what gets redacted and
 * stored is the CALLER's decision, so the mark is taken by the caller at the
 * redaction call — the engine's five sites, and `cdkd import`'s one.
 *
 * The CONDITIONS are per SITE, not global, and stating them globally is what
 * this paragraph kept getting wrong (PR 2753, rounds 3 and 4). "After the
 * provider call" is false for the no-change re-check, which marks BEFORE it
 * and may skip it entirely. "Every leaf this pass produced" is false for the
 * auto-refresh readback of an UNCHANGED resource, where nothing was resolved
 * at all — there the safety comes from the empty secrets map, not from the
 * mark. Read the per-site list below rather than a rule over all seven.
 *
 * The seven call sites, and which of them the record HOLDS, because the earlier
 * "two never-installed copies" reading of this paragraph was false once the
 * third copy arrived:
 * - `propertiesToRecord` — the record's `properties`, installed. The resolved
 *   bag itself when the route drops nothing, a narrowed copy of it when it
 *   does, and `withoutSilentDropProperties` returns its input by reference in
 *   the first case, which is why the mark must be taken AFTER the narrowing
 *   and not before.
 * - `drainObservedCaptures` — the `observedProperties` readback it installs,
 *   and a COPY: the object a provider returned is never the marked one, so a
 *   provider that hands back its own `properties` argument cannot get a
 *   previous generation marked. It marks EVERY capture it drains, which is
 *   wider than "a resource this pass wrote" — the schema-upgrade auto-refresh
 *   of an UNCHANGED resource is marked too. What keeps that safe is the map,
 *   not the mark: `perResourceSecrets` is populated only in the create /
 *   update arms, so an unchanged resource's walk carries an empty one and the
 *   span arm cannot fire whatever the object is marked.
 * - `resolveOutputs` — the `outputs` bag this pass resolved. What every site
 *   shares is that the marked object is the redaction INPUT; whether the
 *   record then holds that same object varies, and here it depends on whether
 *   this pass recorded any output secret: with one,
 *   `redactOutputs` returns a fresh redacted bag and that return value is
 *   installed; with none — the ordinary deploy — it returns its input
 *   unchanged and the marked object IS the one
 *   stored. On the no-change path the newly redacted bag is installed when
 *   the outputs CHANGED, and the previous `persistedOutputs` is kept
 *   otherwise; that previous bag is unmarked, which is the answer that arm
 *   wants. When an output FAILED there, what is installed is either a fresh
 *   merge of this pass's values with the previous bag's carried ones (issue
 *   #2771), mixed provenance and never marked, or — when that merge refuses —
 *   the previous bag kept whole, unmarked as above.
 * - the update arm's no-change re-check — a marked `{ ...resolvedProps }`
 *   compared against the stored record so a stored token reads as a no-op.
 *   NOT installed; the object the provider is handed is the unmarked original.
 * - the rollback journal's FAILED-op `attemptedProperties` — a marked copy, so
 *   that persisted artifact does not carry the plaintext on exactly the
 *   failure path. NOT installed on the record.
 * - `cdkd import`'s `resolveImportedProperties` (issue #2745) — the bag
 *   import's OWN resolver produced from the imported template, marked as the
 *   redaction input; the record holds the redacted COPY, unmarked. Not a
 *   deploy pass, and the mark does not say it is: what it claims is PAIR
 *   PROVENANCE — this bag was produced from this source, in this pass, by the
 *   resolver that recorded these pairs — which import's resolve satisfies
 *   exactly as the create arm's does, since `unresolvedProperties` is the
 *   template bag it resolved and its per-resource map holds the pairs. What
 *   it does NOT claim is that AWS holds the value: `observedProperties` is
 *   captured separately, against the redacted record, and is never marked
 *   here.
 * - `recordNestedStackParameterExpressions` (issue #2745) — a shallow COPY of
 *   a nested-stack row's resolved `Parameters` sub-bag, marked as the
 *   position pass's input so a sub-floor middle a literal frame embeds is
 *   written as its token there, which is what the recorder's sub-floor
 *   carry reads. NOT installed: the caller's own object is untouched, and
 *   whether THAT gets marked is decided at the caller (the deploy engine's
 *   two sites mark it later, in `propertiesToRecord`; the replay's three
 *   never do). Pair provenance holds at all five callers: the engine's two
 *   resolve the row in the pass that recorded the pairs, and the replay's
 *   three hand it the bag `resolveReplayProps` filled through
 *   `recordResolvedPair` from the journal rows it resolved just before -- the
 *   desired row, and on the update and failed-op arms the current or
 *   attempted row as well -- all within one replay, so every pair in it is
 *   that pass's own.
 */
export function markSameGenerationBag<T extends object>(bag: T): T {
  sameGenerationBags.add(bag);
  return bag;
}

/**
 * Exported for `cdkd import`'s unit test, which asserts that the STORED record
 * is not the marked object (maintainer review of PR 3052). Read-only over the
 * `WeakSet`: no behavior in this module changes with the export, and the only
 * writer, {@link markSameGenerationBag}, was exported already.
 */
export function isSameGenerationBag(bag: unknown): boolean {
  // `WeakSet.has` answers `false` for a primitive or `null` without throwing,
  // so no type guard sits in front of it: one that did would be inert.
  return sameGenerationBags.has(bag as object);
}
