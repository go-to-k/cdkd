import { readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  parseContextOptions,
  stateOptions,
  useCdkBootstrapAssetsOption,
} from '../options.js';
import { withSharedDrainBudget } from '../../deployment/drain-budget.js';
import { getLogger } from '../../utils/logger.js';
import { confirmOrRefuse } from './confirm-prompt.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { foldRegionOption, namedCliRegion } from '../region-options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, synthesisStatusMessage } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
} from '../../state/lock-contention-message.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import {
  IntrinsicFunctionResolver,
  isUnboundTemplateParameter,
} from '../../deployment/intrinsic-function-resolver.js';
import {
  maskSecretsInText,
  redactSecretsForState,
  STATE_SOURCED_BASELINE_RULES,
  type RecordedSecretValues,
} from '../../deployment/secret-redaction.js';
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
  exportNamesCarriedFrom,
  orphansCarriedFrom,
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
   * go through auto-resolution. Default is `false` for CDK CLI parity:
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

async function importCommand(stackArg: string | undefined, options: ImportOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Region falls through CLI flag → env → us-east-1, the same chain as deploy.
  const region = namedCliRegion(options.region) ?? 'us-east-1';

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
    // Every contention message this command (and its nested recursion) raises
    // points at the SAME lock object it was working on (issue #2170).
    const lockRecovery: LockRecoveryContext = {
      profile: options.profile,
      stateBucket,
      statePrefix: options.statePrefix,
    };
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
    // disambiguate — imports are per-stack and ambiguity here is
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
    // rewrite the template's asset references BEFORE anything reads it
    // (design §7.1). Nested child templates in the recursive CFn-migration
    // walk are rewritten at their own load site below. Lazy: asset-less
    // apps / legacy regions add no AWS calls beyond the marker read.
    const resolveAssetRedirect = createAssetRedirectResolver({
      stateBackend,
      stsRegion: region,
      ...(options.profile && { profile: options.profile }),
      useCdkBootstrapAssets: resolveUseCdkBootstrapAssets(options.useCdkBootstrapAssets),
      suppressLegacyNotice: true,
    });
    const assetRedirect = await resolveAssetRedirect(stackInfo.assetManifestPath, targetRegion);
    // Issue #1652 — the template whose `Properties` land in `state.properties`.
    // In cdkd-assets mode this is a snapshot taken BEFORE the rewrite, so
    // state records the CDK-bootstrap (`cdk-<qualifier>-assets-*`) values the
    // AWS-side resources actually hold at adoption time, not the cdkd-assets
    // values the rewrite substitutes.
    //
    // The original §7.1 intent was the opposite ("rewrite before writing
    // state, so imported state matches what the next deploy would write — no
    // spurious first-deploy churn"). That optimization is only sound for a
    // resource whose live value import reads back from AWS. Most providers'
    // `import()` return just a physical id (e.g. `IAMPolicyProvider`), so
    // baking the rewritten value into state made the deploy diff compare the
    // rewritten template against a rewritten state, classify `NO_CHANGE`, and
    // NEVER correct the live resource — a silent split-brain (the IAM policy
    // that `s3deploy.BucketDeployment` generates keeps granting the CDK
    // bootstrap bucket while `SourceBucketNames` points at the cdkd bucket,
    // surfacing later as a runtime AccessDenied). Recording the pre-rewrite
    // value trades one corrective UPDATE on the first post-import deploy for
    // correctness, which is the right trade when adopting a stack that was
    // deployed by something else.
    let stateTemplate = stackInfo.template;
    if (assetRedirect) {
      // Snapshot BEFORE the in-place rewrite mutates the template.
      stateTemplate = structuredClone(stackInfo.template);
      const rewritten = rewriteTemplateAssetReferences(stackInfo.template, assetRedirect);
      logger.debug(
        `Rewrote ${rewritten} asset reference(s) to cdkd asset storage in template of ` +
          `stack ${stackInfo.stackName}`
      );
      if (rewritten > 0) {
        // Deliberately does NOT claim what AWS currently holds. Synth always
        // emits `cdk-*` names, so `rewritten > 0` fires even when re-importing a
        // stack cdkd itself deployed in cdkd-assets mode — where the live values
        // are already the cdkd ones, so the next deploy still classifies an
        // UPDATE (state holds `cdk-*`, the template holds `cdkd-*`) and issues
        // the calls; it is a no-op at AWS, not an absent one.
        logger.info(
          `Note: ${rewritten} asset reference(s) in stack ${stackInfo.stackName} are recorded in ` +
            `state at their pre-rewrite (CDK bootstrap) values, so the next 'cdkd deploy' ` +
            `repoints any resource that still holds them to cdkd asset storage.`
        );
      }
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
      // resource `--resource <id>=<physical>` flags: the physical-name-property
      // half of auto-resolution can't find a resource whose name CDK generated
      // (and a tag walk is not an option either — upstream `cdk deploy` doesn't
      // propagate `aws:cdk:path` as a real AWS tag, and AWS reserves the
      // `aws:` tag prefix so we can't add it on the way through, which is why
      // issue #1134 removed that walk entirely),
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
    // overrides PLUS auto-resolution for everything else — with
    // `--auto`. With no overrides at all, auto mode is implied (the user
    // is asking cdkd to find every resource itself).
    //
    // `--migrate-from-cloudformation` always implies whole-stack auto mode:
    // every CFn-derived override is part of the same migration intent, so
    // the user shouldn't need to also pass `--auto` to avoid selective mode.
    const selectiveMode = overrides.size > 0 && !options.auto && !options.migrateFromCloudformation;
    if (selectiveMode) {
      logger.info(
        `Selective mode: only importing the ${overrides.size} resource(s) you listed ` +
          `(${[...overrides.keys()].join(', ')}). ` +
          `Pass --auto to also auto-resolve the rest.`
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
    // Check the boolean return (issue #2161): `acquireLock` returns `false`
    // (does not throw) when another process holds a live lock, and the
    // discarded return let import proceed under contention and later release
    // the other owner's lock via the `try` below (whose `finally` releases).
    // Throwing on `!acquired` aborts before that `try` is entered.
    const acquired = await lockManager.acquireLock(
      stackInfo.stackName,
      targetRegion,
      owner,
      'import'
    );
    if (!acquired) {
      throw new Error(
        await buildLockContentionMessage({
          lockManager,
          stackName: stackInfo.stackName,
          region: targetRegion,
          recovery: {
            profile: options.profile,
            stateBucket,
            statePrefix: options.statePrefix,
          },
        })
      );
    }

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

      // `stateTemplate` is the PRE-asset-rewrite snapshot in cdkd-assets mode
      // (issue #1652) and `template` itself otherwise — identical in every
      // respect except that its asset references still name CDK bootstrap
      // storage, which is what AWS holds for the resources being adopted.
      const stackState = buildStackState(
        stackInfo.stackName,
        targetRegion,
        rows,
        templateParser,
        stateTemplate,
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
      // ONE drain budget for the whole resolve LOOP inside it (issue #2563),
      // for the same reason the deploy engine's outputs pass wraps: the lock
      // is held above and `saveState` is downstream, and each `resolve` in
      // there can now WAIT on a rejection.
      const unsafeObservedBaselineLogicalIds = await withSharedDrainBudget(() =>
        resolveImportedProperties(stackState, stateTemplate, targetRegion, stateBackend, logger)
      );

      // Populate observedProperties for the freshly-imported resources so
      // the very first `cdkd drift` run after import has a real baseline
      // (matching what `cdkd deploy` does after each create/update). Done
      // synchronously in parallel before saveState — import is a rare op
      // and the few extra seconds are amortized into the user's adoption
      // workflow. Errors are swallowed per-resource so a single
      // readCurrentState failure does not abort the whole import.
      await captureObservedForImportedResources(
        stackState,
        providerRegistry,
        logger,
        unsafeObservedBaselineLogicalIds,
        // Issue #2944: the rows this run REBUILT from the template. Derived
        // from the same `outcome === 'imported'` predicate `buildStackState`
        // uses to decide which records it overwrites, so the two cannot
        // disagree about which `properties` are this run's.
        rebuiltLogicalIdsFrom(rows, stateTemplate)
      );

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
          lockRecovery,
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
          // DescribeStackResources calls instead of redoing them.
          //
          // The guard cannot currently be false: `migrationTree` is awaited
          // unconditionally under the same `if (migrationCfnStackName)` that
          // gates this block, so this is the site that makes
          // `retire-cfn-stack.ts`'s "import always supplies the tree" note
          // true. It is written conditionally anyway because the two
          // assignments are ~500 lines apart and a future early-return
          // between them would reintroduce the undefined case silently.
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
    stackName,
    region,
    properties,
    ...(override !== undefined && { knownPhysicalId: override }),
  };

  try {
    const result: ResourceImportResult | null = await provider.import(input);
    if (!result) {
      // The provider could not resolve a physical id: no `--resource`
      // override, no same-named CloudFormation stack to answer
      // `DescribeStackResources`, and no physical-name property in the
      // template. (There is deliberately no `aws:cdk:path` tag lookup — AWS
      // reserves the `aws:` prefix, so that tag never exists on a real
      // resource; issue #1134.)
      return {
        logicalId,
        resourceType: resource.Type,
        outcome: 'skipped-not-found',
        reason:
          'no matching AWS resource — pass --resource ' +
          `${logicalId}=<physicalId> to adopt it explicitly`,
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
 * The logical ids whose `ResourceState` a run REBUILT from the template — the
 * discriminator `captureObservedForImportedResources` needs for schema v10's
 * `observedBaselineRefused` (issue
 * [#2944](https://github.com/go-to-k/cdkd/issues/2944)).
 *
 * It is a function, exported and tested, rather than an inline
 * `rows.filter(...)` at each call site, because the predicate is the whole
 * safety property: `buildStackState` overwrites exactly the `'imported'` rows
 * and PRESERVES every other record in a selective merge, so a predicate that
 * drifts wider (`rows.map(...)`, or admitting another outcome) silently
 * re-opens the fifth-writer leak — a preserved record's stale, distrusted
 * `properties` would be treated as this run's resolution, captured against,
 * and its refusal cleared. Two inline copies could also drift apart from each
 * other and from `buildStackState`'s own test.
 *
 * Every non-`'imported'` outcome is EXCLUDED, including the ones that sound
 * harmless: `skipped-out-of-scope` is precisely the selective-merge case, and
 * `failed` / `skipped-not-found` / `skipped-no-impl` leave whatever the record
 * already held.
 */
export function rebuiltLogicalIdsFrom(
  rows: readonly ImportRow[],
  template: CloudFormationTemplate
): ReadonlySet<string> {
  return new Set(
    rows
      .filter(
        (r) =>
          r.outcome === 'imported' &&
          // The SAME three conjuncts `buildStackState` applies before it
          // overwrites a record. Filtering on the outcome alone was the first
          // spelling and a review round caught it: a row that is `'imported'`
          // but carries no physical id, or names a logical id the template
          // does not declare, is SKIPPED there — so the record keeps whatever
          // it already held, and calling it rebuilt would let a preserved
          // refusal be cleared against a previous run's properties.
          // Unreachable today (every `outcome: 'imported'` site sets a
          // physical id), which is exactly why it must be spelled rather than
          // argued.
          r.physicalId !== undefined &&
          template.Resources[r.logicalId] !== undefined
      )
      .map((r) => r.logicalId)
  );
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
    // The bag above is carried forward, so its export set travels with it
    // (issue #2193); a record built from nothing exports nothing, and that is
    // a KNOWN `[]`, not an unknown.
    ...(existingState ? exportNamesCarriedFrom(existingState) : { exportNames: [] }),
    // Carried for the same reason (issue #2934), and it matters MORE here than
    // the export set does: import into an existing state is a realistic
    // recovery route after a failed deploy, and this literal enumerates its
    // fields — so without this line the import would silently delete the only
    // record that a live, billing `Retain` resource is still standing in AWS.
    ...(existingState ? orphansCarriedFrom(existingState) : {}),
    // ...but the skipped-outputs record (issue #2740) is DROPPED, not carried,
    // even though it describes that same bag. It records what the last DEPLOY
    // could not resolve, and an import refreshes `attributes` for every
    // resource it imports (see the `rowAttributes ?? priorAttributes` above;
    // selective mode leaves the rest alone), so a key the deploy skipped for
    // want of an attribute may now resolve — with no template resource change
    // to un-bind the record. Carried forward it would make `cdkd diff` preview
    // that key as absent while the next deploy publishes it and its
    // `Export.Name`: the record's silent "nothing to do" over a row that is
    // coming, which is the direction the whole field exists to avoid. Dropping
    // it returns that key to pre-#2740 behaviour until the next deploy
    // recomputes the record: resolved like any other output, so a row when the
    // diff can resolve it and the ordinary whole-section suppression when it
    // cannot. Either way the diff stops asserting that nothing is coming.
    lastModified: Date.now(),
  };
}

/**
 * The same template with its `Parameters` section narrowed to the entries that
 * carry a `Default`, for the `resolveParameters` retry in
 * {@link resolveImportedProperties} (issue
 * [#2321](https://github.com/go-to-k/cdkd/issues/2321)).
 *
 * Presence is tested with `'Default' in definition`, NOT `Default !== undefined`,
 * because that is the test both `resolveParameters` and
 * `isUnboundTemplateParameter` use: a key present with an `undefined` value is
 * a binding to `undefined` for them, and a filter that disagreed would hand the
 * retry a parameter it would then throw on.
 *
 * Everything OUTSIDE `Parameters` is carried through untouched — `Resources` in
 * particular, because `resolveParameters` walks it to decide which SSM-typed
 * defaults are actually referenced and worth a `GetParameter` call.
 */
function defaultOnlyParameterTemplate(template: CloudFormationTemplate): CloudFormationTemplate {
  const declared = template.Parameters;
  if (declared === undefined || declared === null || typeof declared !== 'object') {
    return template;
  }
  const defaulted = Object.fromEntries(
    Object.entries(declared).filter(
      ([, definition]) =>
        definition !== null && typeof definition === 'object' && 'Default' in definition
    )
  );
  return { ...template, Parameters: defaulted };
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
 *     intrinsic context). A parameter-resolution failure means the
 *     template declares a parameter with no `Default`, which an import
 *     cannot bind; it logs and RETRIES over the `Default`-carrying
 *     parameters alone (issue #2321) so one unbindable parameter does
 *     not discard the defaults its siblings declare. The resolver
 *     itself tolerates missing parameter / condition entries.
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
 *
 * RETURNS the logical ids for which an `observedProperties` baseline must NOT
 * be captured, because this walk cannot vouch that the persisted `properties`
 * still SPELL the dynamic reference the template had.
 * `captureObservedForImportedResources` refuses to write a baseline for those
 * (issue [#2828](https://github.com/go-to-k/cdkd/issues/2828) review); the
 * redaction it performs is POSITION-based, so a bag that no longer spells the
 * reference gives it no evidence and the DECRYPTED readback is persisted in
 * the clear.
 *
 * The predicate is deliberately CONSERVATIVE — it over-refuses — and that is a
 * decision a review round paid for. Three arms:
 *
 *  - **Resolution THREW** — refuse, unconditionally. A throw means the
 *    resolver could not finish, so nothing about the persisted bag is
 *    trustworthy evidence. This is BEHAVIOURALLY IDENTICAL to the arm this PR
 *    first shipped: two attempts to sharpen it in between each shipped a leak
 *    (the wrapped-complete-token shape, then the
 *    reference-sourced-from-outside-the-bag shape), and saying so is the
 *    strongest available form of "every sharpening leaked". The arm's own
 *    comment carries both measurements.
 *  - **Resolution SUCCEEDED but LOST an opener.** An `Fn::If` whose condition
 *    was DOWNGRADED resolves without throwing and selects the branch AWS did
 *    not take, so `properties` hold the false-branch literal and no reference
 *    at all. The downgrade needs a parameter with NO `Default` — `cdkd import`
 *    accepts no parameter VALUES from the user, but a `Default`-carrying
 *    parameter IS bound (issue #2321's retry), so only an unbindable one leaves
 *    `evaluateConditions` catching per condition and recording `false`.
 *
 *    ARM 2 IS KNOWN OVER-BROAD for a PUBLIC `{{resolve:ssm:...}}` reference: a
 *    `String` / `StringList` parameter is stored RESOLVED (issue #1901), so its
 *    opener disappears across the resolve and the resource is refused although
 *    nothing was ever secret, costing it a drift baseline on a common config
 *    pattern. Threading the resolve's own `recordedSecretValues` into the
 *    capture corrects it -- measured on issue
 *    [#2852](https://github.com/go-to-k/cdkd/issues/2852), which carries that
 *    remedy -- because a populated map makes absence from it real evidence of
 *    a public parameter, exactly as the deploy path already relies on.
 *
 *  - **Resolution SUCCEEDED but DISCARDED a subtree that is not provably
 *    inert** (issue [#2850](https://github.com/go-to-k/cdkd/issues/2850)).
 *    The count in arm 2 sees only what the raw bag SPELLS, and that issue
 *    measured two ways past it: a downgraded `Fn::If` dropping one reference
 *    while a parameter-sourced reference is ADDED elsewhere (the totals
 *    balance), and a reference sourced ENTIRELY from a parameter `Default` or
 *    a `Mappings` entry then dropped (both counts read zero, and nothing
 *    warns). {@link resolveDiscardsNonInertSubtree} carries the discard-event
 *    enumeration and the fail-closed rules; "inert" is
 *    {@link isInertDiscardedSubtree}'s definition — pure literals with no
 *    opener text and no intrinsic anywhere, because every way a discarded
 *    subtree could have SOURCED a reference is an intrinsic.
 *
 * The cost of a false refusal is one resource's drift baseline until its next
 * deploy; the cost of a false pass is a plaintext secret in `state.json`. So an
 * unmeasurable bag refuses too.
 *
 * WHAT CAN STILL GO WRONG. No claim is made here about what this closes, and
 * that is deliberate: successive review rounds falsified a closure claim, then
 * a closed-set list, then a "reduces" claim -- the mechanism survived every
 * round of measurement and the SENTENCES about it did not. What follows states only
 * the DANGER direction, which can become false only once the residue is gone.
 *
 * PLAINTEXT CAN STILL BE PERSISTED by this capture. Known ways, each with its
 * issue and none of them proven to be all of them:
 *
 *  - a parameter binds to a placeholder `Default` while the DEPLOYED value was
 *    the reference, so no opener exists in any template this walk is handed --
 *    [#2854](https://github.com/go-to-k/cdkd/issues/2854);
 *  - `redactSecretsForState` cannot PAIR the readback against the source at a
 *    position the source carries NO leaf for -- an observed KEY beside a paired
 *    one -- so there is nothing to refuse from and the value scan has no needle
 *    naming it. The row `refuseUncertifiedReadbackPositions`' own table marks
 *    deliberately open, with the cost argument for leaving it that way;
 *    [#2868](https://github.com/go-to-k/cdkd/issues/2868) owns it.
 *    The OTHER pairing failures this bullet used to list -- a reshaped
 *    container, an identity key AWS normalised, an array whose anchors do not
 *    corroborate -- no longer persist the plaintext: since
 *    [#2885](https://github.com/go-to-k/cdkd/issues/2885) this capture declares
 *    its bag a drift baseline, so an uncertified position is masked. They are
 *    rows of `tests/unit/cli/import-observed-baseline-refusal-matrix.test.ts`
 *    rather than entries here;
 *  - the readback holds a secret with NO counterpart in the source at all, set
 *    out of band -- [#2868](https://github.com/go-to-k/cdkd/issues/2868), filed
 *    as a remit question rather than a defect in this mechanism.
 *
 * WHY NO EXHAUSTIVE LIST IS OFFERED, as mechanism rather than framing: this
 * redaction's only evidence is a POST-HOC comparison between the persisted bag
 * and the readback, so anything that comparison cannot see is trusted.
 * Establishing more needs PROVENANCE carried out of the resolver or the
 * deployer, which is where the structural remedy for all of the above lives.
 *
 * The set is returned rather than recorded on the state, because it describes
 * THIS run's resolution and nothing downstream of the save has any use for it.
 *
 * Exported for unit testing — internal to the command flow otherwise. The
 * masking this walk applies (issue #2803) is only provable against the REAL
 * resolver, since the plaintext reaches the message through the resolver's
 * own throw rather than through anything this function writes.
 */
export async function resolveImportedProperties(
  stackState: StackState,
  template: CloudFormationTemplate,
  region: string,
  stateBackend: S3StateBackend,
  logger: ReturnType<typeof getLogger>
): Promise<Set<string>> {
  const unsafeObservedBaselineLogicalIds = new Set<string>();
  const entries = Object.entries(stackState.resources);
  if (entries.length === 0) return unsafeObservedBaselineLogicalIds;

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
    // `resolveParameters` is ALL-OR-NOTHING: it throws on the FIRST parameter
    // that is declared with no `Default` and no supplied value (`cdkd import`
    // supplies none, and has no flag that could), so a single required
    // parameter used to discard the bag WHOLESALE — including the `Default`
    // values the template itself declares for its OTHER parameters. A
    // `Fn::Sub` built from one of those was then persisted verbatim into the
    // imported resource's properties, which issue #2285's refusal cannot
    // close: a `Default`-carrying parameter is correctly OUT of the unbound
    // population, so the placeholder is kept rather than refused (issue
    // [#2321](https://github.com/go-to-k/cdkd/issues/2321)).
    //
    // Those defaults are information this caller already holds, and they are
    // independent of the parameters it could not bind — so retry over a
    // `Default`-only VIEW of the Parameters section. The retry cannot hit the
    // same throw by construction (`isUnboundTemplateParameter` is false for
    // every parameter carrying a `Default`, which is exactly the population
    // that survives the filter), and re-entering the SAME method rather than
    // hand-binding each `Default` keeps the SSM-typed
    // (`AWS::SSM::Parameter::Value<...>`) lookup and its
    // unreferenced-parameter skip identical to the happy path instead of a
    // paraphrase that can drift from it.
    //
    // Issue #2285's refusal is UNAFFECTED in both directions:
    // `isUnboundTemplateParameter` answers `false` for a `Default`-carrying
    // parameter BEFORE it consults the bound bag, so binding those defaults
    // cannot move a parameter into or out of the unbound population. A
    // `${VpcId}` is still refused and still named by `unboundParameterNames`
    // below; a `${Stage}` now resolves to its declared default.
    logger.debug(
      `Template parameter resolution failed during import-time property resolution: ${err instanceof Error ? err.message : String(err)} — retrying with the template's 'Default'-carrying parameters only; resources referencing an unbindable parameter will still be skipped per-resource.`
    );
    try {
      parameters = await resolver.resolveParameters(defaultOnlyParameterTemplate(template));
    } catch (defaultsErr) {
      // A `Default`-only retry can still fail on its own terms — an SSM-typed
      // default whose `GetParameter` is rejected is the reachable case. Fall
      // back to the pre-#2321 empty bag rather than aborting an import that
      // already succeeded against AWS; the resources are on the AWS side
      // whatever happens here, so a throw would lose the state write for work
      // that cannot be undone.
      //
      // KNOWN RESIDUAL, deliberately not fixed here: this fallback is COARSER
      // than it needs to be. One unresolvable SSM-typed default discards the
      // PLAIN `Default` values too, so #2321's defect returns for that
      // template — `${Stage}` is written verbatim again. A third pass over the
      // non-SSM defaults would close it. It is left because this arm is the
      // one place the resolver's `isUnboundTemplateParameter` exclusion is
      // still load-bearing (see the note on that predicate, which cites this
      // arm as its live producer), so the two must be changed together and
      // reasoned about as one. `tests/unit/cli/import.test.ts` PINS the
      // residual — the case asserting a verbatim `app-${Stage}-topic` after a
      // rejected `GetParameter` — so it cannot widen silently, and so the
      // resolver's claim about this arm cannot go stale unnoticed.
      parameters = {};
      logger.debug(
        `'Default'-only template parameter resolution also failed during import-time property resolution: ${defaultsErr instanceof Error ? defaultsErr.message : String(defaultsErr)} — continuing without parameters; resources referencing them will be skipped per-resource.`
      );
    }
  }
  // The three `logger.debug` catches in this preamble — this one and the two
  // `resolveParameters` arms above — interpolate the resolver's error text
  // UNMASKED, and that is deliberate rather than the issue #2803 defect
  // repeated. There is no bag to mask against here: the
  // per-resource `recordedSecretValues` is created inside the walk below, and
  // these three calls thread no `recordedSecretValues` of their own, so nothing
  // can have been recorded when they fail. Passing a freshly-made empty map
  // would be ceremony — `maskSecretsInText` is the identity on one — and would
  // read as a guard where there is nothing to guard. If a future change threads
  // a bag into any of these calls, mask that one THEN.
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

  // The parameters this import could NOT bind, decided by the SAME predicate
  // the resolver refuses on (issue #2285) rather than by re-reading the error
  // text below. `cdkd import` accepts no parameter values at all, so when this
  // list is non-empty the sibling-shaped remedies in the per-resource warning
  // cannot apply to the failure and the message has to say so.
  const unboundParameterNames = Object.keys(
    (template.Parameters ?? {}) as Record<string, unknown>
  ).filter((name) => isUnboundTemplateParameter(name, template, parameters));

  const baseContext = {
    template,
    resources: stackState.resources,
    ...(Object.keys(parameters).length > 0 && { parameters }),
    ...(Object.keys(conditions).length > 0 && { conditions }),
    stateBackend,
    stackName: stackState.stackName,
  };

  for (const [logicalId, resource] of entries) {
    // Fresh PER-RESOURCE secrets map so the imported state persists the
    // `{{resolve:...}}` expression, not the plaintext (GHSA fix), while a
    // whole-secret value from one resource cannot rewrite another's literal
    // (see the deploy engine's `perResourceSecrets` doc for the rationale).
    //
    // HOISTED above the `try` (issue #2803), and that is load-bearing rather
    // than style: the resolver records `plaintext -> expression` into this map
    // AS IT GOES, so a resolution that records one reference and then throws on
    // the next has already put a plaintext here — and the `catch` below prints
    // the resolver's error text at DEFAULT verbosity. Declared inside the
    // `try`, the bag was out of scope exactly where it was needed as a needle
    // set. `rollback-executor.ts` and `drift.ts` hoist for the same reason and
    // say so at their own declarations.
    const recordedSecretValues = new Map<string, string>();
    // Captured BEFORE the resolve + reassignment below: this unresolved bag is
    // the POSITION source (#1910), and `resource.properties` is overwritten
    // with the resolved one inside the `try`.
    //
    // HOISTED above the `try` for the same reason the map above is, and for one
    // more: the refusal decision AFTER the try/catch reads it on BOTH arms.
    const unresolvedProperties = resource.properties ?? {};
    let threw = false;
    try {
      const resolved = (await resolver.resolve(unresolvedProperties, {
        ...baseContext,
        recordedSecretValues,
      })) as Record<string, unknown>;
      resource.properties =
        recordedSecretValues.size > 0
          ? redactSecretsForState(resolved, recordedSecretValues, unresolvedProperties)
          : resolved;
    } catch (err) {
      // Intrinsic referenced a resource not in the importable set
      // (e.g. custom resource that wasn't adopted) or a parameter
      // without a value. Leave the raw intrinsic in place — the
      // resource is already imported on the AWS side, and the user
      // can either re-import the missing sibling or surgically fix
      // state via `cdkd state orphan` + redeploy.
      //
      // BOTH causes reach this catch, and the remedies differ. The
      // sibling-shaped ones stay as written; the parameter-shaped clause is
      // appended only when this template actually has an unbindable parameter
      // (issue #2285 routed that failure here), because re-importing a sibling
      // cannot fix it and `cdkd import` has no flag to bind one with.
      //
      // MASKED (issue #2803). `cdkd import` sets no `skipDynamicReferences`, so
      // the resolve above really does DECRYPT — that is what makes any error
      // out of it a candidate for carrying a plaintext, and it is unchanged.
      // This warn prints at default verbosity, in the command whose stated
      // contract is to persist the `{{resolve:...}}` expression and never the
      // value.
      //
      // SINCE ISSUE #2827 THE RESOLVER MASKS ITS OWN THROWS, so the paragraph
      // that used to sit here — "the resolver's throws interpolate what it was
      // handed, so this boundary is the only mask" — no longer describes the
      // code. What this mask still OWNS is the population the resolver never
      // built: an SDK rejection raised inside `client.send` and propagated
      // through `resolveDynamicReferences` untouched, which is exactly the
      // shape that carries a plaintext (an IAM AccessDenied names the RESOURCE
      // it refused, and for an id an `Fn::Sub` assembled that is the decrypted
      // value). Masking twice is idempotent, so nothing is lost on the errors
      // the resolver already masked. `import-resolver-error-masking.test.ts`
      // pins both halves and says which case discriminates which.
      //
      // THE MASK IS STILL BOUNDED, and this comment deliberately does NOT
      // enumerate how. `maskSecretsInText` matches a needle LITERALLY, so a
      // plaintext that reaches the message re-encoded is not masked here, and
      // neither is one below `MIN_NEEDLE_LENGTH` (4) unless it is the ENTIRE
      // string. (Embedding on its own is NOT a limit — the substring arm masks
      // `key '<plaintext>' not found` fine; an earlier revision of this line
      // said otherwise.) The enumeration lives where it is ACTED ON and kept
      // true — `intrinsic-function-resolver.ts`'s `maskValueLeaves` and the
      // residual note above `maskingContext` in `evaluateConditions` — because
      // five review rounds on this PR each rewrote a taxonomy in THIS spot and
      // each was wrong in a NEW way (`no mask can fix it`, then `a raw-value
      // mask closes it`, both refuted by measurement); nothing here re-checks a
      // claim about the masker's semantics.
      //
      // What this site owns, and what the test file pins: the bag is hoisted
      // so the `catch` can name it, and the message is masked against it.
      //
      // UNCHANGED by issue #2563, which added the drain: a needle missed
      // because a drain released on a spent budget under-redacts here, and
      // that is not a regression -- the merge base has no drain at all, so
      // its grace is zero unconditionally. Do not re-derive it as one.
      logger.warn(
        `Failed to resolve intrinsics in Properties for imported resource '${logicalId}' (${resource.resourceType}): ${maskSecretsInText(err instanceof Error ? err.message : String(err), recordedSecretValues)}. ` +
          `State will be written with the raw intrinsic shape, which may cause 'cdkd destroy' to fail on this resource — re-import once every referenced sibling is in state, or remove this resource via 'cdkd state orphan'.` +
          (unboundParameterNames.length > 0
            ? ` This template also declares parameter(s) with no 'Default' that an import cannot bind (${unboundParameterNames.join(', ')}), and 'cdkd import' accepts no parameter values — if this property was built from one of those, re-importing a sibling will not change it: give the parameter a 'Default' in the template and re-import, or correct the recorded properties before the next 'cdkd deploy'.`
            : '')
      );
      threw = true;
    }

    // THE `attributes` CHOKE POINT (issue
    // [#2847](https://github.com/go-to-k/cdkd/issues/2847)). `attributes` is
    // the third bag on this record and, until this line, the only one no
    // redactor on the import path ever touched: `properties` has been redacted
    // since the original GHSA fix (just above) and `observedProperties` since
    // issue #2828. The deploy path has no such gap — every `saveState` goes
    // through `scrubResourceRecord`, which walks all THREE fields uniformly —
    // so this is import catching up to the choke point deploy already has,
    // not a new mechanism.
    //
    // WHY THE VALUE SCAN AND NO POSITION SOURCE. `redactSecretsForState`'s
    // source argument positions a bag against the TEMPLATE SHAPE it was
    // resolved from. `attributes` is an AWS READBACK with its own key set — it
    // is not the resolved form of `unresolvedProperties` and does not
    // correspond to it positionally, so handing that bag over as a source
    // would be a claim this site cannot make. `scrubResourceRecord` redacts
    // `attributes` with NO source for exactly this reason (the #1900
    // fallback), and this site takes the same shape deliberately rather than
    // inventing a fourth positioning rule.
    //
    // WHY IT RUNS ON THE THROW ARM TOO, and why it is placed ABOVE the refusal
    // below rather than after it. The resolver records `plaintext ->
    // expression` into `recordedSecretValues` AS IT GOES, so a resolve that
    // decrypted one reference and then threw on the next has ALREADY put a
    // needle in the bag — that is the same property the hoist above the `try`
    // exists for, and the `catch`'s own mask relies on it. Skipping the throw
    // arm would leave the readback unredacted in exactly the runs where the
    // needles are known to exist. The refusal below `continue`s, so anything
    // written after it would never reach a throwing resource.
    //
    // THE MAP CAN BE EMPTY, and then this is an identity return — the guard is
    // the same one the `properties` line above uses. That is the ordinary case
    // and it is NOT a gap this line could close: with no needles there is
    // nothing to scan for. What survives an empty map, and what survives a
    // NON-empty one, is the AWS-GENERATED secret — a credential AWS minted
    // that no template ever spelled, so no expression exists to rewrite it to.
    // `CloudControlProvider.import` addresses its own half of that class
    // structurally (see `maskUncertifiedModelValues`); the residue is recorded
    // on the issue rather than claimed closed here.
    if (recordedSecretValues.size > 0 && resource.attributes !== undefined) {
      resource.attributes = redactSecretsForState(resource.attributes, recordedSecretValues);
    }

    // THE REFUSAL (see this function's doc block for the two arms and why the
    // predicate is deliberately CONSERVATIVE rather than precise).
    // ARM 1 -- the resolve THREW. Refuse, FULL STOP: no inspection of the bag at
    // all, and tested FIRST so the two `JSON.stringify` passes below are not
    // computed on the arm that ignores them. Two review rounds tried to be
    // cleverer here and both leaked -- refusing only when an opener is not
    // already a COMPLETE token admitted a complete token wrapped in a
    // single-element `Fn::Join` / `Fn::Sub` / `Fn::If`; refusing only when the
    // raw bag CARRIES an opener admitted a reference sourced from OUTSIDE the
    // bag. A throw means the resolver could not finish, so nothing about the
    // bag is trustworthy evidence.
    if (threw) {
      unsafeObservedBaselineLogicalIds.add(logicalId);
      continue;
    }
    const rawOpeners = countDynamicReferenceOpeners(unresolvedProperties);
    const persistedOpeners = countDynamicReferenceOpeners(resource.properties);
    // ARM 3 (issue #2850) — the resolve SUCCEEDED but DISCARDED a subtree it
    // cannot vouch is inert. The count arm below sees only what the raw bag
    // SPELLS, so it misses a drop the bag never spelled (a reference sourced
    // from a parameter `Default` or a `Mappings` entry: both counts read
    // zero) and a drop BALANCED by an addition elsewhere. The predicate's
    // own doc block carries the discard-event enumeration and the fail-closed
    // rules.
    //
    // EVALUATED IN ITS OWN try, FAIL-CLOSED (independent parent-review
    // blocker): the walk recurses SYNCHRONOUSLY, so a bag nested deeper than
    // the sync call stack — but still shallow enough for JSON.stringify's
    // lighter frames, so the two counts above compute normally and nothing
    // short-circuits — raises `RangeError` here, and no enclosing catch
    // exists: the per-resource try wraps only the resolve, and a throw out of
    // this function aborts the import AFTER the AWS-side import already
    // succeeded — exactly what the parameter fallback above refuses to allow,
    // in its own words ("a throw would lose the state write for work that
    // cannot be undone"). A bag the walk cannot traverse is a bag it cannot
    // vouch for: refuse, the same direction as
    // `countDynamicReferenceOpeners`' serialization guard. Pinned by the
    // deep-bag case in the refusal-matrix suite, which BISECTS to the minimal
    // refusing depth rather than guessing one, because every limit here moves
    // with the ambient stack.
    //
    // THE TRADE THE CATCH MAKES, stated because the comment above names only
    // the safe half: it swallows EVERY throw, so a future shape bug in the
    // walk (a `TypeError`, not just the overflow) reads as "discards" and
    // costs baselines silently instead of failing a test loudly. That is the
    // right direction for a security refusal, and the debug line below is
    // the compensation — name and shape only, like the capture's own catch,
    // never the message (which could carry template text).
    let discardsNonInertSubtree: boolean;
    try {
      discardsNonInertSubtree = resolveDiscardsNonInertSubtree(
        unresolvedProperties,
        conditions,
        template.Mappings
      );
    } catch (err) {
      logger.debug(
        `observed-baseline discard walk failed for imported ${logicalId} (${resource.resourceType}): ${err instanceof Error ? err.name : typeof err} — refusing the baseline fail-closed.`
      );
      discardsNonInertSubtree = true;
    }
    if (
      rawOpeners === undefined ||
      persistedOpeners === undefined ||
      // ARM 2 — the resolve SUCCEEDED but LOST an opener, which a downgraded
      // `Fn::If` does routinely.
      persistedOpeners < rawOpeners ||
      discardsNonInertSubtree
    ) {
      unsafeObservedBaselineLogicalIds.add(logicalId);
    }
  }

  return unsafeObservedBaselineLogicalIds;
}

/** The opener every dynamic reference starts with, secret-bearing or not. */
const DYNAMIC_REFERENCE_OPENER = '{{resolve:';

/**
 * How many dynamic-reference OPENERS a property bag carries, counted over its
 * JSON serialization rather than by walking string leaves — which is the whole
 * point on the RAW side: a token assembled by `Fn::Join` is SPLIT across array
 * elements, so `{{resolve:secretsmanager:` survives as a fragment that no scan
 * for a COMPLETE token would see. `secretValueFromJson` renders exactly that
 * shape, so the split form is the common one, not the exotic one.
 *
 * `undefined` when the bag cannot be serialized. Callers treat that as "cannot
 * vouch for this bag" rather than as zero — the only safe direction, since the
 * cost of a false refusal is a drift baseline and the cost of a false pass is a
 * plaintext secret in `state.json`.
 */
function countDynamicReferenceOpeners(bag: unknown): number | undefined {
  let text: string;
  try {
    text = JSON.stringify(bag ?? {}) ?? '';
  } catch {
    return undefined;
  }
  let count = 0;
  for (let from = 0; ;) {
    const at = text.indexOf(DYNAMIC_REFERENCE_OPENER, from);
    if (at === -1) return count;
    count++;
    from = at + DYNAMIC_REFERENCE_OPENER.length;
  }
}

/**
 * Whether an object key can make the resolver treat its object as an
 * INTRINSIC. Deliberately BROADER than the resolver's own dispatch list
 * (`resolveValue` names specific keys; this matches any `Fn::`-prefixed one):
 * the callers below use it to decide what a DISCARDED subtree could have
 * been, and over-matching there only widens a refusal, never a pass.
 */
function isIntrinsicShapedKey(key: string): boolean {
  return key === 'Ref' || key.startsWith('Fn::');
}

/**
 * Whether a subtree the resolve DISCARDED is provably INERT: pure JSON
 * literals, carrying no `{{resolve:` opener text in any string leaf and no
 * intrinsic-shaped object key anywhere.
 *
 * This is the capability question of issue
 * [#2850](https://github.com/go-to-k/cdkd/issues/2850) asked in the
 * fail-closed direction. Asking "could this subtree have carried or SOURCED a
 * dynamic reference" precisely would need enumerating every source a reference
 * can arrive from — a parameter `Default` via `Ref` or `Fn::Sub`, a `Mappings`
 * entry via `Fn::FindInMap`, another stack's outputs via `Fn::ImportValue` /
 * `Fn::GetStackOutput` — and the enumeration missing one form is exactly how
 * the opener COUNT missed the first two. Every one of those source forms is an
 * intrinsic, so "no intrinsic at all" covers them all without naming any, and
 * a plain-literal subtree is one whose value at deploy time was the same
 * public template text this walk can read.
 */
function isInertDiscardedSubtree(node: unknown): boolean {
  if (typeof node === 'string') return !node.includes(DYNAMIC_REFERENCE_OPENER);
  if (node === null || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.every((element) => isInertDiscardedSubtree(element));
  const record = node as Record<string, unknown>;
  // `{Ref: 'AWS::NoValue'}` is the ONE intrinsic that cannot have produced a
  // value at deploy time either — CloudFormation defines it as property
  // REMOVAL — so discarding it discards nothing AWS could hold. Without this
  // carve-out the walk refused the single most common `Fn::If` idiom
  // (`[Cond, <value>, {Ref: 'AWS::NoValue'}]`) whenever the condition held,
  // a pure false positive a review round measured (the matrix's NoValue row
  // pins it). Exact single-key match only: a `Ref` beside other keys is the
  // dispatch-order discard and stays non-inert.
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'Ref' && record['Ref'] === 'AWS::NoValue') return true;
  return Object.entries(record).every(
    ([key, value]) => !isIntrinsicShapedKey(key) && isInertDiscardedSubtree(value)
  );
}

/**
 * Whether a scalar the resolver consumes RAW (an `Fn::Select` index) is a
 * template-constant literal that `resolveSelect`'s `resolvedList[index]` read
 * actually honors: a number, or the CANONICAL digit-string of one. The
 * canonical form is load-bearing, not pedantry — a delta review round
 * measured `['a','b']['01']` as `undefined` (a non-canonical string is a
 * property name, not an index) while CloudFormation integer-parses it to 1,
 * so `'01'` is exactly as selection-divergent as an intrinsic index and must
 * not count as static. Anything non-static makes the selection depend on a
 * value this import cannot reproduce.
 */
function isStaticSelectIndex(value: unknown): boolean {
  // Non-negative on the number arm too (parent review): `resolveSelect`
  // treats a negative index as out-of-bounds and returns its placeholder,
  // discarding the WHOLE list — the string arm's regex already refuses
  // `'-1'`, and the two arms vouching for different shapes was the
  // asymmetry. cdkd deploys the same placeholder, but this predicate's job
  // is "the selection is a real, deploy-constant index", which a negative
  // never is.
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

/**
 * A `Fn::FindInMap` lookup-key argument the resolver can only have resolved
 * to the same key at deploy time: a plain scalar literal CARRYING NO
 * `{{resolve:` opener. The opener clause is the same delta-review finding one
 * helper up: `resolveFindInMap` resolves each key through `resolveValue`, so
 * a dynamic-reference STRING key is decrypted before the lookup and the
 * selected entry depends on the secret's deploy-time value — not on the
 * template text this walk reads.
 */
function isStaticLookupKey(value: unknown): boolean {
  if (typeof value === 'string') return !value.includes(DYNAMIC_REFERENCE_OPENER);
  return typeof value === 'number' || typeof value === 'boolean';
}

/**
 * ARM 3 of the observed-baseline refusal (issue
 * [#2850](https://github.com/go-to-k/cdkd/issues/2850)): did the resolve
 * DISCARD a subtree it cannot vouch is inert?
 *
 * The opener-count comparison (ARM 2) sees only what the raw bag SPELLS, and
 * the issue measured two ways past it on the success arm: a downgraded
 * `Fn::If` that drops one reference while a parameter-sourced reference is
 * added elsewhere (the totals balance), and a reference sourced ENTIRELY from
 * outside the bag then dropped (both counts read zero, nothing throws, no
 * warn fires). Both are DISCARD events: the resolver threw a subtree away
 * unresolved, and whatever that subtree would have produced — which is what
 * AWS actually holds when the deployed condition took the other branch — is
 * exactly what the persisted bag cannot position a redaction for.
 *
 * So this walk detects the discard EVENTS on the RAW bag instead of comparing
 * positions across the resolve (which would need a path identity across the
 * `Fn::If` collapse that does not exist). The discarders, enumerated from
 * `IntrinsicFunctionResolver` rather than assumed — and re-enumerated by this
 * PR's review round, which found the first cut had missed TWO (`Fn::FindInMap`
 * and `Fn::Select` below; an earlier revision called `resolveIf` "the only
 * LAZY selector" and the resolver's own source refutes it):
 *
 *  - `resolveIf` — a LAZY selector: it resolves the selected branch
 *    only, so the unselected branch is discarded UNRESOLVED. A missing
 *    condition warns and selects the FALSE branch (no throw), so the success
 *    arm reaches it. Dispatch is `'Fn::If' in obj`, not single-key.
 *  - `resolveFindInMap` — the OTHER lazy site: the 4-argument form's
 *    `DefaultValue` is resolved only on a lookup MISS, so a HIT discards it
 *    unresolved; and a non-literal lookup KEY makes the un-taken mapping
 *    entries discarded template content. The walk's own arm comment carries
 *    both modes.
 *  - `resolveSelect` — eager on the LIST but the INDEX is consumed RAW, never
 *    resolved: an intrinsic index selects `undefined` here while
 *    CloudFormation resolved it at deploy, so the whole list is potentially
 *    discarded content. (With a NUMERIC-LITERAL index the selection is
 *    template-constant and the un-selected elements were discarded at deploy
 *    too — that case discards nothing AWS could hold.)
 *  - Dispatch order itself — `resolveValue` dispatches on the first matching
 *    intrinsic key, so an object holding an intrinsic key AMONG OTHER KEYS
 *    resolves as that intrinsic and silently DROPS the sibling keys'
 *    subtrees.
 *  - NOT `Fn::Sub`: its variable map is resolved eagerly, every entry.
 *  - NOT `Fn::Join`'s delimiter: it is consumed raw too, but CloudFormation
 *    itself admits no intrinsic there, and an intrinsic delimiter joins as
 *    `[object Object]` — a mangled value, not a discarded reference.
 *
 * Fail-closed rules, in the order tested (an earlier revision of this list
 * omitted the two arms the review round added while still claiming to BE the
 * tested order — a list that claims an order and is not the order is worse
 * than no list, so keep it complete or delete the claim):
 *
 *  - an ARRAY recurses element-wise, so a discarder inside a list property
 *    (`SecurityGroupIds: [{Fn::If: ...}]`) is found;
 *  - single-key `Fn::If` with well-formed args and a condition the evaluated
 *    map carries (`Object.hasOwn`, the same test `resolveIf` uses since issue
 *    #2767): the UNSELECTED branch must be inert, and the SELECTED branch is
 *    recursed into;
 *  - single-key `Fn::If` whose condition the map does NOT carry: BOTH
 *    branches must be inert. The resolver warns and takes the false branch,
 *    so this is a SUPERSET of mirroring it — mirroring the lookup exactly is
 *    the two-spellings-of-one-question drift this repo keeps paying for, and
 *    the superset can only over-refuse, never leak;
 *  - single-key `Fn::If` with MALFORMED args: refuse;
 *  - single-key `Fn::FindInMap`: MALFORMED (< 3 args) refuses; a 4th
 *    argument must be inert AS A WHOLE (its `DefaultValue` is resolved only
 *    on a lookup miss, and any sibling key there — or a whole 4th arg with
 *    no `DefaultValue` key — is discarded unconditionally); a non-literal
 *    lookup key refuses unless the map in scope is inert (the NAMED map for
 *    a literal map name, the whole `Mappings` section otherwise); then the
 *    args recurse;
 *  - single-key `Fn::Select`: MALFORMED (not exactly 2 args) refuses; a
 *    non-static index refuses unless the list argument is inert; then the
 *    args recurse;
 *  - a MULTI-KEY object carrying intrinsic-shaped keys: TWO or more such
 *    keys refuse outright (dispatch drops the losers as whole INTRINSICS,
 *    whose values' text is not evidence of what they pull); with exactly
 *    one, every value must be inert — which sibling the dispatch order
 *    drops is deliberately not mirrored here;
 *  - everything else recurses, so a nested `Fn::If` inside an `Fn::Join` /
 *    `Fn::Sub` argument is still found.
 *
 * Additive beside ARM 1 (throw) and ARM 2 (count loss): refusal strictly
 * widens, so no previously-refused shape can start leaking, and the risk
 * direction is over-refusal alone. The negative controls live in the matrix:
 * an `Fn::If` discarding pure literals stays ADMITTED, and so does a
 * multi-key intrinsic object whose sibling values are literals.
 *
 * THE CALLER WRAPS EVERY CALL IN A FAIL-CLOSED try (see the ARM 3 note at
 * the call site): this walk recurses synchronously and a deep-enough bag
 * overflows the call stack where the JSON.stringify arms still compute.
 */
function resolveDiscardsNonInertSubtree(
  node: unknown,
  conditions: Record<string, boolean>,
  mappings: unknown
): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    return node.some((element) => resolveDiscardsNonInertSubtree(element, conditions, mappings));
  }
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'Fn::If') {
    const args = record['Fn::If'];
    if (!Array.isArray(args) || args.length !== 3 || typeof args[0] !== 'string') {
      return true;
    }
    const [conditionName, valueIfTrue, valueIfFalse] = args as [string, unknown, unknown];
    if (!Object.hasOwn(conditions, conditionName)) {
      return !isInertDiscardedSubtree(valueIfTrue) || !isInertDiscardedSubtree(valueIfFalse);
    }
    const selected = conditions[conditionName] ? valueIfTrue : valueIfFalse;
    const discarded = conditions[conditionName] ? valueIfFalse : valueIfTrue;
    if (!isInertDiscardedSubtree(discarded)) return true;
    return resolveDiscardsNonInertSubtree(selected, conditions, mappings);
  }
  // `Fn::FindInMap` — TWO discard modes, both found by the PR's review round
  // (the enumeration below this walk's doc block originally called `resolveIf`
  // "the only LAZY selector", which the resolver's own source refutes):
  //
  //  - the 4-argument form's `DefaultValue` is resolved LAZILY, only when the
  //    lookup misses ("resolve it lazily only when we need to fall back to
  //    it", `resolveFindInMap`). A lookup that HITS at import discards the
  //    `DefaultValue` subtree UNRESOLVED — the exact `resolveIf` pattern —
  //    while the deployed stack may have MISSED (the keys were resolved from
  //    values this import does not hold) and AWS holds what the default
  //    resolved to. So a non-inert `DefaultValue` refuses regardless of which
  //    way this import's lookup went. (With ALL-LITERAL keys the hit/miss IS
  //    template-static and deploy-identical, so refusing there is a
  //    deliberate over-refusal — the fail-closed form is kept rather than
  //    re-deriving the lookup, a delta review round weighed and accepted it.)
  //  - a lookup KEY that is not a scalar literal makes WHICH mapping entry
  //    was selected depend on a value this import cannot reproduce, so the
  //    un-taken entries are discarded template content. That matters exactly
  //    when the map holds something non-inert (a `{{resolve:` token — the
  //    Mappings grammar admits no intrinsics, but nothing enforces that on an
  //    imported template), so refuse on the pair: non-literal key AND
  //    non-inert map. The map checked is the NAMED one when the map name is a
  //    literal, the whole `Mappings` section when even that is dynamic.
  if (keys.length === 1 && keys[0] === 'Fn::FindInMap') {
    const args = record['Fn::FindInMap'];
    // Malformed in BOTH directions, like the `Fn::Select` arm below (parent
    // review round 2): `resolveFindInMap` destructures exactly four args and
    // IGNORES the rest, so a fifth argument is discarded WHOLE and unresolved
    // — the same class the 4th-argument check below closes — and judging it
    // by recursion alone admits a `{Ref: ...}` there.
    if (!Array.isArray(args) || args.length < 3 || args.length > 4) return true;
    if (args.length > 3) {
      // The WHOLE 4th argument must be inert, not just its `DefaultValue`
      // (parent review): `resolveFindInMap` reads ONLY that key, so a SIBLING
      // key's subtree there is discarded unconditionally — and a 4th arg with
      // no `DefaultValue` key at all (a typo'd one included) is discarded
      // WHOLE, since `hasDefaultValue` reads false and the lookup proceeds as
      // 3-arg. Judging the container instead of extracting one key covers
      // every one of those shapes with the same fail-closed question, and an
      // ordinary `{ DefaultValue: 'literal' }` is inert as a whole exactly
      // when its default is.
      if (!isInertDiscardedSubtree(args[3])) return true;
    }
    if (!args.slice(0, 3).every((key) => isStaticLookupKey(key))) {
      const scope =
        typeof args[0] === 'string' &&
        mappings !== null &&
        typeof mappings === 'object' &&
        Object.hasOwn(mappings as Record<string, unknown>, args[0])
          ? (mappings as Record<string, unknown>)[args[0]]
          : mappings;
      if (!isInertDiscardedSubtree(scope)) return true;
    }
    return args.some((arg) => resolveDiscardsNonInertSubtree(arg, conditions, mappings));
  }
  // `Fn::Select` consumes its index RAW — `resolveSelect` never resolves it,
  // so an intrinsic index selects `undefined` in cdkd while CloudFormation
  // RESOLVED it at deploy time. The list is resolved eagerly (every element
  // decrypted and recorded), but the un-selected elements are then discarded,
  // and with the maps dead by capture time the persisted bag cannot vouch for
  // what AWS holds at that position. A non-static index over a non-inert list
  // therefore refuses; over a pure-literal list every element AWS could hold
  // is public template text and the resource keeps its baseline.
  if (keys.length === 1 && keys[0] === 'Fn::Select') {
    const args = record['Fn::Select'];
    if (!Array.isArray(args) || args.length !== 2) return true;
    // A static index over a LITERAL list must also be IN BOUNDS (parent
    // review round 2): `resolvedList[999]` on a two-element list is
    // `undefined` — `resolveSelect` answers with its OutOfBounds placeholder
    // and the whole eagerly-decrypted list is discarded, the same class as a
    // negative index. Only a literal array's length is checkable statically;
    // an intrinsic list argument keeps the index-only test.
    const staticSelection =
      isStaticSelectIndex(args[0]) && (!Array.isArray(args[1]) || Number(args[0]) < args[1].length);
    if (!staticSelection && !isInertDiscardedSubtree(args[1])) return true;
    return args.some((arg) => resolveDiscardsNonInertSubtree(arg, conditions, mappings));
  }
  if (keys.length > 1 && keys.some((key) => isIntrinsicShapedKey(key))) {
    // TWO OR MORE intrinsic-shaped keys refuse OUTRIGHT (parent review):
    // dispatch order runs exactly one of them and drops the others as WHOLE
    // INTRINSICS — `{Ref: 'P', 'Fn::Sub': '${SecretRef}'}` discards the
    // `Fn::Sub`, whose VALUE is an opener-free string while its SEMANTICS
    // pull a parameter — so judging the dropped values' text is not evidence
    // there. With a single intrinsic key, the dropped siblings are plain
    // VALUES and the inertness question is the right one.
    if (keys.filter((key) => isIntrinsicShapedKey(key)).length > 1) return true;
    return !keys.every((key) => isInertDiscardedSubtree(record[key]));
  }
  return keys.some((key) => resolveDiscardsNonInertSubtree(record[key], conditions, mappings));
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

/**
 * `cdkd import`'s confirmation prompt. Its only call site is inside the
 * `if (!options.yes)` block above, which is what keeps `confirmOrRefuse`'s
 * non-interactive refusal (issue #2275) from firing on a `--yes` run.
 *
 * Exported for unit testing — internal to the command flow otherwise.
 */
export async function confirmPrompt(prompt: string): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    refusal:
      'The cdkd import confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass -y / --yes to confirm the state write, or run the command ' +
      'from a real terminal.',
  });
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
 * The empty secrets map the observed-capture redaction below passes. Shared
 * and module-level because `redactSecretsForState` only ever READS its map,
 * and because an empty one is not an oversight here but the POSITION-only
 * configuration the call site's note argues for — the same constant
 * `cdkd state refresh-observed` passes for the same reason.
 */
const NO_RECORDED_SECRETS: RecordedSecretValues = new Map();

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
 *
 * Exported for unit testing -- internal to the command flow otherwise. The
 * input-space matrix drives THIS function rather than replaying its
 * `redactSecretsForState` call by hand, so a change to the arguments it passes
 * cannot leave that fence green.
 *
 * Every captured bag is REDACTED before it lands on the record, and a resource
 * whose redaction POSITION SOURCE is unusable is skipped entirely — see the
 * call site's own note (issue
 * [#2828](https://github.com/go-to-k/cdkd/issues/2828)).
 */
export async function captureObservedForImportedResources(
  stackState: StackState,
  providerRegistry: ProviderRegistry,
  logger: ReturnType<typeof getLogger>,
  unsafeObservedBaselineLogicalIds: ReadonlySet<string>,
  rebuiltLogicalIds: ReadonlySet<string>
): Promise<void> {
  const entries = Object.entries(stackState.resources);
  if (entries.length === 0) return;

  await Promise.all(
    entries.map(async ([logicalId, resource]) => {
      // NO BASELINE where the position source cannot vouch for the readback
      // (issue #2828 review). The redaction below is POSITION-based — its only
      // evidence is that `resource.properties` SPELL the dynamic reference —
      // and `resolveImportedProperties` decides, per resource, whether they
      // still do; its doc block carries the rule and the two measured arms it
      // is drawn from. Where they do not, `redactSecretsForState` finds no
      // reference to substitute.
      //
      // WHAT HAPPENS NEXT DIFFERS BY ARM, and conflating them is what an
      // earlier revision of this sentence did. On the LOST-OPENER arm the
      // readback comes back UNCHANGED and the DECRYPTED value is persisted in
      // the clear -- that is the disclosure this skip exists to stop. On the
      // THROW arm the source leaf is typically a RAW intrinsic OBJECT against a
      // STRING readback, which since #2885 is an uncertified position and is
      // MASKED rather than persisted; the four `closedByMask` rows of the
      // refusal matrix exist to prove exactly that. The skip is still right for
      // both -- a masked baseline is a cost, not a fix -- but only the first
      // arm is a leak.
      //
      // The COST is not nothing, and saying so matters because the cheaper
      // reading invites someone to widen the skip. A resource skipped here
      // falls back to comparing `properties` — which on the throw arm are the
      // RAW intrinsics, so `cdkd drift` reports phantom drift on it where a
      // captured baseline would have been clean. That is a real (small)
      // regression, taken deliberately against a plaintext disclosure. The
      // throw arm now pays it for EVERY throwing resource, including ones with
      // no dynamic reference at all: narrowing it to "carries a reference" was
      // tried and leaked, because a reference can be sourced from a parameter
      // `Default` or a `Mappings` entry the raw bag never mentions.
      //
      // TWO MORE consumers, named rather than left to be discovered. This list
      // is the ones MEASURED, not a proof there are no others.
      //
      // BOTH ARE ABOUT THE SKIP, not about the mask #2885 introduced, and the
      // mask case is strictly bounded for them: each reads a field the mask
      // cannot occupy or cannot make worse -- `RetentionInDays` is NUMERIC and
      // {@link refuseUncertifiedSubtree} masks STRING leaves only, and for the
      // boolean-ish protection fields an ABSENT key (what the skip leaves) is
      // already the degraded read these bullets describe, so a masked string in
      // its place adds nothing. That is why they are stated once, here, rather
      // than repeated against the mask.
      //
      //  - `countProtectedResources` in `destroy-runner.ts` reads
      //    `observedProperties` as its fallback for `DeletionProtection` /
      //    `LoadBalancerAttributes`, so a refused resource whose protection was
      //    set OUT OF BAND is missing from the destroy prompt's protected
      //    count. Not data loss -- AWS still refuses the delete -- but the
      //    prompt under-reports.
      //  - `logGroupHasPositiveRetention` in `stateful-types.ts` reads it for
      //    `AWS::Logs::LogGroup`'s `RetentionInDays`, and that file's own doc
      //    names the import case as the reason it does. A refused LogGroup
      //    loses the `has-retention` fast path and its recreate prompt degrades.
      //
      // A THIRD cost, and the only one that can reach LIVE AWS: a refused
      // resource has raw `properties` and no baseline, so `cdkd drift --revert`
      // takes the RAW bag as its revert baseline and
      // `resolveStateSecretExpressions` re-resolves only `{{resolve:` STRINGS
      // -- an `Fn::Join` OBJECT walks through into `provider.update`. Issue
      // [#2855](https://github.com/go-to-k/cdkd/issues/2855); whether that
      // update fails loudly or corrupts silently is deliberately recorded there
      // as UNMEASURED rather than guessed at here.
      //
      // EVERY earned refusal in the input-space matrix is proved to have really
      // leaked -- that file asserts it row by row, and its count is the one that
      // holds. No count is repeated here: a previous revision stated one, it was
      // wrong, and this repo's rule is that a drifted count is DELETED rather
      // than recounted.
      //
      // "Lands with `observedProperties: undefined`" holds for a FRESHLY
      // imported record. It does NOT hold for one PRESERVED by a selective
      // merge: `buildStackState` copies `existingState.resources` wholesale, so
      // such a record keeps whatever baseline it already had — including a
      // pre-GHSA plaintext one — and the skip below then leaves that baseline
      // in place. `cdkd scrub` is the remedy, and issue
      // [#2872](https://github.com/go-to-k/cdkd/issues/2872) records the
      // narrow case where that is WORSE than not refusing.
      //
      // THE MISSING BASELINE USED NOT TO BE PERMANENT, AND THAT WAS THE
      // RESIDUE: the deploy-start auto-refresh and `cdkd state
      // refresh-observed` both fill a missing baseline against the record's
      // `properties`, which after a refusal can hold the wrong-branch LITERAL
      // the refusal distrusted — and neither writer holds the template
      // evidence this walk refused on, nor could it (issue
      // [#2944](https://github.com/go-to-k/cdkd/issues/2944)). So the refusal
      // is RECORDED on the state record below, in the only thing that survives
      // between this process and theirs: `observedBaselineRefused` (schema
      // v10+), whose type doc carries the full argument. Both writers skip a
      // marked record; a deploy that CREATEs or UPDATEs the resource clears
      // it, because that deploy holds the template evidence this walk lacked.
      // Schema v10+ (issue #2944), and THIS ARM IS THE FIFTH REFILL WRITER —
      // `cdkd import` itself, found by the adversarial review of the fix for
      // the other four rather than by the issue.
      //
      // `unsafeObservedBaselineLogicalIds` describes only what THIS run's
      // resolve could see. A record PRESERVED by a selective merge is seeded
      // from `existingState.resources` by `buildStackState` and is overwritten
      // only when a row re-imported it, so its `properties` are a PREVIOUS
      // run's downgraded output — a plain `dev-placeholder` literal. Re-solving
      // that literal trips no arm (no throw, openers 0 -> 0, nothing
      // discarded), so the id is absent from this run's set, and without this
      // gate the loop below would capture a readback positioned against it —
      // persisting the decrypted value, the byte-identical configuration the
      // `schema-v9-to-v10-migration` integ reproduces one command over — and
      // the `delete` further down would then LAUNDER the marker, standing the
      // other four writers down permanently.
      //
      // `rebuiltLogicalIds` is the discriminator the set cannot supply: the
      // rows this run actually imported, whose `properties` were rebuilt from
      // the template. A marked record OUTSIDE it keeps its marker and its
      // refusal; only a rebuilt one can earn a clear.
      const preservedRefusal =
        resource.observedBaselineRefused === true && !rebuiltLogicalIds.has(logicalId);
      if (preservedRefusal) {
        logger.debug(
          `observedProperties capture SKIPPED for preserved ${logicalId} (${resource.resourceType}): a previous 'cdkd import' run refused this record's baseline and this run did not re-import it, so its recorded properties are still the ones that refusal distrusted. Deploy a change to this resource to restore a baseline.`
        );
        return;
      }
      if (unsafeObservedBaselineLogicalIds.has(logicalId)) {
        // Set BEFORE the early return, and set on the record rather than
        // returned to the caller, because the caller hands this same object to
        // `saveState` — the set that drove the skip describes THIS run's
        // resolution and is discarded with it.
        resource.observedBaselineRefused = true;
        logger.debug(
          `observedProperties capture SKIPPED for imported ${logicalId} (${resource.resourceType}): the recorded properties no longer spell the template's dynamic reference, so they cannot position a redaction — capturing an AWS readback against them could persist a resolved secret in plaintext. Drift will compare against the recorded properties for this resource until the next successful deploy.`
        );
        return;
      }
      // Schema v10+ (issue #2944). CLEARED HERE, not on capture success, and the
      // difference is a defect a review round found: reaching this line already
      // means the record was REBUILT from the template this run AND this run's
      // resolve did not refuse it, which is exactly the evidence the marker was
      // waiting for. Gating the clear on the capture SUCCEEDING instead made it
      // a permanent brand for any resource whose provider has no
      // `readCurrentState`, whose readback came back `undefined`, or whose read
      // threw — their `properties` are this run's trustworthy resolution, yet
      // `drift --accept` / `--revert` would refuse them forever and only a
      // CREATE / UPDATE deploy could clear it. That contradicts the field's own
      // "refusal record, not a brand" contract.
      //
      // `delete` rather than `= undefined`: the field must be ABSENT from the
      // persisted JSON, which is what a reader tests.
      delete resource.observedBaselineRefused;
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
          // GHSA-p5qg-v9gv-hc7w (issue #2828), the `cdkd import` twin of the
          // `cdkd state refresh-observed` writer issue #1926 closed. The
          // readback is what AWS actually holds, so for a resource whose
          // template property is a `{{resolve:secretsmanager:...}}` reference —
          // or a `{{resolve:ssm:...}}` naming a `SecureString` — it is the
          // DECRYPTED value, and persisting it verbatim writes the plaintext
          // into `state.json`. This writer reached the redaction module along
          // NO path before this line, even though the sibling `properties`
          // walk in `resolveImportedProperties` (which runs BEFORE this one at
          // both call sites) has redacted since the original GHSA fix.
          //
          // The map is EMPTY by construction (`NO_RECORDED_SECRETS`): the
          // per-resource maps the resolve walk records into are scoped to that
          // walk, so POSITION is the whole mechanism here — exactly the
          // configuration `cdkd state refresh-observed` and the deploy's own
          // `drainObservedCaptures` persist under. `resource.properties` is
          // this record's own redacted bag, so where it holds the unresolved
          // expression, walking the observed bag against it rewrites the
          // plaintext AWS echoes back onto that expression with no secret fetch
          // and no value matching.
          //
          // "Where it holds" is deliberate. An earlier revision said the skip
          // above GUARANTEES it; it does not, and the WHAT CAN STILL GO WRONG
          // block on `resolveImportedProperties` lists the ways -- the
          // properties may hold a literal, or the walk may be unable to pair
          // the readback against them, with the skip never firing.
          //
          // `STATE_SOURCED_BASELINE_RULES` is the row this write site occupies
          // in `secret-redaction.ts`'s generation table ("observed walk,
          // own-record source"). The BASELINE constant, not the plain readback
          // one, because DESTINATION is what selects it and this writer has
          // exactly one: `observedProperties`, which is a drift BASELINE and
          // nothing else. `cdkd drift --accept` passes the other constant
          // because it writes its result into `properties` for a record with no
          // baseline, where a mask is a regression; that is not this site
          // (issue [#2885](https://github.com/go-to-k/cdkd/issues/2885), the
          // residue issue [#2852](https://github.com/go-to-k/cdkd/issues/2852)
          // left). What the mask costs, what it spares and what it masks are
          // `refuseUncertifiedSubtree`'s to document and are not repeated here.
          //
          // WHAT IS LOCAL is WHICH of this command's resources it can reach,
          // and the answer is a population DISJOINT from the skip above: that
          // one refuses a baseline outright, while this reaches a resource the
          // classifier ADMITS whose readback the position walk then cannot
          // pair. Such a resource keeps its record AND its baseline, with
          // `SECRET_MASK` at the leaves that could not be certified. No count
          // is given for either population, and the skip's own note one screen
          // up says why.
          //
          // The remedy for a masked leaf is a deploy that actually CREATES or
          // UPDATES that resource, not any `cdkd deploy`:
          // `kickOffAutoRefreshObservedProperties` skips a record whose
          // `observedProperties` is already defined, and a mask is defined.
          resource.observedProperties = redactSecretsForState(
            observed,
            NO_RECORDED_SECRETS,
            resource.properties ?? {},
            STATE_SOURCED_BASELINE_RULES
          );
        }
      } catch (err) {
        // NAME AND SHAPE, never the message. The sibling warn in
        // `resolveImportedProperties` masks with `maskSecretsInText`; that is
        // not available here, because the secrets map on this path is EMPTY by
        // construction, so there is no needle set to mask against. And the
        // message can carry a plaintext: `CloudControlProvider.readCurrentState`
        // does a bare `JSON.parse` on the resource model and rethrows, and V8
        // embeds an input snippet in a `SyntaxError` -- measured on node
        // v24.19.0, `JSON.parse('{"Password": SUPER-SECRET-abc}')` reports
        // `..."assword": SUPER-SECR"...`. So log what identifies the failure
        // without quoting the input, the way `parseResourceModel` already does.
        logger.debug(
          `observedProperties capture for imported ${logicalId} (${resource.resourceType}) failed: ${err instanceof Error ? err.name : typeof err} — drift will fall back to template properties for this resource until the next successful deploy.`
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
 *
 * THE REGION SEGMENT IS READ BACK, so it must be the CHILD's region and must
 * not be collapsed with the parent's (issue
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055)).
 * `nestedStackChildRegionFromLocalArn` in
 * [src/deployment/intrinsic-function-resolver.ts](../../deployment/intrinsic-function-resolver.ts)
 * parses this segment to learn which region to resolve a child's persisted
 * `{{resolve:...}}` output in — a secret NAME is regional, so resolving it in
 * the wrong region can answer with a DIFFERENT secret. Reading the child's own
 * state record instead is not an option: the region is part of that record's S3
 * key, so the lookup would be circular. That reader's doc block carries the
 * full rationale; this note exists because the value is produced HERE and the
 * next edit to the import walk would otherwise have nothing in front of it.
 *
 * Both call sites already pass a child-scoped value — the top-level walk passes
 * `targetRegion` (the stack being imported) and the recursive nested walk
 * passes `childRegion` — and parent and child region are necessarily equal
 * until cross-region nested stacks ship. The parameter is named `childRegion`
 * anyway, matching `NestedStackProvider.synthesizeArn`, so the requirement is
 * visible at the signature rather than only in prose.
 */
function synthesizeNestedStackArn(
  childRegion: string,
  accountId: string,
  parentStackName: string,
  logicalId: string
): string {
  return `arn:cdkd-local:${childRegion}:${accountId}:nested-stack/${parentStackName}/${logicalId}`;
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
 *      `importCommand`'s `try` / `finally`). This is the conventional
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
   * Threaded down the recursion so a CHILD's contention message names the same
   * bucket / profile the parent resolved. `cdkd force-unlock` re-resolves both
   * from the ambient profile otherwise, and a nested child never has a state
   * record to fall back on (issue #2170).
   */
  lockRecovery: LockRecoveryContext;
  /**
   * Issue #1002 PR 2 — §6 mapping table when the region is in cdkd-assets
   * mode. Each child template read below gets the §7 rewrite (nested
   * templates bypass the top-level rewrite in `importCommand`). Per issue
   * #1652 a snapshot is taken BEFORE that rewrite and is what feeds the
   * child's state write, so `state.properties` keeps the pre-rewrite values.
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
    // Issue #1652 — same PRE-rewrite state snapshot as the root walk: the
    // child's `state.properties` must carry the CDK-bootstrap asset values
    // AWS holds, so the next `cdkd deploy` produces the corrective UPDATE
    // instead of a `NO_CHANGE` that leaves the live child resources pointing
    // at the CDK bootstrap bucket forever.
    let childStateTemplate = childTemplate;
    if (assetRedirect) {
      childStateTemplate = structuredClone(childTemplate);
      const childRewritten = rewriteTemplateAssetReferences(childTemplate, assetRedirect);
      if (childRewritten > 0) {
        // Announced per CHILD, not only at the root. Under
        // `--migrate-from-cloudformation` the assets can live entirely in
        // nested children, in which case the root's count is 0 and no notice
        // would be printed at all — while the child states carry pre-rewrite
        // values and the next deploy shows UPDATEs the user was never warned
        // about.
        logger.info(
          `Note: ${childRewritten} asset reference(s) in nested stack ${childStackName} are ` +
            `recorded in state at their pre-rewrite (CDK bootstrap) values, so the next ` +
            `'cdkd deploy' repoints any resource that still holds them to cdkd asset storage.`
        );
      }
    }

    // Check the boolean (issue #2161): a bare `acquireLock` returns `false`
    // for a live foreign lock, which the discarded return treated as acquired,
    // so a nested-child import ran under contention and released the other
    // owner's lock via the `try` below. See the top-level import site above.
    const childAcquired = await lockManager.acquireLock(
      childStackName,
      childRegion,
      lockOwner,
      'import'
    );
    if (!childAcquired) {
      throw new Error(
        await buildLockContentionMessage({
          lockManager,
          stackName: childStackName,
          region: childRegion,
          subject: 'nested stack',
          recovery: args.lockRecovery,
        })
      );
    }
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
        childStateTemplate,
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
      // One budget for this child's resolve loop too; see the root call.
      const childUnsafeObservedBaselineLogicalIds = await withSharedDrainBudget(() =>
        resolveImportedProperties(
          childStackState,
          childStateTemplate,
          childRegion,
          stateBackend,
          logger
        )
      );
      await captureObservedForImportedResources(
        childStackState,
        providerRegistry,
        logger,
        childUnsafeObservedBaselineLogicalIds,
        // Issue #2944, same derivation as the top-level call site. A nested
        // child is built fresh on every recursive walk rather than merged, so
        // in practice every row is rebuilt — passing the set anyway keeps the
        // two call sites the same shape, so a future change to the child walk
        // cannot quietly acquire the preserved-record hazard.
        rebuiltLogicalIdsFrom(rows, childTemplate)
      );

      await stateBackend.saveState(childStackName, childRegion, childStackState);
      logger.info(
        `✓ Nested stack state written: ${childStackName} (${childRegion}) — ` +
          `${rows.filter((r) => r.outcome === 'imported').length} resource(s) imported.`
      );

      // Recurse into grandchildren. The recursive call acquires their
      // own locks; this child's lock stays held until its `finally`
      // releases it AFTER its descendants' locks are released (matches
      // the "leaves first, parent last" lock contract — descendants
      // release first, then this level, then the root in `importCommand`'s
      // outer `finally`).
      if (childTreeNode.nested.size > 0) {
        await importNestedStackChildrenRecursive({
          lockRecovery: args.lockRecovery,
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
