/**
 * The key-space rules and user-facing messages for the stack-OUTPUTS bag, whose
 * keys come from TWO writers that must agree (issue
 * [#1919](https://github.com/go-to-k/cdkd/issues/1919)).
 *
 * `state.outputs` is keyed by output NAME, and an output carrying `Export:` is
 * additionally ALIASED under its export name in that same bag so a cross-stack
 * `Fn::ImportValue` finds it. Alongside it runs a parallel bag — the redaction
 * POSITION source (issue
 * [#1910](https://github.com/go-to-k/cdkd/issues/1910)) — holding each key's
 * UNRESOLVED template value. Whenever those two bags disagree about which
 * output owns a key, `redactByPath` positions a leaf by a source belonging to a
 * DIFFERENT output and persists that output's `{{resolve:...}}` reference as
 * this one's value. So the rules deciding key ownership live here, in one
 * place, because FOUR writers apply them: `DeployEngine.resolveOutputs` (both of
 * its bags), `cdkd scrub` (which reconstructs the same source bag from the
 * template to redact legacy state), and `analyzer/outputs-diff.ts`, which
 * PREVIEWS the very bag the deploy persists — a count that was wrong here for
 * two rounds, and the missing writer was the one whose divergence surfaces as a
 * phantom diff row on every run. Writers spelling the rule separately is
 * exactly how they drifted apart in the first place.
 *
 * The two writers do NOT share every rule, and the differences are deliberate —
 * each is documented at the rule it applies to. In short: the engine knows
 * which output it just resolved a value from and which outputs its conditions
 * suppressed; scrub knows neither, because its bag was written by an earlier
 * binary under conditions it can only re-evaluate best-effort.
 *
 * THE PARITY TABLE. "These writers agree" is this module's load-bearing claim,
 * and it was carried in review reports rather than in the code until a round
 * traded one divergence for two. Every row is pinned by a test on BOTH sides —
 * `deploy-engine-outputs-export-name-collision.test.ts` and
 * `analyzer/outputs-diff.test.ts` — because a row tested on one side only is
 * how the last divergence shipped.
 *
 * | `Export.Name` shape                          | deploy            | diff              |
 * |----------------------------------------------|-------------------|-------------------|
 * | intrinsic, substitutes a secretsmanager ref    | refuse (exact)    | refuse (spelling) |
 * | intrinsic, substitutes a PINNED SecureString   | refuse (exact)    | publish (residual)|
 * | LITERAL, spelled as a `{{resolve:...}}` token | publish           | publish           |
 * | LITERAL, contains a recorded plaintext        | refuse            | decide from STATE |
 * | intrinsic/literal, unpinned `ssm:` plaintext  | refuse if recorded| publish (residual)|
 * | collides with a published output name         | refuse            | refuse            |
 *
 * The SecureString row is a real divergence, recorded rather than closed: the
 * diff's spelling test matches only `secretsmanager:` / `ssm-secure:`, because a
 * plain `{{resolve:ssm:...}}` is secret by parameter TYPE (issue #1901) and
 * treating the spelling as a signal would fire on ordinary public config. So an
 * intrinsic name substituting a pinned SecureString is refused by the deploy and
 * published by the preview — a permanent phantom ADD. No plaintext escapes (the
 * preview never substitutes one), so it is a reporting defect, not a
 * disclosure.
 *
 * Two rows deserve their reason stated, because both look wrong in isolation:
 *
 * - A LITERAL name spelled as an expression is PUBLISHED, not refused. The
 *   deploy short-circuits a string `Export.Name` past the resolver, so nothing
 *   is substituted and the key holds the EXPRESSION — which is what state
 *   stores post-redaction anyway. Refusing it on the diff side alone produced a
 *   phantom REMOVE on every run.
 * - A LITERAL name in a stack that resolves a secret is decided by the DIFF from
 *   the STORED bag (issue [#1942](https://github.com/go-to-k/cdkd/issues/1942)).
 *   Deploy refuses such a name only when it CONTAINS a resolved plaintext, and
 *   the preview never substitutes one, so it cannot evaluate that predicate —
 *   but state holding the alias KEY proves a previous deploy already evaluated
 *   it and published, over the same literal name, so the preview publishes the
 *   same key with today's value. When the key is ABSENT (a first deploy of the
 *   alias or of the stack) there is no recorded verdict, so the diff falls back
 *   to suppressing its whole outputs delta and RECORDING the alias key as
 *   failed, which is this module's twin's existing answer to "cannot reproduce
 *   what deploy will do" and also avoids printing a plaintext-bearing key into
 *   CI logs. The `outputs-diff.ts` branch carries the two residuals (a rotation
 *   flipping deploy's verdict; a key stored by a pre-#1919 binary, which
 *   records no verdict).
 *
 * The message builders live here for the reason
 * `src/provisioning/nested-stack-messages.ts` gives: a test that pins behavior
 * on a warning must not pin it on a hand-copied string, or a reword silently
 * makes the test vacuous.
 *
 * Unlike that module this one is NOT import-free — it takes `secret-redaction`,
 * which is itself a documented no-import leaf, so no cycle is reachable through
 * it.
 *
 * KNOWN RESIDUALS of the secret-bearing-name refusal, all of the same shape —
 * it can only see what the RESOLVER recorded — and all inherited rather than
 * introduced here:
 *
 * - (CLOSED by issue [#1933](https://github.com/go-to-k/cdkd/issues/1933),
 *   kept here because the reasoning is worth not re-deriving.) An `ssm`
 *   reference whose `Type` came back unclassifiable is still deliberately never
 *   pinned (issue [#1901](https://github.com/go-to-k/cdkd/issues/1901), so the
 *   next pass re-asks AWS rather than inheriting a transient verdict) — but its
 *   VALUE is no longer cached either, precisely so the two cannot disagree. A
 *   later occurrence therefore RE-RESOLVES and records into its own bag rather
 *   than substituting a plaintext with nothing recorded, so the refusal fires.
 * - A `Ref` to a `NoEcho` PARAMETER substituted into an export name is recorded
 *   nowhere: `NoEcho` is outside cdkd's dynamic-reference secret model
 *   entirely, so nothing here can see it.
 * - In the DEPLOY ENGINE, `evaluateConditions` runs before any bag is built and
 *   records into a map that caller discards, while still WARMING the resolver's
 *   dynamic-reference cache — so a PINNED reference (`secretsmanager`, or a
 *   definitive `SecureString`) first reached from a `Conditions` entry is
 *   invisible to every later bag. Narrowed by #1933: an UNPINNED ssm value is
 *   not cached, so it is no longer reachable this way, and a pinned one still
 *   carries its verdict on the cache entry — the residual is now only that the
 *   conditions pass's own recorded VALUES are discarded. Scoped to that ONE
 *   caller: `resolveParameters` routes through `resolveSSMParameter`, not
 *   `resolveDynamicReferences`, so it warms no cache (an earlier revision of
 *   this note claimed otherwise). The fix belongs on the resolver's cache-hit
 *   arm (i.e. with #1901's classification), not here. Named rather than closed.
 *
 *   **NOT true of `cdkd scrub`, and an earlier revision of this bullet said it
 *   was** (corrected with issue #2748). `scrub.ts` hands `evaluateConditions`
 *   its OUTPUTS bag deliberately, so there a condition's secret IS a redaction
 *   needle over outputs — over-redaction of state, which is scrub's purpose,
 *   not the cross-contamination this bullet warns about. Since #2748,
 *   `evaluateConditions` invents a PRIVATE map only when its caller brought
 *   none, so what must not leak is the map this function INVENTS; a caller's
 *   own bag stays that caller's choice.
 * - The refusal errs the other way for `Fn::Select` / `Fn::Split`, whose
 *   DISCARDED elements are still resolved: a secret in an unused element lands
 *   in the name's map and suppresses a working export. Fail-safe and warned, so
 *   it is documented rather than special-cased. (`Fn::If` resolves only the
 *   taken branch and has no such effect.)
 */

