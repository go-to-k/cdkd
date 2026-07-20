import { readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as readline from 'node:readline/promises';
import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  parseContextOptions,
  stateOptions,
  useCdkBootstrapAssetsOption,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, synthesisStatusMessage } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import { IntrinsicFunctionResolver } from '../../deployment/intrinsic-function-resolver.js';
import {
  resolveApp,
  resolveStateBucketWithDefault,
  resolveUseCdkBootstrapAssets,
} from '../config-loader.js';
import {
  createAssetRedirectResolver,
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../assets/asset-redirect.js';
import { buildReadCurrentStateContext } from './drift.js';
import { readCdkPath } from '../cdk-path.js';
import {
  retireCloudFormationStack,
  getCloudFormationResourceTree,
  tryGetCloudFormationResourceMap,
  NESTED_STACK_RESOURCE_TYPE,
  type CfnStackResourceTree,
} from './retire-cfn-stack.js';
import type {
  CloudFormationTemplate,
  ResourceImportInput,
  ResourceImportResult,
  TemplateResource,
} from '../../types/resource.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type ResourceState,
  type StackState,
} from '../../types/state.js';

interface ImportOptions {
  app?: string;
  output?: string;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  resource?: string[];
  resourceMapping?: string;
  resourceMappingInline?: string;
  /**
   * If set, write the resolved `{logicalId: physicalId}` map for every
   * `imported` outcome to this path before the confirmation prompt.
   * Mirrors upstream `cdk import --record-resource-mapping <file>`. The
   * file is written even if the user says "no" to the prompt — the data
   * was resolved either way and is useful for re-runs.
   */
  recordResourceMapping?: string;
  /**
   * When true, resources NOT in `--resource` / `--resource-mapping` still
   * go through tag-based auto-import. Default is `false` for CDK CLI parity:
   * when explicit overrides are supplied, only those resources are imported
   * and the rest are skipped (left for the next deploy to create). Pass
   * `--auto` to opt back into hybrid mode (current pre-PR behavior).
   *
   * No-flag invocation (`cdkd import MyStack`) always auto-imports
   * everything via tags — this flag only matters once at least one of
   * `--resource` / `--resource-mapping` is also supplied.
   */
  auto: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  verbose: boolean;
  context?: string[];
  /**
   * After successfully writing cdkd state, retire the named CloudFormation
   * stack: inject `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain`
   * on every resource via UpdateStack, then DeleteStack. AWS resources are
   * left intact (now solely managed by cdkd). Pass `true` to use the cdkd
   * stack name as the CFn stack name (the common case for CDK-deployed
   * stacks); pass a string to override when the CFn stack name differs.
   */
  migrateFromCloudformation?: boolean | string;
  /**
   * Issue #1002 PR 2 — pin legacy asset destinations (skip the cdkd
   * asset-storage rewrite) for this invocation. See design §4.2.
   */
  useCdkBootstrapAssets?: boolean;
}

/**
 * Outcome category for one logicalId, used to summarise the run.
 *
 * `imported` — resource found and added to state.
 * `skipped-no-impl` — provider doesn't implement `import`.
 * `skipped-not-found` — provider returned `null` (no matching AWS resource).
 * `skipped-out-of-scope` — explicit-override mode and this resource was not
 *    listed; user opted not to import it. Kept distinct from
 *    `skipped-not-found` because it doesn't reflect AWS state.
 * `failed` — provider threw; logged but lets the rest of the stack proceed.
 */

type ImportOutcome =
  | 'imported'
  | 'skipped-no-impl'
  | 'skipped-not-found'
  | 'skipped-out-of-scope'
  | 'failed';

interface ImportRow {
  logicalId: string;
  resourceType: string;
  outcome: ImportOutcome;
  physicalId?: string;
  reason?: string;
  /**
   * Provider-returned attribute snapshot for `Fn::GetAtt` resolution
   * (issue #1098). Populated only on the `imported` outcome, and only when
   * the provider's `import()` returned an `attributes` map — providers that
   * omit it leave this `undefined` and the state row keeps `{}`.
   *
   * Persisting it makes an adopted resource state-shape-identical to one
   * created by `cdkd deploy`, which already stores a create-time attribute
   * snapshot. Same staleness class as deploy, not a new one.
   */
  attributes?: Record<string, unknown>;
}

/**
 * Exported for `cdkd migrate --from-cfn-stack` (PR B of #465) so the
 * migrate orchestrator can drive the same lock + state + retire pipeline
 * as `cdkd import` without spawning a subprocess. Original Commander
 * registration in {@link createImportCommand} still wraps this in
 * `withErrorHandling` so library callers must handle their own exits.
 */
export type RunImportOptions = ImportOptions;
export async function runImport(
  stackArg: string | undefined,
  options: ImportOptions
): Promise<void> {
  return importCommand(stackArg, options);
}

