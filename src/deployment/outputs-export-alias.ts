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
 * | LITERAL, contains a recorded plaintext        | refuse            | SUPPRESS delta    |
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
 * - A LITERAL name in a stack that resolves a secret makes the DIFF suppress its
 *   whole outputs delta, and RECORD the alias key as failed so the suppression
 *   warning cannot blame the wrong cause. Deploy refuses such a name only when
 *   it CONTAINS a resolved plaintext, and the preview never substitutes one, so
 *   it cannot decide; suppressing is this module's twin's existing answer to
 *   "cannot reproduce what deploy will do", and it also avoids printing a
 *   plaintext-bearing key into CI logs. It is deliberately the WEAKER of the two
 *   fixes considered: deciding the case from the stored bag (state holding the
 *   key proves a previous deploy published it) would keep the outputs delta
 *   working, but it is a new positive arm and belongs in its own review rather
 *   than in a fix round — issue
 *   [#1942](https://github.com/go-to-k/cdkd/issues/1942).
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
 * - An `ssm` reference whose `Type` came back unclassifiable is deliberately
 *   never pinned (issue
 *   [#1901](https://github.com/go-to-k/cdkd/issues/1901), so the next pass
 *   re-asks AWS rather than inheriting a transient verdict), so a later cache
 *   hit can substitute that plaintext with nothing recorded and the refusal
 *   cannot fire. Closing it belongs with #1901's classification.
 * - A `Ref` to a `NoEcho` PARAMETER substituted into an export name is recorded
 *   nowhere: `NoEcho` is outside cdkd's dynamic-reference secret model
 *   entirely, so nothing here can see it.
 * - `evaluateConditions` runs BEFORE any bag is built, in both the deploy engine
 *   and `cdkd scrub`, and records into a map its caller discards while still
 *   WARMING the resolver's dynamic-reference cache — so an unpinned ssm
 *   reference first reached from a `Conditions` entry is invisible to every
 *   later bag. Scoped to that ONE caller: `resolveParameters` routes through
 *   `resolveSSMParameter`, not `resolveDynamicReferences`, so it warms no cache
 *   (an earlier revision of this note claimed otherwise). Merging a conditions
 *   map into an outputs bag would make a condition's secret a redaction NEEDLE
 *   over outputs — the cross-contamination the per-bag design exists to
 *   prevent — so the fix belongs on the resolver's cache-hit arm (i.e. with
 *   #1901's classification), not here. Named rather than closed.
 * - The refusal errs the other way for `Fn::Select` / `Fn::Split`, whose
 *   DISCARDED elements are still resolved: a secret in an unused element lands
 *   in the name's map and suppresses a working export. Fail-safe and warned, so
 *   it is documented rather than special-cased. (`Fn::If` resolves only the
 *   taken branch and has no such effect.)
 */

import type { TemplateOutput } from '../types/resource.js';
import { stripControlChars } from '../utils/regexp.js';
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
  const exposure: RecordedSecretValues = new Map();
  for (const [plaintext, expression] of secrets) {
    if (text === plaintext || (plaintext.length >= MIN_SECRET_NEEDLE && text.includes(plaintext))) {
      exposure.set(plaintext, expression);
    }
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
  exposure: RecordedSecretValues
): string {
  const masked = stripControlChars(maskEveryOccurrence(exportName, exposure));
  const shown = masked === stripControlChars(exportName) ? '' : `(masked: "${masked}") `;
  return (
    `Output ${stripControlChars(outputKey)} has an Export.Name that resolves to a value containing a secret ` +
    `${shown}— skipping the export alias. ` +
    `An export name becomes a key in state.json and in the exports index, and redaction rewrites ` +
    `VALUES only, so publishing it would persist the secret in plaintext. ` +
    `Use a non-secret Export.Name.`
  );
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
  key: string,
  exposure: RecordedSecretValues
): string {
  return (
    `State for ${stripControlChars(stackName)} holds an output KEY containing a secret ` +
    `(masked: "${stripControlChars(maskEveryOccurrence(key, exposure))}") — cdkd scrub cannot rewrite a key, ` +
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
 * No masking here, and none is needed: the name printed is one that MATCHED a
 * declared output name, i.e. template text, and a name carrying a secret is
 * refused by {@link secretBearingExportNameWarning} before this is reached.
 */
export function exportAliasCollisionWarning(outputKey: string, exportName: string): string {
  const shown = stripControlChars(exportName);
  const from = stripControlChars(outputKey);
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
  // The masking argument is REQUIRED so a future caller cannot silently print
  // an unmasked name — even though today it never fires. Both callers only
  // reach this message when the name MATCHED a declared output name, i.e.
  // template text, so a resolved intrinsic carrying plaintext is refused by the
  // collision test before it can be printed. An earlier comment here claimed
  // the opposite as the reason for masking; the honest reason is that scrub,
  // unlike the deploy twin, has no secret refusal upstream to make that
  // guarantee structural, so the mask stays as the cheap belt.
  const exposure = secretsPresentIn(exportName, secrets);
  const shown = stripControlChars(
    exposure ? maskEveryOccurrence(exportName, exposure) : exportName
  );
  return (
    `Output ${stripControlChars(outputKey)} exports as "${shown}", which is also the name of another output in this stack — ` +
    `state cannot say which of the two the stored value under "${shown}" came from, so that key is ` +
    `redacted by value match instead of by template position, and two references resolving to the same ` +
    `value could still collapse there. Rename the export, or the colliding output, and redeploy.`
  );
}
