/**
 * `cdkd drift [<stack>...]`. The implementation lives in `./drift/*.ts`;
 * this module keeps the command factory and re-exports every name it
 * exported before the split, so importers and tests are unchanged.
 */
import { Command } from 'commander';
import { commonOptions, stateOptions, deprecatedRegionOption } from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { UNREADABLE_RESOURCES_MAP_ROW } from '../../state/malformed-resources-bag.js';
import { driftCommand } from './drift/command.js';
import { stackRegionOption } from './drift/report.js';

export { matchOutcome } from './drift/outcome.js';
export type { NotComparedCause, DriftOutcome } from './drift/outcome.js';
export {
  refuseUnprovenDriftSecret,
  driftProducerRegionEvidence,
} from './drift/secret-resolution.js';
export { DRIFT_READ_FAILURE_BREAKER_THRESHOLD } from './drift/read-failure.js';
export { maskMarkedNoEchoBaseline, maskMarkedNoEchoBaselineWithLeaves } from './drift/redaction.js';
export {
  undeclaredUncomparedDriftKeys,
  preFixBaselineUncomparedDriftKeys,
  declaredEmptyProperties,
  declaredTrueProperties,
} from './drift/baseline-keys.js';
export {
  warnIfPreV10BaselineGap,
  buildReadCurrentStateContext,
  canonicalizeDerivedPatternBName,
} from './drift/compare.js';
export { getAtPath, setAtPath } from './drift/accept.js';
export {
  mergeTagListForRevert,
  findRevertPreservedTagKeys,
  findRevertUnbaselinedAwsKeys,
  preserveLiveValuesAtUnresolvedTokens,
  collectUnresolvedIntrinsicObjectPaths,
} from './drift/revert-merge.js';
export {
  overlayLiveAtUncertifiedPaths,
  preserveLiveValuesAtMaskedLeaves,
} from './drift/revert-live-values.js';
export {
  buildRevertNewProperties,
  driftAbsentMeansDefaultKeys,
  withAbsentDefaultKeys,
  collectNarrowedTopLevelKeys,
} from './drift/revert-payload.js';
export { printAcceptPlan, printRevertPlan, confirmPrompt } from './drift/plan.js';
export type { HumanTextSink } from './drift/plan.js';
export { reportPlanValue, writeHumanReport } from './drift/report.js';

// Re-exported so the drift tests keep importing it from the command they pin;
// the definition lives beside the other malformed-record spellings, because
// `cdkd diff` reports the same row (go-to-k/cdkd#3018).
export { UNREADABLE_RESOURCES_MAP_ROW };

/**
 * Create the `drift` command.
 */
export function createDriftCommand(): Command {
  const cmd = new Command('drift')
    .description(
      'Detect drift between cdkd state and AWS reality. Exits 0 when nothing drifted, 1 when drift is ' +
        'detected, and 2 when nothing drifted but cdkd REFUSED to compare a resource, because a dynamic ' +
        'reference its state records could not be attributed to a region. Pass --accept to update cdkd ' +
        'state from AWS, or --revert to push cdkd state values back into AWS.'
    )
    .argument(
      '[stacks...]',
      'Stack name(s) to check (physical CloudFormation names), each with its nested stacks'
    )
    .option('--all', 'Check every stack in the state bucket', false)
    .option('--json', 'Output as JSON', false)
    .option(
      '--accept',
      'Update cdkd state with the AWS-current values for every drifted property (state ← AWS). ' +
        'Mutually exclusive with --revert.',
      false
    )
    .option(
      '--revert',
      'Push cdkd state values back into AWS via provider.update for every drifted resource (AWS ← state). ' +
        'Mutually exclusive with --accept.',
      false
    )
    .option(
      '--dry-run',
      'Print the planned mutations without acquiring a lock or hitting AWS / S3. ' +
        'Honored by --accept and --revert.',
      false
    )
    .option(
      '--concurrency <number>',
      'Maximum concurrent provider.update calls during --revert',
      (value) => parseInt(value, 10),
      4
    )
    .addOption(stackRegionOption())
    .action(withErrorHandling(driftCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