import type { TemplateOutput } from '../types/resource.js';
import { SECRET_MASK, type RecordedSecretValues } from './secret-redaction.js';

/**
 * Does CloudFormation suppress this output on this deploy?
 *
 * CFn does not create an output whose `Condition` evaluates false, and
 * `resolveOutputs` mirrors that (issue #1028). Unknown condition names are
 * KEPT, matching `filterResourcesByCondition` on the resource side — a
 * condition cdkd could not evaluate must not silently delete an output.
 *
 * DEPLOY-SIDE ONLY. `cdkd scrub` deliberately does not use this: see
 * {@link collectDeclaredOutputNames}.
 */
export function isOutputSuppressedByCondition(
  output: TemplateOutput,
  conditions?: Record<string, boolean>
): boolean {
  return output.Condition !== undefined && conditions?.[output.Condition] === false;
}

/**
 * The output NAMES this deploy actually publishes — every declared output minus
 * the condition-suppressed ones.
 *
 * This is the set that owns keys in BOTH bags, and the reason the answer is
 * "published" rather than "declared": a suppressed output writes no value, so
 * it must not write a position source either, and its name is free for an
 * export alias to use. Reserving names for suppressed outputs would drop a
 * WORKING export the moment an unrelated condition went false.
 *
 * Sound at deploy time because these are the SAME condition values the deploy
 * itself acted on. Not sound in scrub — see {@link collectDeclaredOutputNames}.
 */
