import { stripForDisplay } from '../../../utils/regexp.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { StackState } from '../../../types/state.js';
import { importableOutputKeys } from '../../../types/state.js';
import {
  keptWholeReasonText,
  mergeNoChangeOutputs,
} from '../../../deployment/no-change-outputs-merge.js';
import { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import {
  isWholeSecretReferenceToken,
  resolveTemplateOutputs,
  templateLetsConditionsReachOutputs,
  type OutputChange,
} from '../../../analyzer/outputs-diff.js';
import {
  carriedExportAliasExposure,
  noEchoParameterValueSeed,
} from '../../../deployment/outputs-export-alias.js';
import type { RecordedSecretValues } from '../../../deployment/secret-redaction.js';
import { logger } from './logger.js';

/**
 * {@link computeStackDiff}'s `Outputs` delta when an output failed to resolve:
 * the deploy's no-change merge where it applies, otherwise none.
 */
export function outputChangesAfterResolutionFailure({
  diffCalculator,
  changes,
  resolved,
  everyConditionKnown,
  template,
  currentState,
  effectiveTemplate,
  outputsPassSecrets,
  noEchoSeed,
  diffOutputsAgainst,
  stackName,
}: {
  diffCalculator: DiffCalculator;
  changes: Awaited<ReturnType<DiffCalculator['calculateDiff']>>;
  resolved: Awaited<ReturnType<typeof resolveTemplateOutputs>>;
  everyConditionKnown: boolean;
  template: CloudFormationTemplate;
  currentState: StackState;
  effectiveTemplate: CloudFormationTemplate;
  outputsPassSecrets: RecordedSecretValues;
  noEchoSeed: ReturnType<typeof noEchoParameterValueSeed>;
  diffOutputsAgainst: (
    rawDesired: Record<string, unknown>,
    exportNames: ReadonlySet<string>,
    forceLegacyRecord?: boolean
  ) => OutputChange[];
  stackName: string;
}): OutputChange[] {
  let outputChanges: OutputChange[] = [];
  const resourcesChange = diffCalculator.hasChanges(changes);
  const merge =
    resolved.failuresMirrorDeploy &&
    everyConditionKnown &&
    !templateLetsConditionsReachOutputs(template) &&
    !resourcesChange
      ? mergeNoChangeOutputs({
          persisted: currentState.outputs ?? {},
          resolved: withFailedOutputsUndefined(resolved.outputs, resolved.failedOutputKeys),
          declaredOutputs: effectiveTemplate.Outputs,
          previousExportNames: new Set(importableOutputKeys(currentState)),
          resolvedExportNames: [...resolved.exportNames],
          // The deploy's carried-alias verdict (go-to-k/cdkd#4657), over this
          // diff's outputs-pass corpora; the reason is the deploy's to print.
          refusesCarriedAlias: (_outputKey, exportName) =>
            carriedExportAliasExposure(exportName, outputsPassSecrets, noEchoSeed) === undefined
              ? undefined
              : 'refused',
        })
      : undefined;
  if (merge?.kind === 'merged') {
    // A carried key is compared at its STORED value, which erases evidence only
    // its resolved value held: an output that resolves to a secret expression
    // (an `Fn::GetAtt` to an attribute the record stores as one) marks a
    // pre-GHSA record through `desired`, and its carried plaintext does not.
    // Where such an expression can come from (a stored attribute, a parameter,
    // another stack's outputs) is not enumerable, so no test of the template
    // stands in for it; and a secret expression stored under another key does
    // not exonerate either, since pass 1 of `computeOutputsDiff` excuses only
    // the key that holds one. So the record is treated as legacy, and every
    // stored value on a rendered row withheld, whenever a carried key's stored
    // value is anything but a secret expression: the one value pass 1 would
    // have excused for that key. That is one WHOLE secret token, of any
    // spelling (a SecureString `ssm` one included, issue #4056). A token
    // beside other text is not: a pre-#1901 deploy stored
    // `{{resolve:secretsmanager:A}}-<SecureString plaintext>` itself (issue
    // #4101), and a carried key has no resolved side here to compare the
    // literal parts against, so pass 1's veto would excuse it as its own
    // desired value.
    const storedOutputs = currentState.outputs ?? {};
    const withheld = merge.carriedKeys.some(
      (key) => !isWholeSecretReferenceToken(storedOutputs[key])
    );
    outputChanges = diffOutputsAgainst(merge.outputs, new Set(merge.exportNames), withheld);
    // Every failure on this path is named (`failuresMirrorDeploy`), so the set
    // holds every output this pass FAILED. A key a binding #2740 record skipped
    // never reached resolution and is not in it: that record previews the key
    // as absent on every diff path, merge or not, as it documents.
    //
    // The #1948 residual `computeOutputsDiff` documents (a stack that deletes
    // its ONLY secret-bearing output prints that output's stored value as a
    // REMOVE row's `old:` side) reaches a RENDERED section on this path, where
    // the suppression used to hide it, only when every carried key's stored
    // value is a secret expression; otherwise the forced verdict above
    // withholds that row's value too.
    //
    // The warning splits the failed outputs the way the merge carries OUTPUT
    // keys: one with a stored value under its own name is carried and compared
    // at it, one without is not (the merge reads `hasOwn(persisted, key)`). The
    // latter's literal `Export.Name` alias can still be carried on its own, so
    // the second group is named for what it lacks, not as left out entirely.
    //
    // The withheld-values sentence is gated on the RENDERED result: the forced
    // verdict redacts only non-ADD rows, so an ADD-only or empty section has
    // nothing withheld to explain. Its reason names what forced it, a value
    // carried from state (an output key OR an alias), not "a failed output
    // compared at a stored value", which an alias-only carry contradicts. The
    // stand-in alone advises `cdkd scrub`, which finds nothing on a stack that
    // holds no secret, hence the sentence.
    const failed = [...resolved.failedOutputKeys];
    const isStored = (key: string): boolean =>
      Object.prototype.hasOwnProperty.call(storedOutputs, key);
    const compared = failed.filter(isStored);
    const unstored = failed.filter((key) => !isStored(key));
    const names = (keys: string[]): string => keys.map(stripForDisplay).join(', ');
    const explainWithheld =
      withheld && outputChanges.some((change) => change.oldValueRedacted === true);
    logger.warn(
      `Outputs of stack ${stripForDisplay(stackName)}: ${failed.length} output(s) could not be resolved for this diff.` +
        (compared.length > 0 ? ` Compared at their stored values: ${names(compared)}.` : '') +
        (unstored.length > 0 ? ` No stored value under their own names: ${names(unstored)}.` : '') +
        ` The next deploy may write a value for any of them it can resolve.` +
        (explainWithheld
          ? ` Previous values in this Outputs section are withheld because a value carried from state for a failed output is not a secret reference, so this diff cannot rule out legacy plaintext in state. That reason no longer applies once every failed output resolves, though other legacy-plaintext checks still can withhold them.`
          : '')
    );
  } else {
    // Surface the case where the outputs DID differ but a resolution failure
    // suppressed the report, mirroring the deploy engine's twin warning
    // ("Outputs changed but one or more could not be resolved"). Silence would
    // leave "no Outputs section" ambiguous between "unchanged" and "could not
    // be computed".
    //
    // The failed keys are excluded first, and that exclusion is what keeps the
    // warning meaningful. Unlike the deploy side — which keeps an unresolved key
    // with the value `undefined` — this resolver DROPS it, so a naive diff reads
    // every failed key as a REMOVE. Without the filter the warning would fire on
    // the ordinary, expected case the resolver itself logs at debug (an output
    // referencing a resource this deploy will create), including on the very
    // first diff of a stack.
    // Reached with a merge in hand only when it KEPT the previous bag whole,
    // which the deploy announces with its own warning; this one names the same
    // reason. Without one, "a resource this deploy has yet to create" is the
    // likely cause only while a resource change is pending: on a stack with
    // none, a gate above refused the preview instead.
    const wouldHaveChanged = diffOutputsAgainst(resolved.outputs, resolved.exportNames).filter(
      (change) => !resolved.failedKeys.has(change.name)
    );
    if (wouldHaveChanged.length > 0) {
      logger.warn(
        `Outputs of stack ${stripForDisplay(stackName)} may have changed, but one or more could not be resolved ` +
          `against current state — omitting the Outputs section from this diff. ` +
          (merge?.kind === 'kept'
            ? keptWholeReasonText(merge.reason)
            : resourcesChange
              ? `It is usually an output referencing a resource this deploy has yet to create.`
              : `The stack has no resource change; this diff cannot preview what the deploy does with the outputs that failed here.`)
      );
    }
  }
  return outputChanges;
}

/**
 * The preview's bag in the shape `mergeNoChangeOutputs` reads from the deploy
 * engine: each failed OUTPUT present with the value `undefined`
 * (issue #3101). This resolver drops a failed key while the deploy keeps it,
 * and the merge tells "failed, keep the stored value" from "not produced,
 * remove it" by exactly that presence. A fresh null-prototype bag, like both
 * bags it stands between, so a resolved `__proto__` export alias survives the
 * copy as a data key.
 */
function withFailedOutputsUndefined(
  outputs: Record<string, unknown>,
  failedOutputKeys: ReadonlySet<string>
): Record<string, unknown> {
  const bag = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(outputs)) bag[key] = value;
  for (const key of failedOutputKeys) bag[key] = undefined;
  return bag;
}
