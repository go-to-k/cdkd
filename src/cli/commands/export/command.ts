import { cdkdRemedy, pasteableCommand, proseQuoted } from '../../../utils/pasteable-command.js';
import { displayAwsMessage } from '../../../utils/display-safe.js';
import {
  refuseMalformedResourcePropertiesForExport,
  refuseMalformedResourcesForExport,
} from '../../../state/malformed-resources-bag.js';
import { parseContextOptions, warnIfDeprecatedRegion } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  legacyStateBucketFallbackRegion,
  resolveEffectiveRegion,
} from '../../region-options.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import { Synthesizer, synthesisStatusMessage } from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
} from '../../../state/lock-contention-message.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../../config-loader.js';
import { describeStack, renderNoStackMatch } from '../../stack-matcher.js';
import { type TemplateFormat } from '../../yaml-cfn.js';
import { type ExportOptions } from './plan-types.js';
import {
  assertCfnStackAbsent,
  confirmPrompt,
  parseTemplateFile,
  phase2RetryCommand,
  pickStackRegion,
  printNextSteps,
  refuseTransientContextIfUnsafe,
} from './command-helpers.js';
import {
  orphanCommandFor,
  plainOrNotShown,
  preDeletedLine,
  quotedOrNotShown,
  quotedRegion,
  recordValueOrNotShown,
  rowIdent,
} from './render.js';
import { blockedMigrationTail, buildImportPlan, groupBlockedReasons } from './import-plan.js';
import {
  parseParameterOverrides,
  resolveTemplateParameters,
  rootParameterValues,
} from './parameters.js';
import {
  buildCdkdStateStackTree,
  cdkd2cfnStackName,
  parseCfnChildStackNameOverrides,
} from './stack-tree.js';
import { reportDriftBaselineGaps } from './drift-baseline.js';
import {
  applyImportOverlayForPhase2,
  crossStackRefLine,
  filterTemplateForImport,
  injectDeletionPolicyForImport,
  printPlan,
  scanCrossStackReferences,
} from './template-overlay.js';
import { runPerStackImportLoop } from './per-stack-loop.js';
import { removeExportedStackRecord } from './per-stack-phases.js';
import {
  PRE_DELETE_HANDLERS,
  preDeleteListingLines,
  preDeleteManualCommands,
} from './pre-delete.js';
import { executeImportChangeSet, executeUpdateChangeSet } from './changeset.js';

