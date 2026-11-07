import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  stateOptions,
  stackOptions,
  useCdkBootstrapAssetsOption,
  noCfnFallbackOption,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { refactorCommand } from './refactor/command.js';

export { planStackRefactor, referencedLogicalIds } from './refactor/plan.js';
export type {
  RefactorDiffFn,
  DifferingRename,
  SkippedRename,
  StackRefactorPlan,
  ProposedMove,
} from './refactor/plan.js';
export {
  applyStackRefactor,
  renderRefactorPlan,
  sampleMappingFile,
  overridesForStack,
  moveOverridesOf,
  envKey,
} from './refactor/apply.js';

/** Create the `cdkd refactor` command. */
export function createRefactorCommand(): Command {
  const cmd = new Command('refactor')
    .description(
      "Keep resources whose logical IDs a construct rename changed, instead of replacing them (mirrors 'cdk refactor'). Rewrites cdkd state only; AWS resources are not touched."
    )
    .argument(
      '[stacks...]',
      "Stack name(s) to refactor. Accepts CDK display paths (e.g. 'MyStage/Api') with wildcards, or exact physical CloudFormation names."
    )
    .option('--all', "Refactor every top-level stack (Stage stacks: '**')", false)
    .option('--dry-run', 'Print the refactor plan without writing state', false)
    .option(
      '--override-file <path>',
      'A JSON mapping file naming pairs the detection finds ambiguous, in the cdk refactor format: {"environments":[{"account","region","resources":{"Stack.OldId":"Stack.NewId"}}]}'
    )
    .option('--revert', 'Apply the mapping file in reverse (requires --override-file)', false)
    .option('-f, --force', 'Skip the confirmation prompt', false)
    .addOption(useCdkBootstrapAssetsOption)
    .addOption(noCfnFallbackOption)
    .action(withErrorHandling(refactorCommand));

  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...contextOptions].forEach(
    (opt) => cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
