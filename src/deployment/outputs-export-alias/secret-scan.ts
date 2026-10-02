import {
  SECRET_MASK,
  carryLogOnlyValuesCarriedBy,
  isSingleDynamicReferenceToken,
  printingCorpusOf,
  recordLogOnlyParameterValue,
  type RecordedSecretValues,
} from '../secret-redaction.js';

/**
 * Mirrors `secret-redaction`'s own `MIN_NEEDLE_LENGTH`. Duplicated rather than
 * imported because the two bounds answer different questions and should be free
 * to diverge: that one bounds what may be REWRITTEN, this one what may be
 * REFUSED or REPORTED.
 */
export const MIN_SECRET_NEEDLE = 4;

/**
 * Characters deleted before any secret containment test on this path, and
 * deleted from the text that gets PRINTED — ONE class, because the verdict and
 * the printed text have to live in the same string space (issue
 * [#2874](https://github.com/go-to-k/cdkd/issues/2874)).
 *
 * WHY A THIRD CLASS RATHER THAN EITHER SANITISER'S. `stripControlChars`
 * DELETES its class; `displaySafe` REPLACES its own with a space. Composing
 * them — which is what every site here used to do — leaves three different
 * strings in play: the raw key the verdict was taken from, the sanitised key
 * that was printed, and the masked one in between. A recorded secret split by
 * a DELETED character is absent from the raw key and contiguous in the printed
 * one, so the verdict said `safe` over text that held the plaintext; a secret
 * split by a REPLACED one is absent from both and prints one character short
 * of the plaintext, which a `not.toContain(SECRET)` assertion cannot see.
 * Measured across both classes: eight of ten characters reconstituted the
 * secret verbatim, and the remaining two printed it minus one character.
 *
 * So the fix is not another arm on the check — it is removing the second and
 * third string. Everything below happens in {@link secretScanHaystacks} space:
 * one stripped string, and its trim for printing.
 *
 * THE CLASS IS DERIVED FROM UNICODE CATEGORIES, NOT ENUMERATED. A hand list
 * was written first -- both sanitisers' classes plus the four residuals
 * `display-safe.ts` names -- and review measured it arbitrary: `U+2060`
 * (WORD JOINER) verdicted `safe` and printed visibly-contiguous plaintext
 * while `U+FEFF` was caught, and `U+2060` is the character Unicode itself
 * designates as the replacement for `U+FEFF` in that role. Eight more did the
 * same (`U+00AD`, `U+180E`, `U+FE0F`, `U+3164`, `U+2061`, `U+FFFB`, `U+115F`,
 * `U+17B4`). A list of the invisibles somebody happened to think of is not a
 * boundary; the general categories are.
 *
 * - `\p{Cc}` control and `\p{Cf}` format: the C0 / C1 and DEL ranges, the bidi
 *   marks / embeddings / overrides / isolates, the zero-width set, `U+FEFF`,
 *   `U+00AD`, `U+061C`, and the invisible-operator block.
 * - `\p{Zl}` / `\p{Zp}`: `U+2028` / `U+2029`, the two `displaySafe` REPLACES.
 * - `\p{Default_Ignorable_Code_Point}`: Unicode's own INTENT-TO-BE-IGNORED
 *   property, which carries the variation selectors, the Mongolian free
 *   variation selectors, the Hangul fillers and `U+034F` COMBINING GRAPHEME
 *   JOINER.
 *
 * - `\p{Me}` ENCLOSING marks. The same zero-advance-width shape as `\p{Mn}`
 *   below, and INCLUDED in the printed class because the cost argument that
 *   keeps `\p{Mn}` out of it does not transfer: `\p{Me}` is about a dozen code points
 *   with no legitimate use in a resource name.
 *
 * NOT `\p{Mn}`. `\p{Default_Ignorable_Code_Point}` is Unicode's
 * INTENT-TO-BE-IGNORED property, NOT "everything that renders as nothing":
 * NONSPACING marks carry zero advance width too, so a secret split by one
 * (`U+09BC`) renders contiguous. They are kept in THIS class because it is
 * also the PRINTED space, and `\p{Mn}` is the diacritics of Devanagari,
 * Arabic, Hebrew and Vietnamese -- deleting it would mangle legitimate names
 * for every user. They are caught instead by the wider DETECTION space,
 * {@link SECRET_DETECTION_ONLY} (issue
 * [#2889](https://github.com/go-to-k/cdkd/issues/2889)).
 *
 * THE THIRD BULLET REPLACED A HAND TAIL, and the hand tail was measured
 * leaking. A first cut listed the ranges by hand -- `FE00-FE0F`,
 * `E0100-E01EF`, `180B-180D`, `115F`, `1160`, `3164`, `FFA0`, `17B4`, `17B5`
 * -- and review found `U+034F` outside it, printing `hunter2hunter2` in a
 * `warn` line under a `safe` verdict. It also spelled `180B-180D` while
 * calling itself "the Mongolian FVS", missing `U+180F`, which Unicode 14
 * added. Naming the PROPERTY is what makes the next such addition arrive
 * covered instead of arriving as another finding.
 *
 * WIDENED HERE AND NOT IN `display-safe.ts` because the two files answer
 * different questions. `displaySafe` is about a terminal rendering a value,
 * and its recorded reason for keeping these is command forgery -- where a
 * character that renders as nothing changes nothing. That reason does not
 * transfer to a secret: a plaintext split by an invisible character is READ by
 * a human exactly as if it were contiguous, so disclosure needs no paste.
 *
 * `tests/unit/deployment/secret-scan-class-superset.test.ts` fences this as a
 * SUPERSET of both sanitisers' classes by SCANNING CODE POINTS rather than by
 * comparing source text, so a future edit to either sanitiser that this class
 * does not cover reds -- the failure mode a hand list has and a derivation
 * does not.
 */
