import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  stateOptions,
  parseStackRegion,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { exportCommand } from './export/command.js';

export {
  isNeverImportableType,
  isImportUnsupportedRecreatableType,
  isPhase2CreatableType,
} from './export/plan-types.js';
export type { ImportPlanEntry, RecreateBeforePhase2Entry } from './export/plan-types.js';
export { resolveRouteDestination } from './export/composite-id-shapes.js';
export {
  hasCompositeIdSplitter,
  splitCompositePhysicalId,
} from './export/composite-id-splitters.js';
export {
  COMPOSITE_PHYSICAL_ID_IDENTIFIER_TYPES,
  hasCompositePhysicalIdIdentifier,
  resolveCompositePhysicalIdIdentifier,
} from './export/composite-physical-id.js';
export type {
  CompositePhysicalIdContext,
  IdentifierBackfillDeps,
} from './export/composite-physical-id.js';
export { securityGroupRuleLookupRetryDelays } from './export/sg-ingress-rule-id.js';
export {
  invokePreDeleteHandler,
  preDeleteListingLines,
  preDeleteManualCommands,
} from './export/pre-delete.js';
export {
  awsStackNameArg,
  phase2RetryCommand,
  pickStackRegion,
  parseTemplateFile,
  refuseTransientContextIfUnsafe,
  printNextSteps,
  confirmPrompt,
} from './export/command-helpers.js';
export { adoptionPreparingLabel, preDeletedLine, orphanWithholdWhy } from './export/render.js';
export type { CdkdStateStackTree } from './export/render.js';
export {
  buildCdkdStateStackTree,
  flattenCdkdStateTreeLeafFirst,
  flattenCdkdStateTreeRootFirst,
  cdkd2cfnStackName,
  parseCfnChildStackNameOverrides,
  fsReadErrorCause,
  indexNestedTemplatePaths,
  buildPerStackImportNodes,
} from './export/stack-tree.js';
export type { PerStackImportNode, NestedStackRow } from './export/stack-tree.js';
export {
  buildImportPlan,
  sharedImportIdentifierKey,
  sharedImportIdentifierReason,
  blockedMigrationTail,
  groupBlockedReasons,
} from './export/import-plan.js';
export {
  cfnRefusesImportDespiteRegistry,
  physicalIdIsNotImportIdentifier,
  fetchPrimaryIdentifier,
} from './export/type-schema.js';
export {
  parseParameterOverrides,
  resolveTemplateParameters,
  extractChildImportParameters,
  resolveChildImportParameters,
  ssmParameterReader,
  SsmChildParameterRefusalError,
  buildResolvedParametersPerStack,
} from './export/parameters.js';
export type { SsmParameterReader, ResolvedParamsStackNode } from './export/parameters.js';
export {
  injectDeletionPolicyForImport,
  filterTemplateForImport,
  applyImportOverlayForPhase2,
  crossStackRefLine,
  scanCrossStackReferences,
  injectRetainAndRewriteTemplateUrl,
} from './export/template-overlay.js';
export type { CrossStackReference } from './export/template-overlay.js';
export { reportDriftBaselineGaps } from './export/drift-baseline.js';
export {
  selectChangeSetTemplateSource,
  executeImportChangeSet,
  submitImportChangeSet,
  flipStackToUpdateComplete,
  fetchCfnStackTemplate,
  executeUpdateChangeSet,
} from './export/changeset.js';
export type { ChangeSetUploadOpts } from './export/changeset.js';
export { runPerStackImportLoop } from './export/per-stack-loop.js';
export { removeExportedStackRecord } from './export/per-stack-phases.js';
export type {
  ImportedStackRecord,
  PerStackImportLoopResult,
  RunPerStackImportLoopDeps,
  RunPerStackImportLoopOptions,
} from './export/per-stack-loop.js';

