import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { isPasteableIdent, safeMsg } from '../../../utils/display-safe.js';
import {
  refuseMalformedResourcePropertiesForExport,
  refuseMalformedResourcesForExport,
} from '../../../state/malformed-resources-bag.js';
import { type Parameter } from '@aws-sdk/client-cloudformation';
import { withSharedDrainBudget } from '../../../deployment/drain-budget.js';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
} from '../../../state/lock-contention-message.js';
import { IntrinsicFunctionResolver } from '../../../deployment/intrinsic-function-resolver.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import { type TemplateFormat } from '../../yaml-cfn.js';
import { withPasteableAwsProfile } from '../../../utils/pasteable-aws-profile.js';
import { type ChangeSetUploadOpts, runTemplateUploadCleanup } from './changeset.js';
import {
  type CdkdStateStackTree,
  orphanCommandFor,
  quotedOrNotShown,
  quotedRegion,
  safeDetail,
} from './render.js';
import {
  buildPerStackImportNodes,
  cdkd2cfnStackName,
  flattenCdkdStateTreeLeafFirst,
} from './stack-tree.js';
import { CHILD_LOCK_RETRY_DELAY_MS, CHILD_LOCK_RETRY_MAX_ATTEMPTS } from './plan-types.js';
import {
  SsmChildParameterRefusalError,
  buildResolvedParametersPerStack,
  parameterValuesOf,
  ssmParameterReader,
} from './parameters.js';
import { blockedMigrationTail, buildImportPlan, groupBlockedReasons } from './import-plan.js';
import { preDeleteListingLines, preDeleteManualCommands } from './pre-delete.js';
import { assertCfnStackAbsent, awsStackNameArg, confirmPrompt } from './command-helpers.js';
import { type PerStackPlan, runPerStackImportPhases } from './per-stack-phases.js';

/**
 * Per-stack record of a successfully-IMPORTed stack within a
 * {@link runPerStackImportLoop} run. The orchestrator collects these as
 * each stack's phase-1 IMPORT completes so:
 *   - The next stack's iteration can adopt this stack as a nested
 *     reference via the recorded `cfnStackArn`.
 *   - On a mid-loop failure, the error message can name which stacks
 *     successfully moved to CFn (and whose cdkd state is therefore
 *     stale and should be cleared after the user resolves the failure
 *     cause).
 */
export interface ImportedStackRecord {
  /** cdkd state-key form (e.g. `MyApp~Database`). */
  cdkdStackName: string;
  /** CFn stack name actually submitted (post-`cdkd2cfnStackName` mapping or override). */
  cfnStackName: string;
  /** Full CFn stack ARN captured from `DescribeStacks` post-IMPORT. */
  cfnStackArn: string;
}

/**
 * Outcome of a {@link runPerStackImportLoop} invocation. Reflects whether
 * the run actually mutated AWS state, surfaced for the caller's logging.
 */
export interface PerStackImportLoopResult {
  outcome: 'success' | 'dry-run' | 'cancelled';
  importedStacks: ImportedStackRecord[];
}

/**
 * Caller-supplied dependencies for {@link runPerStackImportLoop}. Grouped
 * into one object so the orchestrator's signature stays readable even as
 * the dependency surface grows. Mirrors the
 * `prepareCloudFormationStackRetirement`-style dependency-injection shape.
 */
export interface RunPerStackImportLoopDeps {
  cfnClient: AwsClients['cloudFormation'];
  /**
   * Live-read seam for the identifier BACKFILL (issue #1791). Optional for the
   * same reason `buildImportPlan`'s is: a caller without one keeps the
   * state-only refusal.
   */
  ec2Client?: AwsClients['ec2'];
  /**
   * Reads a parent's SSM-typed Parameter that a nested child is passed
   * (go-to-k/cdkd#3915). REQUIRED, so a caller cannot drop it and leave such
   * a row to refuse; it is only called when a child row needs one.
   */
  ssmClient: AwsClients['ssm'];
  stateBackend: S3StateBackend;
  lockManager: LockManager;
  uploadOpts: ChangeSetUploadOpts;
  /** `process.env.USER@HOST:PID`-style lock-ownership tag for nested-child lock acquisition. */
  lockOwner: string;
}

