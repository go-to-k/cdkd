import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import { bold, cyan, gray, green, red, yellow } from '../../../utils/colors.js';
import { CdkdError, DeployCancelledError } from '../../../utils/error-handler.js';
import {
  validateRecreateTargets,
  renderRecreateTargetsErrors,
  probeAndRevalidateStateful,
} from '../../../deployment/recreate-targets.js';
import { findReplacedReadersOfRecreateTargets } from '../../../deployment/recreate-target-readers.js';
import { promptRecreateConfirm } from '../recreate-confirm-prompt.js';
import {
  refuseMalformedResourceEntriesForDeploy,
  refuseMalformedResourcesForDeploy,
} from '../../../state/malformed-resources-bag.js';
import { toOutputValueString } from '../outputs-file.js';
import { findDownstreamConsumers } from '../recreate-downstream-consumers.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { DeploymentRunResult } from '../../../types/deployment-events.js';
import { startRunRecorder, recordRunOutcome, recordRunFailed } from '../deployment-events-run.js';
import { LockManager } from '../../../state/lock-manager.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../../provisioning/register-providers.js';
import { withNestedStackContext } from '../../../provisioning/nested-stack-context.js';
import { DeployEngine, type DeployEngineOptions } from '../../../deployment/deploy-engine.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import { resolveCaptureObservedState } from '../../config-loader.js';
import { createPrefixMigrationGate } from '../prefix-migration-check.js';
import { composeStateLoadedGates, crossPrefixEngineOptions } from '../cross-prefix-gate.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../types/state.js';
import { splitUpdatePartial } from './helpers.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { ConsoleLogger } from '../../../utils/logger.js';
import type { ProviderClasses } from '../../../provisioning/register-providers.js';
import type { ProducerLookup } from '../../../deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import type {
  DeploymentApprover,
  RequireApprovalLevel,
} from '../../../deployment/deploy-engine/options.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import type { CrossPrefixGuard } from '../../../state/stack-registry.js';
import type { AssetRedirectMap } from '../../../assets/asset-redirect.js';
import type { DagBuilder } from '../../../analyzer/dag-builder.js';
import type { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import type { ExportIndexStore } from '../../../state/export-index-store.js';
import type { StackOutputsByStack } from '../outputs-file.js';
import type { DeployCommandOptions } from './types.js';

/**
 * What `deployCommand` hands each stack's deploy: the run's options, shared
 * state infra and analyzers, and the two run-level counters it feeds.
 */
export interface DeployStackContext {
  providerClasses: ProviderClasses;
  logger: ConsoleLogger;
  options: DeployCommandOptions;
  baseRegion: string;
  stateConfig: { bucket: string; prefix: string };
  stateBucket: string;
  skipPrefix: boolean;
  refusalRecovery: LockRecoveryContext;
  crossPrefixGuard: CrossPrefixGuard;
  preflightStateBackend: S3StateBackend;
  stackRedirects: Map<StackInfo, AssetRedirectMap>;
  producerLookup: ProducerLookup;
  approveDeployment: DeploymentApprover | undefined;
  requireApproval: RequireApprovalLevel;
  dagBuilder: DagBuilder;
  diffCalculator: DiffCalculator;
  exportIndexStore: ExportIndexStore;
  accountId: string;
  outputsFile: string | undefined;
  stackOutputs: StackOutputsByStack;
  /** Adds a stack's unaddressed resources (and the cross-prefix part) to the run's totals. */
  addUnaddressed: (stackUnaddressed: number, crossPrefixKept: number) => void;
  /** Counts a stack that unwound through `DeployCancelledError`. */
  addCancelledStack: () => void;
  /** Every stack of this run, as `inRunStackKey` keys (go-to-k/cdkd#6088). */
  inRunStacks: ReadonlySet<string>;
}

/**
 * Deploys one stack inside its stack AWS scope: builds the stack's state
 * backend, lock manager, provider registry and engine, runs the pre-lock
 * `--recreate-via-*` checks, deploys, and prints the stack's summary.
 */
export async function deployStackInScope(
  ctx: DeployStackContext,
  stackInfo: StackInfo,
  stackRegion: string,
  stackAwsClients: AwsClients
): Promise<void> {
  const {
    providerClasses,
    logger,
    options,
    baseRegion,
    stateConfig,
    stateBucket,
    skipPrefix,
    refusalRecovery,
    crossPrefixGuard,
    preflightStateBackend,
    stackRedirects,
    producerLookup,
    approveDeployment,
    requireApproval,
    dagBuilder,
    diffCalculator,
    exportIndexStore,
    accountId,
    outputsFile,
    stackOutputs,
    addUnaddressed,
    addCancelledStack,
  } = ctx;
  const stateS3Client = new AwsClients({
    region: baseRegion,
    ...(options.profile && { profile: options.profile }),
  });
  const stackStateBackend = new S3StateBackend(stateS3Client.s3, stateConfig, {
    region: baseRegion,
    ...(options.profile && { profile: options.profile }),
  });
  // The release purge overlaps the events flush below rather than adding
  // a round trip to every deploy's tail.
  const stackLockManager = new LockManager(stateS3Client.s3, stateConfig, {
    deferReleasePurge: true,
  });
  const stackProviderRegistry = new ProviderRegistry();
  registerAllProviders(stackProviderRegistry, providerClasses);
  stackProviderRegistry.setCustomResourceResponseBucket(stateBucket);
  if (options.allowUnsupportedTypes?.length) {
    stackProviderRegistry.allowUnsupportedTypes(options.allowUnsupportedTypes);
  }
  // MERGED, not either-or. Commander derives the option name from the long
  // flag, so `--prefer-sdk-route` and its deprecated alias land on two
  // different properties — reading one would silently ignore the other, and
  // the one silently ignored would be whichever the user actually typed.
  const preferSdkRoute = [
    ...(options.preferSdkRoute ?? []),
    ...(options.allowUnsupportedProperties ?? []),
  ];
  if (preferSdkRoute.length) {
    stackProviderRegistry.allowUnsupportedProperties(preferSdkRoute);
  }

  // Issue [#808] — best-effort structured deployment-event recorder.
  // Skipped under --dry-run (no real run to record — startRunRecorder
  // returns undefined). The engine emits per-resource + rollback events
  // through it; this CLI emits the run-level RUN_STARTED (inside
  // startRunRecorder) / RUN_FINISHED and finalize()s in the finally
  // below. Failures are swallowed inside the store and never surface
  // here. Declared OUTSIDE the try so the catch / finally see it.
  const eventRecorder = startRunRecorder({
    backend: stackStateBackend,
    stackName: stackInfo.stackName,
    region: stackRegion,
    command: 'deploy',
    dryRun: options.dryRun,
  });
  // Tracks the terminal result for the recorder's index summary;
  // flipped to FAILED in the catch below.
  let runResult: DeploymentRunResult = 'SUCCEEDED';

  try {
    // Pre-flight migration check for --prefix-user-supplied-names.
    // When prefix-skipping is active AND the stack has existing state
    // with Pattern B resources whose physical id is still prefixed with
    // the stack name, cdkd's diff path will silently propose
    // REPLACEMENT on each of them. Surface this up front so the user
    // sees the side effect before any provider call runs. Honors
    // --yes / --force (the CLI is single-flagged via `options.yes`).
    // No-op when:
    //   - skipPrefix is false (legacy prefixing is opted back in)
    //   - state is empty (first-time deploy — nothing to migrate)
    //   - no Pattern B resource is still prefixed
    //
    // Runs as the engine's `onCurrentStateLoaded` gate (fired right
    // after the post-lock state read, before any provider call) rather
    // than as its own pre-lock `getState` of the same object — see
    // `createPrefixMigrationGate` for the full rationale.
    const migrationGate = createPrefixMigrationGate({
      stackName: stackInfo.stackName,
      skipPrefix,
      yes: options.yes,
    });
    const crossPrefix = crossPrefixEngineOptions({
      stackName: stackInfo.stackName,
      region: stackRegion,
      bucket: stateBucket,
      recovery: refusalRecovery,
      guard: crossPrefixGuard,
      backend: preflightStateBackend,
    });

    // Issue [#615] — validate `--recreate-via-cc-api <LogicalId>` (+
    // companion `--force-stateful-recreation`) against the synth
    // template + existing state. Surfaces every error category in
    // one block (typos / missing-state / ambiguous-intent with
    // --allow-unsupported-properties / stateful guard refusal) so
    // the user fixes them all in one cycle. Skipped when the flag
    // is absent (no list).
    // Issue [#2567] — the ids below are validated against THIS stack's
    // template + state + live probes, so they travel to the engine WITH
    // the stack name they were validated against: the option object is
    // spread into every nested child engine, and an id set with no stack
    // on it matched a child's colliding logical id too.
    let recreateTargets: DeployEngineOptions['recreateTargets'];
    if (options.recreateViaCcApi?.length || options.recreateViaSdkProvider?.length) {
      const stateForRecreateCheck = await stackStateBackend.getState(
        stackInfo.stackName,
        stackRegion
      );
      // The SAME two refusals the engine raises at its own state load, on
      // this pre-lock read of the same record (go-to-k/cdkd#3202). The
      // engine's load does not dominate this check: `validateRecreateTargets`
      // indexes the named rows itself, so a `null` row was reported as
      // "missing from state" — with a diagnostic telling the operator to
      // drop the flag for it, which leaves the resource un-recreated with
      // the broken row in place — and a typeless row reached the
      // confirmation prompt as `resourceType: undefined` before the engine
      // refused. Bag first: an unreadable bag has no rows to name.
      if (stateForRecreateCheck) {
        refuseMalformedResourcesForDeploy(
          stateForRecreateCheck.state,
          stackInfo.stackName,
          stackRegion,
          refusalRecovery
        );
        refuseMalformedResourceEntriesForDeploy(
          stateForRecreateCheck.state,
          stackInfo.stackName,
          stackRegion,
          refusalRecovery
        );
      }
      const syncValidation = validateRecreateTargets({
        template: stackInfo.template,
        state: stateForRecreateCheck?.state ?? {
          version: STATE_SCHEMA_VERSION_CURRENT,
          stackName: stackInfo.stackName,
          region: stackRegion,
          resources: {},
          outputs: {},
          lastModified: Date.now(),
        },
        recreateViaCcApi: options.recreateViaCcApi ?? [],
        recreateViaSdkProvider: options.recreateViaSdkProvider ?? [],
        allowUnsupportedProperties: new Set([
          ...(options.preferSdkRoute ?? []),
          ...(options.allowUnsupportedProperties ?? []),
        ]),
        forceStatefulRecreation: options.forceStatefulRecreation ?? false,
        // Reviewer caught: `hasProvider(rt)` returns true for ANY
        // routable type (SDK / Cloud Control / Custom Resource / escape-
        // hatch), so a Tier 2 CC-only type would slip past
        // `blockedNoSdkProvider` and the routing decision would silently
        // round-trip back to CC after the recreate. Ask the narrower
        // `getProviderType(rt) === 'sdk'` instead — true ONLY when a
        // dedicated SDK provider is registered for the type.
        hasSdkProvider: (rt) => stackProviderRegistry.getProviderType(rt) === 'sdk',
        // Issue #3887: the SAME predicate the routing layer refuses the
        // Cloud Control auto-route with, so a recreate is refused for
        // exactly the types Cloud Control cannot create.
        ccRouteUnavailableReason: (rt) => stackProviderRegistry.ccRouteUnavailableReason(rt),
      });
      // Issues [#648] / [#2558] — promote the two conditionally
      // stateful types whose sync reason is `null` (which means
      // DEFER for them, not "not stateful"): an `AWS::S3::Bucket`
      // to `'has-objects'` when the live bucket has at least one
      // object, an `AWS::Logs::LogGroup` to `'has-log-events'` when
      // it has at least one log stream. Both use the DEPLOY-region
      // clients (the user's bucket / log group lives in the stack's
      // deploy region, not the state bucket region). The S3 probe
      // soft-fails OPEN on permission denied / bucket-not-found; the
      // log-group probe fails CLOSED, because an unset retention is
      // CloudWatch's never-expire and an unprovable emptiness must
      // not read as empty. Both log a warn saying which happened.
      const validation = await probeAndRevalidateStateful({
        validation: syncValidation,
        clients: {
          s3: stackAwsClients.s3,
          cloudWatchLogs: stackAwsClients.cloudWatchLogs,
          // The region the recorded resources live in, for the same reason
          // `DeleteContext.expectedRegion` carries it: the log-group probe
          // reads a `ResourceNotFoundException` as "gone", and that is only
          // sound when the client is pointing where the state says the
          // resource is.
          expectedRegion: stateForRecreateCheck?.state.region,
          // The record's body named a region that is not its key's, so
          // that comparand cannot decide anything: `getState` normalized
          // the record to the key's region, which is what the clients are
          // built for, so the compare above would pass by construction
          // (issue #3328 review round 2). The probe must stay conservative
          // instead of reading a not-found as "empty".
          ...(stateForRecreateCheck?.divergentBodyRegion !== undefined && {
            expectedRegionDiverged: true,
          }),
        },
        forceStatefulRecreation: options.forceStatefulRecreation ?? false,
      });
      const errorBlock = renderRecreateTargetsErrors(validation);
      if (errorBlock) {
        throw new CdkdError(errorBlock, 'RECREATE_TARGETS_INVALID');
      }
      recreateTargets = {
        stackName: stackInfo.stackName,
        viaCcApi: new Set(
          validation.targets.filter((t) => t.direction === 'to-cc-api').map((t) => t.logicalId)
        ),
        viaSdkProvider: new Set(
          validation.targets.filter((t) => t.direction === 'to-sdk').map((t) => t.logicalId)
        ),
      };
      if (recreateTargets.viaCcApi.size > 0 || recreateTargets.viaSdkProvider.size > 0) {
        // go-to-k/cdkd#4383 — the same-stack readers the recreate REPLACES
        // when a target's id moves (a create-only property holds the
        // reference), named by the prompt below. Advisory: read off the
        // raw template, before parameters and conditions are resolved, so
        // it can over-name. The REFUSAL of a stateful one is the engine's
        // (`refuseStatefulReplacedReaders`), on the template it diffs and
        // before any provider call.
        const replacedReaders = await findReplacedReadersOfRecreateTargets({
          template: stackInfo.template,
          state: stateForRecreateCheck?.state ?? {
            version: STATE_SCHEMA_VERSION_CURRENT,
            stackName: stackInfo.stackName,
            region: stackRegion,
            resources: {},
            outputs: {},
            lastModified: Date.now(),
          },
          targetIds: validation.targets.map((t) => t.logicalId),
        });

        // Issue [#650] — enumerate downstream `Fn::ImportValue`
        // consumers via the state bucket walk so the warn block
        // names them by stack. Soft-fail (returns []) on read
        // errors — the generic caveat still surfaces below.
        const downstreamConsumers = await findDownstreamConsumers({
          producerStack: stackInfo.stackName,
          producerRegion: stackRegion,
          stateBackend: stackStateBackend,
          baseRegion,
        });

        // Issue [#649] — interactive [y/N] prompt. Mirrors the
        // existing prefix-rename prompt structure: per-stack, with
        // --yes / -y short-circuiting to the warn-log surface that
        // v1 shipped. Stateful targets get a **DATA LOSS** prefix
        // as a third "stop and think" moment beyond the explicit
        // --force-stateful-recreation opt-in.
        const proceed = await promptRecreateConfirm({
          stackName: stackInfo.stackName,
          targets: validation.targets,
          yes: options.yes ?? false,
          // Tells the prompt whether the emptiness probe ran: it did NOT
          // under this flag (`probeAndRevalidateStateful` returns early),
          // so a conditional type's `null` reason proves nothing there.
          forceStatefulRecreation: options.forceStatefulRecreation ?? false,
          downstreamConsumers,
          replacedReaders,
        });
        if (!proceed) {
          return;
        }
      }
    }

    // Issue #1002 PR 2 — thread the stack's §6 mapping table into the
    // engine (post-resolution audit) and the nested-stack context
    // (child-template rewrite). Undefined in legacy mode.
    const assetRedirect = stackRedirects.get(stackInfo);

    const deployEngineOptions: DeployEngineOptions = {
      concurrency: options.concurrency,
      dryRun: options.dryRun,
      noRollback: !options.rollback,
      ...(options.roleArn && { roleArn: options.roleArn }),
      refusalRecovery,
      ...(assetRedirect && { assetRedirect }),
      ...(eventRecorder && { eventRecorder }),
      onCurrentStateLoaded: composeStateLoadedGates(crossPrefix.firstDeployGate, migrationGate),
      ...(crossPrefix.onFirstDeployLeftNoRecord && {
        onFirstDeployLeftNoRecord: crossPrefix.onFirstDeployLeftNoRecord,
      }),
      onDestructivePlan: crossPrefix.onDestructivePlan,
      crossPrefixHolder: crossPrefix.crossPrefixHolder,
      // Issue #2719. Unconditional, unlike `recreateTargets` above: an
      // empty Set is the same as absent to every reader, and gating on
      // size only matters where the value's PRESENCE changes behaviour.
      ...(options.pinCcApi?.length && {
        pinCcApi: { stackName: stackInfo.stackName, logicalIds: new Set(options.pinCcApi) },
      }),
      ...(recreateTargets &&
        (recreateTargets.viaCcApi.size > 0 || recreateTargets.viaSdkProvider.size > 0) && {
          recreateTargets,
        }),
      ...(options.replace && { replace: true }),
      ...(options.forceStatefulRecreation && { forceStatefulRecreation: true }),
      ...(options.skipFinalSnapshot && { skipFinalSnapshot: true }),
      // Region-pinned clients for the pre-delete final snapshots
      // (issues #1352 / #1353). Passed explicitly; since #1981 the stack
      // AWS scope also makes getAwsClients() return these same clients.
      finalSnapshotClients: stackAwsClients,
      ...(options.strictGetatt && { strictGetAtt: true }),
      ...(options.cfnFallback === false && { cfnFallback: false }),
      producerLookup,
      ...(stackInfo.account && { consumerAccount: stackInfo.account }),
      captureObservedState: resolveCaptureObservedState(options.captureObservedState),
      ...(options.resourceWarnAfter?.globalMs !== undefined && {
        resourceWarnAfterMs: options.resourceWarnAfter.globalMs,
      }),
      ...(options.resourceTimeout?.globalMs !== undefined && {
        resourceTimeoutMs: options.resourceTimeout.globalMs,
      }),
      ...(options.resourceWarnAfter?.perTypeMs && {
        resourceWarnAfterByType: options.resourceWarnAfter.perTypeMs,
      }),
      ...(options.resourceTimeout?.perTypeMs && {
        resourceTimeoutByType: options.resourceTimeout.perTypeMs,
      }),
      ...(approveDeployment && { requireApproval, approveDeployment }),
      // go-to-k/cdkd#5238: recorded so `cdkd state destroy` can honor it.
      ...(stackInfo.terminationProtection === true && { terminationProtection: true }),
      inRunStacks: ctx.inRunStacks,
    };

    const stackDeployEngine = new DeployEngine(
      stackStateBackend,
      stackLockManager,
      dagBuilder,
      diffCalculator,
      stackProviderRegistry,
      deployEngineOptions,
      stackRegion,
      exportIndexStore
    );

    // Set the NestedStackProvider context for this deploy. The provider
    // pulls parentStackName / parentRegion / nestedTemplates / accountId
    // from the surrounding AsyncLocalStorage scope (see
    // src/provisioning/nested-stack-context.ts). When the stack has no
    // AWS::CloudFormation::Stack resources, this is a cheap no-op (the
    // provider is never invoked); when it does, the context lets the
    // provider build a child DeployEngine recursively.
    const deployResult = await withNestedStackContext(
      {
        stateBackend: stackStateBackend,
        lockManager: stackLockManager,
        providerRegistry: stackProviderRegistry,
        parentStackName: stackInfo.stackName,
        parentRegion: stackRegion,
        accountId,
        awsClients: stackAwsClients,
        stateBucket,
        exportIndexStore,
        // Null-prototype on the ABSENT arm too (issue go-to-k/cdkd#3480):
        // the index is omitted when no row carried a usable asset path, and
        // on a `{}` fallback `NestedStackProvider`'s
        // `if (!childTemplatePath)` guard reads an inherited member for a
        // row named `toString` / `valueOf` and is skipped.
        nestedTemplates: stackInfo.nestedTemplates ?? nullPrototypeRecord<string>(),
        dagBuilder,
        diffCalculator,
        options: deployEngineOptions,
        // A template-removal DELETE of an `AWS::CloudFormation::Stack` row
        // recurses into `runDestroyForStack` from here, so the child's
        // recovery hints need the run's prefix exactly as the destroy
        // commands' do (issue #2170). This was the fourth entry point and
        // the one the review found still open.
        destroyOptions: {
          statePrefix: options.statePrefix,
          ...(options.profile && { profile: options.profile }),
        },
        ...(assetRedirect && { assetRedirect }),
      },
      () => stackDeployEngine.deploy(stackInfo.stackName, stackInfo.template)
    );

    logger.info(`\n${bold('Deployment Summary:')}`);
    logger.info(`  Stack: ${bold(cyan(deployResult.stackName))}`);
    logger.info(
      `  Created: ${deployResult.created > 0 ? green(deployResult.created) : gray(deployResult.created)}`
    );
    // Issue #1819: partials are INCLUDED here and broken out below, so the
    // console and `RUN_FINISHED.counts.updated` report the same number. A
    // partial IS an update that happened -- excluding it here while the
    // events store counted it made the two disagree by exactly the partial
    // count, with nothing on either side saying so.
    //
    // Issue #1989: `updatePartial` also carries nested-stack descendants'
    // partials, which are NOT rows of this stack — `updated` counts only
    // this stack's own rows. Only this stack's own partials join the
    // total; a descendant's get their own row below.
    const { ownUpdatePartial, nestedUpdatePartial } = splitUpdatePartial(deployResult);
    const updatedTotal = deployResult.updated + ownUpdatePartial;
    logger.info(`  Updated: ${updatedTotal > 0 ? yellow(updatedTotal) : gray(updatedTotal)}`);
    logger.info(
      `  Deleted: ${deployResult.deleted > 0 ? red(deployResult.deleted) : gray(deployResult.deleted)}`
    );
    // Issue #1762: only shown when non-zero — a skipped DELETE is rare
    // and abnormal (cdkd did not confirm the delete), so a permanent
    // `Skipped: 0` row would train the reader to ignore it.
    if (deployResult.deleteSkipped > 0) {
      logger.info(`  Skipped (not deleted): ${yellow(deployResult.deleteSkipped)}`);
    }
    // go-to-k/cdkd#4705: same only-when-non-zero rule.
    const crossPrefixKept = deployResult.crossPrefixKept ?? 0;
    if (crossPrefixKept > 0) {
      logger.info(
        `  Kept (replacement refused: another state prefix records the stack, or the check could not run): ${yellow(crossPrefixKept)}`
      );
    }
    // Issue #1819: same only-when-non-zero rule and the same reason. Worded
    // as what SURVIVED rather than as "partial", because the row the user
    // is looking at was updated fine — the number counts resources the
    // update was supposed to retire and did not.
    if (ownUpdatePartial > 0) {
      // Worded as a SUBSET of the line above ("of which"), because it is
      // one: the same resources are counted in both, and a reader adding
      // the two would otherwise double-count them.
      logger.info(safeMsg`    of which left an orphaned predecessor: ${yellow(ownUpdatePartial)}`);
    }
    // Issue #1989: NOT indented under `Updated:` — these are rows of a
    // nested child or grandchild, so they are not part of that total. Each
    // one's own warning and `partial (…)` row printed during the child's
    // deploy, naming the survivor.
    if (nestedUpdatePartial > 0) {
      logger.info(
        safeMsg`  Left an orphaned predecessor in a nested stack: ${yellow(nestedUpdatePartial)}`
      );
    }
    // Issue #1960: the two rows above are the deploy-side twin of what
    // makes `cdkd destroy` exit 2 (#1752) — a resource cdkd was
    // responsible for may still be alive in AWS. Feed the run-level
    // counter and say what it costs HERE, beside the counts: the throw
    // fires after every stack has finished and so cannot name which stack
    // contributed, while this line can.
    //
    // The two cases are NOT equally recoverable and the wording must not
    // flatten them. A skipped DELETE keeps its state record on purpose
    // (see the `deleteSkipped` arm in deploy-engine/delete.ts), so the next
    // `cdkd deploy` re-attempts it — that one self-heals. A partial
    // UPDATE's survivor is untracked, because the record now points at
    // the replacement, so nothing will ever retry it.
    const stackUnaddressed =
      deployResult.deleteSkipped + deployResult.updatePartial + crossPrefixKept;
    // Guarded on dryRun even though the engine hard-codes both counters to
    // 0 on its two dry-run returns: that invariant lives in the engine, and
    // a future dry run that PREVIEWED "would be skipped" would otherwise
    // make `cdkd deploy --dry-run` exit 2 while printing "Dry run
    // completed" -- a run that changed nothing reporting a survivor.
    if (!options.dryRun) {
      addUnaddressed(stackUnaddressed, crossPrefixKept);
    }
    logger.info(`  Unchanged: ${gray(deployResult.unchanged)}`);
    logger.info(`  Duration: ${cyan((deployResult.durationMs / 1000).toFixed(2) + 's')}`);

    // Issue #1111 item 3 — one-line surface for the per-resolution
    // "Unknown attribute ..., returning physical ID" warns, which
    // otherwise scroll away on green deploys.
    if (deployResult.attributeFallbackCount > 0) {
      logger.warn(
        `${deployResult.attributeFallbackCount} attribute resolution(s) fell back to the ` +
          `physical ID (potentially wrong values); re-run with --strict-getatt to fail on these`
      );
    }

    if (deployResult.outputs && Object.keys(deployResult.outputs).length > 0) {
      logger.info('\nOutputs:');
      for (const [key, value] of Object.entries(deployResult.outputs)) {
        logger.info(`  ${deployResult.stackName}.${key} = ${String(value)}`);
      }
    }
    // A stack without outputs gets no key, as in the AWS CDK CLI.
    if (
      outputsFile !== undefined &&
      deployResult.outputs &&
      Object.keys(deployResult.outputs).length > 0
    ) {
      stackOutputs[stackInfo.stackName] = Object.fromEntries(
        Object.entries(deployResult.outputs ?? {}).map(([key, value]) => [
          key,
          toOutputValueString(value),
        ])
      );
    }

    if (options.dryRun) {
      logger.info(`\n${green('✓')} ${bold('Dry run completed')} - no actual changes made`);
    } else if (stackUnaddressed > 0) {
      // Issue #1960: the exit code was only half the mis-report — this
      // line said "completed successfully" for a run that left an AWS
      // resource cdkd owned alive. Mirrors the marker `cdkd destroy`
      // switches to for the identical outcome ("⚠ Stack X partially
      // destroyed"), so the visual verdict and the exit code agree.
      //
      // Printed even under --allow-unaddressed: that flag suppresses the
      // exit code, not the finding. A run whose operator opted out still
      // has to be able to see, in its own log, that something survived.
      logger.warn(
        `\n⚠ ${bold(
          `Stack ${deployResult.stackName} deployed, but ${stackUnaddressed} ` +
            `resource(s) were left unaddressed`
        )} — they may still exist in AWS. ` +
          (options.allowUnaddressed
            ? `Exiting 0 because --allow-unaddressed was passed.`
            : // Not "will exit 2": in a multi-stack run another stack can
              // still FAIL after this line prints, and a real failure takes
              // precedence with exit 1. This counts TOWARD exit 2 rather
              // than promising it.
              `This counts toward a non-zero exit (2 unless something else fails; ` +
              `pass --allow-unaddressed to exit 0).`)
      );
    } else {
      logger.info(`\n${green('✓')} ${bold('Deployment completed successfully')}`);
    }

    // Issue #1960: a run that left a resource unaddressed exits 2, so
    // recording it as SUCCEEDED here would make the durable post-mortem
    // contradict the exit code the same run returned -- the split verdict
    // this issue closed for the console banner, reopened in the events
    // store. `cdkd destroy` already records FAILED for the identical
    // outcome (its `skippedCount > 0` arm), so this is parity.
    //
    // `recordRunFailed` is deliberately NOT used: it carries error metadata
    // and no counts, and `skipped` is the only figure in the summary that
    // says a resource survived.
    if (!options.dryRun && stackUnaddressed > 0) runResult = 'FAILED';
    recordRunOutcome(
      eventRecorder,
      stackInfo.stackName,
      runResult,
      {
        created: deployResult.created,
        // Issue #1819: a partial update still UPDATED the resource, unlike a
        // skipped DELETE which did nothing. Counting it only under
        // `skipped` would make the durable record say `~0` for a run whose
        // own RESOURCE_SUCCEEDED events show an UPDATE, so it counts in
        // BOTH: `updated` for what happened, `skipped` for what did not.
        // This stack's own partials only (issue #1989), matching the
        // console's `Updated:`; a descendant's still counts in `skipped`.
        updated: updatedTotal,
        deleted: deployResult.deleted,
        // Issue #1762: the run-level counterpart of the summary row above.
        // `cdkd events` renders `RunCounts.skipped` as `⚠N`, and destroy
        // has populated it since #1752 — without it here a deploy that
        // skipped a DELETE records a run summary that says only what it
        // DID delete, so the durable post-mortem understates the run in
        // exactly the direction this change exists to correct.
        // Issue #1819 rides the SAME run-level counter as #1762's skipped
        // DELETE: `cdkd events` renders `RunCounts.skipped` as `⚠N`, and
        // both cases mean "cdkd did not address a resource it was
        // responsible for". Splitting them at the run level would need a
        // schema field for a number the per-resource events already carry
        // — each survivor has its own RESOURCE_SKIPPED with the reason.
        ...(stackUnaddressed > 0 && { skipped: stackUnaddressed }),
      },
      deployResult.durationMs
    );
  } catch (deployError) {
    // The user declined the prefix-migration confirmation inside the
    // engine's pre-provisioning gate. Nothing was provisioned and the
    // engine already released the lock, so unwind quietly — this is
    // NOT a deploy failure and must not be recorded as one (matches
    // the plain `return` the pre-lock version of the check used).
    if (deployError instanceof DeployCancelledError) {
      addCancelledStack();
      // `runResult` stays SUCCEEDED, so `finalize` below records this stack
      // as a successful run in the events index. That is a KNOWN exemption
      // from this issue's "the record must not contradict the run" rule,
      // not an oversight: `DeploymentRunResult` has only SUCCEEDED and
      // FAILED, and neither describes a stack the user deliberately
      // declined -- FAILED would newly report user-initiated cancellations
      // as failures, which is its own mis-report. Recording the honest
      // answer needs a third value on the event schema, which is a schema
      // change and out of scope here. Pre-existing behavior, unchanged;
      // what this PR adds is the run-level message that now SAYS how many
      // stacks never deployed, so the omission is no longer silent.
      return;
    }
    // Issue [#808] — record the run-level failure event before
    // re-throwing. Error metadata only (no resource properties).
    runResult = 'FAILED';
    recordRunFailed(eventRecorder, stackInfo.stackName, deployError);
    throw deployError;
  } finally {
    // Best-effort final flush + index update, beside the lock's deferred
    // version purge. Neither throws, and both finish before the S3 client
    // they use is destroyed.
    await Promise.all([
      eventRecorder?.finalize(runResult),
      stackLockManager.settleDeferredPurges(),
    ]);
    stackAwsClients.destroy();
    stateS3Client.destroy();
  }
}
