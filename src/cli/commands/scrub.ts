import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  stateOptions,
  stackOptions,
  contextOptions,
  deprecatedRegionOption,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { scrubCommand } from './scrub/command.js';

export { ScrubNeededError, ScrubIndexInvariantError } from './scrub/errors.js';
export { scrubCommand } from './scrub/command.js';
export type { ScrubOptions } from './scrub/command.js';
export { planExportIndexRepair } from './scrub/export-index.js';
export type { ExportIndexFinding, ExportIndexRepairPlan } from './scrub/export-index.js';
export {
  SCRUBBED_STATE_OBJECT_DESCRIPTION,
  SCRUBBED_EXPORT_INDEX_OBJECT_DESCRIPTION,
  scrubbedStateKey,
  scrubbedLegacyStateKey,
  scrubbedExportIndexKey,
  SCRUB_CLEAN_SCOPE_NOTE,
} from './scrub/save-state.js';
export type { NestedChildScrubInput, NestedChildScrubTarget } from './scrub/nested.js';
export {
  planUnnamedOutputDrop,
  readConsumerRecords,
  findDroppedOutputReaders,
} from './scrub/outputs.js';
export type { ConsumerRecord } from './scrub/outputs.js';
export {
  orderScrubTargets,
  memoizeCrossStackStateReads,
  scrubRefusalWording,
  plaintextProducerCrossStackReadError,
} from './scrub/cross-stack-refusals.js';
export {
  producerPublishesSecretExpression,
  buildExportOwnerIndex,
} from './scrub/producer-expression.js';
export { findUnrepairedCrossStackReadNames } from './scrub/cross-stack-findings.js';
export type {
  PerformedCrossStackReads,
  UnrepairedCrossStackReadName,
} from './scrub/cross-stack-findings.js';
export { SharedEntriesSecrets } from './scrub/shared-entries-secrets.js';
export type { ScrubStackResult } from './scrub/stack-result.js';
export { scrubStack } from './scrub/stack.js';
export { applyScrubNoEcho } from './scrub/noecho.js';
export type { ScrubNoEchoPlan } from './scrub/noecho.js';

export function createScrubCommand(): Command {
  const cmd = new Command('scrub')
    .description(
      'Rewrite persisted state so resolved secret dynamic references are stored ' +
        'as their {{resolve:...}} expression, not the plaintext value (no deploy).'
    )
    .argument(
      '[stacks...]',
      'Stack name(s) to scrub (physical name or display path); the nested stacks under each are scrubbed too'
    )
    .option('--all', 'Scrub every stack in the synthesized app', false)
    .option('--dry-run', 'Report what would be scrubbed without writing state')
    .addOption(
      new Option(
        '--purge-history',
        "Also purge the earlier S3 versions of every examined stack's state.json, not only the ones scrub rewrites (drops their state-recovery history; a record scrub refuses is never purged)"
      ).conflicts('dryRun')
    )
    .option(
      '--fail',
      'With --dry-run, exit non-zero if a value the template names through a {{resolve:...}} reference ' +
        'is found in plaintext (CI gate). ' +
        'Also exits non-zero on a real run when a leak was found that scrub cannot rewrite.'
    );

  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...contextOptions].forEach(
    (opt) => cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);

  cmd.action(withErrorHandling(scrubCommand));
  return cmd;
}