async function importCommand(stackArg: string | undefined, options: ImportOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Region falls through CLI flag → env → us-east-1, the same chain as deploy.
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';

  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry);

    // Synth — required for import: we need logicalId/resourceType/dependencies
    // from the template. Without it, the user would have to specify everything
    // manually, which is the use case we explicitly avoid.
    const appCmd = options.app || resolveApp();
    if (!appCmd) {
      throw new Error(
        '`cdkd state import` requires a CDK app: pass --app or set it in cdk.json. ' +
          'The template is read to find logical IDs, resource types, and dependencies.'
      );
    }

    logger.info(synthesisStatusMessage(appCmd, 'Synthesizing CDK app to read template...'));
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const result = await synthesizer.synthesize({
      app: appCmd,
      output: options.output || 'cdk.out',
      ...(Object.keys(context).length > 0 && { context }),
      // Threaded so the macro-expander has a real state bucket for
      // the > 51,200-byte template upload path (Issue #463).
      stateBucket,
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
    });

    // Stack selection: prefer explicit positional, otherwise auto-pick a single
    // stack when the assembly carries exactly one. Multi-stack assemblies must
    // disambiguate — tag-based imports are per-stack and ambiguity here is
    // worth a clear error rather than guessing.
    let stackInfo;
    if (stackArg) {
      stackInfo = result.stacks.find((s) => s.stackName === stackArg || s.displayName === stackArg);
      if (!stackInfo) {
        throw new Error(
          `Stack '${stackArg}' not found in synthesized app. ` +
            `Available: ${result.stacks.map((s) => s.stackName).join(', ')}`
        );
      }
    } else if (result.stacks.length === 1) {
      stackInfo = result.stacks[0]!;
    } else {
      throw new Error(
        `Multiple stacks found: ${result.stacks.map((s) => s.stackName).join(', ')}. ` +
          `Specify the stack name as a positional argument.`
      );
    }
    const targetRegion = stackInfo.region || region;

    logger.info(`Target stack: ${stackInfo.stackName} (${targetRegion})`);

    // Issue #1002 PR 2 — when the target region is in cdkd-assets mode,
    // rewrite the template's asset references BEFORE anything reads it, so
    // the imported state matches what the next deploy would write (no
    // spurious first-deploy churn; design §7.1). Nested child templates in
    // the recursive CFn-migration walk are rewritten at their own load site
    // below. Lazy: asset-less apps / legacy regions add no AWS calls beyond
    // the marker read.
    const resolveAssetRedirect = createAssetRedirectResolver({
      stateBackend,
      stsRegion: region,
      ...(options.profile && { profile: options.profile }),
      useCdkBootstrapAssets: resolveUseCdkBootstrapAssets(options.useCdkBootstrapAssets),
      suppressLegacyNotice: true,
    });
    const assetRedirect = await resolveAssetRedirect(stackInfo.assetManifestPath, targetRegion);
    if (assetRedirect) {
      const rewritten = rewriteTemplateAssetReferences(stackInfo.template, assetRedirect);
      logger.debug(
        `Rewrote ${rewritten} asset reference(s) to cdkd asset storage in template of ` +
          `stack ${stackInfo.stackName}`
      );
    }

    // Parse user-supplied physical-id overrides up front so any syntax error
    // surfaces before we make AWS calls.
    const overrides = parseResourceOverrides(
      options.resource,
      options.resourceMapping,
      options.resourceMappingInline
    );
    if (overrides.size > 0) {
      logger.debug(`User-supplied physical IDs: ${[...overrides.keys()].join(', ')}`);
    }

    // Resolve the CloudFormation stack name we're migrating off, when the
    // user opted in. Done up front so we can populate overrides BEFORE the
    // selective-mode decision below.
    const migrationCfnStackName = options.migrateFromCloudformation
      ? typeof options.migrateFromCloudformation === 'string' &&
        options.migrateFromCloudformation.length > 0
        ? options.migrateFromCloudformation
        : stackInfo.stackName
      : undefined;
    if (options.migrateFromCloudformation && options.dryRun) {
      throw new Error(
        '--migrate-from-cloudformation is not compatible with --dry-run: ' +
          'the post-state-write retirement (UpdateStack + DeleteStack) issues real AWS calls. ' +
          'Use plain `cdkd import --dry-run` to preview the import in isolation.'
      );
    }
    // Compute the importable-template set up front. We need it both for
    // the existing-state guard's selective-mode decision below AND for
    // filtering the CFn-derived migration mapping (CFn knows about
    // sentinel resources like `AWS::CDK::Metadata` that cdkd silently
    // skips on import — those mustn't be merged into `overrides` or the
    // typo-validation step would reject them).
    const template = stackInfo.template;
    const templateParser = new TemplateParser();
    const resources = collectImportableResources(template);
    const templateLogicalIds = new Set(resources.map((r) => r.logicalId));
    logger.info(`Found ${resources.length} resource(s) in template`);

    // Recursive tree of CFn resources rooted at the source migration stack.
    // Populated when `--migrate-from-cloudformation` is set; carries every
    // nested child's flat resource map AND its own children, so the
    // per-child state-write walk below and the post-import retire flow
    // share a single set of AWS round-trips. Stays `undefined` outside
    // the migration code path so non-migration imports pay no extra cost.
    let migrationTree: CfnStackResourceTree | undefined;
    if (migrationCfnStackName) {
      // Pre-populate overrides from the source CFn stack via a recursive
      // `DescribeStackResources` walk. This is the load-bearing piece that
      // makes `cdk deploy`-managed stacks importable by cdkd without per-
      // resource `--resource <id>=<physical>` flags: cdkd's tag-based auto-
      // lookup can't find those resources (upstream `cdk deploy` doesn't
      // propagate `aws:cdk:path` as a real AWS tag, and AWS reserves the
      // `aws:` tag prefix so we can't add it on the way through either),
      // so we ask CloudFormation directly. User-supplied `--resource` /
      // `--resource-mapping` entries take precedence — they were inserted
      // into `overrides` first. Logical IDs CFn knows about but cdkd's
      // import skips (e.g. `AWS::CDK::Metadata`) are filtered out here.
      //
      // Recursive walk added for issue [#464](https://github.com/go-to-k/cdkd/issues/464):
      // when the source stack carries `AWS::CloudFormation::Stack`
      // children, we ALSO need their flat resource maps (for per-child
      // state writes after the root import) AND their children, and so
      // on. The tree shape is the unit of truth.
      logger.info(
        `Resolving physical IDs from CloudFormation stack '${migrationCfnStackName}' (recursive)...`
      );
      migrationTree = await getCloudFormationResourceTree(
        migrationCfnStackName,
        awsClients.cloudFormation
      );
      // Shared filter (see `mergeCfnDerivedOverrides`): non-importable rows,
      // nested-stack rows, and ids the user already supplied are all dropped.
      const mergeStats = mergeCfnDerivedOverrides({
        cfnMapping: migrationTree.resources,
        template,
        templateLogicalIds,
        overrides,
      });
      logger.info(
        `Resolved ${mergeStats.derived} physical ID(s) from CloudFormation` +
          formatCfnOverrideMergeDetail(mergeStats)
      );
      // Validate template ↔ AWS shape: every nested-stack row in the synth
      // template MUST have a matching child in the AWS tree, and vice
      // versa. A mismatch indicates the template was hand-edited mid-flight
      // or AWS removed a child between the user's last `cdk deploy` and
      // this `cdkd import` — abort up front rather than partially walking
      // and leaving the user with one stack's state written and another
      // stack's state missing.
      validateNestedStackShape(
        template,
        migrationTree,
        stackInfo.stackName,
        stackInfo.nestedTemplates ?? {}
      );
    }

    // Resolve the caller's AWS account ID via STS when we need it to
    // synthesize cdkd-local ARNs for nested-stack rows (issue #464). Mirrors
    // what `deploy.ts` does for the same reason — the synth ARN's account
    // segment is load-bearing because `NestedStackProvider.create` writes
    // it into the parent's state at deploy time, and `cdkd diff` would
    // surface a phantom change otherwise. Only resolved when the migration
    // tree actually has nested children — non-nested migrations and bare
    // `cdkd import` paths skip the STS call. Uses the shared `awsClients.sts`
    // (vs. `new STSClient(...)`) so the active profile / credentials apply
    // and the test surface mocks once at the AwsClients level.
    let accountIdForNestedSynth: string | undefined;
    if (migrationTree && migrationTree.nested.size > 0) {
      const { GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
      const identity = await awsClients.sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Account) {
        throw new Error(
          'STS GetCallerIdentity returned no Account — cdkd needs the account ID to ' +
            'synthesize cdkd-local ARNs for nested-stack rows. Verify the active AWS ' +
            'credentials are valid (e.g. `aws sts get-caller-identity`).'
        );
      }
      accountIdForNestedSynth = identity.Account;
    }

    // Selective vs auto mode. CDK CLI parity: when the user passes
    // `--resource X=Y` (or `--resource-mapping`), only those resources are
    // imported; the rest are skipped (and will be CREATEd on the next
    // deploy). The user can opt into the old hybrid behavior — explicit
    // overrides PLUS tag-based auto-import for everything else — with
    // `--auto`. With no overrides at all, auto mode is implied (the user
    // is asking cdkd to find every resource by tag).
    //
    // `--migrate-from-cloudformation` always implies whole-stack auto mode:
    // every CFn-derived override is part of the same migration intent, so
    // the user shouldn't need to also pass `--auto` to avoid selective mode.
    const selectiveMode = overrides.size > 0 && !options.auto && !options.migrateFromCloudformation;
    if (selectiveMode) {
      logger.info(
        `Selective mode: only importing the ${overrides.size} resource(s) you listed ` +
          `(${[...overrides.keys()].join(', ')}). ` +
          `Pass --auto to also tag-import the rest.`
      );
    }

    // Auto mode: ask CloudFormation for the physical IDs before falling back
    // to the per-provider lookups (issue #1128).
    //
    // Auto mode's per-resource lookup is two-stage: the template's physical
    // name property first, then an `aws:cdk:path` tag walk. The tag stage
    // CANNOT match on real AWS — AWS rejects any `aws:`-prefixed tag write
    // ("Tag keys beginning with aws: are reserved for system use") and
    // CloudFormation keeps the value in the template's resource `Metadata`
    // without ever promoting it to a tag. So a resource whose physical name
    // CloudFormation generated (the usual CDK shape, since CDK rarely sets
    // explicit names) came back `not found` even though it was sitting right
    // there and perfectly importable.
    //
    // `DescribeStackResources` answers the question exactly, and
    // `--migrate-from-cloudformation` has always used it — auto mode simply
    // never did. This is best-effort: a cdkd-native stack has no CFn
    // counterpart, so `null` is the normal case and we fall straight through
    // to the existing per-provider lookups.
    //
    // Flat, not recursive: nested children need per-child state writes and a
    // retire pass, which is `--migrate-from-cloudformation`'s job. Nested-stack
    // rows are filtered out below so the AWS child-stack ARN never overwrites
    // the synthesized cdkd-local ARN `importOne` writes.
    //
    // Two assumptions worth naming, both shared with the bare form of
    // `--migrate-from-cloudformation`:
    //   - the CFn stack sharing this stack's NAME is the same application. An
    //     unrelated same-named stack could seed wrong ids, which is why the
    //     info line below names the stack it read from.
    //   - the ids are only as good as the stack's state. A stack stuck in
    //     `ROLLBACK_COMPLETE` / `DELETE_FAILED` still answers with ids of
    //     resources that may no longer exist; providers re-read the resource
    //     during import, so those surface as `skipped-not-found` rather than
    //     bad state.
    if (!selectiveMode && !migrationCfnStackName) {
      const cfnResources = await tryGetCloudFormationResourceMap(
        stackInfo.stackName,
        awsClients.cloudFormation
      );
      if (cfnResources) {
        // Same three filters as the migration path — shared so a change to
        // any of them lands once (issue #1131). Note the second-order effect
        // documented on the helper: seeding `overrides` ALSO pre-resolves
        // `{Ref: <X>}` in a resource's Properties via `substituteOverrideRefs`
        // before `provider.import()` runs, which auto mode did not do before
        // #1128. That is intended — it is the same resolution
        // `--migrate-from-cloudformation` has always produced, and it is what
        // makes sub-resource providers (e.g. `SQSQueuePolicyProvider`)
        // importable — but it is broader than "resolve physical IDs" alone.
        const mergeStats = mergeCfnDerivedOverrides({
          cfnMapping: cfnResources,
          template,
          templateLogicalIds,
          overrides,
        });
        if (mergeStats.derived > 0) {
          logger.info(
            `Resolved ${mergeStats.derived} physical ID(s) from CloudFormation stack '${stackInfo.stackName}'. ` +
              `To adopt AND retire that stack, use --migrate-from-cloudformation.`
          );
        } else {
          // Distinguish "stack exists but contributed nothing" (every id
          // already overridden, or no overlapping logical ids) from "no such
          // stack" -- otherwise both look identical in the logs.
          logger.debug(
            `CloudFormation stack '${stackInfo.stackName}' contributed no new physical IDs.`
          );
        }
      } else {
        logger.debug(
          `No CloudFormation stack named '${stackInfo.stackName}' — resolving physical IDs per provider.`
        );
      }
    }

    // Existing-state guard. The previous implementation refused with
    // `--force` required for any pre-existing state and then unconditionally
    // overwrote the entire resource map — which silently dropped unlisted
    // resources in selective mode. The new policy distinguishes destructive
    // from non-destructive cases:
    //
    //   - Selective mode (overrides without --auto) is **non-destructive**:
    //     unlisted resources are preserved on merge. `--force` is only
    //     required when one of the listed resources is already in state
    //     (the merge would overwrite that entry).
    //   - Auto / whole-stack mode is **destructive**: it rebuilds the
    //     resource map from the template, dropping any state entry not
    //     re-imported. `--force` is required whenever existing state exists.
    //
    // We load existing state up front (rather than just checking presence)
    // so we can both (a) merge in selective mode and (b) forward the etag
    // to `saveState` for optimistic locking.
    const existingResult = await stateBackend.getState(stackInfo.stackName, targetRegion);
    const existingState = existingResult?.state ?? null;
    const existingEtag = existingResult?.etag;
    const migrationPending = existingResult?.migrationPending ?? false;

    if (existingState) {
      if (!selectiveMode) {
        // Auto / whole-stack: always destructive when state exists.
        if (!options.force) {
          throw new Error(
            `State already exists for stack '${stackInfo.stackName}' (${targetRegion}). ` +
              `Auto / whole-stack import rebuilds the entire resource map from the template, ` +
              `which would drop any state entry not re-imported. Pass --force to confirm. ` +
              `To add specific resources without affecting unlisted ones, use ` +
              `--resource <id>=<physicalId> (selective merge — no --force needed).`
          );
        }
      } else {
        // Selective merge: non-destructive for unlisted resources. `--force`
        // is only needed when a listed override would overwrite an entry
        // already in state.
        const conflicts = [...overrides.keys()].filter((id) =>
          Object.prototype.hasOwnProperty.call(existingState.resources, id)
        );
        if (conflicts.length > 0 && !options.force) {
          throw new Error(
            `Selective import would overwrite resource(s) already in state: ` +
              `${conflicts.join(', ')}. ` +
              `Pass --force to confirm the overwrite, or remove these IDs from --resource / --resource-mapping.`
          );
        }
        const preservedCount = Object.keys(existingState.resources).filter(
          (id) => !overrides.has(id)
        ).length;
        logger.info(
          `Merging into existing state for ${stackInfo.stackName} (${targetRegion}): ` +
            `preserving ${preservedCount} unlisted resource(s)` +
            (conflicts.length > 0 ? `, overwriting ${conflicts.length} listed entry(ies)` : '')
        );
      }
    }

    // Validate that every override key actually exists in the template —
    // a typo'd logical ID would otherwise be silently ignored in selective
    // mode and the user wouldn't know why their import "did nothing".
    // (`template` / `resources` / `templateLogicalIds` are computed
    // earlier so the migration block can filter out non-importable IDs
    // before they land in `overrides`.)
    for (const overrideId of overrides.keys()) {
      if (!templateLogicalIds.has(overrideId)) {
        throw new Error(
          `--resource / --resource-mapping references logical ID '${overrideId}' ` +
            `which is not in the synthesized template for stack '${stackInfo.stackName}'. ` +
            `Available IDs: ${[...templateLogicalIds].join(', ')}`
        );
      }
    }

    // Acquire the lock up front — even in dry-run we want to fail fast if
    // another process is mid-deploy (the dry-run plan would lie about the
    // current AWS state otherwise).
    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    await lockManager.acquireLock(stackInfo.stackName, targetRegion, owner, 'import');

    try {
      const rows: ImportRow[] = [];
      for (const { logicalId, resource } of resources) {
        // Selective mode: skip resources not in overrides up front. They
        // never hit the provider, so the summary correctly distinguishes
        // "out of scope" from "AWS not found".
        if (selectiveMode && !overrides.has(logicalId)) {
          rows.push({
            logicalId,
            resourceType: resource.Type,
            outcome: 'skipped-out-of-scope',
            reason: 'not in --resource / --resource-mapping (use --auto to include)',
          });
          continue;
        }

        // Nested-stack short-circuit (issue #464): adopt each
        // `AWS::CloudFormation::Stack` row with cdkd's synthesized
        // cdkd-local ARN. `NestedStackProvider` has no `import()` (the
        // child's state is written out-of-band below in
        // `importNestedStackChildren`), so without this short-circuit
        // every nested-stack row would surface as `skipped-no-impl` and
        // the parent's `Ref <NestedStack>` resolutions would later
        // mis-resolve at deploy time. Only fires when we have a
        // matching child in the AWS tree — outside the migration code
        // path the dispatch falls through to the existing
        // `skipped-no-impl` (provider has no `import()`).
        if (
          resource.Type === NESTED_STACK_RESOURCE_TYPE &&
          migrationTree &&
          migrationTree.nested.has(logicalId) &&
          accountIdForNestedSynth
        ) {
          rows.push({
            logicalId,
            resourceType: resource.Type,
            outcome: 'imported',
            physicalId: synthesizeNestedStackArn(
              targetRegion,
              accountIdForNestedSynth,
              stackInfo.stackName,
              logicalId
            ),
          });
          continue;
        }

        const outcome = await importOne({
          logicalId,
          resource,
          stackName: stackInfo.stackName,
          region: targetRegion,
          providerRegistry,
          override: overrides.get(logicalId),
          overrides,
        });
        rows.push(outcome);
      }

      printSummary(rows);

      // Write the resolved logicalId→physicalId mapping out for re-use in
      // CI (mirrors upstream `cdk import --record-resource-mapping`).
      // Done BEFORE any early-return / confirmation: --dry-run, "no" at
      // the prompt, and zero-imports all still produce the file. Empty
      // mapping serializes as `{}` rather than being omitted, so callers
      // can detect "ran but nothing matched" vs "did not run". A write
      // failure here is logged but does NOT abort: the import already
      // happened in memory, and the record file is metadata.
      if (options.recordResourceMapping) {
        writeRecordedMapping(options.recordResourceMapping, rows);
      }

      if (options.dryRun) {
        logger.info('--dry-run: state will NOT be written. Re-run without --dry-run to apply.');
        return;
      }

      const importedRows = rows.filter((r) => r.outcome === 'imported');
      if (importedRows.length === 0) {
        logger.warn('No resources were successfully imported. State will not be written.');
        return;
      }

      if (!options.yes) {
        // In a selective merge, the resulting state holds the imported rows
        // PLUS the preserved unlisted entries from existing state. Reflect
        // that in the prompt so the user sees the full impact, not just
        // what's being added in this run.
        const importedCount = importedRows.length;
        const preservedCount =
          selectiveMode && existingState
            ? Object.keys(existingState.resources).filter((id) => !overrides.has(id)).length
            : 0;
        const totalAfter = importedCount + preservedCount;
        const breakdown =
          preservedCount > 0
            ? ` (${importedCount} new/overwritten + ${preservedCount} preserved)`
            : '';
        const ok = await confirmPrompt(
          `Write state for ${stackInfo.stackName} (${targetRegion}) ` +
            `with ${totalAfter} resource(s)${breakdown}?`
        );
        if (!ok) {
          logger.info('Import cancelled.');
          return;
        }
      }

      const stackState = buildStackState(
        stackInfo.stackName,
        targetRegion,
        rows,
        templateParser,
        template,
        existingState,
        selectiveMode
      );

      // Resolve CFn intrinsics (Ref / Fn::GetAtt / Fn::Sub / ...) in every
      // freshly-imported resource's `properties` against the assembled
      // state map, then overwrite `state.properties` with the resolved
      // shape. Closes issue #328: pre-fix, `buildStackState` wrote the
      // synth template's Properties verbatim, intrinsics and all, which
      // broke `cdkd destroy` for sub-resource types whose `delete()` reads
      // properties at delete time (e.g. `AWS::Lambda::Permission` whose
      // `FunctionName` is `{Fn::GetAtt: [...]}`). `cdkd deploy` does NOT
      // have this problem because the deploy engine runs the resolver
      // against each resource's Properties before calling `provider.create()`
      // and stores the resolved shape in state — this brings `cdkd import`
      // in line with the v3 schema's "resolved template intent" semantics.
      //
      // Per-resource try/catch: an intrinsic referencing a resource that
      // wasn't imported (custom resource, out-of-scope sibling) is logged
      // and left as-is rather than aborting the whole import. The
      // eventual destroy failure on the un-resolved props is narrower
      // than blowing up the entire adoption flow.
      await resolveImportedProperties(stackState, template, targetRegion, stateBackend, logger);

      // Populate observedProperties for the freshly-imported resources so
      // the very first `cdkd drift` run after import has a real baseline
      // (matching what `cdkd deploy` does after each create/update). Done
      // synchronously in parallel before saveState — import is a rare op
      // and the few extra seconds are amortized into the user's adoption
      // workflow. Errors are swallowed per-resource so a single
      // readCurrentState failure does not abort the whole import.
      await captureObservedForImportedResources(stackState, providerRegistry, logger);

      // Forward the etag for optimistic locking when state already exists,
      // and trigger legacy-key migration when the existing state was loaded
      // from the v1 layout. For the create-from-empty case, the absence of
      // `expectedEtag` is what tells saveState to use IfNoneMatch.
      const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {};
      if (existingEtag) {
        saveOptions.expectedEtag = existingEtag;
      }
      if (migrationPending) {
        saveOptions.migrateLegacy = true;
      }
      await stateBackend.saveState(stackInfo.stackName, targetRegion, stackState, saveOptions);
      logger.info(`✓ State written: ${stackInfo.stackName} (${targetRegion})`);
      logger.info(
        `  ${importedRows.length} resource(s) imported. ` +
          `Run 'cdkd diff' to see how the imported state lines up with the template.`
      );

      // Recursive per-child state writes (issue #464). For every nested
      // `AWS::CloudFormation::Stack` resource at this level, recursively
      // adopt the child stack into its own v6-keyed state file under
      // `cdkd/<parent>~<childLogicalId>/<region>/state.json` with
      // `parentStack` / `parentLogicalId` / `parentRegion` populated.
      // Done AFTER the root state write so a failure in the recursive
      // walk leaves the user with a working root state record they can
      // re-run against (each child write is idempotent — the resource
      // map is rebuilt from CFn's per-child `DescribeStackResources`
      // response). Children's locks are acquired leaves-first and
      // released in reverse on both success and failure.
      if (migrationCfnStackName && migrationTree && accountIdForNestedSynth) {
        await importNestedStackChildrenRecursive({
          parentStackName: stackInfo.stackName,
          parentRegion: targetRegion,
          parentNestedTemplates: stackInfo.nestedTemplates ?? {},
          parentTree: migrationTree,
          stateBackend,
          lockManager,
          providerRegistry,
          templateParser,
          lockOwner: owner,
          accountId: accountIdForNestedSynth,
          logger,
          assetRedirect,
        });
      }

      // Optional: retire the source CloudFormation stack now that cdkd state
      // is committed. Done AFTER state write so a failure here leaves the
      // user with a working cdkd state record they can re-run against, or
      // fall back to retiring the CFn stack manually. Stays inside the
      // lock-protected `try` block so a concurrent `cdkd deploy` can't race
      // the post-write CFn calls.
      if (migrationCfnStackName) {
        // Partial-import warning: some template resources didn't make it
        // into cdkd state (AWS-not-found, no provider, or out-of-scope).
        // After DeleteStack those resources keep existing in AWS but are
        // unmanaged by both CFn (Retain causes DeleteStack to skip them)
        // AND cdkd (never written to state). Surface that out loud so the
        // user can either re-import or accept the orphaning intentionally.
        const orphaned = resources.length - importedRows.length;
        if (orphaned > 0) {
          logger.warn(
            `--migrate-from-cloudformation: ${orphaned} of ${resources.length} ` +
              `template resource(s) were NOT imported into cdkd. After the ` +
              `CloudFormation stack is retired, those resources remain in AWS ` +
              `but are unmanaged by both CloudFormation and cdkd.`
          );
        }
        await retireCloudFormationStack({
          cfnStackName: migrationCfnStackName,
          cfnClient: awsClients.cloudFormation,
          yes: options.yes,
          // Reuse cdkd's state bucket as transient storage for the
          // Retain-injected template when it exceeds the 51,200-byte
          // inline UpdateStack limit. Forward `--profile` so the
          // upload identity matches the one that just wrote cdkd state.
          stateBucket,
          ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
          // Pass the pre-built tree so the recursive Retain-injection
          // walk inside `retireCloudFormationStack` reuses our existing
          // DescribeStackResources calls instead of redoing them. Only
          // populated in the migration code path.
          ...(migrationTree && { resourceTree: migrationTree }),
        });
      }
    } finally {
      await lockManager.releaseLock(stackInfo.stackName, targetRegion).catch((err) => {
        logger.warn(`Failed to release lock: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } finally {
    awsClients.destroy();
  }
}

interface ImportTask {
  logicalId: string;
  resource: TemplateResource;
  stackName: string;
  region: string;
  providerRegistry: ProviderRegistry;
  override: string | undefined;
  /**
   * Full overrides map for this import run — used to pre-resolve `{Ref: <X>}`
   * intrinsics in `resource.Properties` against earlier-imported (or
   * CFn-pre-populated) physical IDs before the per-resource `provider.import()`
   * is called. See {@link substituteOverrideRefs} and issue #361 for the
   * canonical case (`AWS::SQS::QueuePolicy` under
   * `--migrate-from-cloudformation`).
   */
  overrides: Map<string, string>;
}

/** Per-filter counts from {@link mergeCfnDerivedOverrides}. */
export interface CfnOverrideMergeStats {
  /** Entries actually seeded into `overrides` by this merge. */
  derived: number;
  /** CFn rows whose logical ID is not an importable template resource (e.g. `AWS::CDK::Metadata`). */
  skippedNonImportable: number;
  /** CFn rows for `AWS::CloudFormation::Stack` resources (handled separately). */
  skippedNestedStackRow: number;
  /** CFn rows that survived both filters but were already in `overrides` (user-supplied wins). */
  overriddenByUser: number;
}

/**
 * Merge a CloudFormation-derived `logicalId -> physicalId` map into the run's
 * `overrides`, applying the three filters every CFn-derived seed needs, and
 * report what each filter dropped.
 *
 * The filters, in order:
 *   1. **Not an importable template resource** — CFn knows about sentinel rows
 *      like `AWS::CDK::Metadata` that cdkd silently skips on import. Merging
 *      those would make the typo-validation step reject them.
 *   2. **Nested-stack row** — the AWS-side physical ID of an
 *      `AWS::CloudFormation::Stack` row is the child stack ARN, which is NOT
 *      what we want as an import override. The parent's state entry carries
 *      the synthesized cdkd-local ARN (matching what `NestedStackProvider.create`
 *      writes at deploy time — design §6), populated by `importOne`'s
 *      short-circuit. Filtering here keeps the AWS ARN from overwriting it.
 *   3. **Already overridden** — user-supplied `--resource` /
 *      `--resource-mapping` entries are inserted before any CFn lookup and
 *      always win.
 *
 * Shared by all three CFn-derived seeding sites so a change to any filter
 * lands once: the `--migrate-from-cloudformation` root walk, the auto-mode
 * best-effort lookup (issue #1128), and the recursive nested-child walk.
 * The three differ only in their LOGGING, which stays at the call sites.
 *
 * **Second-order effect worth naming:** `overrides` is also consumed by
 * {@link substituteOverrideRefs}, so seeding it from CloudFormation means a
 * `{Ref: <X>}` in a resource's Properties pre-resolves to the CFn physical ID
 * before `provider.import()` sees it. That is intended — it is what makes
 * sub-resource providers (e.g. `SQSQueuePolicyProvider`, which reads
 * `properties.Queues[0]` as a literal queue URL) importable — but it is a
 * behavior beyond "resolve physical IDs", and it applies to every caller of
 * this helper, not just the migration path. See issue #1131.
 *
 * Mutates `overrides` in place; does not mutate `cfnMapping` or `template`.
 */
export function mergeCfnDerivedOverrides(params: {
  cfnMapping: ReadonlyMap<string, string>;
  template: CloudFormationTemplate;
  templateLogicalIds: ReadonlySet<string>;
  overrides: Map<string, string>;
}): CfnOverrideMergeStats {
  const { cfnMapping, template, templateLogicalIds, overrides } = params;
  const stats: CfnOverrideMergeStats = {
    derived: 0,
    skippedNonImportable: 0,
    skippedNestedStackRow: 0,
    overriddenByUser: 0,
  };
  for (const [logicalId, physicalId] of cfnMapping) {
    if (!templateLogicalIds.has(logicalId)) {
      stats.skippedNonImportable++;
      continue;
    }
    if (template.Resources[logicalId]?.Type === NESTED_STACK_RESOURCE_TYPE) {
      stats.skippedNestedStackRow++;
      continue;
    }
    if (overrides.has(logicalId)) {
      stats.overriddenByUser++;
      continue;
    }
    overrides.set(logicalId, physicalId);
    stats.derived++;
  }
  return stats;
}

/**
 * Render the human-readable breakdown of a {@link mergeCfnDerivedOverrides}
 * result — the parenthesized suffix of the `Resolved N physical ID(s)` line.
 * Returns `''` when nothing was dropped (no breakdown worth reporting).
 */
export function formatCfnOverrideMergeDetail(stats: CfnOverrideMergeStats): string {
  const detail: string[] = [];
  if (stats.overriddenByUser > 0)
    detail.push(`${stats.overriddenByUser} already overridden by --resource`);
  if (stats.skippedNonImportable > 0)
    detail.push(`${stats.skippedNonImportable} non-importable (e.g. CDKMetadata)`);
  if (stats.skippedNestedStackRow > 0)
    detail.push(`${stats.skippedNestedStackRow} nested-stack row(s) handled separately`);
  return detail.length > 0 ? ` (${detail.join(', ')})` : '';
}

/**
 * Recursively substitute `{Ref: <LogicalId>}` shapes in an arbitrary value
 * tree with the matching entry from `overrides`. Used to bridge the gap
 * between CDK synth's template (which carries raw intrinsics) and what a
 * provider's `import()` needs to see at the time it's called — specifically
 * for sub-resource providers like `SQSQueuePolicyProvider` whose fallback
 * path reads `properties.<ParentKey>` as a literal operational identifier
 * (queue URL / topic ARN / bucket name) rather than the unresolved intrinsic.
 *
 * Scope is intentionally narrow:
 *   - Only `{Ref: <X>}` shapes are substituted. `Fn::GetAtt` is NOT handled
 *     here — the overrides map carries physical IDs only, not the
 *     per-resource attributes a GetAtt resolution needs. Full GetAtt /
 *     Fn::Sub / Fn::Join handling happens later in
 *     `resolveImportedProperties` against the populated `stackState.resources`.
 *   - Pseudo-parameter refs (`AWS::Region` / `AWS::AccountId` / etc.) are
 *     left untouched — those are handled by the full resolver post-import.
 *   - When the `Ref` target is NOT in the overrides map, the intrinsic is
 *     left in place (the post-import resolver may resolve it from the
 *     `stackState.resources` built by other imports).
 *
 * Closes issue #361 — `AWS::SQS::QueuePolicy` under
 * `--migrate-from-cloudformation` previously hard-errored because
 * `properties.Queues[0]` arrived at `provider.import()` as
 * `{Ref: <Queue>}` and the queue URL needed for the fallback identification
 * branch was never substituted in.
 *
 * Pure-functional — does not mutate `value`.
 */
export function substituteOverrideRefs(value: unknown, overrides: Map<string, string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => substituteOverrideRefs(v, overrides));
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'Ref' && typeof obj['Ref'] === 'string') {
    const refTarget = obj['Ref'] as string;
    const resolved = overrides.get(refTarget);
    if (resolved !== undefined) {
      return resolved;
    }
    // Target not in overrides — leave intrinsic untouched for the
    // post-import resolver to handle.
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = substituteOverrideRefs(v, overrides);
  }
  return result;
}

async function importOne(task: ImportTask): Promise<ImportRow> {
  const logger = getLogger();
  const { logicalId, resource, stackName, region, providerRegistry, override, overrides } = task;

  if (!providerRegistry.hasProvider(resource.Type)) {
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'skipped-no-impl',
      reason: 'no provider registered',
    };
  }

  const provider = providerRegistry.getProvider(resource.Type);
  if (!provider.import) {
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'skipped-no-impl',
      reason: `provider does not implement import (yet)`,
    };
  }

  const cdkPath = readCdkPath(resource);
  // Pre-resolve `{Ref: <X>}` intrinsics in Properties against the overrides
  // map. For `--migrate-from-cloudformation` this map is pre-populated from
  // CFn's `DescribeStackResources` with every resource's PhysicalResourceId,
  // so sub-resource providers (e.g. `SQSQueuePolicyProvider`) whose
  // `Properties` carries `{Ref: <Parent>}` see the parent's operational
  // identifier here rather than the raw intrinsic. The post-import
  // `resolveImportedProperties` pass still runs full intrinsic resolution
  // (incl. `Fn::GetAtt` / `Fn::Sub` / etc.) — this hook is the targeted
  // pre-pass needed at provider.import() time. Closes issue #361.
  const properties = substituteOverrideRefs(resource.Properties ?? {}, overrides) as Record<
    string,
    unknown
  >;
  const input: ResourceImportInput = {
    logicalId,
    resourceType: resource.Type,
    cdkPath,
    stackName,
    region,
    properties,
    ...(override !== undefined && { knownPhysicalId: override }),
  };

  try {
    const result: ResourceImportResult | null = await provider.import(input);
    if (!result) {
      return {
        logicalId,
        resourceType: resource.Type,
        outcome: 'skipped-not-found',
        reason: 'no matching AWS resource',
      };
    }
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'imported',
      physicalId: result.physicalId,
      ...(result.attributes !== undefined && { attributes: result.attributes }),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to import ${logicalId} (${resource.Type}): ${msg}`);
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'failed',
      reason: msg,
    };
  }
}