export async function exportCommand(
  stackArg: string | undefined,
  options: ExportOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }

  warnIfDeprecatedRegion(options);

  // Gate transient context overrides. CLI `-c key=value` flags are
  // visible to cdkd's synth but NOT persisted to cdk.json /
  // cdk.context.json, so a subsequent `cdk deploy` would synthesize a
  // different template and CFn would replace or update resources.
  // Default-refuse forces the user to either move the overrides into
  // cdk.json (durable) or explicitly accept the risk with
  // `--accept-transient-context`. Done up front, before synth, so the
  // error message is the very first thing the user sees.
  refuseTransientContextIfUnsafe(options);

  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // go-to-k/cdkd#2100: the profile's region when none is named, not a
  // `us-east-1` literal (`resolveEffectiveRegion`).
  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  const region = effectiveRegion.region;
  const stateBucket = await resolveStateBucketWithDefault(
    options.stateBucket,
    region,
    legacyStateBucketFallbackRegion(effectiveRegion)
  );

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

  try {
    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    // Every contention message this command raises (top-level and per nested
    // child) points at the SAME lock object it was working on (issue #2170).
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

    // Synthesize the CDK app to get the template (or read a user-supplied
    // template file). cdkd state does not persist the original template
    // body, so synth is required even though we only inspect the cdkd
    // state for physical IDs.
    let template: Record<string, unknown>;
    let resolvedStackName: string;
    let synthedRegion: string | undefined;
    // The format we will re-emit the template in when we send phase-1 /
    // phase-2 changesets to CloudFormation. CDK synth always produces
    // JSON; the only path that can introduce YAML is `--template <path>`,
    // where we sniff the file content via the CFn-aware codec.
    let templateFormat: TemplateFormat = 'json';
    // Set when synth runs (not when --template is used). Captures all
    // stacks in the user's CDK app, used by the cross-stack consumer
    // scan to detect Fn::GetStackOutput references to the exporting
    // stack from sibling stacks.
    let allSynthStacks: Array<{ stackName: string; template: unknown }> = [];
    // Per-logical-id absolute paths to nested-stack child templates next to
    // the root stack's template in cdk.out. Populated from
    // `stackInfo.nestedTemplates`. Used by the per-stack IMPORT loop
    // (#464 PR B2) to recursively load every child template body; empty
    // for flat stacks AND for the `--template` path (the user-supplied
    // template file has no nested-template side cars cdkd could load).
    // Null-prototype from the DECLARATION, not only on the reassignment below
    // (issue go-to-k/cdkd#3480): this bag reaches `buildPerStackImportNodes`,
    // whose `if (!childTemplatePath)` guard would read an inherited
    // `Object.prototype` member for a child row named `toString` and skip the
    // out-of-sync refusal.
    let rootNestedTemplatePaths: Record<string, string> = nullPrototypeRecord<string>();

    if (options.template) {
      // User-supplied template path: still need a stack name to load state.
      if (!stackArg) {
        throw new Error(
          '--template requires a stack name as a positional argument to identify the cdkd state record.'
        );
      }
      const parsed = parseTemplateFile(options.template);
      template = parsed.template;
      templateFormat = parsed.format;
      resolvedStackName = stackArg;
    } else {
      const appCmd = options.app || resolveApp();
      if (!appCmd) {
        throw new Error(
          "'cdkd export' requires a CDK app (pass --app or set it in cdk.json) " +
            "OR a pre-rendered CFn template (--template '<path>')."
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

      // Both refusals go through the shared `renderNoStackMatch`, as in
      // `cdkd import`. The zero-stack check sits BEFORE the chain: with no
      // argument the `else` arm would otherwise answer
      // `Multiple stacks found: .`.
      const stackPatterns = stackArg ? [stackArg] : [];
      if (result.stacks.length === 0) {
        throw new Error(renderNoStackMatch(stackPatterns, result.stacks));
      }
      let stackInfo;
      if (stackArg) {
        stackInfo = result.stacks.find(
          (s) => s.stackName === stackArg || s.displayName === stackArg
        );
        if (!stackInfo) {
          // The shared message says "matching", while export matches
          // EXACTLY: say so when the argument
          // carries a star, or a Stage wildcard argument reads as
          // contradicting the list. Worded as import.ts words it.
          const exactOnly = stackArg.includes('*')
            ? ". cdkd export matches a stack name exactly, so '*' is not a wildcard here"
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
      // A failed context lookup blocks only the stack it exports (go-to-k/cdkd#5807).
      refuseFailedLookups([stackInfo], result.stacks, result.failedLookups);
      template = stackInfo.template as unknown as Record<string, unknown>;
      resolvedStackName = stackInfo.stackName;
      synthedRegion = stackInfo.region;
      // Null-prototype on the ABSENT arm too (issue go-to-k/cdkd#3480).
      rootNestedTemplatePaths = stackInfo.nestedTemplates ?? nullPrototypeRecord<string>();
      allSynthStacks = result.stacks.map((s) => ({
        stackName: s.stackName,
        template: s.template,
      }));
    }

    const cfnStackName = options.cfnStackName ?? resolvedStackName;
    const targetRegion = await pickStackRegion(
      stateBackend,
      resolvedStackName,
      synthedRegion,
      options.stackRegion
    );

    logger.info(
      `Migrating cdkd stack ${quotedOrNotShown(resolvedStackName)} (${quotedRegion(targetRegion)}) → CloudFormation stack ${quotedOrNotShown(cfnStackName)}`
    );

    // Refuse if a CFn stack with that name already exists. CFn IMPORT's
    // CreateChangeSet either creates a new stack (CHANGE_SET_TYPE=IMPORT
    // against a non-existent stack) or attaches imports to an existing
    // one; mixing the two cases silently would surprise users.
    await assertCfnStackAbsent(awsClients.cloudFormation, cfnStackName);

    // Load cdkd state for the target stack.
    const stateData = await stateBackend.getState(resolvedStackName, targetRegion);
    if (!stateData) {
      throw new Error(
        `No cdkd state found for stack ${quotedOrNotShown(resolvedStackName)} (${quotedRegion(targetRegion)}). ` +
          `Nothing to migrate.`
      );
    }
    const { state, etag, migrationPending } = stateData;
    // A record whose `resources` is not a readable map is refused HERE, by name,
    // rather than left to `buildImportPlan` below: a `null` or absent bag makes
    // its first `state.resources[logicalId]` read throw a bare `TypeError`, and
    // any other shape reads every row as "not deployed by cdkd" (issue #3188).
    // The nested tree's CHILD records get the same refusal in
    // `runPerStackImportLoop`, since the tree walk returns such a child
    // childless instead of throwing. Export's OWN text (go-to-k/cdkd#4181):
    // the shared one describes a save over the record, and export deletes it.
    const recordRegion = migrationPending ? undefined : targetRegion;
    refuseMalformedResourcesForExport(state, resolvedStackName, recordRegion, lockRecovery);
    // An entry whose `properties` map is not an object (go-to-k/cdkd#3315):
    // `buildImportPlan` and the phase-2 pre-delete read it through `?? {}`,
    // which lets a string, a list or a number through. At the LOAD, above
    // every read, as the module's placement rule asks.
    refuseMalformedResourcePropertiesForExport(
      state,
      resolvedStackName,
      recordRegion,
      lockRecovery
    );

    // Guard (issue #1183): a rollback journal means the stack is in a failed,
    // not-yet-reverted state. Exporting that half-deployed state to
    // CloudFormation is almost certainly unintended — warn and require
    // confirmation (or --yes), pointing at `cdkd rollback` / re-deploy first.
    const exportJournal = await stateBackend.loadRollbackJournal(resolvedStackName, targetRegion);
    if (exportJournal && exportJournal.segments.length > 0) {
      logger.warn(
        `Stack ${quotedOrNotShown(resolvedStackName)} has a rollback journal — a previous deploy failed or was ` +
          `interrupted and has not been reverted. Exporting this half-deployed state to ` +
          `CloudFormation is likely unintended; revert it first (or ${proseQuoted(cdkdRemedy('cdkd deploy'))} to fix ` +
          `forward).` +
          `\nRevert it with: ${
            pasteableCommand('cdkd rollback', [{ value: resolvedStackName, hole: 'stack' }]).command
          }`
      );
      if (!options.yes && !options.dryRun) {
        const proceed = await confirmPrompt('Export anyway?');
        if (!proceed) {
          logger.info('Export cancelled');
          return;
        }
      }
    }

    // Build the import plan BEFORE acquiring the lock: cdkd state × template
    // resources, classified into phase1 (importable) / phase2 (Custom::* CFn
    // will CREATE) / recreateBeforePhase2 (IMPORT-unsupported, pre-delete +
    // CFn CREATE in phase 2) / nestedStackRows (AWS::CloudFormation::Stack —
    // PR B1 detects, PR B2 submits) / blocked (anything else — aborts).
    //
    // Ordering (issue #1659): planning performs NO AWS write — it reads the
    // already-loaded state object plus `DescribeType` — so nothing here needs
    // the lock, and a stack that cannot be exported at all now says so without
    // first taking a lock that blocks concurrent `cdkd deploy` / `destroy`.
    // The nested-stack path has always planned before locking
    // (`runPerStackImportLoop` acquires per-child locks after its own
    // `buildImportPlan`); this makes the single-stack path agree.
    const { phase1Imports, phase2Creates, recreateBeforePhase2, nestedStackRows, blocked } =
      await buildImportPlan(state, template, awsClients.cloudFormation, resolvedStackName, {
        recreateImportUnsupported: options.recreateImportUnsupported,
        skipImportSupportPreflight: options.skipImportSupportPreflight,
        rootStackName: resolvedStackName,
        // The same resolution the changeset's parameters come from below.
        parameterValues: rootParameterValues(template, options.parameter),
        parametersFromCli: true,
        // Consulted only for a row cdkd state cannot answer for (issue #1791).
        // Same client family as `awsClients.cloudFormation` above, so the
        // region assumption is the one the whole command already makes.
        ec2Client: awsClients.ec2,
      });

    // `blocked` resources are genuinely unfixable (missing state, unknown
    // never-importable types, a type CFn refuses for IMPORT, etc.) — nothing
    // the user can do at runtime resolves them. Hard-fail in both dry-run and
    // real-run paths; printing the plan here is unhelpful because there is no
    // path forward.
    if (blocked.length > 0) {
      logger.error('The following resources block migration:');
      for (const line of groupBlockedReasons(blocked)) {
        logger.error(line);
      }
      throw new Error(
        `${new Set(blocked.map((b) => b.logicalId)).size} resource(s) block migration. ` +
          blockedMigrationTail(blocked)
      );
    }

    // Acquire the lock before any AWS write. Dry-run skips the lock so it
    // is a pure read.
    //
    // `acquireLock` returns `false` (rather than throwing) when another
    // live, non-expired lock holder exists. EVERY cdkd write command checks
    // that return value since issue #2161 — export was simply the first,
    // because it is uniquely irreversible: once the CFn IMPORT changeset
    // executes and cdkd state is deleted, there is no backing out. Do not
    // read this comment as licence to discard the boolean elsewhere.
    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    if (!options.dryRun) {
      const acquired = await lockManager.acquireLock(
        resolvedStackName,
        targetRegion,
        owner,
        'export'
      );
      if (!acquired) {
        throw new Error(
          await buildLockContentionMessage({
            lockManager,
            stackName: resolvedStackName,
            region: targetRegion,
            recovery: lockRecovery,
          })
        );
      }
    }

    try {
      // Nested-stack rows (issue #464 PR B2): full per-stack IMPORT loop.
      // The orchestrator handles the entire cdkd → CFn migration for the
      // whole tree: leaf-first IMPORT changesets, child-ARN adoption via
      // the AWS-docs "Nest an existing stack" pattern, per-stack phase-2
      // UPDATE for Custom Resources, leaf-first state cleanup, and
      // per-child lock acquisition / release. See `runPerStackImportLoop`
      // for the algorithm + design §4.3 for the AWS-side constraint that
      // ruled out the original single-atomic-changeset design.
      if (nestedStackRows.length > 0) {
        // Pass the already-loaded `state` to skip the redundant
        // root-state fetch — the orchestrator just read it at line ~770.
        const nestedStackTree = await buildCdkdStateStackTree(
          resolvedStackName,
          targetRegion,
          stateBackend,
          state,
          lockRecovery
        );

        // Run the same drift-baseline / cross-stack pre-flight the flat
        // path runs. For nested trees, only the root parent's outputs
        // are visible to sibling stacks (children are accessed via the
        // parent's `Outputs.<ChildLogicalId>` propagation, not directly),
        // so scanning the root is sufficient.
        reportDriftBaselineGaps(
          state,
          logger,
          {
            stackName: resolvedStackName,
            // A LEGACY record (`migrationPending`) was loaded from a key with no
            // region: `pickStackRegion` hands back the synth region only so the
            // legacy probe can run, and a command carrying it matches no record.
            region: migrationPending ? undefined : targetRegion,
          },
          options.template ? undefined : template,
          lockRecovery
        );
        if (allSynthStacks.length > 0) {
          const crossRefs = scanCrossStackReferences(allSynthStacks, resolvedStackName);
          if (crossRefs.length > 0) {
            const lines = crossRefs.map((r) => crossStackRefLine(r, resolvedStackName));
            if (options.strictCrossStack) {
              throw new Error(
                `Refusing to export: ${crossRefs.length} cross-stack reference(s) to ` +
                  `${quotedOrNotShown(resolvedStackName)} found in sibling stacks. After migration, those ` +
                  `references depend on the CloudFormation fallback (the migrated stack's ` +
                  `outputs live in CFn; cdkd resolves them via DescribeStacks after the ` +
                  `cdkd-state miss), and consumers deployed with --no-cfn-fallback break. ` +
                  `Migrate consumers first, or remove the references, or drop ` +
                  `--strict-cross-stack to proceed with a warning:\n` +
                  lines.join('\n')
              );
            }
            logger.warn(
              `${crossRefs.length} cross-stack reference(s) to ${quotedOrNotShown(resolvedStackName)} from ` +
                `sibling stacks. After the migration those consumers resolve this stack's ` +
                `outputs via the CloudFormation fallback (weak reference; the outputs now ` +
                `live in CFn) — they break only when deployed with --no-cfn-fallback. ` +
                `Migrate consumers from the leaves up if you rely on cdkd-state-only resolution.`
            );
            for (const line of lines) logger.warn(line);
          }
        }

        // Resolve root template Parameters once (forwarded to the root's
        // IMPORT changeset; children's Parameters are extracted per-stack
        // by the orchestrator from the parent's `Properties.Parameters`
        // block).
        const userParametersNested = parseParameterOverrides(options.parameter);
        const { parameters: rootParametersForNested, missing: missingNested } =
          resolveTemplateParameters(template, userParametersNested);
        if (missingNested.length > 0) {
          throw new Error(
            `Template requires parameter(s) without defaults: ${missingNested.map((n) => quotedOrNotShown(n)).join(', ')}. ` +
              `Pass each one as --parameter Key=Value (or set a Default in the CDK code).`
          );
        }

        const childOverrides = parseCfnChildStackNameOverrides(options.cfnChildStackName);
        const result = await runPerStackImportLoop({
          lockRecovery,
          rootStackName: resolvedStackName,
          rootRegion: targetRegion,
          rootStackInfoNestedTemplates: rootNestedTemplatePaths,
          rootTemplateFormat: templateFormat,
          tree: nestedStackTree,
          rootTemplate: template,
          cfnStackNameOverrides: {
            root: options.cfnStackName,
            childMap: childOverrides,
          },
          rootParameters: rootParametersForNested,
          deps: {
            cfnClient: awsClients.cloudFormation,
            ec2Client: awsClients.ec2,
            ssmClient: awsClients.ssm,
            stateBackend,
            lockManager,
            uploadOpts: {
              stateBucket,
              ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
            },
            lockOwner: owner,
          },
          options: {
            dryRun: options.dryRun,
            yes: options.yes,
            includeNonImportable: options.includeNonImportable,
            recreateImportUnsupported: options.recreateImportUnsupported,
            skipImportSupportPreflight: options.skipImportSupportPreflight,
          },
        });

        if (result.outcome === 'success') {
          // Compute the root's resolved CFn name with the same fallback the
          // orchestrator applied (override → cdkd2cfnStackName(rootName) →
          // identity for `~`-free root names). The outer `cfnStackName`
          // variable was set with the bare `resolvedStackName` fallback
          // (before nested-stack handling was added) so it can diverge
          // from what the orchestrator actually submitted; recompute here
          // so the next-steps banner names the stack the user can find
          // in the CFn console.
          const rootCfnNameForNextSteps =
            options.cfnStackName ?? cdkd2cfnStackName(resolvedStackName);
          printNextSteps({
            cfnStackName: rootCfnNameForNextSteps,
            cdkStackName: resolvedStackName,
            contextOverrides: options.context ?? [],
          });
        }

        // `migrationPending` and `etag` are state-bookkeeping fields the
        // outer scope deliberately references-and-discards (see the same
        // `void` pattern in the flat-stack path below).
        void etag;
        void migrationPending;
        return;
      }

      if (
        phase1Imports.length === 0 &&
        phase2Creates.length === 0 &&
        recreateBeforePhase2.length === 0
      ) {
        logger.warn('No resources to migrate — cdkd state is empty.');
        return;
      }
      if (phase1Imports.length === 0) {
        throw new Error(
          'No importable resources in the template. CloudFormation IMPORT changeset ' +
            'requires at least one importable resource for phase 1.'
        );
      }

      printPlan(phase1Imports, cfnStackName);
      if (phase2Creates.length > 0) {
        logger.info(`Phase 2 will CREATE ${phase2Creates.length} non-importable resource(s):`);
        for (const p of phase2Creates) {
          logger.info(`  ${rowIdent(p.logicalId)} (${rowIdent(p.resourceType)})`);
        }
        logger.info('');
      }
      if (recreateBeforePhase2.length > 0) {
        logger.info(
          `Phase 2 will also re-CREATE ${recreateBeforePhase2.length} ` +
            `IMPORT-unsupported resource(s) after cdkd deletes the AWS-side resource:`
        );
        for (const r of recreateBeforePhase2) {
          for (const line of preDeleteListingLines(r)) logger.info(`  ${line}`);
        }
        logger.info(
          '  Brief unavailability window per type (IAM::Policy: the inline ' +
            'policy is removed from each listed Role/User/Group between phases — any ' +
            'in-flight AWS API call that depends on the granted permission will fail until ' +
            'CFn re-CREATEs it in phase 2 from the template, whose principals cdkd has checked ' +
            'against the listed ones; a principal it could not confirm is marked). Pass ' +
            '--no-recreate-import-unsupported to block instead.'
        );
        logger.info('');
      }

      // `--include-non-importable` is a real-run safety gate (Custom Resource
      // onCreate re-invocation needs to be idempotent — see AGENTS.md). On
      // `--dry-run` we WARN instead of hard-erroring so the user sees the
      // full plan + the gate they'll need to flip for the real run. Erroring
      // out before printPlan defeats the point of dry-run.
      if (options.dryRun) {
        if (phase2Creates.length > 0 && !options.includeNonImportable) {
          logger.warn(
            `${phase2Creates.length} non-importable resource(s) detected (Custom::*). ` +
              `A real run (without --dry-run) would require --include-non-importable ` +
              `to run a 2-phase migration: phase 1 imports the importable resources; ` +
              `phase 2 CFn-CREATEs the non-importable ones (re-invoking each Custom ` +
              `Resource's backing Lambda onCreate handler — make sure those are idempotent).`
          );
        }
        logger.info('--dry-run: no CloudFormation changeset will be created.');
        return;
      }

      // Real run: hard error on missing --include-non-importable so the user
      // explicitly opts into the CR re-invocation semantics before phase 2
      // touches AWS.
      if (phase2Creates.length > 0 && !options.includeNonImportable) {
        logger.error('The following resources cannot be imported into CloudFormation:');
        for (const p of phase2Creates) {
          logger.error(
            `  - ${rowIdent(p.logicalId)} (${rowIdent(p.resourceType)}): CFn cannot import ` +
              `this type`
          );
        }
        throw new Error(
          `${phase2Creates.length} non-importable resource(s) detected (Custom::*). ` +
            `Pass --include-non-importable to run a 2-phase migration: phase 1 imports ` +
            `the importable resources; phase 2 CFn-CREATEs the non-importable ones ` +
            `(re-invoking each Custom Resource's backing Lambda onCreate handler — ` +
            `make sure those are idempotent). Or destroy these resources first.`
        );
      }

      if (!options.yes) {
        const phase2Note =
          phase2Creates.length > 0
            ? ` Phase 2 will then CREATE ${phase2Creates.length} non-importable resource(s) ` +
              `(invoking each Custom Resource's onCreate handler).`
            : '';
        const recreateNote =
          recreateBeforePhase2.length > 0
            ? ` cdkd will also DELETE ${recreateBeforePhase2.length} AWS resource(s) ` +
              `between phases so CFn can re-CREATE them in phase 2 (brief unavailability ` +
              `window — see plan above for the affected resources).`
            : '';
        // "AWS resources are unchanged on import" is the simple case. When
        // pre-delete is in play, that claim is false for the recreate-targets
        // (they're deleted then re-CREATEd; AWS resource ids stay the same
        // post-CREATE, but there's a brief window where they don't exist).
        // Use the more specific wording in that case.
        const unchangedClaim =
          recreateBeforePhase2.length > 0
            ? ` All other AWS resources are unchanged on import.`
            : ` AWS resources are unchanged on import.`;
        const ok = await confirmPrompt(
          `Create CloudFormation stack ${quotedOrNotShown(cfnStackName)} by importing ${phase1Imports.length} ` +
            `resource(s) from cdkd state ${quotedOrNotShown(resolvedStackName)} (${quotedRegion(targetRegion)})?` +
            phase2Note +
            recreateNote +
            unchangedClaim +
            ` cdkd state for ${quotedOrNotShown(resolvedStackName)} will be deleted on success.`
        );
        if (!ok) {
          logger.info('Migration cancelled. cdkd state and CloudFormation are unchanged.');
          return;
        }
      }

      // Drift baseline pre-flight. cdkd state schema v3 carries
      // `observedProperties` (the AWS-current snapshot at last
      // deploy / import), which is the baseline `cdkd drift` compares
      // against. If the baseline is missing — older state schemas or
      // resources written by providers without `readCurrentState` —
      // the user has no reliable way to verify the CDK template matches
      // AWS reality before the migration. Surface that as a warning so
      // they can re-run `cdkd state refresh-observed` first if drift
      // matters.
      reportDriftBaselineGaps(
        state,
        logger,
        {
          stackName: resolvedStackName,
          // See the nested-tree call above: a legacy record's key has no region.
          region: migrationPending ? undefined : targetRegion,
        },
        options.template ? undefined : template,
        lockRecovery
      );

      // Cross-stack consumer scan. After this stack moves to CFn, its
      // outputs live in CFn (not cdkd state). Since issue #1697 cdkd's
      // `Fn::GetStackOutput` resolver falls back to CloudFormation
      // `DescribeStacks` on a cdkd-state miss, so consumers keep
      // resolving by default — but the reference becomes
      // CFn-fallback-dependent, and consumers deployed with
      // `--no-cfn-fallback` break. Warn (or refuse with
      // --strict-cross-stack) when any sibling stack in the same CDK app
      // references this one. The scan only sees stacks in
      // `allSynthStacks` — when the user passes --template, we skip the
      // scan because we have no sibling templates.
      if (allSynthStacks.length > 0) {
        const crossRefs = scanCrossStackReferences(allSynthStacks, resolvedStackName);
        if (crossRefs.length > 0) {
          const lines = crossRefs.map((r) => crossStackRefLine(r, resolvedStackName));
          if (options.strictCrossStack) {
            throw new Error(
              `Refusing to export: ${crossRefs.length} cross-stack reference(s) to ` +
                `${quotedOrNotShown(resolvedStackName)} found in sibling stacks. After migration, those ` +
                `references depend on the CloudFormation fallback (the migrated stack's ` +
                `outputs live in CFn; cdkd resolves them via DescribeStacks after the ` +
                `cdkd-state miss), and consumers deployed with --no-cfn-fallback break. ` +
                `Migrate consumers first, or remove the references, or drop ` +
                `--strict-cross-stack to proceed with a warning:\n` +
                lines.join('\n')
            );
          }
          logger.warn(
            `${crossRefs.length} cross-stack reference(s) to ${quotedOrNotShown(resolvedStackName)} from ` +
              `sibling stacks. After the migration those consumers resolve this stack's ` +
              `outputs via the CloudFormation fallback (weak reference; the outputs now ` +
              `live in CFn) — they break only when deployed with --no-cfn-fallback. ` +
              `Migrate consumers from the leaves up if you rely on cdkd-state-only resolution.`
          );
          for (const line of lines) logger.warn(line);
        }
      }

      // Resolve template Parameters once (used by both phase 1 and phase 2).
      // Aborts here if the template has required parameters without
      // defaults that the user did not supply via --parameter.
      const userParameters = parseParameterOverrides(options.parameter);
      const { parameters: cfnParameters, missing } = resolveTemplateParameters(
        template,
        userParameters
      );
      if (missing.length > 0) {
        throw new Error(
          `Template requires parameter(s) without defaults: ${missing.map((n) => quotedOrNotShown(n)).join(', ')}. ` +
            `Pass each one as --parameter Key=Value (or set a Default in the CDK code).`
        );
      }

      // Phase 1: IMPORT changeset. CFn IMPORT requires DeletionPolicy on
      // every resource (AWS hard requirement). CDK-synth templates only
      // emit DeletionPolicy when the user sets RemovalPolicy explicitly,
      // so we inject DeletionPolicy: Delete on resources that lack the
      // attribute — matches what CFn would have applied as the type's
      // default if the user had deployed via plain CFn. See
      // injectDeletionPolicyForImport's docstring for the Retain-vs-Delete
      // rationale.
      const phase1Template = filterTemplateForImport(template, phase1Imports);
      const injectedCount = injectDeletionPolicyForImport(phase1Template);
      if (injectedCount > 0) {
        logger.info(
          `Injected DeletionPolicy: Delete on ${injectedCount} resource(s) without an ` +
            `explicit DeletionPolicy (required by CFn IMPORT — matches the CDK/CFn ` +
            `default for resources without RemovalPolicy).`
        );
      }
      await executeImportChangeSet(
        awsClients.cloudFormation,
        cfnStackName,
        phase1Template,
        phase1Imports,
        cfnParameters,
        templateFormat,
        {
          stateBucket,
          ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
        }
      );

      logger.info(
        `✓ Phase 1: CloudFormation stack ${quotedOrNotShown(cfnStackName)} created via IMPORT. ` +
          `${phase1Imports.length} resource(s) imported.`
      );

      // Pre-delete IMPORT-unsupported resources (currently just
      // AWS::IAM::Policy). These were skipped from phase 1
      // because AWS rejects them in IMPORT changesets. The synth template
      // still includes them, so phase-2 UPDATE will see them as new and
      // CFn will issue CREATE — but only AFTER we delete the AWS-side
      // resource here, or CFn's CREATE would collide with the
      // already-existing one. Failure here is fatal: cdkd state is intact
      // (release happens in outer finally) but a partial pre-delete may
      // leave AWS in a half-state — the recovery path is to fix the
      // underlying issue (permissions, AWS API throttling) and re-run
      // the export command. The lock prevents concurrent cdkd activity.
      if (recreateBeforePhase2.length > 0) {
        for (const entry of recreateBeforePhase2) {
          const handler = PRE_DELETE_HANDLERS[entry.resourceType];
          if (!handler) {
            throw new Error(
              `No pre-delete handler registered for ${plainOrNotShown(entry.resourceType)} ` +
                `(${plainOrNotShown(entry.logicalId)}). This is a cdkd bug — the resource is in ` +
                `IMPORT_UNSUPPORTED_RECREATABLE_TYPES but lacks a PRE_DELETE_HANDLERS entry. ` +
                `Phase 1 IMPORT already succeeded; cdkd state is intact. To recover, ` +
                `delete the AWS resource manually and run the phase 2 UPDATE.`
            );
          }
          logger.info(
            `Pre-deleting AWS resource for ${rowIdent(entry.logicalId)} ` +
              `(${rowIdent(entry.resourceType)}) ` +
              `so CFn can re-CREATE in phase 2...`
          );
          try {
            await handler(entry);
            logger.info(`  ${preDeletedLine(entry.physicalId)}`);
          } catch (err) {
            const msg = describeAwsFailure(err).detail;
            const orphan = orphanCommandFor(resolvedStackName, targetRegion, lockRecovery);
            throw new Error(
              `Phase 1 (IMPORT) succeeded; pre-delete of ${plainOrNotShown(entry.logicalId)} ` +
                `(${plainOrNotShown(entry.resourceType)}, physicalId: ${recordValueOrNotShown(entry.physicalId)}) failed: ` +
                `${displayAwsMessage(msg)}\n\n` +
                `The CloudFormation stack ${quotedOrNotShown(cfnStackName)} contains the phase-1 imports ` +
                `but the IMPORT-unsupported resources (${recreateBeforePhase2.length} total) ` +
                `still exist in AWS unmanaged. cdkd state is UNCHANGED. Re-running ` +
                `\`cdkd export\` does NOT work — the existing-stack check rejects it. ` +
                `To recover manually:\n` +
                `  1. Fix the failure cause (typically IAM permissions for the underlying ` +
                `AWS API — iam:Delete{Role,User,Group}Policy for an inline policy).\n` +
                `  2. Delete the remaining AWS-side IMPORT-unsupported resources by hand:\n` +
                preDeleteManualCommands(recreateBeforePhase2)
                  .map((line) => `       ${line}\n`)
                  .join('') +
                `     (one per entry in the pre-delete list logged above).\n` +
                `  3. Run the phase-2 UPDATE manually with the full synth template:\n` +
                `       ${phase2RetryCommand(cfnStackName)}\n` +
                `  4. Once phase 2 succeeds, clean up cdkd's stale state record.${orphan.note}\n` +
                `     Run: ${orphan.command}`
            );
          }
        }
      }

      // Phase 2: UPDATE changeset to add the non-importable resources via
      // CREATE. Skipped when there are none. A phase-2 failure leaves the
      // CFn stack in a partial state (phase 1 resources imported, phase 2
      // missing) and cdkd state intact so the user can recover manually
      // via `aws cloudformation update-stack` + `cdkd state orphan`.
      const phase2Count = phase2Creates.length + recreateBeforePhase2.length;
      if (phase2Count > 0) {
        try {
          // Apply the same conditional overlay to phase-2 that phase-1
          // applied, preserving symmetry — see
          // applyImportOverlayForPhase2's docstring for the rule (only
          // fires on literal-string mismatch, no-op for absent / intrinsic)
          // and PR #316 for the silent-REPLACE incident that surfaced the
          // symmetry requirement.
          const phase2Template = applyImportOverlayForPhase2(template, phase1Imports);
          await executeUpdateChangeSet(
            awsClients.cloudFormation,
            cfnStackName,
            phase2Template,
            cfnParameters,
            templateFormat,
            {
              stateBucket,
              ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
            }
          );
          const parts: string[] = [];
          if (phase2Creates.length > 0) {
            parts.push(`${phase2Creates.length} non-importable resource(s) CREATEd`);
          }
          if (recreateBeforePhase2.length > 0) {
            parts.push(`${recreateBeforePhase2.length} IMPORT-unsupported resource(s) re-CREATEd`);
          }
          logger.info(`✓ Phase 2: ${parts.join('; ')}.`);
        } catch (err) {
          const msg = describeAwsFailure(err).detail;
          const recreateNote =
            recreateBeforePhase2.length > 0
              ? `  - cdkd deleted ${recreateBeforePhase2.length} AWS resource(s) before ` +
                `phase 2 (Stage etc.). They are gone in AWS but absent from the CFn stack. ` +
                `Running phase 2 UPDATE manually will CFn-CREATE them fresh.\n`
              : '';
          const orphan = orphanCommandFor(resolvedStackName, targetRegion, lockRecovery);
          throw new Error(
            `Phase 1 (IMPORT) succeeded; phase 2 (UPDATE) failed: ${displayAwsMessage(msg)}\n\n` +
              `The CloudFormation stack ${quotedOrNotShown(cfnStackName)} now contains the imported ` +
              `resources but is missing ${phase2Count} resource(s) (${phase2Creates.length} ` +
              `Custom Resource(s) + ${recreateBeforePhase2.length} IMPORT-unsupported). ` +
              `cdkd state is UNCHANGED so you can inspect what's in it, but DO NOT run ` +
              `\`cdkd deploy\` against this stack (the imported resources are now ` +
              `CFn-managed). To recover:\n` +
              recreateNote +
              `  1. Fix the failure cause (typically an onCreate Lambda error).\n` +
              `  2. Re-run the phase 2 UPDATE manually with the full synth template:\n` +
              `       ${phase2RetryCommand(cfnStackName)}\n` +
              `  3. Once phase 2 succeeds, clean up cdkd's stale state record.${orphan.note}\n` +
              `     Run: ${orphan.command}`
          );
        }
      }

      // Delete cdkd state for the migrated stack. Done AFTER phase 2 so a
      // phase-2 failure leaves state intact for recovery (see catch above).
      // The lock is still held; we release it inside the outer `finally`.
      await removeExportedStackRecord(stateBackend, resolvedStackName, targetRegion, logger);
      logger.info(
        `cdkd state for ${quotedOrNotShown(resolvedStackName)} (${quotedRegion(targetRegion)}) removed. ` +
          `Manage the stack with 'cdk deploy' or 'aws cloudformation' from here on.`
      );

      // Print the load-bearing handoff message: the exact cdk diff / cdk
      // deploy commands the user should run next, including any -c
      // overrides captured from this export run.
      printNextSteps({
        cfnStackName,
        cdkStackName: resolvedStackName,
        contextOverrides: options.context ?? [],
      });

      // observedProperties / etag / legacy migration are no longer
      // relevant since the state record is gone. The local references
      // are kept just to make it explicit that we deliberately discarded
      // them.
      void etag;
      void migrationPending;
    } finally {
      if (!options.dryRun) {
        await lockManager.releaseLock(resolvedStackName, targetRegion).catch((err) => {
          logger.warn(`Failed to release lock: ${describeAwsFailure(err).detail}`);
        });
      }
    }
  } finally {
    awsClients.destroy();
  }
}
