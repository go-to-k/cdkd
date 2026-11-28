import type { StackState } from '../../../types/state.js';
import { redactForState, maskSecretsInText } from '../../../deployment/secret-redaction.js';
import { displayIdent, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import {
  findUnrepairedCrossStackReadNames,
  type UnrepairedCrossStackReadName,
} from './cross-stack-findings.js';
import { allRecordedSecrets } from './outputs.js';
import type { ScrubStackRewriteInput } from './stack.js';

/**
 * The cross-stack read-name walk of {@link scrubStackRewritePass}, moved
 * verbatim to keep that pass under the source-file size cap: repair
 * `imports[].exportName` and `outputReads[].{sourceStack,outputName}` with
 * this run's needles, and report the entries it could not repair.
 *
 * go-to-k/cdkd#3289 closed the WRITE side: `imports[].exportName`,
 * `outputReads[].sourceStack` and `outputReads[].outputName` are redacted at
 * the persist choke point, so a name an `Fn::Sub` assembled around a
 * resolved `{{resolve:...}}` no longer reaches `state.json` in plaintext. It
 * did NOT close the repair side — both lists rode {@link scrubStackRewritePass}'s
 * `...carriedState` spread untouched, so a record an older binary already
 * wrote kept its plaintext and `cdkd scrub --fail` reported it clean.
 *
 * WHICH FIELDS, and why it is not all six: the per-field provenance is in
 * `docs/design/3289-cross-stack-read-name-redaction.md`. Three names come
 * from the TEMPLATE and are redactable; `sourceRegion` is an AWS region and
 * `imports[].sourceStack` is stored verbatim forever because
 * `scanActiveConsumers` matches destroy-time refusals on it. Redacting that
 * one would drop a destroy-blocking record, which is why the write side
 * leaves it alone too — the two sides must agree on the field set or a
 * scrub would undo a deploy's deliberate decision.
 *
 * SCOPE IS **NEVER-AGAIN** ONLY, and the issue body was corrected before
 * this landed rather than after. Of the four across-deploy cases,
 * SAME-VALUE self-repairs and DUPLICATE is closed by the union normalizer;
 * this walk closes NEVER-AGAIN, where the reference is never re-resolved so
 * no later deploy rewrites it. **ROTATED is NOT repaired**: scrub derives
 * its needles by re-resolving the live template, so it holds the CURRENT
 * secret value, and the stale plaintext on disk is a value nothing in this
 * run knows. It is REPORTED instead (go-to-k/cdkd#3382) — see
 * `findUnrepairedCrossStackReadNames` below.
 *
 * The needle set is `allRecordedSecrets` — the union — for the same reason
 * `redactUnaccountedOutputs` uses it: a cross-stack NAME is not positioned
 * against any one resource's bag, so the per-resource scoping that protects
 * `state.resources` has nothing to scope here.
 *
 * NO FLOOR IS APPLIED HERE, and an earlier revision applied one and said it
 * matched `redactUnaccountedOutputs`. Both halves were wrong: that call site
 * applies none either, and `allRecordedSecrets` has ALREADY dropped every
 * sub-`MIN_NEEDLE_LENGTH` key before returning. A second copy of a
 * security-relevant predicate is the hazard this repo documents most — the
 * next reader sees callers filtering, removes the floor inside
 * `allRecordedSecrets`, and silently un-floors the OTHER callers while this
 * one stays safe. One floor, one place.
 *
 * A DELIBERATE DIVERGENCE FROM THE WRITE SIDE, so a later lane does not
 * "fix" it in the fabrication direction: `DeployEngine.redactCrossStackReads`
 * uses its own UNFILTERED union, so a sub-floor whole-value name is redacted
 * on write and is NOT repaired here. That is the safe direction — scrub
 * rewrites a record no deploy is re-deriving, so it must be the more
 * conservative of the two.
 *
 * Scrub's union also includes `orphanSecrets`, which the write side's does
 * not. A plaintext recorded ONLY by an orphan record therefore repairs here
 * and would not be redacted by the next deploy's key normalizer, so that
 * entry can re-take go-to-k/cdkd#3289's DUPLICATE shape. It needs a
 * coincidental substring match to happen at all, and DUPLICATE is a doubled
 * row rather than a disclosure, so it is recorded rather than designed
 * around.
 */
export function repairCrossStackReadNames({
  state,
  outputSecrets,
  perResourceSecrets,
  orphanSecrets,
  prePassFindings,
  logger,
  shownStack,
}: Pick<
  ScrubStackRewriteInput,
  | 'outputSecrets'
  | 'perResourceSecrets'
  | 'orphanSecrets'
  | 'prePassFindings'
  | 'logger'
  | 'shownStack'
> & { state: StackState }): {
  newImports: StackState['imports'];
  newOutputReads: StackState['outputReads'];
  unrepairedReadNames: UnrepairedCrossStackReadName[];
  changed: number;
} {
  let changed = 0;
  const crossStackNeedles = allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets);
  // No empty-map short-circuit: `redactSecretsForState` already returns its
  // input unchanged for an empty bag with no source, and the deploy-side twin
  // deleted exactly this arm because a branch no probe can red is worse than
  // no branch (go-to-k/cdkd#3289).
  const redactCrossStackName = (name: string): string =>
    redactForState(name, { provenance: 'value-scan', secrets: crossStackNeedles });
  const newImports = state.imports?.map((entry) => {
    const exportName = redactCrossStackName(entry.exportName);
    if (exportName === entry.exportName) return entry;
    changed++;
    return { ...entry, exportName };
  });
  const newOutputReads = state.outputReads?.map((entry) => {
    const sourceStack = redactCrossStackName(entry.sourceStack);
    const outputName = redactCrossStackName(entry.outputName);
    if (sourceStack === entry.sourceStack && outputName === entry.outputName) return entry;
    changed++;
    return { ...entry, sourceStack, outputName };
  });
  // The entries the walk above could NOT repair although today's template
  // still reads a secret-bearing name of their shape (go-to-k/cdkd#3382).
  // Counted into the verdict so `--fail` does not exit 0 over them. Nothing
  // is written for them: their plaintext is a value this run never learned.
  const unrepairedReadNames = findUnrepairedCrossStackReadNames(
    { imports: newImports, outputReads: newOutputReads },
    prePassFindings.performedReads,
    redactCrossStackName
  );
  for (const { list, index, entry } of unrepairedReadNames) {
    // The stored NAME is never printed: it holds a secret's earlier value,
    // which no needle this run holds can mask. `imports[].sourceStack` is a
    // producer record's own stack name, equal to a read this run performed,
    // and is masked anyway; `outputReads[].sourceStack` is template-derived
    // and may be the very field holding the old value, so it is omitted.
    const producer =
      list === 'imports'
        ? `producer ${displayStackName(maskSecretsInText(entry.sourceStack, crossStackNeedles))}, `
        : '';
    logger.warn(
      safeMsg`Scrub of ${shownStack}: state.${list}[${index}] (${producer}${displayIdent(String(entry.sourceRegion))}) ` +
        `holds a cross-stack read name in plaintext that has the shape of a secret-bearing ` +
        `read in today's template but not the secret's current value — most likely a value ` +
        `from before the secret was ROTATED. Scrub cannot repair it (it matches only the ` +
        `current value) and does not print it; treat that earlier value as exposed. A deploy ` +
        safeMsg`that updates ${shownStack} rewrites this list from the reads it performs.`
    );
  }
  return { newImports, newOutputReads, unrepairedReadNames, changed };
}