/**
 * Parse `--resource MyBucket=my-bucket-name` flags (repeatable),
 * `--resource-mapping <file>` JSON file, and `--resource-mapping-inline
 * '<json>'` JSON string into a single override map.
 *
 * The JSON shape (file or inline) is `{ "<logicalId>": "<physicalId>", ... }`
 * for CDK CLI `cdk import --resource-mapping` / `--resource-mapping-inline`
 * parity.
 *
 * `--resource-mapping` and `--resource-mapping-inline` are mutually
 * exclusive (matches upstream `cdk import`): the user picks one source.
 *
 * `--resource` flags take precedence over the JSON source when a logicalId
 * appears in both — explicit-on-CLI wins.
 */
function parseResourceOverrides(
  flags: string[] | undefined,
  mappingFile: string | undefined,
  mappingInline: string | undefined
): Map<string, string> {
  const map = new Map<string, string>();

  if (mappingFile && mappingInline) {
    throw new Error(
      '--resource-mapping and --resource-mapping-inline are mutually exclusive; pass only one.'
    );
  }

  if (mappingFile) {
    let raw: string;
    try {
      raw = readFileSync(mappingFile, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read --resource-mapping file '${mappingFile}': ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
    const parsed = parseMappingJson(raw, `--resource-mapping file '${mappingFile}'`);
    for (const [key, value] of Object.entries(parsed)) {
      map.set(key, value);
    }
  }

  if (mappingInline) {
    const parsed = parseMappingJson(mappingInline, '--resource-mapping-inline');
    for (const [key, value] of Object.entries(parsed)) {
      map.set(key, value);
    }
  }

  for (const entry of flags ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new Error(`--resource expects 'logicalId=physicalId', got '${entry}'`);
    }
    map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }

  return map;
}

/**
 * Parse a `{logicalId: physicalId}` JSON document — either a file body
 * (for `--resource-mapping`) or an inline string (for
 * `--resource-mapping-inline`). The `source` label is woven into error
 * messages so the user can tell which input failed.
 */
function parseMappingJson(raw: string, source: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${source} as JSON: ` + (err instanceof Error ? err.message : String(err))
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object {logicalId: physicalId}`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`${source}: value for '${key}' must be a string, got ${typeof value}`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Write the resolved `{logicalId: physicalId}` map to disk for re-use
 * (mirrors upstream `cdk import --record-resource-mapping <file>`).
 *
 * Inclusion rules: only `imported` rows. `skipped-*` and `failed` rows
 * are excluded — they do not represent a usable physical id.
 *
 * Format: pretty-printed JSON with 2-space indent + trailing newline,
 * so the file is human-reviewable before the user confirms the import.
 *
 * Failure: logged via `logger.error` but NOT thrown. The import has
 * already resolved every physical id in memory; failing to persist the
 * record file is a metadata problem, not a load-bearing one.
 */
function writeRecordedMapping(filePath: string, rows: ImportRow[]): void {
  const logger = getLogger();
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.outcome === 'imported' && row.physicalId) {
      map[row.logicalId] = row.physicalId;
    }
  }
  const body = JSON.stringify(map, null, 2) + '\n';
  try {
    writeFileSync(filePath, body, 'utf-8');
    logger.info(`Wrote resolved mapping to ${filePath} (${Object.keys(map).length} entry(ies))`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to write --record-resource-mapping file '${filePath}': ${msg}. ` +
        `Continuing — the import already resolved every physical id in memory.`
    );
  }
}

/**
 * Walk the template's `Resources` and return the entries we should attempt
 * to import. Filters out CDK metadata sentinels (`AWS::CDK::Metadata`) which
 * are not real AWS resources.
 */
function collectImportableResources(
  template: CloudFormationTemplate
): { logicalId: string; resource: TemplateResource }[] {
  const out: { logicalId: string; resource: TemplateResource }[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    out.push({ logicalId, resource });
  }
  return out;
}

/**
 * Compose a `StackState` from the per-resource import outcomes plus
 * dependency info recovered from the template.
 *
 * `failed` and `skipped-*` rows are dropped — they are not part of state.
 *
 * Resource-map composition depends on the mode:
 *   - `selectiveMode && existingState`: existing resources are the merge
 *     base, every entry survives unless explicitly overwritten by an
 *     `imported` row. Non-destructive for unlisted resources.
 *   - Auto / whole-stack: the resource map is rebuilt from scratch so any
 *     state entry not re-imported is dropped (the user opted into this with
 *     `--force`).
 *
 * Outputs are ALWAYS inherited from `existingState` when present — the
 * import flow never derives outputs (they're computed at deploy time from
 * each resource's attributes), so even an auto-mode rebuild has no reason
 * to wipe them.
 */
function buildStackState(
  stackName: string,
  region: string,
  rows: ImportRow[],
  templateParser: TemplateParser,
  template: CloudFormationTemplate,
  existingState: StackState | null,
  selectiveMode: boolean
): StackState {
  const resources: Record<string, ResourceState> =
    selectiveMode && existingState ? { ...existingState.resources } : {};
  // Template Parameter names are not provisioning-order edges — filter them
  // from the persisted dependencies (issue #1032), mirroring the deploy
  // engine's extractAllDependencies. Without this, destroy's state-derived
  // graph build warns `depends on <Param>, but <Param> not found in template`.
  const parameterNames = new Set(Object.keys(template.Parameters ?? {}));
  for (const row of rows) {
    if (row.outcome !== 'imported' || !row.physicalId) continue;
    const tmplResource = template.Resources[row.logicalId];
    if (!tmplResource) continue;
    const deps = [...templateParser.extractDependencies(tmplResource)].filter(
      (dep) => !parameterNames.has(dep)
    );
    // Attribute carry-over: a re-imported row REPLACES the whole
    // ResourceState, so a resource that already had a populated attribute
    // map (from a prior `cdkd deploy` or import) would have it wiped when
    // the provider's `import()` returns no attributes. Fall back to the
    // stored map — but ONLY when the physical id is unchanged. Attributes
    // describe a specific AWS resource, so carrying them across a
    // re-import that repoints the logical id at a DIFFERENT physical id
    // (`--resource X=<other>` with `--force`) would resurrect stale facts
    // about the old resource and hand them to `Fn::GetAtt`.
    const prior = existingState?.resources[row.logicalId];
    const priorAttributes =
      prior && prior.physicalId === row.physicalId ? prior.attributes : undefined;
    // Normalize "no attributes" to `undefined` BEFORE the coalesce below.
    // Almost no provider omits the field: across src/provisioning/providers
    // the overwhelming majority of `import()` return sites spell it
    // `attributes: {}` explicitly (ssm-parameter, s3-bucket,
    // lambda-function, ...), and `{}` is not `undefined`, so a plain
    // `row.attributes ?? priorAttributes` would leave the fallback
    // unreachable in production and still wipe a good stored map.
    const rowAttributes =
      row.attributes && Object.keys(row.attributes).length > 0 ? row.attributes : undefined;
    resources[row.logicalId] = {
      physicalId: row.physicalId,
      resourceType: row.resourceType,
      properties: tmplResource.Properties ?? {},
      // Issue #1098: persist the provider-returned attribute snapshot so an
      // adopted resource can back `Fn::GetAtt` the same way a deployed one
      // does. A provider that returns no attributes (absent OR `{}`) falls
      // back to the same-physical-id stored map, then to `{}`.
      attributes: rowAttributes ?? priorAttributes ?? {},
      dependencies: deps,
      // v7+ (#614): every imported resource is owned by its SDK Provider
      // (the import() method lives on SDK Providers). Explicit so the
      // post-import drift / destroy paths route through the SDK provider
      // without falling back to the absent-field "sdk legacy default".
      provisionedBy: 'sdk',
    };
  }
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName,
    region,
    resources,
    outputs: existingState?.outputs ?? {},
    lastModified: Date.now(),
  };
}

/**
 * Walk every resource in `stackState.resources` and overwrite its
 * `properties` with the result of running the synth template's raw
 * Properties through `IntrinsicFunctionResolver` against the assembled
 * state map.
 *
 * Closes issue #328. `cdkd deploy` runs the resolver against each
 * resource's Properties before calling `provider.create()` and stores
 * the resolved shape in state — this brings `cdkd import` in line so
 * the v3 schema's `properties` field consistently holds "resolved
 * template intent" (post-intrinsic substitution) across both write
 * paths. Without this, sub-resource types whose `delete()` reads
 * properties at delete time (e.g. `AWS::Lambda::Permission` whose
 * `FunctionName` is `{Fn::GetAtt: [..., 'Arn']}`) get raw intrinsic
 * objects passed to the AWS SDK and fail validation.
 *
 * The resolver is run AFTER all `provider.import()` calls finish, so by
 * the time it walks each resource every logicalId in the importable set
 * has a known `physicalId` in `stackState.resources` for Ref / GetAtt
 * to bind against.
 *
 * Edge cases:
 *   - Parameters / Conditions are resolved from the template up front
 *     (same shape the deploy engine builds for its CREATE / UPDATE
 *     intrinsic context). Resolution failures here log + leave the
 *     template's defaults untouched — the resolver itself tolerates
 *     missing parameter / condition entries.
 *   - Per-resource try/catch: if a Properties tree references a
 *     resource not in the importable set (custom resource that wasn't
 *     adopted, out-of-scope sibling in selective mode), the resolver
 *     throws `Ref <X> not found` / `Resource <X> not found for
 *     Fn::GetAtt`. We log the failure and leave the resource's
 *     original properties intact. The eventual `cdkd destroy` failure
 *     on the un-resolved props is a narrower problem than aborting the
 *     whole adoption flow.
 *
 * `existingState`'s `resources` survive the walk only when they
 * weren't re-imported in this run — selective merge preserves them as
 * already-stored, which on the v3 baseline is already resolved-shape
 * from a prior import / deploy, so re-resolving is a no-op.
 */
async function resolveImportedProperties(
  stackState: StackState,
  template: CloudFormationTemplate,
  region: string,
  stateBackend: S3StateBackend,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const entries = Object.entries(stackState.resources);
  if (entries.length === 0) return;

  const resolver = new IntrinsicFunctionResolver(region);

  // Build Parameters / Conditions the same way the deploy engine does
  // (best-effort: a failure here means the template references a
  // parameter without a default and no user value was supplied, which
  // would have rejected at deploy time too — log + skip the resolution
  // pass rather than blow up the import that already succeeded against
  // AWS).
  let parameters: Record<string, unknown> = {};
  let conditions: Record<string, boolean> = {};
  try {
    parameters = await resolver.resolveParameters(template);
  } catch (err) {
    logger.debug(
      `Template parameter resolution failed during import-time property resolution: ${err instanceof Error ? err.message : String(err)} — continuing without parameters; resources referencing them will be skipped per-resource.`
    );
  }
  try {
    conditions = await resolver.evaluateConditions({
      template,
      resources: stackState.resources,
      parameters,
    });
  } catch (err) {
    logger.debug(
      `Template condition evaluation failed during import-time property resolution: ${err instanceof Error ? err.message : String(err)} — continuing without conditions.`
    );
  }

  const baseContext = {
    template,
    resources: stackState.resources,
    ...(Object.keys(parameters).length > 0 && { parameters }),
    ...(Object.keys(conditions).length > 0 && { conditions }),
    stateBackend,
    stackName: stackState.stackName,
  };

  for (const [logicalId, resource] of entries) {
    try {
      const resolved = (await resolver.resolve(resource.properties ?? {}, baseContext)) as Record<
        string,
        unknown
      >;
      resource.properties = resolved;
    } catch (err) {
      // Intrinsic referenced a resource not in the importable set
      // (e.g. custom resource that wasn't adopted) or a parameter
      // without a value. Leave the raw intrinsic in place — the
      // resource is already imported on the AWS side, and the user
      // can either re-import the missing sibling or surgically fix
      // state via `cdkd state orphan` + redeploy.
      logger.warn(
        `Failed to resolve intrinsics in Properties for imported resource '${logicalId}' (${resource.resourceType}): ${err instanceof Error ? err.message : String(err)}. ` +
          `State will be written with the raw intrinsic shape, which may cause 'cdkd destroy' to fail on this resource — re-import once every referenced sibling is in state, or remove this resource via 'cdkd state orphan'.`
      );
    }
  }
}

function printSummary(rows: ImportRow[]): void {
  const logger = getLogger();
  const counts = {
    imported: 0,
    'skipped-no-impl': 0,
    'skipped-not-found': 0,
    'skipped-out-of-scope': 0,
    failed: 0,
  } as Record<ImportOutcome, number>;

  logger.info('');
  logger.info('Import plan:');
  for (const r of rows) {
    counts[r.outcome]++;
    const tag = formatOutcome(r.outcome);
    const detail =
      r.outcome === 'imported' ? ` (${r.physicalId})` : r.reason ? ` — ${r.reason}` : '';
    logger.info(`  ${tag} ${r.logicalId} (${r.resourceType})${detail}`);
  }
  logger.info('');
  logger.info(
    `Summary: ${counts.imported} imported, ${counts['skipped-not-found']} not found, ` +
      `${counts['skipped-no-impl']} unsupported, ` +
      `${counts['skipped-out-of-scope']} out of scope, ${counts.failed} failed`
  );
}

function formatOutcome(outcome: ImportOutcome): string {
  switch (outcome) {
    case 'imported':
      return '✓';
    case 'skipped-not-found':
      return '·';
    case 'skipped-no-impl':
      return '?';
    case 'skipped-out-of-scope':
      return '-';
    case 'failed':
      return '✗';
  }
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

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
 *      Imports every resource in the template via tag-based lookup
 *      (`aws:cdk:path`). cdkd's value-add over CDK CLI — useful for
 *      adopting a whole stack that was previously deployed by `cdk deploy`.
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
 *      resources still go through tag-based auto-import. The pre-PR
 *      default behavior, now opt-in.
 */
export function createImportCommand(): Command {
  const cmd = new Command('import')
    .description(
      'Adopt already-deployed AWS resources into cdkd state. Reads the CDK app to find ' +
        'logical IDs, resource types, and dependencies. With no flags, imports every ' +
        'resource via the aws:cdk:path tag. With --resource / --resource-mapping, only ' +
        'the listed resources are imported (CDK CLI parity); pass --auto to also tag-import the rest.'
    )
    .argument(
      '[stack]',
      'Stack to import. Optional when the synthesized app contains exactly one stack.'
    )
    .option(
      '--resource <id=physical>',
      'Explicit physical-id override for one logical ID. Repeatable. ' +
        'When at least one --resource is given, only listed resources are imported ' +
        '(CDK CLI parity). Pass --auto to also tag-import everything else.',
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
        'tag-based auto-lookup), write the resulting {logicalId: physicalId} map ' +
        'to <file> as JSON. Useful in auto / hybrid mode for capturing the ' +
        'tag-resolved mapping and feeding it back as --resource-mapping in ' +
        'non-interactive CI re-runs. Written before the confirmation prompt ' +
        '(so the user can review the file before saying "yes") and even when the ' +
        'user says "no". Mirrors `cdk import --record-resource-mapping`.'
    )
    .option(
      '--auto',
      'Hybrid mode: when explicit overrides are supplied, ALSO tag-import ' +
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
      'After cdkd state is written, retire the named CloudFormation stack ' +
        '(deletes the CFn stack record; AWS resources are NOT deleted): ' +
        'inject DeletionPolicy=Retain and UpdateReplacePolicy=Retain on every ' +
        'resource via UpdateStack, then DeleteStack. cdkd takes over management. ' +
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

/**
 * Populate `observedProperties` for every resource in a freshly-built
 * import StackState by calling the matching provider's
 * `readCurrentState`. Mirrors what `cdkd deploy` does after each
 * create/update so the very first `cdkd drift` run after import has a
 * real AWS-current baseline (instead of falling back to template
 * `properties` and silently missing console-side changes).
 *
 * Synchronous + parallel — import is rare enough that the few extra
 * seconds for `Promise.all` over the imported set are amortized into
 * the user's adoption workflow. Per-resource errors are swallowed
 * (logged at debug) so a single readCurrentState failure does not abort
 * the import; the affected resource simply lands without
 * `observedProperties` and the next deploy will populate it.
 *
 * Resources whose provider does not implement `readCurrentState`
 * (incremental rollout — see `ResourceProvider.readCurrentState`'s
 * doc-comment) keep `observedProperties: undefined`; the drift comparator
 * falls back to `properties` for those, matching pre-v3 behavior.
 */
async function captureObservedForImportedResources(
  stackState: StackState,
  providerRegistry: ProviderRegistry,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const entries = Object.entries(stackState.resources);
  if (entries.length === 0) return;

  await Promise.all(
    entries.map(async ([logicalId, resource]) => {
      try {
        const provider = providerRegistry.getProviderFor({
          resourceType: resource.resourceType,
          provisionedBy: resource.provisionedBy,
        }).provider;
        if (!provider.readCurrentState) return;
        const observed = await provider.readCurrentState(
          resource.physicalId,
          logicalId,
          resource.resourceType,
          resource.properties ?? {},
          // Issue #323: pass cross-resource context so IAM providers
          // can filter inline policies managed by sibling
          // AWS::IAM::Policy resources. By the time this runs, every
          // imported resource is already in stackState.resources, so
          // the sibling lookup is complete.
          buildReadCurrentStateContext(stackState, logicalId)
        );
        if (observed !== undefined) {
          resource.observedProperties = observed;
        }
      } catch (err) {
        logger.debug(
          `observedProperties capture for imported ${logicalId} (${resource.resourceType}) failed: ${err instanceof Error ? err.message : String(err)} — drift will fall back to template properties for this resource until the next successful deploy.`
        );
      }
    })
  );
}

/**
 * Synthesize the cdkd-local ARN that `NestedStackProvider.create` would write
 * for a nested-stack resource (design [docs/design/459-nested-stacks.md](../../../docs/design/459-nested-stacks.md)
 * §3, issue [#464](https://github.com/go-to-k/cdkd/issues/464) §6). Partition
 * `cdkd-local` is load-bearing — any consumer that misuses this value as a
 * real AWS ARN fails loudly with "Invalid ARN partition: cdkd-local" rather
 * than silently using a non-ARN string. The format MUST match
 * `NestedStackProvider.synthesizeArn` so an import-then-deploy cycle does
 * not surface phantom property changes on the nested-stack row.
 */
function synthesizeNestedStackArn(
  region: string,
  accountId: string,
  parentStackName: string,
  logicalId: string
): string {
  return `arn:cdkd-local:${region}:${accountId}:nested-stack/${parentStackName}/${logicalId}`;
}

/**
 * Validate the parent template ↔ AWS CFn tree shape consistency before any
 * destructive walk begins. Three failure modes are surfaced up front so
 * the user gets one clear error instead of a partial-success state file
 * graveyard:
 *
 *   1. Synth template has `AWS::CloudFormation::Stack` row at logical id X
 *      but AWS tree has no child at X — likely the user added a new
 *      nested child to the CDK code without running `cdk deploy` first.
 *   2. AWS tree has child at logical id Y but synth template has no
 *      matching row — the user removed a nested child from the CDK code
 *      but the live CFn stack still has it (or AWS removed it
 *      mid-flight).
 *   3. Synth's `nestedTemplates` index is missing a path for some nested
 *      row — usually means CDK 2.x didn't emit `Metadata['aws:asset:path']`
 *      on the row (older CDK versions, or a hand-edited template). Without
 *      the local template file we can't enumerate the child's resources
 *      for the per-child state write.
 *
 * Mirrors the upstream `cdk import` mismatch UX — "import refuses on a
 * shape mismatch, fix the shape and re-run."
 */
function validateNestedStackShape(
  template: CloudFormationTemplate,
  tree: CfnStackResourceTree,
  parentStackName: string,
  nestedTemplates: Record<string, string>
): void {
  const templateNestedIds = new Set<string>();
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === NESTED_STACK_RESOURCE_TYPE) {
      templateNestedIds.add(logicalId);
    }
  }
  const treeNestedIds = new Set<string>(tree.nested.keys());

  const inTemplateMissingFromAws: string[] = [];
  for (const id of templateNestedIds) {
    if (!treeNestedIds.has(id)) inTemplateMissingFromAws.push(id);
  }
  const inAwsMissingFromTemplate: string[] = [];
  for (const id of treeNestedIds) {
    if (!templateNestedIds.has(id)) inAwsMissingFromTemplate.push(id);
  }
  const inTemplateMissingNestedTemplatePath: string[] = [];
  for (const id of templateNestedIds) {
    if (!nestedTemplates[id]) inTemplateMissingNestedTemplatePath.push(id);
  }

  const problems: string[] = [];
  if (inTemplateMissingFromAws.length > 0) {
    problems.push(
      `template has nested-stack row(s) not present in CloudFormation: ` +
        `[${inTemplateMissingFromAws.join(', ')}] — run \`cdk deploy\` first ` +
        `so the AWS-side stack matches the synth template`
    );
  }
  if (inAwsMissingFromTemplate.length > 0) {
    problems.push(
      `CloudFormation has nested-child stack(s) not present in the synth template: ` +
        `[${inAwsMissingFromTemplate.join(', ')}] — the CDK code was edited ` +
        `to remove these children, but the live CFn stack still has them. ` +
        `Run \`cdk deploy\` to apply the removal, or revert the CDK edit`
    );
  }
  if (inTemplateMissingNestedTemplatePath.length > 0) {
    problems.push(
      `synth cloud assembly is missing nested-template asset paths for row(s) ` +
        `[${inTemplateMissingNestedTemplatePath.join(', ')}] — verify CDK 2.x ` +
        `\`cdk.NestedStack\` emits Metadata['aws:asset:path'] (default behavior)`
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `cdkd import --migrate-from-cloudformation: parent stack '${parentStackName}' ` +
        `template ↔ CloudFormation shape mismatch:\n  - ${problems.join('\n  - ')}`
    );
  }
}