const SECRET_SCAN_INVISIBLES = /[\p{Cc}\p{Cf}\p{Me}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Characters deleted from the canonical (printed) space ONLY for the secret
 * containment test, never from what is printed (issue
 * [#2889](https://github.com/go-to-k/cdkd/issues/2889)): NONSPACING marks,
 * after canonical decomposition. {@link detectionForms} decomposes (NFD),
 * deletes the marks, and recomposes (NFC), so a precomposed letter and its
 * decomposed spelling -- which render identically -- meet as the same base
 * letter, and a Hangul syllable recomposes rather than staying split into
 * jamo that would inflate its length past the floor.
 *
 * WHY THIS DOES NOT REOPEN #2874, whose finding was a verdict and a printed
 * text in DIFFERENT spaces. That bug needed a secret VISIBLE in the printed
 * string and ABSENT from the tested one. {@link secretsPresentIn} keeps every
 * printed-space arm and ORs the detection arm beside them, so the verdict is a
 * SUPERSET of the printed-space verdict by construction: a name judged safe
 * was tested in the printed space AND in a wider one. A name whose ONLY hit is
 * in the detection space is masked in neither (its canonical needle is not in
 * the printed string), so {@link secretSafeKeyDisplay} withholds it rather
 * than printing it, and its post-mask re-test runs the detection arm too.
 *
 * Its COST is over-refusal, stated rather than hidden, in both directions: a
 * recorded secret CARRYING marks (`cafe` + `U+0301`) matches its unmarked
 * skeleton (`cafe` in `cafeteria-export`), and an unmarked recorded secret
 * matches a name that spells it with marks added (`cafe` in
 * `cafe` + `U+0301` + `-api`, or the precomposed `caf` + `U+00E9` + `-api`).
 * Either export alias is refused and warned. Fail-safe, and it takes a
 * skeleton of at least {@link MIN_SECRET_NEEDLE} characters or a whole-name
 * match.
 */
const SECRET_DETECTION_ONLY = /\p{Mn}/gu;

/**
 * `canonical` in DETECTION space: see {@link SECRET_DETECTION_ONLY}. TWO forms,
 * each scanned by the one detection arm of {@link secretsPresentIn}:
 *
 * - `[0]` MARK-STRIPPED (issue #2889): NFD, marks removed, NFC.
 * - `[1]` COMPATIBILITY-FOLDED (issue
 *   [#4001](https://github.com/go-to-k/cdkd/issues/4001)): the same with NFKD
 *   in place of NFD, so full-width (`U+FF41`), mathematical-alphanumeric,
 *   superscript, ligature (`U+FB01`), circled and the other compatibility
 *   spellings meet their plain letters -- a SUBSTITUTED character that reads
 *   as the secret, where #2889 handled an INSERTED one. NFKD rather than a bare
 *   NFKC so a name that is full-width AND mark-split folds in one step. After
 *   the marks go the text is already compatibility-decomposed, so the closing
 *   NFKC composes exactly as NFC would.
 *
 * ADDED BESIDE `[0]`, NEVER REPLACING IT, because compatibility folding is not
 * closed under containment: Hangul compatibility jamo fold to conjoining jamo
 * that recompose with their NEIGHBOUR, so a needle found in `[0]` space can be
 * absent from `[1]` space. Scanning both keeps today's verdict a subset.
 *
 * THE BOUNDS. Cross-SCRIPT look-alikes (Cyrillic `U+0430` for Latin `a`,
 * Greek omicron for `o`): they are distinct letters with no compatibility
 * mapping, so no normalization joins them. Unicode TR39's confusable skeleton
 * would, and it was not adopted (#4001's decision): the runtime ships no copy,
 * and it would fold legitimate non-Latin names into Latin ones. And a HANGUL
 * JAMO at EITHER edge of a secret, or a secret ENDING in an open Hangul
 * syllable, meeting a compatibility spelling of the rest (a recorded `abcd` +
 * `U+3131` in full-width `abcd` + `U+3131 U+314F`; a recorded `abcd` +
 * `U+AC00` followed by `U+3133`, which folds into its final consonant): the
 * closing recomposition joins the edge to its neighbour in the name, as the
 * previous paragraph describes, and `[0]` keeps the full-width letters. A
 * decomposed form without recomposition would close it, but it matches a
 * syllable by its jamo prefix, which #2889 pinned as NOT a match.
 *
 * The COST of `[1]` is over-refusal on a name whose FOLDED spelling holds a
 * recorded secret: `prod` + full-width `2024` beside a recorded `prod2024`,
 * `pro` + `U+FB01` + `le` (folds to `profile`) beside a recorded `file`,
 * `area-m` + `U+00B2` (superscript two) beside a recorded `ea-m2`, the
 * circled digits `U+2460`-`U+2463` beside a recorded `1234`. Each is refused
 * exactly when its folded spelling, typed in plain characters, would be -- so
 * the cost is compatibility characters in real names meeting a recorded
 * secret, never compatibility characters alone: a full-width or
 * half-width-kana name beside an unrelated secret prints unchanged.
 * Fail-safe and warned.
 */
function detectionForms(canonical: string): readonly [string, string] {
  return [
    canonical.normalize('NFD').replace(SECRET_DETECTION_ONLY, '').normalize('NFC'),
    canonical.normalize('NFKD').replace(SECRET_DETECTION_ONLY, '').normalize('NFKC'),
  ];
}

/**
 * A recorded secret's needles in DETECTION space, computed once per map
 * rather than on every call that scans against it (#2889 review). Keyed by
 * the map object and then by PLAINTEXT, and the forms are a pure function of
 * the plaintext, so an entry added to the map later is simply computed on
 * first use and a stale entry can never be wrong. The cache dies with the
 * map, as the side tables in `secret-redaction.ts` do.
 */
const DETECTION_NEEDLES = new WeakMap<
  RecordedSecretValues,
  Map<string, readonly [string, string]>
>();

function detectionNeedlesOf(
  secrets: RecordedSecretValues,
  plaintext: string,
  canonical: string
): readonly [string, string] {
  let cache = DETECTION_NEEDLES.get(secrets);
  if (cache === undefined) {
    cache = new Map();
    DETECTION_NEEDLES.set(secrets, cache);
  }
  let forms = cache.get(plaintext);
  if (forms === undefined) {
    forms = detectionForms(canonical);
    cache.set(plaintext, forms);
  }
  return forms;
}

/**
 * A possibly-secret-bearing name as PRINTED: {@link secretScanHaystacks}'
 * untrimmed string, trimmed.
 *
 * `.trim()` mirrors `displaySafe`, whose trim this replaces on these paths. It
 * shapes the printed text only; a containment test reads both haystacks, since
 * the trim can remove whitespace that belongs to a recorded secret.
 */
export function canonicalForSecretScan(text: string): string {
  return secretScanHaystacks(text)[0];
}

/**
 * The two haystacks every containment test on this path reads: `[trimmed,
 * untrimmed]`, both with the invisible class deleted (issue
 * [#2890](https://github.com/go-to-k/cdkd/issues/2890)).
 *
 * UNTRIMMED, because a recorded secret's own EDGE whitespace (`\p{Zs}`, which
 * the invisible class keeps) is part of the secret and can sit at the edge of
 * the key, where the trim removes it: a recorded `' a<ZWSP>bcd'` in the key
 * `' abcd-x'` matched no arm and printed `abcd-x`. TRIMMED, because the
 * whole-value arm has to see a key whose edge whitespace is NOT part of the
 * secret: `' ab '` is the sub-floor secret `ab`, and the untrimmed string does
 * not equal it. For the embedded arm the trimmed string adds nothing (it is a
 * substring of the untrimmed one); it is read anyway so the two arms walk one
 * list.
 *
 * WHY THIS PAIR CANNOT SPLIT THE VERDICT FROM THE PRINTED TEXT, the class
 * issue [#2874](https://github.com/go-to-k/cdkd/issues/2874) found. That bug
 * was three strings that could each hold a secret the others did not. These
 * two are one string and a trim of it: the trimmed one is a SUBSTRING of the
 * untrimmed one, and {@link secretSafeKeyDisplay} masks the UNTRIMMED string
 * and prints the trim of the result. Every verdict arm EXCEPT the detection arm
 * ({@link SECRET_DETECTION_ONLY}, whose hits {@link secretSafeKeyDisplay}
 * withholds) implies the canonical needle occurs in that untrimmed string --
 * the raw arm too, since deleting
 * characters from a text containing the plaintext leaves the plaintext's own
 * deletion contiguous in it. So every occurrence a verdict can see is masked
 * before the trim, and the trim can only drop mask-free
 * whitespace from the ends -- it cannot join two characters, so it cannot
 * create an occurrence either. The post-mask re-test then reads the masked
 * untrimmed string, whose trimmed haystack IS the printed text, character for
 * character.
 */
export function secretScanHaystacks(text: string): readonly [string, string] {
  const untrimmed = text.replace(SECRET_SCAN_INVISIBLES, '');
  return [untrimmed.trim(), untrimmed];
}

/**
 * A recorded secret as a NEEDLE in canonical space.
 *
 * STRIPPED BUT NOT TRIMMED. That is not an oversight of the symmetry with
 * {@link canonicalForSecretScan} but the deliberate asymmetry between a
 * haystack and a needle: whitespace at the edge of a recorded secret is part
 * of the secret and sits in the MIDDLE of a longer key, so trimming the needle
 * stops it matching there. Measured -- a recorded `"ab  "` embedded in
 * `x-ab  -y` was masked before this change and came back `safe` after it.
 *
 * Canonicalising the needle at all is what let the raw-key fallback arm go
 * away: a secret whose own plaintext carries a stripped character used to
 * survive in the raw key and be destroyed in the sanitised one, so it could be
 * DETECTED only from the raw form and MASKED in neither -- a permanent
 * `withheld`. Here it is both found and masked.
 */
export function canonicalNeedle(plaintext: string): string {
  return plaintext.replace(SECRET_SCAN_INVISIBLES, '');
}

/**
 * The recorded secrets as NEEDLES, keyed by their canonical form.
 *
 * A needle whose canonical form is EMPTY is dropped: canonicalisation can turn
 * a non-empty recorded value into `''`, and `maskEveryOccurrence` splitting on
 * `''` interleaves the mask between every character of the key. The resolver
 * never records an empty secret, so nothing upstream guards this. Measured
 * without the guard: `OrdinaryKey` came back as
 * `O***r***d***i***n***a***r***y***K***e***y`.
 */
export function canonicalNeedles(secrets: RecordedSecretValues | undefined): RecordedSecretValues {
  const out: RecordedSecretValues = new Map();
  for (const [plaintext, expression] of secrets ?? []) {
    const needle = canonicalNeedle(plaintext);
    if (needle.length > 0) out.set(needle, expression);
  }
  return out;
}

/**
 * Which recorded secrets are visible in `text`, or `undefined` when none is.
 *
 * ONE rule for both callers below, because they were inconsistent and the
 * inconsistency was a hole: the export-name check refused only an exact
 * whole-name match while the state-KEY scan did bounded containment over the
 * same kind of map — so `prod-<secret>-endpoint` was written as a state key by
 * the deploy and then reported by `cdkd scrub` as an UNREPAIRABLE leak. The tool
 * was creating the exact state it tells the user it cannot fix.
 *
 * A WHOLE-value match counts at any length; an EMBEDDED one only at or above
 * {@link MIN_SECRET_NEEDLE}. The bound is what makes containment safe to use for
 * a refusal at all — an unbounded scan over a degenerate one-character secret
 * matches almost every name and silently drops working exports — and its cost
 * is stated rather than hidden: a secret of three characters or fewer embedded
 * in a longer string is not seen. That value is indistinguishable from
 * coincidence, and the same bound already governs every substring redaction
 * cdkd performs.
 *
 * No empty-string case is needed at either caller: the resolver never records an
 * empty secret (`secret-redaction` says so — an empty needle would match every
 * leaf), and the length bound excludes it from the containment arm regardless.
 */
export function secretsPresentIn(
  text: string,
  secrets: RecordedSecretValues | undefined
): RecordedSecretValues | undefined {
  if (!secrets || secrets.size === 0) return undefined;
  // CANONICAL HAYSTACK, RECORDED-LENGTH FLOOR (issue #2874). Both halves are
  // load-bearing and were got wrong in turn.
  //
  // Canonicalising the HAYSTACK here rather than only at the display sites is
  // what makes the deploy-side REFUSAL see a split secret: without it an
  // `Export.Name` carrying one is PUBLISHED as a state key and into the
  // exports index, and `cdkd scrub` then reports it as a leak it cannot
  // rewrite -- this module creating the exact state it tells the user it
  // cannot fix.
  //
  // TWO PRINTED-SPACE ARMS, EACH BOUNDED BY ITS OWN LENGTH (the detection
  // arm below is a third, bounded the same way), because a single floor fails in
  // one direction or the other and both single-arm forms were measured:
  //
  // - Bounding by the RECORDED length alone makes the floor DEFEATABLE. A
  //   recorded `a` followed by three zero-width spaces is four characters and
  //   clears it, while its needle is the single letter `a` -- measured masking
  //   `ApiGatewayEndpoint` into `ApiG***tew***yEndpoint` AND making the deploy
  //   refuse the export alias of every output whose name contains an `a`, the
  //   repo-wide availability failure MIN_SECRET_NEEDLE exists to prevent.
  // - Bounding by the CANONICAL needle alone loses the fail-closed answer for
  //   a key that carries the invisible characters ITSELF -- the raw forms
  //   match there even when the canonical needle is too short.
  //
  // THE CANONICAL ARM READS TWO HAYSTACKS, the stripped text untrimmed and
  // trimmed (issue #2890) -- see `secretScanHaystacks` for why each is needed
  // and why the pair cannot split the verdict from the printed text. With the
  // trimmed one alone, a recorded value whose own EDGE whitespace the trim
  // removed matched no arm however long it rendered.
  //
  // The RAW arm keeps only containment. Its whole-value comparison
  // (`text === plaintext`) is implied by the untrimmed whole-value one: the
  // invisible class is deleted character by character, so equal inputs
  // canonicalise equally. Its containment comparison is NOT implied, and stays:
  // its floor is keyed to the RECORDED length, so it still sees a needle that
  // canonicalisation shortened below the floor.
  //
  // The rule is spelled out at all because an earlier revision claimed the two
  // arms COVER the shortening case, which measurement also refuted:
  // a recorded `a<U+200E>b<U+200E>c` renders as `abc`, and a key spelling the
  // VISIBLE form (`x-abc-y`, no invisibles of its own) matches neither arm --
  // the canonical needle is three characters and the raw plaintext is not in
  // the raw text. That is the documented sub-floor tradeoff applied to what a
  // reader actually sees, not a gap either arm was meant to close. What the
  // raw arm does buy is the key that carries the invisibles too, which main
  // caught and a canonical-only form would have dropped.
  const haystacks = secretScanHaystacks(text);
  // THREE detection haystacks, because the trim and the mark removal do not
  // commute and each order catches a whole-value match the other misses
  // (#2889 review): trimmed AFTER the marks go catches U+0301 + space + `ab`
  // beside a recorded `ab`; the trimmed printed haystack in detection form
  // catches U+0301 + ` ab` beside a recorded ` ab`, whose edge whitespace is
  // part of the secret; and the untrimmed one catches a needle whose own edge
  // whitespace survives only there (a recorded ` abc` in ` ` + U+0301 + `abc`).
  // Every one of the three runs BOTH the whole-value and the embedded test.
  // The three are built once PER DETECTION FORM (`detectionForms`: marks
  // stripped, then compatibility-folded, issue #4001), for the same reason in
  // each form -- a full-width or ideographic space folds to U+0020, which the
  // trim then removes.
  const [markedUntrimmed, foldedUntrimmed] = detectionForms(haystacks[1]);
  const [markedTrimmed, foldedTrimmed] = detectionForms(haystacks[0]);
  const wideHaystacks = [
    [markedUntrimmed.trim(), markedUntrimmed, markedTrimmed],
    [foldedUntrimmed.trim(), foldedUntrimmed, foldedTrimmed],
  ] as const;
  const exposure: RecordedSecretValues = new Map();
  for (const [plaintext, expression] of secrets) {
    // NO EMPTY-NEEDLE GUARD HERE, and the reason has now been wrong twice, so
    // it is stated per-CALLER rather than as a property of this function.
    // `haystack === needle` DOES hold when both are empty -- against a name
    // that canonicalises away entirely -- so this scan returns the entry.
    // What each caller then does with it differs:
    //
    // - `exportNameSecretExposure` -> the deploy REFUSES the alias where it
    //   previously published it. Fail-closed, over a name with no visible
    //   characters at all, so the guard stays out.
    // - `secretSafeKeyDisplay` -> unchanged, `safe`. Its own needle loop and
    //   `canonicalNeedles` both drop the empty needle, so `mask.size === 0`
    //   short-circuits before any `withheld` arm is reachable. A previous
    //   revision of this comment claimed `safe` became `withheld` here; it
    //   was reasoning at THIS function's layer about a result produced two
    //   layers up.
    //
    // What an empty needle cannot do is reach `includes`: the embedded arm is
    // bounded by `needle.length >= MIN_SECRET_NEEDLE`.
    //
    // The guard that matters is in `canonicalNeedles`, keeping an empty needle
    // out of `maskEveryOccurrence` -- `''.split()` interleaves the mask
    // between every character of the key.
    const needle = canonicalNeedle(plaintext);
    const canonicalHit = haystacks.some(
      (haystack) =>
        haystack === needle || (needle.length >= MIN_SECRET_NEEDLE && haystack.includes(needle))
    );
    // DETECTION SPACE (issue #2889): the three detection haystacks above,
    // bounded by the DETECTION needle's own length for the
    // reason the canonical arm is bounded by its own. An ADDED arm, never a
    // replacement: `canonicalHit` is not implied by it, since deleting marks
    // can shorten a needle below the floor.
    //
    // The COMPATIBILITY form (issue #4001) runs the same two tests, but its
    // embedded one needs BOTH detection spellings of the needle to clear the
    // floor. Folding changes length in both directions: `U+2177` (small roman
    // numeral eight) folds to `viii` and `U+2152` to `1` + U+2044 + `10`, so a
    // one-character recorded secret would otherwise refuse every name holding
    // that four-character spelling; and a mathematical letter is two UTF-16
    // units that fold to one, so `U+1D41A U+1D41B` would otherwise be a
    // four-unit needle matching the plain `ab`. The mark-stripped length
    // stands in for the printed one, which it never exceeds except where the
    // mark-stripped arm already applies that larger floor itself. A sub-floor
    // needle is still refused as the WHOLE name.
    const [markedNeedle, foldedNeedle] = detectionNeedlesOf(secrets, plaintext, needle);
    const hitIn = (wides: readonly string[], wideNeedle: string, floor: number): boolean =>
      wides.some(
        (wide) => wide === wideNeedle || (floor >= MIN_SECRET_NEEDLE && wide.includes(wideNeedle))
      );
    const wideHit =
      hitIn(wideHaystacks[0], markedNeedle, markedNeedle.length) ||
      hitIn(wideHaystacks[1], foldedNeedle, Math.min(markedNeedle.length, foldedNeedle.length));
    const rawHit = plaintext.length >= MIN_SECRET_NEEDLE && text.includes(plaintext);
    if (canonicalHit || wideHit || rawHit) exposure.set(plaintext, expression);
  }
  return exposure.size > 0 ? exposure : undefined;
}

/**
 * The secrets present in a resolved `Export.Name`, or `undefined` when it
 * carries none.
 *
 * An `Export.Name` may be an intrinsic (`Fn::Sub` / `Fn::Join`), and those
 * substitute dynamic references — so the resolved name can contain a resolved
 * secret. That name would become a state KEY, and every redaction pass walks
 * VALUES only, so the plaintext would land in `state.json` and be republished
 * into the exports index.
 *
 * THREE signals, and none subsumes another:
 *
 * - `substitutedIntoName` — the caller resolves the name with its OWN
 *   `recordedSecretValues` map, so a non-empty map means the resolver
 *   substituted a secret INTO THIS NAME. Exact, and the only arm that can see a
 *   substituted secret SHORTER than the containment bound below.
 * - a bounded containment scan of `recordedThisPass` ({@link secretsPresentIn}),
 *   which catches plaintext that arrived by any other route — a literal name, a
 *   cache hit, an `Fn::Sub` variable echoing the value.
 * - the same scan over `printingCorpusOf(substitutedIntoName)`, whose LOG-ONLY
 *   needles are what the outputs pass derived from a `NoEcho` value
 *   (go-to-k/cdkd#4043), and over `printingCorpusOf(noEchoParameterValues)`,
 *   every `NoEcho` value the stack holds. Containment only, since both are
 *   stack-wide: a short value (`prod`) embedded in an ordinary name refuses
 *   it, the bound #1919 accepted for a secret.
 *
 * An earlier revision had only the first, calling the scan unpromising because
 * an UNBOUNDED one is: a degenerate one-character recorded secret would make
 * every name containing that character "secret" and silently drop working
 * exports. The bound is what makes the scan safe, and without the scan the
 * deploy wrote `prod-<secret>-endpoint` as a state key that `cdkd scrub` then
 * reported as unrepairable.
 *
 * The containment arm applies with no order caveat: the deploy engine
 * resolves EVERY output value, then EVERY export name, before deciding any
 * alias (go-to-k/cdkd#4043), so this arm sees the complete map whatever the
 * declaration order.
 *
 * No empty-string special case, in either map: the resolver never records an
 * empty secret (`secret-redaction.ts` states it — an empty needle would match
 * every leaf), so an `''` key cannot reach here, and a guard against it would
 * be a branch no test could ever distinguish.
 */
export function exportNameSecretExposure(
  exportName: string,
  substitutedIntoName: RecordedSecretValues,
  recordedThisPass?: RecordedSecretValues,
  noEchoParameterValues?: RecordedSecretValues
): RecordedSecretValues | undefined {
  const exposure: RecordedSecretValues = new Map(substitutedIntoName);
  for (const [plaintext, expression] of secretsPresentIn(exportName, recordedThisPass) ?? []) {
    exposure.set(plaintext, expression);
  }
  // A `NoEcho` PARAMETER's value (go-to-k/cdkd#4043). Two log-only corpora,
  // scanned by containment only, since both are stack-wide: counted
  // wholesale, one `NoEcho` value would refuse every export name. The same
  // scan, and so the same detection haystacks and floor, as a secret: a name
  // EQUAL to the value is refused at any length, one EMBEDDING it at
  // MIN_SECRET_NEEDLE or more.
  //
  // - The name's log-only set, SHARED with the outputs pass: what the pass's
  //   resolutions recorded (an `Fn::Base64` encoding, an `Fn::Split` piece).
  // - `noEchoParameterValues` ({@link noEchoParameterValueSeed}): every
  //   `NoEcho` value the stack holds, whether or not an output reads it, so a
  //   LITERAL name spelling a value only a resource reads is refused too
  //   (maintainer decision on #4043, Phase B).
  for (const corpus of [substitutedIntoName, noEchoParameterValues]) {
    if (corpus === undefined) continue;
    for (const [plaintext, expression] of secretsPresentIn(exportName, printingCorpusOf(corpus)) ??
      []) {
      if (!exposure.has(plaintext)) exposure.set(plaintext, expression);
    }
  }
  return exposure.size > 0 ? exposure : undefined;
}

/**
 * Is every entry of `exposure` a `NoEcho` value (go-to-k/cdkd#4043) -- held by
 * neither the name's own map nor the pass map, so it came from a log-only
 * corpus or the {@link noEchoParameterValueSeed}? The refusal warning then
 * names the `NoEcho` reason instead of a substituted secret.
 */
export function isNoEchoOnlyExposure(
  exposure: RecordedSecretValues,
  substitutedIntoName: RecordedSecretValues,
  recordedThisPass?: RecordedSecretValues
): boolean {
  for (const plaintext of exposure.keys()) {
    if (substitutedIntoName.has(plaintext) || recordedThisPass?.has(plaintext) === true) {
      return false;
    }
  }
  return exposure.size > 0;
}

/**
 * Every `NoEcho` parameter value a stack holds, as LOG-ONLY needles of a new
 * bag, for {@link exportNameSecretExposure}'s seed (go-to-k/cdkd#4043, Phase
 * B). The deploy's outputs pass and `cdkd diff`'s preview build it from the
 * same inputs, so the two verdicts agree.
 *
 * - Each parameter the template declares `NoEcho: true`, in every spelling
 *   `recordLogOnlyParameterValue` records (no `Fn::Split` pieces: a piece is a
 *   verdict needle only once a split in an output or name produces it).
 * - On a nested child, each parent `NoEcho` value one of the child's
 *   parameters CARRIES, read off `inherited`'s log-only needles
 *   (`carryLogOnlyValuesCarriedBy`): a CDK child declares no `NoEcho`, so its
 *   own declarations would seed nothing.
 *
 * - The value as the operator SPELLED it (`userParameters`, else the
 *   template `Default`): a `Number` parameter is coerced before binding, so
 *   `0x1F2A` or `1e10` is bound as `7978` / `10000000000` while a literal
 *   name may spell the original. Not for a `AWS::SSM::Parameter::Value<...>`
 *   parameter: its spelling is the SSM parameter NAME, not the secret, so
 *   seeding it would refuse an ordinary name (`exp-DbPasswordArn`) with a
 *   misleading reason. Its bound value is seeded as above, unless it still
 *   EQUALS that spelling: an operator-supplied SSM-typed value is bound
 *   without a lookup (`coerceParameterTypedValue`), so it is the name too.
 *
 * A value that is one whole `{{resolve:...}}` token (or a list of them) is
 * left out on both sides: it is an expression, not a plaintext, and the
 * parity table publishes a LITERAL name spelled as a token. The deploy binds
 * such a parameter to the token text itself (`resolveParameters` resolves no
 * dynamic reference), so this is the same skip on both sides.
 */
export function noEchoParameterValueSeed(
  parameters:
    | Record<string, { NoEcho?: unknown; Default?: unknown; Type?: unknown } | undefined>
    | undefined,
  values: Record<string, unknown> | undefined,
  inherited?: RecordedSecretValues,
  userParameters?: Record<string, unknown>
): RecordedSecretValues {
  const seed: RecordedSecretValues = new Map();
  if (values === undefined) return seed;
  for (const [name, value] of Object.entries(values)) {
    if (isWholeDynamicReferenceValue(value)) continue;
    if (parameters?.[name]?.NoEcho === true) {
      const type = parameters[name]?.Type;
      const ssmTyped = typeof type === 'string' && type.startsWith('AWS::SSM::Parameter::Value<');
      const spelled = Object.prototype.hasOwnProperty.call(userParameters ?? {}, name)
        ? userParameters?.[name]
        : parameters[name]?.Default;
      // An SSM-typed value an operator SUPPLIED is bound unresolved (no lookup
      // runs for it), so the bound value is still the SSM parameter NAME: not
      // seeded. One a lookup replaced is the secret, and is.
      const boundIsSsmName =
        ssmTyped &&
        typeof value === 'string' &&
        (typeof spelled === 'string' || typeof spelled === 'number') &&
        value === String(spelled);
      if (!boundIsSsmName) recordLogOnlyParameterValue(seed, value);
      if (
        !ssmTyped &&
        (typeof spelled === 'string' || typeof spelled === 'number') &&
        !isWholeDynamicReferenceValue(spelled)
      ) {
        recordLogOnlyParameterValue(seed, String(spelled));
      }
    }
    if (inherited !== undefined) carryLogOnlyValuesCarriedBy(inherited, seed, value);
  }
  return seed;
}

/** A parameter value that is one whole `{{resolve:...}}` token, or a list of them. */
export function isWholeDynamicReferenceValue(value: unknown): boolean {
  if (typeof value === 'string') return isSingleDynamicReferenceToken(value);
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((element) => typeof element === 'string' && isSingleDynamicReferenceToken(element))
  );
}

/**
 * Secrets visible in a state KEY, or `undefined` when there are none.
 *
 * Unlike {@link exportNameSecretExposure} there is no resolution to attribute
 * this to: the key was written by an EARLIER binary, so containment is the only
 * available signal. It is therefore bounded the same way `secret-redaction`
 * bounds its own substring scan — a value shorter than {@link MIN_SECRET_NEEDLE}
 * is matched only as the WHOLE key — because an unbounded containment scan over
 * a degenerate short secret flags every key in the state and fails the
 * `--dry-run --fail` CI gate repo-wide, which is the availability failure the
 * export-name check was redesigned to avoid.
 *
 * Bound and cost are {@link secretsPresentIn}'s; see there.
 */
export function stateKeySecretExposure(
  key: string,
  secrets: RecordedSecretValues
): RecordedSecretValues | undefined {
  return secretsPresentIn(key, secrets);
}

/**
 * Replace EVERY occurrence of every exposed secret with the mask.
 *
 * Deliberately not `maskSecretsInText`: that helper skips needles shorter than
 * its minimum length, which is right when scanning arbitrary bags for
 * coincidental matches but wrong here, where the values are known to be IN this
 * string. Feeding a detected-but-unmaskable name to it printed the secret under
 * a "masked:" label — a message asserting a protection it had not performed.
 * Longest-first so a secret containing another is masked whole.
 */
export function maskEveryOccurrence(text: string, exposure: RecordedSecretValues): string {
  let out = text;
  for (const value of Array.from(exposure.keys()).sort((a, b) => b.length - a.length)) {
    out = out.split(value).join(SECRET_MASK);
  }
  return out;
}
