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
 * The message builders live here for the reason
 * `src/provisioning/nested-stack-messages.ts` gives: a test that pins behavior
 * on a warning must not pin it on a hand-copied string, or a reword silently
 * makes the test vacuous.
 *
 * Unlike that module this one is NOT import-free — it takes `secret-redaction`,
 * which is itself a documented no-import leaf, so no cycle is reachable through
 * it. The masking has to be here rather than at the call sites: an export name
 * can be an INTRINSIC that resolved to secret plaintext, and a builder that
 * accepted a pre-masked string would put the burden of remembering on every
 * caller — which is the same shape of mistake this module exists to prevent.
 */

import type { TemplateOutput } from '../types/resource.js';
import { maskSecretsInText, type RecordedSecretValues } from './secret-redaction.js';

/**
 * Does CloudFormation suppress this output on this deploy?
 *
 * CFn does not create an output whose `Condition` evaluates false, and
 * `resolveOutputs` mirrors that (issue #1028). Unknown condition names are
 * KEPT, matching `filterResourcesByCondition` on the resource side — a
 * condition cdkd could not evaluate must not silently delete an output.
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
 * Would aliasing `exportName` land on a key another published output owns?
 *
 * An output exporting under its OWN name is not a collision: the alias rewrites
 * the identical key with the identical value, and both bags then carry the same
 * source.
 */
export function isExportAliasCollision(
  exportName: string,
  outputKey: string,
  publishedOutputNames: ReadonlySet<string>
): boolean {
  return exportName !== outputKey && publishedOutputNames.has(exportName);
}

/**
 * Does this resolved export name carry secret PLAINTEXT?
 *
 * An `Export.Name` may be an intrinsic (`Fn::Sub` / `Fn::Join`), and those
 * substitute dynamic references — so the resolved name can contain a resolved
 * secret. That name would become a state KEY, and every redaction pass walks
 * VALUES only, so the plaintext would land in `state.json` and be republished
 * into the exports index.
 *
 * Deliberately an exact CONTAINMENT scan rather than
 * `recordedSecretValues.has(name)` or a `maskSecretsInText` round-trip
 * comparison: the former only catches a name that is EXACTLY the secret, and
 * the latter inherits the mask's minimum-needle-length filter, which skips
 * short secrets embedded in a longer name. Both leave a leak this check exists
 * to refuse, and the scan is over a handful of recorded values.
 */
export function exportNameCarriesSecret(
  exportName: string,
  secrets: RecordedSecretValues | undefined
): boolean {
  if (!secrets || secrets.size === 0) return false;
  for (const value of secrets.keys()) {
    if (value !== '' && exportName.includes(value)) return true;
  }
  return false;
}

/**
 * Warning for an `Export.Name` colliding with a published output NAME.
 *
 * Names both outputs because the two are equally likely to be the mistake, and
 * says which value survives — the export is skipped, so the key keeps the
 * output's own value. `exportName` is masked: it can be an intrinsic that
 * resolved to secret plaintext, and stderr is a reader like any other.
 */
export function exportAliasCollisionWarning(
  outputKey: string,
  exportName: string,
  secrets?: RecordedSecretValues
): string {
  const shown = secrets ? maskSecretsInText(exportName, secrets) : exportName;
  return (
    `Output ${outputKey} exports as "${shown}", which is also the name of another output in this stack — ` +
    `skipping the export alias, so output ${shown} keeps its own value and the export is not published. ` +
    `A consumer's Fn::ImportValue on "${shown}" therefore resolves to output ${shown}, NOT to ${outputKey} ` +
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
 * why this message promises something weaker than the deploy-time one.
 */
export function exportAliasCollisionScrubWarning(outputKey: string, exportName: string): string {
  return (
    `Output ${outputKey} exports as "${exportName}", which is also the name of another output in this stack — ` +
    `state cannot say which of the two the stored value under "${exportName}" came from, so that key is ` +
    `redacted by value match instead of by template position, and two references resolving to the same ` +
    `value could still collapse there. Rename the export, or the colliding output, and redeploy.`
  );
}

/**
 * Warning for an `Export.Name` that resolved to something containing secret
 * plaintext. Refused rather than published: the name would be a state KEY, and
 * keys are never redacted.
 */
export function secretBearingExportNameWarning(
  outputKey: string,
  exportName: string,
  secrets: RecordedSecretValues
): string {
  return (
    `Output ${outputKey} has an Export.Name that resolves to a value containing a secret ` +
    `(masked: "${maskSecretsInText(exportName, secrets)}") — skipping the export alias. ` +
    `An export name becomes a key in state.json and in the exports index, and redaction rewrites ` +
    `VALUES only, so publishing it would persist the secret in plaintext. ` +
    `Use a non-secret Export.Name.`
  );
}