/**
 * After the root parent stack's cdkd state is written, walk the
 * `migrationTree.nested` map and adopt every nested child into its own
 * v6-keyed state file (`cdkd/<parent>~<childLogicalId>/<region>/state.json`).
 * Recurses into grandchildren via the same walker.
 *
 * Per child:
 *   1. Acquire the child's lock. Order across the full tree is
 *      **parent-first acquire, leaves-first release** (each level's
 *      `finally` releases its child lock before sibling iteration
 *      continues, and the root lock is the outermost — held by
 *      `runImport`'s `try` / `finally`). This is the conventional
 *      hierarchical lock pattern: parent-first acquire prevents a
 *      second cdkd import from racing past the root lock; leaves-first
 *      release on success/failure means a mid-walk error never strands
 *      a child lock past its scope. Design §3.3 wording ("leaves first,
 *      parent last") is preserved as the RELEASE order; the acquire
 *      order is parent-first to keep the lock graph deadlock-free.
 *   2. Read the child template body from the synth cloud assembly via
 *      `parentNestedTemplates[<childLogicalId>]` (populated by
 *      AssemblyReader at synth time — see {@link AssemblyReader.parseStack}).
 *   3. Enumerate the child's importable resources (same filter as the
 *      root's `collectImportableResources` — drop `AWS::CDK::Metadata`,
 *      short-circuit `AWS::CloudFormation::Stack` rows to synth ARNs).
 *   4. For each child resource: dispatch through `importOne` with the
 *      child's `(logicalId → physicalId)` overrides from `childTree.resources`.
 *   5. Build the child's `StackState` with `parentStack` / `parentLogicalId`
 *      / `parentRegion` populated per state schema v6.
 *   6. Save state via `stateBackend.saveState('<parent>~<childLogicalId>', ...)`.
 *   7. Recurse into grandchildren.
 *
 * Lock release happens in REVERSE acquisition order in the outer
 * `finally` of each child — leaves-first acquire / parent-last release on
 * success, AND parent-last release on failure. Per memory rule
 * `feedback_destructive_state_test_coverage.md`, the lock-release order
 * is verified by unit test.
 */
