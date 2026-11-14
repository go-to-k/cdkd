import { parseContextOptions } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  legacyStateBucketFallbackRegion,
  resolveEffectiveRegion,
  stackRegionResolver,
} from '../../region-options.js';
import { Synthesizer, synthesisStatusMessage } from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
} from '../../../state/lock-contention-message.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { ensureAwsEmulatorStateBucket } from '../emulator-auto-bootstrap.js';
import { TemplateParser } from '../../../analyzer/template-parser.js';
import {
  resolveApp,
  resolveStateBucketWithDefault,
  resolveUseCdkBootstrapAssets,
} from '../../config-loader.js';
import {
  createAssetRedirectResolver,
  rewriteTemplateAssetReferences,
} from '../../../assets/asset-redirect.js';
import {
  getCloudFormationResourceTree,
  tryGetCloudFormationResourceMap,
  type CfnStackResourceTree,
} from '../retire-cfn-stack.js';
import {
  cdkdRemedy,
  commandHole,
  plainOrDescribed,
  proseQuoted,
  quotedOrDescribed,
} from '../../../utils/pasteable-command.js';
import { withPasteableAwsProfile } from '../../../utils/pasteable-aws-profile.js';
import { describeStack, renderNoStackMatch } from '../../stack-matcher.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import {
  refuseMalformedOutputs,
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedResourceEntriesForImport,
  refuseMalformedState,
} from '../../../state/malformed-resources-bag.js';
import { validateNestedStackShape } from './nested.js';
import {
  collectImportableResources,
  formatCfnOverrideMergeDetail,
  mergeCfnDerivedOverrides,
  parseResourceOverrides,
  stackShown,
} from './overrides.js';
import { runLockedImport } from './locked-import.js';
import type { ImportOptions } from './types.js';