/**
 * Caller-supplied option flags for {@link runPerStackImportLoop}. Mirrors
 * the `--dry-run` / `--yes` / `--include-non-importable` /
 * `--recreate-import-unsupported` shape of {@link exportCommand}'s own
 * CLI options, so the orchestrator can be invoked from a single call
 * site without duplicating option parsing.
 */
export interface RunPerStackImportLoopOptions {
  dryRun: boolean;
  yes: boolean;
  includeNonImportable: boolean;
  recreateImportUnsupported: boolean;
  /** See {@link ExportOptions.skipImportSupportPreflight}. Applies to every stack in the tree. */
  skipImportSupportPreflight?: boolean;
}

/**
 * Per-stack IMPORT loop driving `cdkd export` for nested-stack trees
 * (issue #464 PR B2). Submits one IMPORT changeset per cdkd-managed stack
 * in leaf-first order. For non-leaf parents, each `AWS::CloudFormation::Stack`
 * row in the parent's template is adopted as a nested reference via the
 * AWS-docs "Nest an existing stack" pattern: `DeletionPolicy: Retain` is
 * injected, the row's `TemplateURL` is rewritten to point at the just-IMPORTed
 * child stack's current template (fetched via `GetTemplate`), and the
 * row is added to `ResourcesToImport[]` with
 * `{ ResourceIdentifier: { StackId: <child-CFn-arn> } }`.
 *
 * The original "one atomic `--include-nested-stacks` IMPORT changeset"
 * design (#464 design doc §4.3 original) was empirically rejected by AWS:
 * `IncludeNestedStacks is not supported for changeSet type: IMPORT`. See
 * §4.0 of the design doc for the spike findings + per-stack loop rationale.
 *
 * Algorithm:
 *   1. Pre-flight (before any AWS mutation):
 *      - Build per-stack import plans from the tree.
 *      - Reject if any stack has blocked resources OR phase-2 non-importable
 *        resources without `--include-non-importable`.
 *      - Verify no CFn stack already exists under the resolved CFn name
 *        for any tree node.
 *      - Print the per-stack plan summary.
 *      - In `--dry-run`: return without acquiring locks or submitting
 *        changesets.
 *      - Prompt the user once for the whole tree migration (unless `--yes`).
 *      - Acquire per-non-root-child locks (root's lock is already held by
 *        `exportCommand`'s outer scope).
 *   2. Main loop, leaf-first across the tree. Per stack:
 *      - Build the filtered phase-1 template + `ResourcesToImport[]` array.
 *      - For non-leaf parents: per nested-stack row, fetch the child's
 *        current template via `GetTemplate`, upload to S3 (cleanup
 *        accumulated for the outer `finally`), inject Retain + rewrite
 *        TemplateURL, append to `ResourcesToImport[]` with
 *        `{ StackId: <child-arn> }`.
 *      - Submit IMPORT changeset via {@link submitImportChangeSet}.
 *      - Capture the resulting CFn stack ARN via `DescribeStacks` for
 *        the next parent iteration's reference.
 *      - Per-stack phase-2: pre-delete IMPORT-unsupported resources, then
 *        UPDATE changeset for Custom Resources (same shape as the
 *        flat-stack code path, just scoped to this stack).
 *   3. After all stacks IMPORTed: delete cdkd state leaf-first.
 *   4. Always (success AND failure paths):
 *      - Release per-non-root-child locks in reverse order.
 *      - Drain transient template uploads.
 *
 * Failure semantics: each per-stack IMPORT is independent. If leaf A
 * succeeds but parent B fails, A is a standalone CFn stack with A's cdkd
 * state DELETED, while B's cdkd state is PRESERVED. The error message
 * names which stacks moved + which remain. Re-running `cdkd export
 * <parent>` after the failure cause is fixed adopts A as a nested
 * reference (since A is now an existing CFn stack) — the per-stack loop
 * is idempotent in that direction.
 *
 * Exported for unit testing.
 */