async function importNestedStackChildrenRecursive(args: {
  parentStackName: string;
  parentRegion: string;
  /** AssemblyReader-built `childLogicalId → local template file path` index for the parent's direct children. */
  parentNestedTemplates: Record<string, string>;
  parentTree: CfnStackResourceTree;
  stateBackend: S3StateBackend;
  lockManager: LockManager;
  providerRegistry: ProviderRegistry;
  templateParser: TemplateParser;
  lockOwner: string;
  accountId: string;
  logger: ReturnType<typeof getLogger>;
  /**
   * Issue #1002 PR 2 — §6 mapping table when the region is in cdkd-assets
   * mode. Each child template read below gets the §7 rewrite before its
   * properties land in state (nested templates bypass the top-level
   * rewrite in `importCommand`).
   */
  assetRedirect?: AssetRedirectMap | undefined;
}): Promise<void> {
  const {
    parentStackName,
    parentRegion,
    parentNestedTemplates,
    parentTree,
    stateBackend,
    lockManager,
    providerRegistry,
    templateParser,
    lockOwner,
    accountId,
    logger,
    assetRedirect,
  } = args;

  for (const [childLogicalId, childTreeNode] of parentTree.nested) {
    const childStackName = `${parentStackName}~${childLogicalId}`;
    const childRegion = parentRegion;
    const childTemplatePath = parentNestedTemplates[childLogicalId];
    if (!childTemplatePath) {
      throw new Error(
        `cdkd import --migrate-from-cloudformation: missing nested-template ` +
          `path for '${childLogicalId}' under parent '${parentStackName}' — ` +
          `validateNestedStackShape should have rejected this; please file a bug.`
      );
    }

    logger.info(
      `Adopting nested stack '${childLogicalId}' as cdkd stack '${childStackName}' ` +
        `(${childRegion})...`
    );

    const childTemplate = readNestedChildTemplate(childTemplatePath, childLogicalId);
    if (assetRedirect) {
      rewriteTemplateAssetReferences(childTemplate, assetRedirect);
    }

    await lockManager.acquireLock(childStackName, childRegion, lockOwner, 'import');
    try {
      // Compose the child's import overrides from the child tree's flat
      // resource map, through the same shared filter as the root walk
      // (issue #1131). The "already overridden" filter is inert here — the
      // child map starts empty, since `--resource` overrides are root-scoped.
      const childResources = collectImportableResources(childTemplate);
      const childTemplateLogicalIds = new Set(childResources.map((r) => r.logicalId));
      const childOverrides = new Map<string, string>();
      mergeCfnDerivedOverrides({
        cfnMapping: childTreeNode.resources,
        template: childTemplate,
        templateLogicalIds: childTemplateLogicalIds,
        overrides: childOverrides,
      });

      // Dispatch + collect rows (same shape as the root's dispatch loop).
      const rows: ImportRow[] = [];
      for (const { logicalId, resource } of childResources) {
        if (resource.Type === NESTED_STACK_RESOURCE_TYPE && childTreeNode.nested.has(logicalId)) {
          rows.push({
            logicalId,
            resourceType: resource.Type,
            outcome: 'imported',
            physicalId: synthesizeNestedStackArn(childRegion, accountId, childStackName, logicalId),
          });
          continue;
        }
        const outcome = await importOne({
          logicalId,
          resource,
          stackName: childStackName,
          region: childRegion,
          providerRegistry,
          override: childOverrides.get(logicalId),
          overrides: childOverrides,
        });
        rows.push(outcome);
      }

      // Build child state (auto / whole-stack mode — no pre-existing
      // selective merge for a fresh nested child). Populate the v6
      // parent-link fields so `NestedStackProvider.delete`'s child-state
      // lookup at destroy time, `cdkd state list` / `state show` rendering,
      // and any future cross-stack consumer scan can navigate the tree.
      const childStackState = buildStackState(
        childStackName,
        childRegion,
        rows,
        templateParser,
        childTemplate,
        null,
        false
      );
      childStackState.parentStack = parentStackName;
      childStackState.parentLogicalId = childLogicalId;
      childStackState.parentRegion = parentRegion;

      // Resolve intrinsics in child Properties (same reason as root —
      // sub-resource provider deletes read resolved props), populate
      // observedProperties baseline, then save. Re-uses the same
      // helpers as the root so behavior stays in sync.
      await resolveImportedProperties(
        childStackState,
        childTemplate,
        childRegion,
        stateBackend,
        logger
      );
      await captureObservedForImportedResources(childStackState, providerRegistry, logger);

      await stateBackend.saveState(childStackName, childRegion, childStackState);
      logger.info(
        `✓ Nested stack state written: ${childStackName} (${childRegion}) — ` +
          `${rows.filter((r) => r.outcome === 'imported').length} resource(s) imported.`
      );

      // Recurse into grandchildren. The recursive call acquires their
      // own locks; this child's lock stays held until its `finally`
      // releases it AFTER its descendants' locks are released (matches
      // the "leaves first, parent last" lock contract — descendants
      // release first, then this level, then the root in `runImport`'s
      // outer `finally`).
      if (childTreeNode.nested.size > 0) {
        await importNestedStackChildrenRecursive({
          parentStackName: childStackName,
          parentRegion: childRegion,
          // Grandchild template paths live alongside the child template
          // file via `Metadata['aws:asset:path']` — index them with the
          // same logic AssemblyReader uses at the parent level.
          parentNestedTemplates: indexGrandchildTemplatePaths(childTemplate, childTemplatePath),
          parentTree: childTreeNode,
          stateBackend,
          lockManager,
          providerRegistry,
          templateParser,
          lockOwner,
          accountId,
          logger,
          assetRedirect,
        });
      }
    } finally {
      await lockManager.releaseLock(childStackName, childRegion).catch((err) => {
        logger.warn(
          `Failed to release lock for nested stack '${childStackName}' (${childRegion}): ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }
}

/**
 * Read a nested child's template body from the synth cloud assembly's
 * sibling file (the path AssemblyReader populates from
 * `Metadata['aws:asset:path']`). Wraps the I/O + JSON parse failures with
 * an actionable error that names the offending child logical id.
 */
function readNestedChildTemplate(
  templatePath: string,
  childLogicalId: string
): CloudFormationTemplate {
  // Sync fs reads — import is a rare, single-threaded operation and the
  // per-child template is bounded by the 1 MB CFn TemplateURL limit, so
  // the latency is comparable to a few network round-trips. Matching the
  // pattern `NestedStackProvider.readChildTemplate` uses for the same
  // reason.
  let raw: string;
  try {
    raw = readFileSync(templatePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read nested-stack template for '${childLogicalId}' at ` +
        `${templatePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    return JSON.parse(raw) as CloudFormationTemplate;
  } catch (err) {
    throw new Error(
      `Failed to parse nested-stack template for '${childLogicalId}' at ` +
        `${templatePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Index a child template's `AWS::CloudFormation::Stack` rows by their
 * `aws:asset:path` Metadata, mirroring what {@link AssemblyReader.parseStack}
 * does for the root parent. Grandchild template files are sibling .nested
 * files of the child template file in the same cdk.out subdirectory.
 *
 * Refuses absolute paths for the same reason `NestedStackProvider.indexGrandchildTemplates`
 * does: an absolute path indicates the synth output was hand-modified or
 * generated by a non-CDK toolchain — `path.join(dir, '/abs/foo')` would
 * silently bypass our `dir` resolution and point outside cdk.out.
 */
function indexGrandchildTemplatePaths(
  childTemplate: CloudFormationTemplate,
  childTemplatePath: string
): Record<string, string> {
  const dir = nodePath.dirname(childTemplatePath);
  const result: Record<string, string> = {};
  for (const [grandLogicalId, resource] of Object.entries(childTemplate.Resources)) {
    if (resource.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    const meta = resource.Metadata as Record<string, unknown> | undefined;
    const assetPath = meta?.['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    if (nodePath.isAbsolute(assetPath)) {
      throw new Error(
        `cdkd import --migrate-from-cloudformation: grandchild nested-stack ` +
          `'${grandLogicalId}' has Metadata['aws:asset:path']='${assetPath}' ` +
          `which is absolute. CDK emits relative asset paths for nested templates.`
      );
    }
    result[grandLogicalId] = nodePath.join(dir, assetPath);
  }
  return result;
}