export async function importCommand(
  stackArg: string | undefined,
  options: ImportOptions
): Promise<void> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
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

  // Region falls through CLI flag → env → profile → us-east-1, the same chain as deploy.
  // go-to-k/cdkd#2100: the profile's region when none is named, not a
  // `us-east-1` literal (`resolveEffectiveRegion`).
  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  const region = effectiveRegion.region;

  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  // go-to-k/cdkd#2100: the resolved region, explicitly. A region-less bag
  // follows the SDK's chain, which never reads AWS_DEFAULT_REGION, so it would
  // disagree with a region inferred from it.
  const awsClients = new AwsClients({
    region: effectiveRegion.region,
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  // Set when the target stack's region differs from the run's (a stack held
  // on us-east-1), destroyed with the command's clients.
  let targetClients: AwsClients | undefined;
  try {
    // go-to-k/cdkd#6186: under `--aws-emulator` only, create the state bucket
    // when the emulator has none (a no-op on real AWS), through the command's
    // own clients, as `cdkd deploy` does. Never under --dry-run, which creates
    // nothing. Both this and the resolution below run after the bag is set, so
    // the resolution's `getAwsClients()` is that bag (as in deploy), not a
    // region-less default one.
    if (!options.dryRun) {
      await ensureAwsEmulatorStateBucket({
        cliBucket: options.stateBucket,
        region,
        s3: awsClients.s3,
        sts: awsClients.sts,
      });
    }
    const stateBucket = await resolveStateBucketWithDefault(
      options.stateBucket,
      region,
      legacyStateBucketFallbackRegion(effectiveRegion)
    );
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
      failedLookupsCheckedByCaller: true,
    });

    // Stack selection: prefer explicit positional, otherwise auto-pick a single
    // stack when the assembly carries exactly one. Multi-stack assemblies must
    // disambiguate — imports are per-stack and ambiguity here is
    // worth a clear error rather than guessing.
    //
    // Both refusals go through the shared `renderNoStackMatch`. The zero-stack
    // check sits BEFORE the chain: with no argument the `else` arm would
    // otherwise answer `Multiple stacks found: .`.
    const stackPatterns = stackArg ? [stackArg] : [];
    if (result.stacks.length === 0) {
      throw new Error(renderNoStackMatch(stackPatterns, result.stacks));
    }
    let stackInfo;
    if (stackArg) {
      stackInfo = result.stacks.find((s) => s.stackName === stackArg || s.displayName === stackArg);
      if (!stackInfo) {
        // The shared message says "matching", while import matches EXACTLY:
        // say so when the argument carries
        // a star, or a Stage wildcard argument reads as contradicting the
        // list. (Spelled out in words: tests/unit/state lexes this file, and a
        // slash-star inside a line comment opens a block comment to it.)
        const exactOnly = stackArg.includes('*')
          ? ". cdkd import matches a stack name exactly, so '*' is not a wildcard here"
          : '';
        throw new Error(renderNoStackMatch(stackPatterns, result.stacks) + exactOnly);
      }
    } else if (result.stacks.length === 1) {
      stackInfo = result.stacks[0]!;
    } else {
      throw new Error(
        `Multiple stacks found: ${result.stacks.map(describeStack).join(', ')}. ` +
          `Specify the stack name as a positional argument.`
      );
    }
    // A failed context lookup blocks only the stack it imports into (go-to-k/cdkd#5807).
    refuseFailedLookups([stackInfo], result.stacks, result.failedLookups);
    // An env-agnostic stack takes the run's region, held on state the old
    // us-east-1 default wrote (go-to-k/cdkd#2100) so a re-import does not
    // write a second record beside the existing one.
    const targetRegion = await stackRegionResolver({
      effective: effectiveRegion,
      probe: stateBackend,
      logger,
      siblings: result.stacks.filter((s) => !s.region).map((s) => s.stackName),
    })(stackInfo.stackName, stackInfo.region);

    logger.info(`Target stack: ${stackInfo.stackName} (${targetRegion})`);

    // The providers look resources up in the region the state is written
    // under (go-to-k/cdkd#2100): a stack held on us-east-1 must not search the
    // profile's region for names built for us-east-1, nor adopt a same-named
    // resource there. Providers capture their clients when they are
    // registered, so the registry is built AFTER the clients are pointed.
    if (targetRegion !== effectiveRegion.region) {
      targetClients = new AwsClients({
        region: targetRegion,
        ...(options.profile && { profile: options.profile }),
      });
      setAwsClients(targetClients);
      process.env['AWS_REGION'] = targetRegion;
      process.env['AWS_DEFAULT_REGION'] = targetRegion;
    }
    const regionClients = targetClients ?? awsClients;
    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry, providerClasses);

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
          `Use plain ${proseQuoted(cdkdRemedy('cdkd import', '--dry-run'), '`')} to preview the import in isolation.`
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
        regionClients.cloudFormation
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
        // Null-prototype on the ABSENT arm too (issue go-to-k/cdkd#3480): this
        // is the bag `validateNestedStackShape` tests with
        // `if (!nestedTemplates[id])`, which on a `{}` fallback reads an
        // inherited member for a row named `toString` and skips the refusal.
        stackInfo.nestedTemplates ?? nullPrototypeRecord<string>()
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
          // cdkd-profile-display: `withPasteableAwsProfile` prints the profile
          // only when it holds no shell-active character, else a quoted hole.
          'STS GetCallerIdentity returned no Account — cdkd needs the account ID to ' +
            'synthesize cdkd-local ARNs for nested-stack rows. Verify the active AWS ' +
            `credentials are valid (e.g. \`${withPasteableAwsProfile('aws sts get-caller-identity')}\`).`
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
        regionClients.cloudFormation
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
    // `lockRecovery` qualifies each refusal's pasteable commands with this
    // run's account flags (go-to-k/cdkd#3909).
    if (existingState) {
      refuseMalformedState(existingState, stackInfo.stackName, targetRegion, lockRecovery);
    }
    // The ROWS of that map, in SELECTIVE mode only, and only the rows this
    // merge does NOT re-import (go-to-k/cdkd#3202). A selective merge starts
    // from `{ ...existingState.resources }` and saves every row it did not
    // re-import AS IT STANDS, so a `null` or typeless row is carried into the
    // record this command writes and met by the next deploy or destroy
    // instead. A row NAMED by `--resource` / `--resource-mapping` is replaced
    // by `buildStackState` from the provider's answer — `cdkd import S
    // --resource Bad=<id> --force` IS the repair of a broken `Bad` row — so
    // those ids are subtracted. Whole-stack and `--migrate-from-cloudformation`
    // imports REPLACE the map from the template, which makes them a way OUT of
    // such a record, so they are deliberately not refused — the rule
    // go-to-k/cdkd#3159 set: a refusal must not close a recovery route. The
    // shared text holds here: the lock is taken below, after this check, and no
    // AWS resource has been read.
    if (existingState && selectiveMode) {
      refuseMalformedResourceEntriesForImport(
        existingState,
        [...overrides.keys()],
        stackInfo.stackName,
        targetRegion,
        lockRecovery
      );
    }
    // The `outputs` bag takes the same answer and needs its own call — the one
    // above reads `resources` only, and a record can be malformed in either
    // container alone (go-to-k/cdkd#3192). This command CARRIES the bag into a
    // save (`outputs: existingState?.outputs ?? {}` in the state literal
    // below), so a `null` bag is laundered into a well-formed `{}` and the
    // record stops looking damaged; a string one is carried into a record the
    // exports index then republishes. AT THE LOAD, on the same line as the
    // resources refusal, so neither can drift below a read.
    if (existingState) {
      refuseMalformedOutputs(existingState, stackInfo.stackName, targetRegion, lockRecovery);
    }
    // The `orphans` CONTAINER, third call for the same reason (go-to-k/cdkd#3379).
    // This one does NOT launder: `orphansCarriedFrom` copies the stored value
    // verbatim into the save. What it would do instead is write a record every
    // other command then refuses — on the command the docs offer as a recovery
    // route after a failed deploy — and say nothing. Refusing here names the
    // container while the record can still be repaired.
    // The ROWS come with it, on the same argument (go-to-k/cdkd#3500):
    // `orphansCarriedFrom` copies them verbatim, so an unreadable row would be
    // written into the record this command saves and met by the next deploy
    // instead. Container first, matching the order every other reader here uses.
    // That order is NOT load-bearing and the comment says so rather than
    // inventing a reason: the row pass returns `[]` for a container that is not a
    // list, so either order refuses a non-list field through the container guard,
    // with the same text.
    if (existingState) {
      refuseMalformedOrphans(existingState, stackInfo.stackName, targetRegion, lockRecovery);
      refuseMalformedOrphanRecords(existingState, stackInfo.stackName, targetRegion, lockRecovery);
    }
    const existingEtag = existingResult?.etag;
    const migrationPending = existingResult?.migrationPending ?? false;

    if (existingState) {
      if (!selectiveMode) {
        // Auto / whole-stack: always destructive when state exists.
        if (!options.force) {
          // Carries `--force` and a `--resource` fragment, so the stack name
          // and region are shown only when plain and the fragment's holes are
          // quoted (go-to-k/cdkd#4226): both come from the cloud assembly, and
          // a bare `<physicalId>` redirects when pasted.
          throw new Error(
            `State already exists for ${stackShown(stackInfo.stackName)} (${plainOrDescribed(targetRegion, 'region')}). ` +
              `Auto / whole-stack import rebuilds the entire resource map from the template, ` +
              `which would drop any state entry not re-imported. Pass --force to confirm. ` +
              `To add specific resources without affecting unlisted ones, use ` +
              `--resource ${commandHole('id')}=${commandHole('physicalId')} (selective merge — no --force needed).`
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
          // Names `--force` and `--resource`, so each id is shown only when
          // plain (go-to-k/cdkd#4226).
          throw new Error(
            `Selective import would overwrite resource(s) already in state: ` +
              `${conflicts.map((id) => plainOrDescribed(id, 'logical id')).join(', ')}. ` +
              `Pass --force to confirm the overwrite, or remove these IDs from --resource / --resource-mapping.`
          );
        }
        const preservedCount = Object.keys(existingState.resources ?? {}).filter(
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
        // The line opens with the `--resource` flag, so the requested id, the
        // stack name and every template id listed are shown only when plain
        // (go-to-k/cdkd#4226): a planted `A$(touch OWNED)` id ran when pasted.
        throw new Error(
          `--resource / --resource-mapping references logical ID ${quotedOrDescribed(overrideId, 'logical id')} ` +
            `which is not in the synthesized template for ${stackShown(stackInfo.stackName)}. ` +
            `Available IDs: ${[...templateLogicalIds].map((id) => plainOrDescribed(id, 'logical id')).join(', ')}`
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
      return await runLockedImport({
        options,
        logger,
        stateBucket,
        lockRecovery,
        stateBackend,
        lockManager,
        stackInfo,
        targetRegion,
        regionClients,
        providerRegistry,
        assetRedirect,
        stateTemplate,
        overrides,
        migrationCfnStackName,
        template,
        templateParser,
        resources,
        templateLogicalIds,
        migrationTree,
        accountIdForNestedSynth,
        selectiveMode,
        existingState,
        existingEtag,
        migrationPending,
        owner,
      });
    } finally {
      await lockManager.releaseLock(stackInfo.stackName, targetRegion).catch((err) => {
        logger.warn(`Failed to release lock: ${describeAwsFailure(err).detail}`);
      });
    }
  } finally {
    targetClients?.destroy();
    awsClients.destroy();
  }
}