export async function runPerStackImportLoop(args: {
  rootStackName: string;
  rootRegion: string;
  rootStackInfoNestedTemplates: Record<string, string>;
  rootTemplateFormat: TemplateFormat;
  tree: CdkdStateStackTree;
  rootTemplate: Record<string, unknown>;
  cfnStackNameOverrides: {
    /** Root cdkd stack name → CFn stack name (single, from `--cfn-stack-name`). */
    root?: string | undefined;
    /** Per-child cdkd stack name → CFn stack name (from `--cfn-child-stack-name`). */
    childMap: Map<string, string>;
  };
  rootParameters: Parameter[];
  deps: RunPerStackImportLoopDeps;
  options: RunPerStackImportLoopOptions;
  /**
   * Threaded from `exportCommand` so a per-child contention message names the
   * same bucket / profile the root resolved — `cdkd force-unlock` re-resolves
   * both from the ambient profile otherwise, and a nested child never has a
   * state record to infer its region from (issue #2170).
   */
  lockRecovery: LockRecoveryContext;
}): Promise<PerStackImportLoopResult> {
  const logger = getLogger();
  const {
    rootStackName,
    rootRegion,
    rootStackInfoNestedTemplates,
    rootTemplateFormat,
    tree,
    rootTemplate,
    cfnStackNameOverrides,
    rootParameters,
    deps,
    options,
  } = args;

  // Resolve cdkdName → CFn stack name. Root has its own override flag;
  // children fall back to cdkd2cfnStackName (replace `~` with `-`) unless
  // the user supplied `--cfn-child-stack-name`.
  const cfnStackNameOf = (cdkdName: string): string => {
    if (cdkdName === rootStackName) {
      return cfnStackNameOverrides.root ?? cdkd2cfnStackName(cdkdName);
    }
    return cfnStackNameOverrides.childMap.get(cdkdName) ?? cdkd2cfnStackName(cdkdName);
  };

  // Build per-stack template / state metadata for every tree node.
  const nodesByCdkdName = buildPerStackImportNodes(
    rootStackName,
    rootTemplate,
    rootStackInfoNestedTemplates,
    rootTemplateFormat,
    tree,
    args.lockRecovery
  );
  const leafFirst = flattenCdkdStateTreeLeafFirst(tree);

  // Sanity: every tree node must have a per-stack node entry.
  for (const n of leafFirst) {
    if (!nodesByCdkdName.has(n.stackName)) {
      throw new Error(
        `runPerStackImportLoop: missing per-stack template for ${quotedOrNotShown(n.stackName)} — ` +
          `tree node has cdkd state but no synth template was loaded. This is a cdkd bug.`
      );
    }
  }

  // Every node's `resources` bag must be a readable map before anything reads
  // it (issue #3188). `walkCdkdStateStackTree` returns a node whose bag is not
  // one CHILDLESS rather than throwing, so without this the subtree below it
  // would drop out of the migration; the refusal names the record instead of
  // leaving `buildImportPlan` to throw a bare `TypeError` on a `null` bag, or to
  // report every row as not deployed. It runs before the first AWS call and the
  // first per-child lock of the loop, but under the ROOT lock `exportCommand`
  // already holds on a real run; its `finally` releases that lock. The `properties` pass (go-to-k/cdkd#3315) rides the
  // same loop for the same reason: `buildImportPlan` reads every node's map.
  for (const n of leafFirst) {
    const meta = nodesByCdkdName.get(n.stackName)!;
    refuseMalformedResourcesForExport(
      meta.state,
      meta.cdkdStackName,
      meta.region,
      args.lockRecovery
    );
    refuseMalformedResourcePropertiesForExport(
      meta.state,
      meta.cdkdStackName,
      meta.region,
      args.lockRecovery
    );
  }

  // ---- Pre-flight: build per-stack plans + classify ----
  const perStackPlans: PerStackPlan[] = [];
  // Resolve every stack's IMPORT Parameters up front, ROOT-FIRST: a child's
  // intrinsic-valued Parameters (`{Ref: ParentParam}` /
  // `{Fn::GetAtt: [ParentResource, Attr]}`) resolve against its PARENT's
  // already-resolved Parameters + cdkd state — the opposite direction from the
  // leaf-first IMPORT order, so a separate top-down pre-pass is required (see
  // `buildResolvedParametersPerStack`). It runs BEFORE planning so the
  // IAM::Policy template check reads the very values each changeset submits,
  // from the one resolution (go-to-k/cdkd#3910): a second copy of it would
  // disagree with the resolver's lookup order and confirm a principal phase 2
  // does not use. `sessionIntrinsicSkipped` collects the Parameters that STILL
  // could not be resolved (resolver threw / unsupported shape), for the
  // per-stack warn + the aggregate summary at the end of the success path.
  // The root submits `rootParameters` verbatim.
  const paramResolver = new IntrinsicFunctionResolver(rootRegion);
  const resolveAll = (): Promise<{
    paramsByCdkdName: Map<string, Parameter[]>;
    intrinsicSkippedByCdkdName: Map<string, string[]>;
  }> =>
    // ONE drain budget for the resolve LOOP inside it (issue #2563): each
    // `resolve` in that loop can WAIT on a rejection.
    withSharedDrainBudget(() =>
      buildResolvedParametersPerStack({
        rootStackName,
        rootParameters,
        perStackNodes: leafFirst.map((n) => {
          const meta = nodesByCdkdName.get(n.stackName)!;
          return { cdkdName: meta.cdkdStackName, template: meta.template, state: meta.state };
        }),
        tree,
        resolver: paramResolver,
        stateBackend: deps.stateBackend,
        readSsmParameter: ssmParameterReader(deps.ssmClient),
      })
    );
  let resolved: Awaited<ReturnType<typeof resolveAll>>;
  try {
    resolved = await resolveAll();
  } catch (err) {
    // The pre-pass's STRUCTURAL refusals (a pre-v6 child record, one naming a
    // parent outside the tree) would otherwise end a dry run before its plan,
    // which it produced before the pre-pass moved ahead of planning. A dry run
    // warns and plans with no child values, so their principals read as
    // unconfirmed; a real run still refuses, since it would submit them. An
    // unreadable SSM-typed parent Parameter (go-to-k/cdkd#3915) takes the same arm.
    const message = describeAwsFailure(err).detail;
    const plannable =
      message.startsWith('buildResolvedParametersPerStack:') ||
      err instanceof SsmChildParameterRefusalError;
    if (!options.dryRun || !plannable) throw err;
    logger.warn(
      safeMsg`${message} --dry-run plans without the nested stacks' Parameter values; a real run ` +
        `refuses here.`
    );
    resolved = {
      paramsByCdkdName: new Map([[rootStackName, rootParameters]]),
      intrinsicSkippedByCdkdName: new Map(),
    };
  }
  const { paramsByCdkdName, intrinsicSkippedByCdkdName: sessionIntrinsicSkipped } = resolved;
  for (const [cdkdName, skipped] of sessionIntrinsicSkipped) {
    logger.warn(
      `  Child ${quotedOrNotShown(cdkdName)}: could not resolve intrinsic-valued Parameter(s) ` +
        `${skipped.map((n) => quotedOrNotShown(n)).join(', ')} at IMPORT time. The child ` +
        `template's Parameter Default ` +
        `values must cover these — otherwise CFn will reject the IMPORT.`
    );
  }

  for (const node of leafFirst) {
    const meta = nodesByCdkdName.get(node.stackName)!;
    const plan = await buildImportPlan(
      meta.state,
      meta.template,
      deps.cfnClient,
      meta.cdkdStackName,
      {
        recreateImportUnsupported: options.recreateImportUnsupported,
        // `=== true` not a spread: `RunPerStackImportLoopOptions` declares the
        // field optional, and `exactOptionalPropertyTypes` rejects an explicit
        // `undefined` for an optional target property.
        skipImportSupportPreflight: options.skipImportSupportPreflight === true,
        // Same reason for the conditional spread (issue #1791).
        ...(deps.ec2Client && { ec2Client: deps.ec2Client }),
        // `cdkd deploy` / `cdkd diff` take the app stack, never a child's
        // minted `Root~Child` name.
        rootStackName,
        parameterValues: parameterValuesOf(paramsByCdkdName.get(meta.cdkdStackName) ?? []),
        parametersFromCli: meta.cdkdStackName === rootStackName,
      }
    );
    if (plan.blocked.length > 0) {
      const lines = groupBlockedReasons(plan.blocked);
      throw new Error(
        // Not shown unless plain (`quotedOrNotShown`, go-to-k/cdkd#3950):
        // `meta.cdkdStackName` is `walkCdkdStateStackTree`'s minted
        // name carried one alias over, and this throw fires BEFORE
        // `cfnStackNameOf`, so that refusal does not backstop it. The message
        // is MULTI-LINE (`groupBlockedReasons` emits `  - <id> (<type>): ...`
        // rows), so a planted newline forges a blocked-resource row
        // (go-to-k/cdkd#3328 round 6).
        `Stack ${quotedOrNotShown(meta.cdkdStackName)} has ` +
          `${new Set(plan.blocked.map((b) => b.logicalId)).size} resource(s) that block ` +
          `migration:\n${lines.join('\n')}\n${blockedMigrationTail(plan.blocked)}`
      );
    }
    perStackPlans.push({
      cdkdName: meta.cdkdStackName,
      cfnName: cfnStackNameOf(meta.cdkdStackName),
      region: meta.region,
      template: meta.template,
      templateFormat: meta.templateFormat,
      state: meta.state,
      phase1Imports: plan.phase1Imports,
      phase2Creates: plan.phase2Creates,
      recreateBeforePhase2: plan.recreateBeforePhase2,
      nestedStackRows: plan.nestedStackRows,
    });
  }

  // Aggregate phase-2 totals for the include-non-importable gate.
  const totalPhase2Creates = perStackPlans.reduce((acc, p) => acc + p.phase2Creates.length, 0);
  const totalRecreate = perStackPlans.reduce((acc, p) => acc + p.recreateBeforePhase2.length, 0);

  // ---- Print the per-stack plan summary ----
  logger.info('');
  logger.info(
    `Migrating cdkd nested-stack tree rooted at ${quotedOrNotShown(rootStackName)} → CloudFormation ` +
      `(${perStackPlans.length} stack(s), leaf-first):`
  );
  for (const plan of perStackPlans) {
    logger.info(
      `  [${quotedOrNotShown(plan.cdkdName)}] → CFn stack ${quotedOrNotShown(plan.cfnName)}: ` +
        `${plan.phase1Imports.length} leaf import(s)` +
        (plan.nestedStackRows.length > 0
          ? `, ${plan.nestedStackRows.length} nested-child adoption(s)`
          : '') +
        (plan.phase2Creates.length > 0 ? `, ${plan.phase2Creates.length} phase-2 CREATE(s)` : '') +
        (plan.recreateBeforePhase2.length > 0
          ? `, ${plan.recreateBeforePhase2.length} pre-delete + re-CREATE`
          : '')
    );
    // Each pre-delete named, as the single-stack plan does: the tree-wide
    // confirmation below DELETES these between phases (go-to-k/cdkd#3857).
    for (const r of plan.recreateBeforePhase2) {
      for (const line of preDeleteListingLines(r)) logger.info(`    ${line}`);
    }
  }
  logger.info('');

  // ---- Include-non-importable gate (whole-tree) ----
  if (totalPhase2Creates > 0 && !options.includeNonImportable) {
    if (options.dryRun) {
      logger.warn(
        `${totalPhase2Creates} non-importable resource(s) (Custom::*) across the tree. ` +
          `A real run would require --include-non-importable for phase-2 CFn CREATE (re-invokes ` +
          `each Custom Resource's backing Lambda onCreate handler — ensure idempotent).`
      );
      logger.info('--dry-run: no CloudFormation changesets will be created.');
      return { outcome: 'dry-run', importedStacks: [] };
    }
    throw new Error(
      `${totalPhase2Creates} non-importable resource(s) (Custom::*) across the cdkd ` +
        `nested-stack tree. Pass --include-non-importable to run a per-stack 2-phase migration ` +
        `(phase 1 imports the importable resources for each stack; phase 2 CFn-CREATEs the ` +
        `non-importable ones per stack, which re-invokes each Custom Resource's onCreate ` +
        `handler — make sure those are idempotent). Or destroy the Custom Resources first.`
    );
  }

  // ---- Pre-flight: every CFn name in the tree must be free ----
  for (const plan of perStackPlans) {
    await assertCfnStackAbsent(deps.cfnClient, plan.cfnName);
  }

  // ---- Dry-run: return now (before any lock / AWS mutation) ----
  if (options.dryRun) {
    logger.info('--dry-run: no CloudFormation changesets will be created.');
    return { outcome: 'dry-run', importedStacks: [] };
  }

  // ---- Single tree-wide confirmation prompt ----
  if (!options.yes) {
    const phase2Note =
      totalPhase2Creates > 0
        ? ` Phase 2 will CREATE ${totalPhase2Creates} non-importable resource(s) across the tree.`
        : '';
    // As the single-stack prompt says it (go-to-k/cdkd#3910): the pre-deletes
    // are named in the plan above, and "AWS resources are unchanged" is not
    // true of them.
    const recreateNote =
      totalRecreate > 0
        ? ` cdkd will also DELETE ${totalRecreate} AWS resource(s) between phases so CFn can ` +
          `re-CREATE them in phase 2 (brief unavailability window — see the plan above for the ` +
          `affected resources, and for any marked as not confirmed to be re-created).`
        : '';
    const ok = await confirmPrompt(
      `Create ${perStackPlans.length} CloudFormation stack(s) by importing the cdkd ` +
        `nested-stack tree rooted at ${quotedOrNotShown(rootStackName)} (${quotedRegion(rootRegion)}) — ` +
        `leaf-first, per-stack IMPORT loop.` +
        phase2Note +
        recreateNote +
        (totalRecreate > 0
          ? ` All other AWS resources are unchanged.`
          : ` AWS resources are unchanged.`) +
        ` cdkd state for every adopted stack will be deleted on success.`
    );
    if (!ok) {
      logger.info('Migration cancelled. cdkd state and CloudFormation are unchanged.');
      return { outcome: 'cancelled', importedStacks: [] };
    }
  }

  // ---- Pre-acquire per-non-root-child locks (root's lock is already held) ----
  const acquiredChildLocks: Array<{ stackName: string; region: string }> = [];
  try {
    for (const node of leafFirst) {
      if (node.stackName === rootStackName) continue;
      // Retry briefly (≈30s ceiling) so a genuinely-active concurrent run is
      // awaited rather than failing the whole tree migration instantly; an
      // expired lock from a crashed previous run is auto-cleaned by
      // `acquireLock` (30-min TTL) on the first attempt. `acquireLockWithRetry`
      // throws (it does NOT return false) on terminal failure — wrap it to
      // preserve the actionable "no changeset submitted; state unchanged"
      // message + the force-unlock pointer.
      try {
        await deps.lockManager.acquireLockWithRetry(
          node.stackName,
          node.region,
          deps.lockOwner,
          'export',
          CHILD_LOCK_RETRY_MAX_ATTEMPTS,
          CHILD_LOCK_RETRY_DELAY_MS
        );
      } catch (err) {
        throw new Error(
          await buildLockContentionMessage({
            lockManager: deps.lockManager,
            stackName: node.stackName,
            region: node.region,
            subject: 'nested-stack child',
            heldClause: 'another cdkd process held it through the retry window',
            recovery: args.lockRecovery,
            suffix: 'No CloudFormation changeset has been submitted; cdkd state is unchanged.',
          }),
          { cause: err instanceof Error ? err : undefined }
        );
      }
      acquiredChildLocks.push({ stackName: node.stackName, region: node.region });
    }

    // ---- Main per-stack IMPORT loop ----
    const cfnArnByCdkdName = new Map<string, string>();
    const uploadCleanups: Array<() => Promise<void>> = [];
    const importedStacks: ImportedStackRecord[] = [];

    // What a failure of stack i leaves to do (go-to-k/cdkd#3910), shared by
    // every failure after the loop starts. `phase1`: stack i's own IMPORT
    // failed, so its CloudFormation stack may or may not exist; `imported`: it
    // exists, and its nested-child adoption has not happened
    // (go-to-k/cdkd#3967); `adopted`: it exists and needs only phase 2
    // (go-to-k/cdkd#3988); `phase2`: its pre-delete or phase 2 failed. A re-run
    // does not resume in any case; the stacks after i are untouched; and stack
    // i's cdkd record is cleaned up once it is finished by hand — never before,
    // since before its phase 2 that record is the only one of what phase 2
    // would create.
    const nestedResumeTail = (
      i: number,
      failed: 'phase1' | 'imported' | 'adopted' | 'phase2'
    ): string => {
      const plan = perStackPlans[i]!;
      const completed = perStackPlans.slice(0, i);
      const notYetImported = perStackPlans
        .slice(i + 1)
        // `quotedOrNotShown`, not the raw `safeSegment` (go-to-k/cdkd#4205
        // review): selecting the clause after `: ` ran a planted cdkd name.
        .map((p) => quotedOrNotShown(p.cdkdName))
        .join(', ');
      // One command per line of its own, and a withheld plan's note on the line
      // ABOVE its command (go-to-k/cdkd#3436): printing `.command` alone would
      // drop the note, and with it the "do not fill a leading-`-` name" rule.
      // In a LIST of both-hole lines "the next line's command" does not say
      // WHICH record, so the note names it by its CloudFormation stack name,
      // never by the withheld cdkd name. Only when that name is a PLAIN
      // identifier (it always is unless an override bypassed the CFn check):
      // `displayIdent`'s JSON quotes would still let a `$(...)` override run
      // in a pasted clause, so any other name is described, not printed —
      // `plainOrDescribed`'s rule, spelled out for this sentence's grammar.
      const orphanLines = (plans: readonly PerStackPlan[]): string =>
        plans
          .map((p) => {
            const orphan = orphanCommandFor(p.cdkdName, p.region, args.lockRecovery);
            const target = isPasteableIdent(p.cfnName)
              ? `CloudFormation stack ${p.cfnName}`
              : 'a CloudFormation stack whose name is not a plain identifier';
            const note = orphan.note ? `\n  For the record targeting ${target}:${orphan.note}` : '';
            return `${note}\n  ${orphan.command}`;
          })
          .join('');
      // The WHOLE tree is refused on a re-run: `assertCfnStackAbsent` checks
      // every stack's CloudFormation name up front. No backticks: pasted, they
      // would run the command they quote (go-to-k/cdkd#3988).
      const refusal =
        failed !== 'phase1'
          ? `Re-running cdkd export is refused for the whole tree: CloudFormation stacks now ` +
            `exist for this stack and every one IMPORTed before it. `
          : completed.length > 0
            ? `Re-running cdkd export is refused for the whole tree: CloudFormation stacks now ` +
              `exist for every stack IMPORTed before this one, and this stack's may exist too ` +
              `(a failed IMPORT can leave it behind). `
            : // Nothing was imported: only this stack's own CloudFormation stack, if
              // the failed IMPORT left one, stands in the way of a re-run.
              // A stack left mid-IMPORT can hold imported resources, and the
              // IMPORT template carries `DeletionPolicy: Delete`: deleting it
              // would delete them, so the check is printed, not just named.
              `No stack was imported. A failed IMPORT can leave CloudFormation stack ` +
              `${quotedOrNotShown(plan.cfnName)} behind, and a re-run is refused while ` +
              `it exists. Check that it holds no resources:\n  ${
                pasteableCommand(
                  withPasteableAwsProfile('aws cloudformation list-stack-resources'),
                  [awsStackNameArg(plan.cfnName)]
                ).command
              }\nthen delete it, and re-run with: ${
                pasteableCommand('cdkd export', [{ value: rootStackName, hole: 'stack' }]).command
              }\n`;
      if (failed === 'phase1' && completed.length === 0) return refusal.trimEnd();
      // Only the steps stack i still needs (go-to-k/cdkd#3988): a stack with
      // no phase-2 work is not told to run one.
      const hasPhase2 = plan.phase2Creates.length + plan.recreateBeforePhase2.length > 0;
      const steps = [
        ...(failed === 'phase1' ? ['IMPORT'] : []),
        ...(failed === 'imported' && plan.nestedStackRows.length > 0
          ? ['nested-child adoption']
          : []),
        ...(failed === 'phase2' || hasPhase2 ? ['phase 2'] : []),
        // A non-root stack must leave IMPORT_COMPLETE before its parent can
        // adopt it. A phase-2 UPDATE does that on its own; without one, every
        // IMPORT (its own, or its adoption of its children) leaves it there,
        // so the no-op tag update the loop would have run comes LAST.
        ...(plan.cdkdName !== rootStackName && failed !== 'phase2' && !hasPhase2
          ? [
              'closing no-op tag update (which moves it out of IMPORT_COMPLETE, for the adoption by its parent)',
            ]
          : []),
      ];
      // Phase 2 re-CREATEs the IMPORT-unsupported resources, which only a
      // delete makes room for: the pre-delete failure prints these deletes in
      // its head, and every earlier failure must print them here, before the
      // step that needs them (go-to-k/cdkd#3988).
      const preDeletes =
        failed !== 'phase2' && plan.recreateBeforePhase2.length > 0
          ? `Before this stack's phase 2, delete its IMPORT-unsupported resources by hand, ` +
            `which phase 2 re-CREATEs:\n` +
            preDeleteManualCommands(plan.recreateBeforePhase2)
              .map((line) => `  ${line}\n`)
              .join('')
          : '';
      return (
        refusal +
        // Stacks that finished phase 2 keep their cdkd state until the loop's
        // end, so both cdkd and CloudFormation now manage them; a later
        // `cdkd destroy` of the tree would delete live, CloudFormation-managed
        // resources.
        (completed.length > 0
          ? `These stacks finished phase 2 but still have cdkd state, which the export deletes ` +
            `only at its end — clean each up now, so a later cdkd destroy does not delete ` +
            `CloudFormation-managed resources:${orphanLines(completed)}\n`
          : '') +
        preDeletes +
        (steps.length === 0
          ? `This stack needs no further IMPORT, adoption or phase 2; clean up its record the same way:`
          : `Once this stack's ${steps.join(' and ')} ` +
            `${steps.length > 1 ? 'succeed' : 'succeeds'} by hand, clean up its record the ` +
            `same way` +
            // Its children finished as standalone stacks and wait for this
            // stack's Phase 1B adoption, which the by-hand IMPORT must do too.
            (failed === 'phase1' && plan.nestedStackRows.length > 0
              ? ` (its IMPORT must also adopt its already-imported nested children, per the AWS ` +
                `docs "Nest an existing stack" procedure)`
              : '') +
            `:`) +
        `${orphanLines([plan])}\n` +
        `Stacks not yet imported (still cdkd-managed): ${notYetImported || '(none)'}. ` +
        (notYetImported
          ? `cdkd export cannot migrate them now; do it by hand with CloudFormation IMPORT, ` +
            `adopting their nested children per the AWS docs "Nest an existing stack" ` +
            `procedure.`
          : '')
      );
    };

    try {
      return await runPerStackImportPhases({
        logger,
        args,
        deps,
        rootStackName,
        leafFirst,
        cfnStackNameOf,
        perStackPlans,
        paramsByCdkdName,
        sessionIntrinsicSkipped,
        cfnArnByCdkdName,
        uploadCleanups,
        importedStacks,
        nestedResumeTail,
      });
    } finally {
      // Drain transient template uploads. Each cleanup is best-effort:
      // the transient object lives under the `cdkd-migrate-tmp/` prefix
      // and can be reaped manually. CFn has already copied the child
      // templates into its own internal storage during CreateChangeSet,
      // so the S3 objects are no longer load-bearing after the loop.
      for (const cleanup of uploadCleanups) {
        await runTemplateUploadCleanup(cleanup, deps.uploadOpts.stateBucket);
      }
    }
  } finally {
    // Release per-non-root-child locks in reverse acquire order. The
    // outer `exportCommand` releases the root's lock in its own finally.
    for (let i = acquiredChildLocks.length - 1; i >= 0; i--) {
      const lock = acquiredChildLocks[i]!;
      await deps.lockManager.releaseLock(lock.stackName, lock.region).catch((err) => {
        logger.warn(
          `Failed to release lock for ${quotedOrNotShown(lock.stackName)} ` +
            `(${quotedRegion(lock.region)}): ${safeDetail(err)}`
        );
      });
    }
  }
}
