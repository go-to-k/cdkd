import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  stateOptions,
  useCdkBootstrapAssetsOption,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { importCommand } from './import/command.js';

export type { ImportRow, CfnOverrideMergeStats } from './import/types.js';
export { ObservedBaselineRefusals } from './import/types.js';
export {
  mergeCfnDerivedOverrides,
  formatCfnOverrideMergeDetail,
  substituteOverrideRefs,
} from './import/overrides.js';
export { resolvePseudoParameterIntrinsics } from './import/pseudo-parameters.js';
export {
  rebuiltLogicalIdsFrom,
  reimportedAttributes,
  withDeclaredNoEchoMasked,
  noEchoAttributeNamesCarried,
  READS_EVERY_KEY,
  templateGetAttReads,
  buildStackState,
  claimRegistryMarkerAfterImport,
  importedNameGenerationFields,
} from './import/stack-state.js';
export { resolveImportedProperties } from './import/resolve-properties.js';
export { confirmPrompt } from './import/import-one.js';
export { captureObservedForImportedResources } from './import/observed-capture.js';
export { indexGrandchildTemplatePaths } from './import/nested.js';

/**
 * Create the `cdkd import` top-level command.
 *
 * Sits at the top level (not under `cdkd state`) because, like `deploy` /
 * `destroy` / `diff` / `synth`, it requires a CDK app to synthesize: the
 * template is read to find logical IDs, resource types, and dependencies.
 * (`cdkd state ...` subcommands are reserved for state-only operations
 * that don't need the CDK code.)
 *
 * Three usage modes:
 *
 *   1. **Auto mode** (no overrides): `cdkd import MyStack`
 *      Imports every resource in the template, resolving each physical id
 *      from the template's explicit physical-name property and then from a
 *      same-named CloudFormation stack's `DescribeStackResources` (issue
 *      #1128 / #1130). cdkd's value-add over CDK CLI — useful for adopting
 *      a whole stack that was previously deployed by `cdk deploy`. (There is
 *      deliberately no `aws:cdk:path` tag walk: AWS reserves the `aws:` tag
 *      prefix, so that tag never exists on a real resource — issue #1134
 *      removed the walk from every provider.)
 *
 *   2. **Selective mode** (CDK CLI parity, default when overrides given):
 *      `cdkd import MyStack --resource MyBucket=my-bucket-name`
 *      `cdkd import MyStack --resource-mapping mapping.json`
 *      `cdkd import MyStack --resource-mapping-inline '{"MyBucket":"my-bucket-name"}'`
 *      ONLY the listed resources are imported; the rest are skipped
 *      ("out of scope") and will be CREATEd on the next deploy. Matches
 *      `cdk import --resource-mapping` / `--resource-mapping-inline`
 *      semantics.
 *
 *   3. **Hybrid mode** (`--auto` with overrides):
 *      `cdkd import MyStack --resource MyBucket=name --auto`
 *      Listed resources use the explicit physical id; all other
 *      resources still go through auto-resolution. The pre-PR
 *      default behavior, now opt-in.
 */
export function createImportCommand(): Command {
  const cmd = new Command('import')
    .description(
      'Adopt already-deployed AWS resources into cdkd state. Reads the CDK app to find ' +
        'logical IDs, resource types, and dependencies. With no flags, imports every ' +
        "resource, resolving each physical id from the template's physical-name property " +
        "and then from a same-named CloudFormation stack's DescribeStackResources. " +
        'With --resource / --resource-mapping, only the listed resources are imported ' +
        '(CDK CLI parity); pass --auto to auto-resolve the rest.'
    )
    .argument(
      '[stack]',
      'Stack to import. Optional when the synthesized app contains exactly one stack.'
    )
    .option(
      '--resource <id=physical>',
      'Explicit physical-id override for one logical ID. Repeatable. ' +
        'When at least one --resource is given, only listed resources are imported ' +
        '(CDK CLI parity). Pass --auto to also auto-resolve everything else.',
      collectMultiple,
      [] as string[]
    )
    .option(
      '--resource-mapping <file>',
      'Path to a JSON file of {logicalId: physicalId} overrides ' +
        '(CDK CLI `cdk import --resource-mapping` compatible). ' +
        'Implies selective mode unless --auto is set. ' +
        'Mutually exclusive with --resource-mapping-inline.'
    )
    .option(
      '--resource-mapping-inline <json>',
      'Inline JSON object of {logicalId: physicalId} overrides ' +
        '(CDK CLI `cdk import --resource-mapping-inline` compatible). ' +
        'Same shape as --resource-mapping but supplied as a string — useful ' +
        'for non-TTY CI scripts that do not want a separate file. ' +
        'Implies selective mode unless --auto is set. ' +
        'Mutually exclusive with --resource-mapping.'
    )
    .option(
      '--record-resource-mapping <file>',
      'After cdkd resolves every logical ID (via --resource / --resource-mapping / ' +
        'auto-resolution), write the resulting {logicalId: physicalId} map ' +
        'to <file> as JSON. Useful in auto / hybrid mode for capturing the ' +
        'auto-resolved mapping and feeding it back as --resource-mapping in ' +
        'non-interactive CI re-runs. Written before the confirmation prompt ' +
        '(so the user can review the file before saying "yes") and even when the ' +
        'user says "no". Mirrors `cdk import --record-resource-mapping`.'
    )
    .option(
      '--auto',
      'Hybrid mode: when explicit overrides are supplied, ALSO auto-resolve ' +
        'every other resource in the template. Without this flag, --resource / ' +
        '--resource-mapping behave as a whitelist (CDK CLI parity).',
      false
    )
    .option('--dry-run', 'Show planned imports without writing state', false)
    .option(
      '--force',
      'Confirm a destructive write to existing state. Required for auto / whole-stack ' +
        'import when state already exists (rebuilds the entire resource map). Also required ' +
        'in selective mode if a listed override would overwrite a resource already in state. ' +
        'Not needed for a pure selective merge (adding new resources without touching unlisted entries).',
      false
    )
    .option(
      '--migrate-from-cloudformation [cfn-stack-name]',
      'Retire the named CloudFormation stack (deletes the CFn stack record; ' +
        'AWS resources are NOT deleted): inject DeletionPolicy=Retain and ' +
        'UpdateReplacePolicy=Retain on every ' +
        'resource via UpdateStack, write cdkd state from the physical IDs the stack ' +
        'holds after that update, then DeleteStack. cdkd takes over management. ' +
        'Pass without a value to use the cdkd stack name as the CFn stack name ' +
        '(the typical case for a CDK app that was previously deployed via ' +
        '`cdk deploy`); pass an explicit value when the CFn stack name differs.'
    )
    .addOption(useCdkBootstrapAssetsOption)
    .action(withErrorHandling(importCommand));

  // Re-use the same option set as `deploy` / `destroy` for parity.
  [...commonOptions, ...appOptions, ...stateOptions, ...contextOptions].forEach((o) =>
    cmd.addOption(o)
  );

  return cmd;
}

function collectMultiple(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}