export function collectPublishedOutputNames(
  outputs: Record<string, TemplateOutput>,
  conditions?: Record<string, boolean>
): Set<string> {
  const names = new Set<string>();
  for (const [name, output] of Object.entries(outputs)) {
    if (!isOutputSuppressedByCondition(output, conditions)) names.add(name);
  }
  return names;
}

/**
 * Every DECLARED output name, conditions ignored — the set `cdkd scrub` tests
 * collisions against.
 *
 * Scrub must be a SUPERSET here, and the asymmetry with the deploy engine is
 * forced by what scrub can know. Its condition values are re-evaluated
 * best-effort, from template defaults only (the command takes no
 * `--parameters`), and `evaluateConditions` assumes FALSE on any evaluation
 * failure. So "suppressed" is both easy to hit spuriously and impossible to
 * confirm against the deploy that actually wrote the state.
 *
 * The two error directions are not symmetric, which is what settles the rule:
 *
 * - Judging a colliding output suppressed when the DEPLOY published it (the
 *   spurious-false case above) makes scrub miss the collision, write the
 *   exporting output's expression over the colliding key, and persist a
 *   reference naming a DIFFERENT secret — the #1919 corruption, produced by
 *   the remediation command itself.
 * - Judging it published when the deploy suppressed it costs one spurious
 *   warning and one key redacted by VALUE match instead of by position. State
 *   exactly what that costs, since an earlier revision understated it: the
 *   value map is keyed by PLAINTEXT, so when two DISTINCT secrets resolve to
 *   one value it keeps only the last, and that key can be persisted holding a
 *   reference naming the OTHER secret. It is a smaller blast radius than the
 *   first case (one key, and only when two secrets coincide, versus every
 *   collision) but it is the same KIND of error, not a mere loss of precision.
 *
 * A wrong reference beats a lost precision bound, so scrub over-approximates.
 */
export function collectDeclaredOutputNames(outputs: Record<string, TemplateOutput>): Set<string> {
  return new Set(Object.keys(outputs));
}

/**
 * Would aliasing `exportName` land on a key another output owns?
 *
 * An output exporting under its OWN name is not a collision: the alias rewrites
 * the identical key with the identical value, and both bags then carry the same
 * source.
 *
 * Deliberately NOT extended to two outputs sharing one `Export.Name` with no
 * output of that name. Both bags stay consistent there (one iteration writes
 * both the value and its source), so it is not this issue's class — see
 * `docs/cross-stack-references.md`.
 */
export function isExportAliasCollision(
  exportName: string,
  outputKey: string,
  ownedOutputNames: ReadonlySet<string>
): boolean {
  return exportName !== outputKey && ownedOutputNames.has(exportName);
}

/**
 * Mirrors `secret-redaction`'s own `MIN_NEEDLE_LENGTH`. Duplicated rather than
 * imported because the two bounds answer different questions and should be free
 * to diverge: that one bounds what may be REWRITTEN, this one what may be
 * REFUSED or REPORTED.
 */
