import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  regionOption,
  stateOptions,
  stackOptions,
  annotationMessageOptions,
  deployOptions,
  skipFinalSnapshotOption,
  noLocalCustomResourcesOption,
  contextOptions,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { requireApprovalOption } from './require-approval.js';
import { outputsFileOption } from './outputs-file.js';
import { stackTagsOption } from '../options/stack-tags.js';
import { deployCommand } from './deploy/command.js';

export { forceQuitReleaseCommand, splitUpdatePartial } from './deploy/helpers.js';

/**
 * Create deploy command
 */
export function createDeployCommand(): Command {
  const cmd = new Command('deploy')
    .description('Deploy CDK app using SDK/Cloud Control API')
    .argument(
      '[stacks...]',
      "Stack name(s) to deploy. Accepts CDK display paths (e.g. 'MyStage/Api') with wildcards ('MyStage/*', '**'), or exact physical CloudFormation names (e.g. 'MyStage-Api')."
    )
    .option('--all', "Deploy every top-level stack (top-level only; Stage stacks: '**')", false)
    .action(withErrorHandling(deployCommand));

  // Add options
  [
    ...commonOptions,
    ...appOptions,
    ...stateOptions,
    ...stackOptions,
    ...deployOptions,
    skipFinalSnapshotOption,
    noLocalCustomResourcesOption,
    requireApprovalOption,
    outputsFileOption,
    stackTagsOption,
    ...contextOptions,
    ...annotationMessageOptions,
  ].forEach((opt) => cmd.addOption(opt));

  cmd.addOption(regionOption);

  return cmd;
}
