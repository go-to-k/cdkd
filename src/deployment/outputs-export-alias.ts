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
 * place, because THREE writers apply them: `DeployEngine.resolveOutputs` (both
 * of its bags) and `cdkd scrub`, which reconstructs the same source bag from
 * the template to redact legacy state. Two of those writers spelling the rule
 * separately is exactly how they drifted apart in the first place.
 *
 * The two writers do NOT share every rule, and the differences are deliberate —
 * each is documented at the rule it applies to. In short: the engine knows
 * which output it just resolved a value from and which outputs its conditions
 * suppressed; scrub knows neither, because its bag was written by an earlier
 * binary under conditions it can only re-evaluate best-effort.
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
 * The secrets present in a resolved `Export.Name`, or `undefined` when it
 * carries none.
 *
 * An `Export.Name` may be an intrinsic (`Fn::Sub` / `Fn::Join`), and those
 * substitute dynamic references — so the resolved name can contain a resolved
 * secret. That name would become a state KEY, and every redaction pass walks
 * VALUES only, so the plaintext would land in `state.json` and be republished
 * into the exports index.
 *
 * The primary signal is `substitutedIntoName`: the caller resolves the name
 * with its OWN `recordedSecretValues` map, so a non-empty map means the
 * resolver substituted a secret INTO THIS NAME. That is exact — no length
 * threshold and no coincidental match, which a containment scan over the whole
 * pass's secrets cannot promise. (An earlier revision used that scan and it was
 * wrong in both directions: a degenerate one-character recorded secret made
 * every name containing that character "secret" and silently dropped unrelated
 * working exports, while the mask it fed could not mask short values at all.)
 *
 * `recordedThisPass` adds one exact backstop: a name whose WHOLE value equals a
 * recorded secret. That covers a LITERAL `Export.Name` spelling out a value
 * that is a secret elsewhere in the template, where nothing was substituted.
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
  const wholeValue = recordedThisPass?.get(exportName);
  if (wholeValue !== undefined) exposure.set(exportName, wholeValue);
  return exposure.size > 0 ? exposure : undefined;
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
  const masked = maskEveryOccurrence(exportName, exposure);
  const shown = masked === exportName ? '' : `(masked: "${masked}") `;
  return (
    `Output ${outputKey} has an Export.Name that resolves to a value containing a secret ` +
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
    `State for ${stackName} holds an output KEY containing a secret ` +
    `(masked: "${maskEveryOccurrence(key, exposure)}") — cdkd scrub cannot rewrite a key, ` +
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
  return (
    `Output ${outputKey} exports as "${exportName}", which is also the name of another output in this stack — ` +
    `skipping the export alias, so output ${exportName} keeps its own value and the export is not published. ` +
    `A consumer's Fn::ImportValue on "${exportName}" therefore resolves to output ${exportName}, NOT to ${outputKey} ` +
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
export function exportAliasCollisionScrubWarning(outputKey: string, exportName: string): string {
  return (
    `Output ${outputKey} exports as "${exportName}", which is also the name of another output in this stack — ` +
    `state cannot say which of the two the stored value under "${exportName}" came from, so that key is ` +
    `redacted by value match instead of by template position, and two references resolving to the same ` +
    `value could still collapse there. Rename the export, or the colliding output, and redeploy.`
  );
}