const MIN_SECRET_NEEDLE = 4;

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
 * third string. Everything below happens in `canonicalForSecretScan` space.
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
 *   below, and INCLUDED rather than deferred because the cost argument that
 *   defers `\p{Mn}` does not transfer: `\p{Me}` is about a dozen code points
 *   with no legitimate use in a resource name.
 *
 * NAMED RESIDUAL, because `\p{Default_Ignorable_Code_Point}` is Unicode's
 * INTENT-TO-BE-IGNORED property and NOT "everything that renders as nothing"
 * -- an earlier revision of this comment claimed the latter and review refuted
 * it. NONSPACING marks (`\p{Mn}`) carry zero advance width, so a secret split
 * by one renders contiguous while this class keeps it: measured with `U+09BC`,
 * which verdicts `safe` AND publishes the alias. Not widened here, because
 * `\p{Mn}` is the diacritics of Devanagari, Arabic, Hebrew and Vietnamese and
 * deleting it would mangle legitimate names for every user. Tracked as issue
 * [#2889](https://github.com/go-to-k/cdkd/issues/2889), which also carries the
 * homoglyph question. `origin/main` behaves identically, so this is a recorded
 * residual rather than something this change introduced.
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
 * The one string space in which this module tests for, masks, and prints a
 * possibly-secret-bearing name.
 *
 * `.trim()` mirrors `displaySafe`, whose trim this replaces on these paths. It
 * is applied to the TEXT only -- see {@link canonicalNeedle}, where trimming
 * would silently shorten a recorded secret.
 */
function canonicalForSecretScan(text: string): string {
  return text.replace(SECRET_SCAN_INVISIBLES, '').trim();
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
function canonicalNeedle(plaintext: string): string {
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
function canonicalNeedles(secrets: RecordedSecretValues | undefined): RecordedSecretValues {
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
function secretsPresentIn(
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
  // TWO ARMS, EACH BOUNDED BY ITS OWN LENGTH, because a single floor fails in
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
  // THE EFFECTIVE RULE FOR AN EMBEDDED MATCH IS THE RENDERED LENGTH AFTER THE
  // HAYSTACK'S TRIM. The trim is part of the rule, not a detail: a recorded
  // value whose own EDGE whitespace the haystack trims away matches neither
  // arm however long it renders -- measured, a recorded `' a<ZWSP>bcd'`
  // against the key `' abcd-x'` returns `safe` and prints the secret minus one
  // character. `origin/main` does the same, so it is a residual rather than a
  // regression -- tracked as issue
  // [#2890](https://github.com/go-to-k/cdkd/issues/2890) -- and it is written
  // here because two successive revisions of this comment stated the rule
  // WITHOUT the trim and review refuted both. Its scope is narrower than the
  // sentence alone suggests: only `\p{Zs}` edges qualify, since a tab or
  // newline at a needle's edge is `\p{Cc}`, which this class DELETES rather
  // than trims.
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
  const haystack = canonicalForSecretScan(text);
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
    const canonicalHit =
      haystack === needle || (needle.length >= MIN_SECRET_NEEDLE && haystack.includes(needle));
    const rawHit =
      text === plaintext || (plaintext.length >= MIN_SECRET_NEEDLE && text.includes(plaintext));
    if (canonicalHit || rawHit) exposure.set(plaintext, expression);
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
 * TWO signals, and neither subsumes the other:
 *
 * - `substitutedIntoName` — the caller resolves the name with its OWN
 *   `recordedSecretValues` map, so a non-empty map means the resolver
 *   substituted a secret INTO THIS NAME. Exact, and the only arm that can see a
 *   substituted secret SHORTER than the containment bound below.
 * - a bounded containment scan of `recordedThisPass` ({@link secretsPresentIn}),
 *   which catches plaintext that arrived by any other route — a literal name, a
 *   cache hit, an `Fn::Sub` variable echoing the value.
 *
 * An earlier revision had only the first, calling the scan unpromising because
 * an UNBOUNDED one is: a degenerate one-character recorded secret would make
 * every name containing that character "secret" and silently drop working
 * exports. The bound is what makes the scan safe, and without the scan the
 * deploy wrote `prod-<secret>-endpoint` as a state key that `cdkd scrub` then
 * reported as unrepairable.
 *
 * The containment arm applies with no order caveat any more: the deploy engine
 * resolves EVERY output value
 * before deciding any alias, so this arm sees the complete map whatever the
 * declaration order. (An earlier revision of this paragraph said catching that
 * required "resolving the whole template before deciding anything" and called
 * it impractical — the value pass already does exactly that, at no extra cost.
 * The residual is now only a secret first substituted by ANOTHER output's
 * `Export.Name`, since those resolve in the second pass, in declaration order.)
 *
 * No empty-string special case, in either map: the resolver never records an
 * empty secret (`secret-redaction.ts` states it — an empty needle would match
 * every leaf), so an `''` key cannot reach here, and a guard against it would
 * be a branch no test could ever distinguish.
 */
export function exportNameSecretExposure(
  exportName: string,
  substitutedIntoName: RecordedSecretValues,
  recordedThisPass?: RecordedSecretValues
): RecordedSecretValues | undefined {
  const exposure: RecordedSecretValues = new Map(substitutedIntoName);
  for (const [plaintext, expression] of secretsPresentIn(exportName, recordedThisPass) ?? []) {
    exposure.set(plaintext, expression);
  }
  return exposure.size > 0 ? exposure : undefined;
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
function stateKeySecretExposure(
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
function maskEveryOccurrence(text: string, exposure: RecordedSecretValues): string {
  let out = text;
  for (const value of Array.from(exposure.keys()).sort((a, b) => b.length - a.length)) {
    out = out.split(value).join(SECRET_MASK);
  }
  return out;
}

/**
 * Warning for an `Export.Name` that resolved to something containing secret
 * plaintext. Refused rather than published: the name would be a state KEY, and
 * keys are never redacted.
 *
 * The name is shown MASKED, and omitted entirely if masking somehow left it
 * unchanged. stderr is a reader like any other, so the invariant is absolute: a
 * message must never claim a masking it did not perform.
 */
export function secretBearingExportNameWarning(
  outputKey: string,
  exportName: string,
  exposure: RecordedSecretValues,
  secrets?: RecordedSecretValues
): string {
  // `exposure` is the caller's AUTHORITATIVE set -- what resolution put into
  // THIS EXPORT NAME -- and is the force-mask input for the export name ONLY.
  // `secrets` is the containment corpus. Both are needed and neither
  // substitutes for the other (issue #2874): the authoritative set sees a
  // sub-floor or fragment substitution containment cannot, and containment
  // sees a second recorded secret the resolver did not put here but which this
  // name happens to hold.
  const corpus = secrets ?? exposure;
  const name = secretSafeKeyDisplay(exportName, corpus, exposure);
  const shown = name.kind === 'masked' ? `(masked: "${name.text}") ` : '';
  // THE OUTPUT KEY'S FORCE-MASK SET IS BOUNDED; the export name's is not, and
  // the asymmetry is the point. Resolution KNOWS it put `exposure` into the
  // export name, so masking it there at any length is right. It knows nothing
  // about the output key: a sub-floor value appearing in a template-authored
  // name is a coincidence in almost every case, and masking it threshold-free
  // SHREDS the identifier the operator has to act on -- measured, a
  // one-character substituted secret rendered `ApiGatewayEndpoint` as
  // `ApiG***tew***yEndpoint`.
  //
  // So the key's force-mask needles are filtered by the same whole-vs-embedded
  // rule `secretsPresentIn` applies. The residual is stated rather than
  // hidden: a genuinely sub-floor secret embedded in an output key is NOT
  // masked here, which is the identical tradeoff containment already makes.
  const ownerForceMask: RecordedSecretValues = new Map();
  for (const [plaintext, expression] of exposure) {
    // The CANONICAL whole-value comparison sits beside the raw one, or the
    // filter implements half the rule the sentence above names and a key
    // differing from its needle by one invisible character prints raw.
    // Hard to reach through the engine, whose corpus is USUALLY a superset of
    // `exposure` so containment catches the case first -- but not provably so:
    // `recordedSecretValues` is optional on the context, and issue #2563 loses
    // a `nameSecrets` entry a still-pending `Fn::Join` part records. Driven
    // directly by a test rather than left to that argument.
    if (
      plaintext === outputKey ||
      canonicalNeedle(plaintext) === canonicalForSecretScan(outputKey) ||
      plaintext.length >= MIN_SECRET_NEEDLE
    ) {
      ownerForceMask.set(plaintext, expression);
    }
  }
  const owner = displayTextOrWithheld(secretSafeKeyDisplay(outputKey, corpus, ownerForceMask));
  return (
    `Output ${owner} has an Export.Name that resolves to a value containing a secret ` +
    `${shown}— skipping the export alias. ` +
    `An export name becomes a key in state.json and in the exports index, and redaction rewrites ` +
    `VALUES only, so publishing it would persist the secret in plaintext. ` +
    `Use a non-secret Export.Name.`
  );
}

/**
 * How a state-bag KEY may be SHOWN, once it has been tested for secret content
 * (issue [#2667](https://github.com/go-to-k/cdkd/issues/2667)).
 *
 * An export name IS a key of `state.outputs` and of the exports index, and a
 * key holding secret plaintext is the residue `cdkd scrub` exists to report —
 * so any message naming one has to go through the same test the warnings below
 * apply, not through a control-character strip. `displaySafe` /
 * `stripControlChars` sanitise for a TERMINAL; neither masks a secret.
 *
 * Three outcomes, and the third is the one a caller must not collapse into the
 * first: masking can leave the text UNCHANGED (a needle below
 * {@link MIN_SECRET_NEEDLE} that matched only as the whole key, or a mask that
 * happens to equal the input), and printing it then would publish the secret
 * under a label asserting it had been masked —
 * {@link secretBearingExportNameWarning}'s invariant, applied here.
 */
export type SecretSafeKeyDisplay =
  | { kind: 'safe'; text: string }
  | { kind: 'masked'; text: string }
  | { kind: 'withheld' };

/**
 * Test `key` for recorded secret plaintext and return how it may be shown.
 *
 * Reuses {@link stateKeySecretExposure} and the same `maskEveryOccurrence` the
 * warnings below use, rather than restating either: two spellings of "is this
 * key safe to print" would disagree on the boundary cases those two encode
 * (the whole-key match for a sub-floor needle, longest-needle-first masking).
 *
 * CANONICAL SPACE, not a composition of the two sanitisers. An earlier
 * revision of this comment described running `stripControlChars` and then
 * `displaySafe`, with a table of what each one touches and a note that the
 * ORDER was load-bearing. That composition WAS the defect (issue
 * [#2874](https://github.com/go-to-k/cdkd/issues/2874)): it leaves three
 * strings in play -- the raw key the verdict came from, the sanitised key that
 * was printed, and the masked one between them -- and `stripControlChars`
 * DELETES, so a plaintext split by one of its characters is absent from the
 * first and contiguous in the second. See {@link SECRET_SCAN_INVISIBLES} for
 * the class that replaced it and why it is derived rather than enumerated.
 */
export function secretSafeKeyDisplay(
  key: string,
  secrets: RecordedSecretValues,
  forceMask?: RecordedSecretValues
): SecretSafeKeyDisplay {
  // ONE STRING SPACE for the verdict, the masking and the returned text
  // (issue #2874). The bug this replaces was not a missing arm on the check --
  // it was the check, the mask and the print each running over a DIFFERENT
  // string.
  const shown = canonicalForSecretScan(key);

  // THE VERDICT COMES FROM CONTAINMENT ALONE. `secretsPresentIn` is handed the
  // RAW map, not pre-canonicalised needles, because its four-character floor
  // is keyed to the RECORDED length -- passing canonical needles would apply
  // the floor to the shortened form and drop a secret that only LOOKS
  // degenerate after its invisible characters are removed.
  const exposure = stateKeySecretExposure(key, secrets);

  // The caller's AUTHORITATIVE exposure -- what resolution PUT in this name --
  // is force-masked and deliberately NOT part of the verdict above.
  // `secretsPresentIn` bounds an embedded match at MIN_SECRET_NEEDLE while
  // `maskEveryOccurrence` is threshold-free, so a sub-floor secret the
  // resolver knows it substituted is masked today and would stop being masked
  // if the mask set were recomputed by containment alone (measured). It is not
  // a VERDICT input because that signal is about what resolution DID, not
  // about what is textually here.
  const mask: RecordedSecretValues = canonicalNeedles(forceMask);
  for (const [plaintext, expression] of exposure ?? []) {
    const needle = canonicalNeedle(plaintext);
    if (needle.length > 0) mask.set(needle, expression);
  }
  if (mask.size === 0) return { kind: 'safe', text: shown };

  const masked = maskEveryOccurrence(shown, mask);
  if (masked === shown) {
    // NOTHING CHANGED, and which answer that deserves depends on WHY.
    //
    // With an exposure, a needle really is in this text and masking failed to
    // remove it, so the name is withheld -- fail closed. With NO exposure the
    // only needles were force-mask ones that are simply absent from the text,
    // which is the ordinary case for the OUTPUT KEY beside a secret-bearing
    // export name: collapsing that into `withheld` withheld an innocent name
    // on the DEFAULT deploy path and printed a placeholder asserting the name
    // "contains a secret", which was false (measured against `main`).
    //
    // `safe` HERE DOES NOT MEAN "containment cleared it". A recorded secret
    // below MIN_SECRET_NEEDLE that is genuinely embedded in this text is not
    // an exposure and is not masked -- the same documented tradeoff that lets
    // it through when the mask set is empty. Named so the next reader does not
    // take this arm for a stronger claim than it makes.
    return exposure ? { kind: 'withheld' } : { kind: 'safe', text: shown };
  }
  // FAIL CLOSED. Masking is a substring replacement, so a name holding the
  // same secret twice -- once contiguous, once split -- used to mask the first
  // occurrence and print the second. In canonical space that cannot happen,
  // and this re-test is what PROVES it rather than asserting it: any needle
  // still present after masking withholds the whole name.
  if (stateKeySecretExposure(masked, secrets)) return { kind: 'withheld' };
  return { kind: 'masked', text: masked };
}

/**
 * The display for a name plus the verdict its CALLER needs, as one value.
 *
 * Exists so a caller cannot take the verdict from one call and the text from
 * another — the shape of the bug in {@link secretSafeKeyDisplay}'s own callers
 * (issue #2874), one level up.
 */
export function secretBearing(
  display: SecretSafeKeyDisplay
): display is Exclude<SecretSafeKeyDisplay, { kind: 'safe' }> {
  // A TYPE PREDICATE, so a caller that guards on it can hand the SAME display
  // to {@link secretBearingStateKeyWarning}, whose parameter excludes `safe`.
  // That is what makes "the verdict and the printed text came from one call"
  // a compile-time property at the call site rather than a convention.
  return display.kind !== 'safe';
}

/**
 * What a message prints in place of a name it may not show.
 *
 * Deliberately not name-shaped and never quoted as if it were a key: a reader
 * has to be able to tell this is the tool declining, not an odd export name.
 */
export const WITHHELD_NAME_DISPLAY = '<name withheld: contains a secret>';

/** The text of a display, or {@link WITHHELD_NAME_DISPLAY} when there is none. */
export function displayTextOrWithheld(display: SecretSafeKeyDisplay): string {
  return display.kind === 'withheld' ? WITHHELD_NAME_DISPLAY : display.text;
}

/**
 * Warning for a state KEY that already holds secret plaintext — the residue an
 * EARLIER binary left when it published an export name that resolved to one.
 *
 * `cdkd scrub` cannot repair this. Every redaction pass rewrites VALUES; a key
 * is the export's identity, so renaming it here would silently retire an export
 * consumers resolve by name, and dropping it would delete a live export. The
 * remedy is in the template: give the output a non-secret `Export.Name` and
 * redeploy, which rewrites `state.outputs` wholesale and republishes the index.
 * Reported so the `--dry-run --fail` CI gate stops calling such a state clean.
 */
export function secretBearingStateKeyWarning(
  stackName: string,
  display: Exclude<SecretSafeKeyDisplay, { kind: 'safe' }>
): string {
  // TAKES THE DISPLAY, NOT THE KEY. The caller has already computed it to
  // decide whether to warn at all, so recomputing here would be a second
  // chance for the verdict and the printed text to disagree -- the exact shape
  // of issue #2874, one level up. The `safe` arm is excluded by the TYPE
  // rather than handled: a safe display reaching this builder is a caller bug,
  // and the previous revision's three-arm version rendered
  // `holds an output KEY that renders a secret (key: "...")` for a key with no
  // recorded secret at all.
  const clause =
    display.kind === 'masked'
      ? `(masked: "${display.text}") `
      : `(the name is withheld: masking it would leave the secret readable) `;
  // "RENDERS a secret", not "containing a secret": for a key split by an
  // invisible character the key does not literally CONTAIN the plaintext --
  // its rendering reconstitutes it, which is the whole reason this class was
  // invisible to the previous check. A message that overstates what it found
  // is how the previous wording survived being wrong.
  return (
    `State for ${canonicalForSecretScan(stackName)} holds an output KEY that renders a secret ` +
    `${clause}— cdkd scrub cannot rewrite a key, ` +
    `only a value, because the key IS the export name consumers resolve by. ` +
    `Give that output a non-secret Export.Name and redeploy: the next deploy replaces ` +
    `state.outputs and the exports index entirely. ROTATE the exposed secret.`
  );
}

/**
 * Warning for an `Export.Name` colliding with an output NAME it does not own.
 *
 * Names both outputs because the two are equally likely to be the mistake, and
 * says which value survives — the export is skipped, so the key keeps the
 * output's own value.
 *
 * MASKED HERE, and the bound that used to excuse it is named rather than
 * relied on. This message prints a name that MATCHED a declared output name --
 * template text -- and a secret-bearing `Export.Name` is refused by
 * {@link secretBearingExportNameWarning} upstream. But that is SOMEBODY ELSE'S
 * VERDICT, and this site is reached from exactly the arm taken when it MISSED:
 * before issue [#2874](https://github.com/go-to-k/cdkd/issues/2874)
 * canonicalised the containment scan, it missed for eight of ten invisible
 * characters, and this message printed the plaintext verbatim.
 */
export function exportAliasCollisionWarning(
  outputKey: string,
  exportName: string,
  secrets: RecordedSecretValues
): string {
  // THE FOURTH SITE, and the one issue #2874's own grep could not see: it
  // composes `stripControlChars` with NOTHING, so a search for the composed
  // shape missed it while the hazard is identical. `stripControlChars`
  // DELETES, so a recorded plaintext split by one of its characters is
  // reconstituted into this message.
  //
  // Its doc above argues the exposure is bounded because
  // `secretBearingExportNameWarning` refuses a secret-bearing name upstream.
  // That bound is REAL but it is somebody else's verdict, and this site is
  // reached from exactly the `else if` arm taken when that verdict MISSED --
  // which, before #2874 canonicalised the containment scan, it did for eight
  // of ten invisible characters. Measured leaking the plaintext verbatim.
  //
  // So the name is tested HERE too, and `secrets` is REQUIRED rather than
  // optional. An optional corpus was written first and measured printing the
  // plaintext when omitted -- the same foot-gun `exportAliasCollisionScrubWarning`
  // avoids by requiring its own. BOTH names go through the test: `outputKey`
  // is template-controlled and printed three times in this message.
  const shown = displayTextOrWithheld(secretSafeKeyDisplay(exportName, secrets));
  const from = displayTextOrWithheld(secretSafeKeyDisplay(outputKey, secrets));
  return (
    `Output ${from} exports as "${shown}", which is also the name of another output in this stack — ` +
    `skipping the export alias, so output ${shown} keeps its own value and the export is not published. ` +
    `A consumer's Fn::ImportValue on "${shown}" therefore resolves to output ${shown}, NOT to ${from} ` +
    `(CloudFormation would publish both). Rename the export, or the colliding output.`
  );
}

/**
 * Warning for the same collision seen by `cdkd scrub`, whose remedy differs.
 *
 * Scrub does not resolve outputs — it redacts state written by an EARLIER
 * binary, where the alias may have won the colliding key — so it cannot claim
 * the key belongs to either output. It drops the position source for that key
 * and lets the value scan decide from the plaintext actually stored, which is
 * why this message promises something weaker than the deploy-time one. It can
 * also fire on a template the deploy handled cleanly, per
 * {@link collectDeclaredOutputNames}.
 */
export function exportAliasCollisionScrubWarning(
  outputKey: string,
  exportName: string,
  secrets: RecordedSecretValues
): string {
  // A BELT, stated as one rather than as a hazard this mask is known to close
  // (issue #1958 item 9). What actually bounds the exposure is the COLLISION
  // TEST upstream, not this call: {@link scrubStack} warns only for a name that
  // matched a DECLARED output name, and {@link collectDeclaredOutputNames} is
  // `Object.keys(template.Outputs)` — so the string printed here is always one
  // the template itself spells, however the `Export.Name` intrinsic resolved.
  //
  // That leaves the mask REACHABLE but narrow, and the shape is worth naming
  // because it is not the one the argument was originally justified by: it
  // takes a template that NAMES an output with the secret plaintext, which the
  // `MASKS a resolved name that carries plaintext` case in
  // `scrub-export-name-collision.test.ts` builds. The mask still earns its keep
  // there — the template is not stderr, and not a CI log.
  //
  // The argument stays REQUIRED for a reason about scrub rather than about this
  // string. The deploy twin has the bound STRUCTURALLY:
  // {@link secretBearingExportNameWarning} refuses a secret-bearing
  // `Export.Name` before the collision path can see it, which is why
  // {@link exportAliasCollisionWarning} takes no map at all. Scrub publishes no
  // alias, so it runs no such refusal and its bound rests on the collision test
  // alone — one predicate away from a future caller that widens the set of
  // names reaching here.
  //
  // BOTH names are masked, not just the exported one (issue #1958 review). They
  // come from the same place: the collision fired because `exportName` matched a
  // DECLARED output name, so `outputKey` is a declared output name too, and the
  // reachable shape above — a template that NAMES an output with the plaintext —
  // puts the plaintext on whichever of the two is that output. Masking one and
  // printing its neighbour raw is the mask-one-argument-leave-its-neighbour
  // shape issue #2176 found in the providers, one line apart instead of two
  // files.
  // THIS SITE PRINTS EVEN WHEN THE VERDICT MISSES, which is what made it the
  // worst of the three (issue #2874): the other two sit behind a caller that
  // skips the message entirely, so a missed verdict there is a detection gap;
  // here it was a disclosure, and it needed only ONE recorded secret split by
  // an invisible character rather than two. Routing through
  // `secretSafeKeyDisplay` keeps the print-always behaviour — the collision
  // and its remedy are actionable whether or not a name can be shown — while
  // making the printed text and the verdict the same string.
  const nameDisplay = (name: string): SecretSafeKeyDisplay => secretSafeKeyDisplay(name, secrets);
  const exportDisplay = nameDisplay(exportName);
  const shown = displayTextOrWithheld(exportDisplay);
  // The `stored value under "..."` clause loses its referent when the name is
  // withheld, so it is REWORDED rather than left quoting a placeholder as if
  // it were a key. The pair is still identified: the sibling name and the
  // stack name reach the operator through the rest of the message.
  const storedUnder =
    exportDisplay.kind === 'withheld'
      ? 'the stored value under that name'
      : `the stored value under "${shown}"`;
  // WHEN BOTH NAMES WITHHOLD the two placeholders are identical, and the
  // sentence then reads as a name colliding with ITSELF. Distinguish them:
  // the reader cannot act on either name, but must still be able to tell that
  // there are two.
  const ownerDisplay = nameDisplay(outputKey);
  const owner =
    ownerDisplay.kind === 'withheld' && exportDisplay.kind === 'withheld'
      ? '<the owning output, name withheld: contains a secret>'
      : displayTextOrWithheld(ownerDisplay);
  return (
    `Output ${owner} exports as ${
      exportDisplay.kind === 'withheld' ? shown : `"${shown}"`
    }, which is also the name of another output in this stack — ` +
    `state cannot say which of the two ${storedUnder} came from, so that key is ` +
    `redacted by value match instead of by template position, and two references resolving to the same ` +
    `value could still collapse there. Rename the export, or the colliding output, and redeploy.`
  );
}