export function createExportCommand(): Command {
  const cmd = new Command('export')
    .description(
      'Hand a cdkd-managed stack over to CloudFormation via CFn IMPORT (changeset). ' +
        'AWS resources are unchanged; cdkd state for the stack is deleted on success. ' +
        'Mirror of `cdkd import` (AWS → cdkd) in the reverse direction (cdkd → CFn). ' +
        'Accepts JSON and YAML templates (YAML via a CFn-aware codec that preserves ' +
        '!Ref / !GetAtt / !Sub shorthand). Aborts if any resource is not CFn-importable.'
    )
    .argument('[stack]', 'Stack name to export (auto-detected for single-stack apps)')
    .option(
      '--cfn-stack-name <name>',
      'Name of the destination CloudFormation stack for the root stack. Defaults to the ' +
        "cdkd stack name (or the cdkd2cfnStackName mapping when the name contains '~'). " +
        'For per-nested-child overrides, use --cfn-child-stack-name.'
    )
    .option(
      '--cfn-child-stack-name <pair...>',
      "Per-nested-child CFn stack-name override. Repeatable. Format: '<cdkdName>=<cfnName>' " +
        "(e.g. --cfn-child-stack-name 'MyApp~Database=my-app-db'). The cdkd stack name for a " +
        "nested child is '<parent>~<childLogicalId>' (v6 state-key form). Without an override " +
        "the CFn name is derived by replacing '~' with '-'. Only consulted when the exported " +
        'stack tree contains nested children; ignored for flat stacks.'
    )
    .option(
      '--template <path>',
      'Path to a pre-rendered CloudFormation template (JSON or YAML — format auto-detected). Skips synth.'
    )
    .option(
      '--stack-region <region>',
      'Region of the cdkd state record to operate on. Required when the same stack name has state in multiple regions.',
      parseStackRegion
    )
    .option('--dry-run', 'Print the import plan without creating a changeset.', false)
    .option(
      '--accept-transient-context',
      'Allow CLI -c key=value overrides at export time even though they are not ' +
        'persisted to cdk.json / cdk.context.json (default: refuse). When set, the ' +
        'user is responsible for passing the same -c flags to every future cdk deploy.',
      false
    )
    .option(
      '--include-non-importable',
      'Run a 2-phase migration when the stack contains non-importable resources ' +
        '(Custom::*). Phase 1 imports the importable resources; phase 2 CFn-CREATEs ' +
        "the non-importable ones, which re-invokes each Custom Resource's onCreate " +
        'handler. Make sure onCreate is idempotent before enabling.',
      false
    )
    .option(
      '--parameter <key=value...>',
      'CFn template Parameter override, repeatable. Required when the synthesized ' +
        'template has Parameters without Default values; otherwise overrides the ' +
        "template's default value. Format: --parameter Key=Value."
    )
    .option(
      '--strict-cross-stack',
      'Refuse to export when sibling cdkd stacks in the same CDK app reference the ' +
        'exporting stack via Fn::GetStackOutput. Without the flag, cdkd warns and ' +
        'proceeds — the consumers keep resolving via the CloudFormation fallback ' +
        '(weak reference) unless they deploy with --no-cfn-fallback.',
      false
    )
    .option(
      '--skip-import-support-preflight',
      'Skip the pre-flight that refuses resource types whose CloudFormation registry ' +
        'schema says CFn cannot IMPORT them (no read handler AND NON_PROVISIONABLE), AND ' +
        "cdkd's short list of types measured refused by CreateChangeSet despite their " +
        'registry schema (AWS::AppSync::GraphQLApi), and let CreateChangeSet answer ' +
        "instead. Neither check is AWS's supported-for-import list, so this is the escape " +
        'hatch for a type AWS has since made importable. Expect the changeset to be ' +
        'rejected if the check was right.',
      false
    )
    .option(
      '--no-recreate-import-unsupported',
      'Block instead of auto-handling resource types AWS does NOT support in IMPORT ' +
        'changesets (AWS::IAM::Policy). ' +
        'Default behavior: cdkd skips these from phase 1, deletes the AWS-side resource ' +
        'between phases, and lets CFn re-CREATE in phase 2 (brief unavailability window). ' +
        'With this flag, the export aborts with a clear error instead.'
    )
    .action(withErrorHandling(exportCommand));

  [...commonOptions, ...appOptions, ...stateOptions, ...contextOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
