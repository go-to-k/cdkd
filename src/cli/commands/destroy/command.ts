/**
 * `cdkd destroy`: the command handler. Split out of `../destroy.ts`.
 */
import { CrossPrefixGuard } from '../../../state/stack-registry.js';
import {
  pasteableCommand,
  plainOrDescribed,
  quotedOrDescribed,
  withheldTargetClause,
} from '../../../utils/pasteable-command.js';
import {
  warnIfDeprecatedRegion,
  validateResourceTimeouts,
  type ResourceTimeoutOption,
} from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { asIsMessage, displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  legacyStateBucketFallbackRegion,
  reconcileExportIndexRegion,
  resolveEffectiveRegion,
  stackRegionResolver,
  stateWithRegion,
  withOtherIndexRemoval,
} from '../../region-options.js';
import {
  NestedStackChildDirectDestroyError,
  PartialFailureError,
  StackTerminationProtectionError,
} from '../../../utils/error-handler.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { accountArgs, withheldAccountClause } from '../../../state/malformed-resources-bag.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import type { DeploymentRunResult } from '../../../types/deployment-events.js';
import { startRunRecorder, recordRunFailed } from '../deployment-events-run.js';
import { DeploymentEventsReader } from '../../../state/deployment-events-store.js';
import { ExportIndexStore } from '../../../state/export-index-store.js';
import { LockManager } from '../../../state/lock-manager.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import { setResolvedResourceTimeouts } from '../../../provisioning/resource-timeout-registry.js';
import { withNestedStackContext } from '../../../provisioning/nested-stack-context.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { forwardSigtermToSigint, watchCommandInterrupt } from '../../../utils/interrupt-signals.js';
import { resolveStateBucketWithDefault } from '../../config-loader.js';
import { describeStack, renderNotInAppWarning } from '../../stack-matcher.js';
import { runDestroyForStack } from '../destroy-runner.js';
import { skippedDestroyMessage } from '../destroy-skip-message.js';
import { TemplateNoEchoReresolver } from '../../../deployment/noecho-delete-reresolution.js';
import { selectDestroyTargets, orderDestroyTargets, type DestroyTarget } from './select-targets.js';
import { plannedDestroyRegion, protectionNotNamed, purgeEventsAfterDestroy } from './helpers.js';

/**
 * Destroy command implementation
 */
export async function destroyCommand(
  stackArgs: string[],
  options: {
    app?: string;
    output?: string;
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    exclusively?: boolean;
    region?: string;
    profile?: string;
    roleArn?: string;
    yes: boolean;
    force: boolean;
    removeProtection?: boolean;
    skipFinalSnapshot?: boolean;
    purgeEvents?: boolean;
    verbose: boolean;
    context?: string[];
    allowUnsupportedTypes?: string[];
    resourceWarnAfter?: ResourceTimeoutOption;
    resourceTimeout?: ResourceTimeoutOption;
  }
): Promise<void> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
    // Disable the live progress renderer in verbose mode — debug logs would
    // interleave too aggressively with the live area's in-flight task lines.
    process.env['CDKD_NO_LIVE'] = '1';
  }

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  // Reject mis-ordered --resource-warn-after / --resource-timeout pairs
  // up front so the user sees the error before synth runs. Mutates
  // `options.resourceWarnAfter` in place when auto-lowering the inherited
  // warn against a shortened --resource-timeout (so the destroy-runner
  // call site below reads the lowered value).
  validateResourceTimeouts(options);
  // Seed the provisioning-layer registry so providers with an INNER waiter
  // cap can lift it to the user-resolved budget (issue #1280).
  setResolvedResourceTimeouts(options.resourceTimeout);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Resolve --state-bucket from CLI, env, cdk.json, or default
  // go-to-k/cdkd#2100: the profile's region when none is named, never a
  // `us-east-1` literal. Destroy reads each stack's region from its state
  // records; this value is only the fallback for a region-less legacy record,
  // and that fallback is reconciled per stack (`regionForStack`) so a record
  // the old default wrote is still found.
  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  const region = effectiveRegion.region;
  const stateBucket = await resolveStateBucketWithDefault(
    options.stateBucket,
    region,
    legacyStateBucketFallbackRegion(effectiveRegion)
  );
  // The account flags the state commands this command prints carry
  // (go-to-k/cdkd#4648): `--profile`, the RESOLVED bucket and the prefix, so a
  // pasted `cdkd state orphan` / `cdkd state destroy` acts on the bucket this
  // run read.
  const accountRecovery: LockRecoveryContext = {
    profile: options.profile,
    stateBucket,
    statePrefix: options.statePrefix,
  };
  const stateCommandAccount = {
    args: accountArgs(accountRecovery),
    clause: withheldAccountClause(accountRecovery, 'the command lines below print'),
  };

  logger.info('Starting stack destruction...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  // Also set AWS_REGION env for providers using local SDK clients
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

  // Command-scoped interrupt record (issue #2117). Registered BEFORE the
  // SIGTERM forwarder below, mirroring `deploy.ts`, so a forwarded signal can
  // never arrive while the command owns no handler of its own.
  const interruptWatch = watchCommandInterrupt({ command: 'cdkd destroy' });

  // CI cancellation delivers SIGTERM, not Ctrl-C (issue #1342) — route it
  // through the destroy-runner's graceful-SIGINT drain (issue #816).
  //
  // Guarded: a throw here would leave the watch's listener installed for the
  // rest of the PROCESS, and `forwardSigtermToSigint` decides between emitting
  // SIGINT and `process.exit(143)` on `process.listenerCount('SIGINT') === 0`,
  // so one leaked listener silently changes SIGTERM handling for every command
  // that follows. The other half of that throw — the interrupt SCOPE it opens
  // before registering — is unwound inside `forwardSigtermToSigint` itself,
  // since a caller holding no unregister function cannot close it.
  let unforwardSigterm: () => void;
  try {
    unforwardSigterm = forwardSigtermToSigint();
  } catch (error) {
    interruptWatch.dispose();
    throw error;
  }

  // go-to-k/cdkd#4705 (review R4-2): the backend may REPLACE its client with a
  // bucket-region one, which `awsClients.destroy()` does not reach.
  let stateBackendForCleanup: S3StateBackend | undefined;
  // go-to-k/cdkd#4705: each stack's post-record writes and lock release, when
  // several stacks are destroyed (`deferRegistryTail`); awaited in `finally`.
  const deferredTails: Array<Promise<void>> = [];
  let deferRegistryTail: ((released: Promise<void>) => void) | undefined;
  try {
    // 1. Initialize components
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    // Pass region/profile so the backend can rebuild its S3 client if the
    // bucket lives in a region different from the CLI's profile region.
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    stateBackendForCleanup = stateBackend;
    // Fail fast if the state bucket is missing, before synth or any destructive work.
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    // Exports index store for post-destroy invalidation of this stack's
    // entries. Strong-reference safety checks scan state.json directly
    // (NOT the index), so the index is purely a perf hint for the
    // resolver on subsequent deploys.
    const runIndexRegion = await reconcileExportIndexRegion({
      effective: effectiveRegion,
      probe: stateBackend,
      statePrefix: options.statePrefix,
      logger,
    });
    const newIndexStore = (indexRegion: string): ExportIndexStore =>
      new ExportIndexStore(
        awsClients.s3,
        stateBucket,
        options.statePrefix,
        indexRegion,
        stateBackend,
        { profile: options.profile }
      );
    // go-to-k/cdkd#2100: a destroyed stack's entries — a nested child's too —
    // also leave the OTHER candidate index file (`withOtherIndexRemoval`).
    const exportIndexStore = withOtherIndexRemoval(newIndexStore(runIndexRegion), {
      effective: effectiveRegion,
      runIndexRegion,
      statePrefix: options.statePrefix,
      probe: stateBackend,
      createStore: newIndexStore,
      logger,
    });
    const regionForStack = stackRegionResolver({
      effective: effectiveRegion,
      probe: stateBackend,
      logger,
    });
    const providerRegistry = new ProviderRegistry();

    // Register all SDK providers
    registerAllProviders(providerRegistry, providerClasses);

    // Configure custom resource response handling via S3
    providerRegistry.setCustomResourceResponseBucket(stateBucket);

    // Escape hatch: types deployed with --allow-unsupported-types must also be
    // destroyable, so route them through Cloud Control here too.
    if (options.allowUnsupportedTypes?.length) {
      providerRegistry.allowUnsupportedTypes(options.allowUnsupportedTypes);
    }

    const selection = await selectDestroyTargets(stackArgs, options, stateBackend, logger);
    if (selection === undefined) return;
    const { appStacks, synthScanStacks, stackPatterns, allStateRefs, namesAppStack } = selection;
    let targets = selection.targets;

    // Aggregate error counts across stacks so a single partial failure
    // anywhere in the run propagates to a non-zero exit (PartialFailureError
    // → exit code 2). Mirrors `cdkd state destroy`'s totalErrors handling.
    // Hoisted out of the per-stack loop so the upfront nested-child-by-name
    // refusal (after the empty-match gate below) can use the same accumulator.
    let totalErrors = 0;
    // Issue #1752: resources whose provider reported `{ outcome: 'skipped' }`
    // — cdkd did not confirm the delete (it could not address them, or a
    // custom-resource Delete handler refused: issue #2054), so they may
    // still exist in AWS. Counted separately from `totalErrors` (nothing
    // FAILED) but treated the same way for the exit code: the runner
    // preserved state, so reporting success would tell CI the stack is gone
    // when it is not.
    let totalSkipped = 0;
    // The share of `totalSkipped` that keeps no state record: resources a
    // failed deploy created, left in AWS (go-to-k/cdkd#4738).
    let totalOrphanSkips = 0;
    // Set true when a per-stack destroy was gracefully interrupted (issue
    // #816) — the PER-STACK outcome, as the runner reported it.
    let interrupted = false;
    // What the multi-stack loop and the exit code actually ask (issue #2117):
    // "has this COMMAND been interrupted?" — either a stack reported it, or a
    // signal landed in a window no runner handler spanned. Always call it at
    // the point of decision; assigning it to a local re-creates the
    // sampled-once channel this issue is about.
    //
    // The `interrupted ||` disjunct looks subsumed by the watch — both are
    // ordinary `process.on('SIGINT')` listeners, so a real signal reaches both
    // — and round 3's review proposed dropping it. It is KEPT, because that
    // argument is about the PROCESS while this expression is about the
    // CALLEE's return value: the loop trusts what `runDestroyForStack`
    // reported, not a global side-channel that happens to agree. Measured by
    // probe rather than assumed — removing it reddens three cases that fence
    // the runner channel on its own (`still honours the runner-reported
    // interrupt` here and in the `state destroy` twin, plus `does NOT purge
    // the event history of a stack the runner reported interrupted`), each of
    // which hands back `interrupted: true` without emitting a signal at all.
    const runInterrupted = (): boolean => interrupted || interruptWatch.interrupted();
    // Set only where a `break` leaves at least one stack UNPROCESSED.
    //
    // The exit code needs this and the loop does not, which is why it is a
    // second flag rather than a rename. A signal can also land in the TAIL of
    // the run — after the last (or only) stack returned cleanly, during
    // `eventRecorder.finalize` / `purgeEventsAfterDestroy` — and there the
    // command-level answer is true while every target really was destroyed.
    // Reading `runInterrupted()` at the terminal throw made that case exit 2
    // with "State preserved — re-run 'cdkd destroy' to finish" over a destroy
    // that had nothing left to finish, which is a wrong answer in the
    // direction CI acts on. Before issue #2117 that site read the sampled
    // `result.interrupted`, which was false there.
    let stoppedEarly = false;

    if (targets.length === 0) {
      // Special-case: when a user explicitly names a stack that doesn't appear
      // in candidateStacks but DOES exist in state with `parentStack` set, we
      // hit "No matching stacks found" — misleading, since the state file
      // exists but the synth-success filter excludes nested children (they
      // aren't CDK top-level stacks). Detect that case and surface the
      // dedicated A2 refusal so the user gets a clear "destroy the parent
      // instead" message instead of the generic miss. Only fires for
      // explicit, non-wildcard names — wildcards still get the generic miss
      // (they aren't a clear "destroy this specific child" intent).
      if (stackPatterns.length > 0) {
        const allStateNamesSet = new Set(allStateRefs.map((r) => r.stackName));
        // In state but not this app's, and not a nested child refused below
        // (another app's stack sharing the bucket): named rather than
        // answered with a bare "No matching stacks found in state" (#3507).
        const notInApp: string[] = [];
        for (const pattern of stackPatterns) {
          if (pattern.includes('*') || pattern.includes('?') || pattern.includes('/')) continue;
          if (!allStateNamesSet.has(pattern)) continue;
          // Names an undeployed stack of this app; warned about above.
          if (namesAppStack.has(pattern)) continue;
          // Single-region MVP per design §3 (`parentRegion === region` until
          // cross-region nested stacks ship). For v6 state — which is the
          // only state that has `parentStack` set, and therefore the only
          // state the refusal below acts on — `region` is always populated,
          // so the `?? region` tail is defensive against a hand-edited
          // legacy state file rather than a code path v6 writers reach.
          // A future cross-region extension should mirror the multi-region
          // disambiguation logic in the per-stack loop below.
          const refRegion =
            allStateRefs.find((r) => r.stackName === pattern)?.region ??
            (await regionForStack(pattern));
          const stateOnlyResult = await stateBackend.getState(pattern, refRegion);
          if (stateOnlyResult?.state.parentStack) {
            const err = new NestedStackChildDirectDestroyError(
              pattern,
              stateOnlyResult.state.parentStack,
              stateOnlyResult.state.parentLogicalId,
              undefined,
              stateCommandAccount
            );
            logger.error(`  ✗ ${err.message}`);
            totalErrors++;
          } else if (appStacks.length > 0 && !notInApp.includes(pattern)) {
            notInApp.push(pattern);
          }
        }
        if (totalErrors > 0) {
          throw new PartialFailureError(
            `Destroy completed with ${totalErrors} resource error(s). State preserved — ` +
              `inspect 'cdkd state show <stack>' and re-run 'cdkd destroy' to retry.`
          );
        }
        if (notInApp.length > 0) logger.warn(renderNotInAppWarning(notInApp));
      }
      logger.info('No matching stacks found in state');
      return;
    }

    const ordering = await orderDestroyTargets(
      targets,
      appStacks,
      synthScanStacks,
      regionForStack,
      logger
    );
    targets = ordering.targets;
    const { uniqueNames, strictRegion, describeTarget, dependentsOf } = ordering;
    // go-to-k/cdkd#6115: the targets this run has not destroyed -- declined at
    // the prompt, refused, failed or stopped -- so a stack one of them depends
    // on is kept rather than deleted under it. A target with no state record
    // is not here: nothing of it is left to use the stack.
    const notDestroyed = new Set<DestroyTarget>();

    // accountId is only used to synthesize the parent's fake `Ref` ARN inside
    // `NestedStackProvider.create` — the destroy path never re-synthesizes
    // that ARN (each child's physicalId already lives in state and is
    // passed straight to `provider.delete`). Using the same `'unknown'`
    // placeholder as `cdkd state destroy` avoids an STS call that would
    // fail when no AWS credentials are configured (= the CI test env), and
    // matches the same pattern used by `state.ts` for the destroy path.
    const accountId = 'unknown';

    // Index state refs by stack name so we can resolve which region(s) each
    // stack has. Built once so the per-stack loop is cheap.
    const stateRefsByName = new Map<string, typeof allStateRefs>();
    for (const ref of allStateRefs) {
      const arr = stateRefsByName.get(ref.stackName) ?? [];
      arr.push(ref);
      stateRefsByName.set(ref.stackName, arr);
    }

    // 3. Process each stack via the shared destroy runner. The cross-stack
    // `totalErrors` accumulator is declared above (before the empty-match
    // gate) so the upfront nested-child-by-name refusal can also contribute.
    // go-to-k/cdkd#4705: every target stack's scan starts NOW, before the
    // sequential loop (one listing, one run-wide probe cap), prioritized in
    // the loop's order; each stack's destroy then awaits its own memoized
    // result, which promotes it ahead of the rest.
    // Only in the region the loop will destroy, and not for a stack its
    // termination protection skips.
    const crossPrefixCheck = { cache: new CrossPrefixGuard(stateBackend) };
    // go-to-k/cdkd#4705: with several stacks, each one's post-record writes
    // (kept list or tombstone, marker release) finish under its held lock
    // while the next stack is destroyed, and are all awaited before the
    // command ends (the `finally` below) -- nothing costs a round trip per
    // stack.
    if (targets.length > 1) deferRegistryTail = (released) => deferredTails.push(released);
    // A region-less (legacy) record falls back to a region, reconciled per
    // stack so the old default's record is not missed (go-to-k/cdkd#2100).
    const fallbackRegionByName = new Map<string, string>();
    for (const name of uniqueNames) {
      if ((stateRefsByName.get(name) ?? []).some((r) => !r.region)) {
        fallbackRegionByName.set(name, await regionForStack(name));
      }
    }
    // The region a target's destroy acts in, or `undefined` when its records
    // do not decide one. A shared name takes only its own region's record.
    // A shared-name stack pinned to an account destroys only under that
    // account's credentials: two Stages pinned to different accounts in one
    // region share the name and region, and with the OTHER account's profile
    // the record found is the other Stage's (#5176). One GetCallerIdentity,
    // only when such a target exists; an unreadable identity skips them too.
    const wrongAccount = new Set<DestroyTarget>();
    let callerAccountUnreadable = false;
    const accountPinned = [...strictRegion.keys()].filter((t) => t.synth?.account !== undefined);
    if (accountPinned.length > 0) {
      let callerAccount: string | undefined;
      callerAccountUnreadable = true;
      try {
        const { GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
        callerAccount = (await awsClients.sts.send(new GetCallerIdentityCommand({}))).Account;
        callerAccountUnreadable = callerAccount === undefined;
      } catch (err) {
        logger.debug(safeMsg`Could not read the caller account: ${describeAwsFailure(err).detail}`);
      }
      for (const t of accountPinned) if (t.synth!.account !== callerAccount) wrongAccount.add(t);
    }
    const plannedRegionFor = (target: DestroyTarget): string | undefined => {
      if (wrongAccount.has(target)) return undefined;
      const refs = stateRefsByName.get(target.stackName) ?? [];
      const strict = strictRegion.get(target);
      if (strict !== undefined) return refs.some((r) => r.region === strict) ? strict : undefined;
      return plannedDestroyRegion(
        refs,
        target.synth?.region,
        fallbackRegionByName.get(target.stackName) ?? region
      );
    };
    for (const target of targets) {
      if (
        target.synth?.terminationProtection === true &&
        !(options.removeProtection === true && target.dependsOnSelected === undefined)
      ) {
        continue;
      }
      const planned = plannedRegionFor(target);
      if (planned !== undefined) {
        void crossPrefixCheck.cache.full(target.stackName, planned, 'prestart');
      }
    }
    for (const [stackIndex, target] of targets.entries()) {
      const stackName = target.stackName;
      logger.info(`\nPreparing to destroy stack: ${describeTarget(target)}`);
      // go-to-k/cdkd#6115: `--remove-protection` reaches only the stacks the
      // user NAMED. A stack added because it depends on one is still refused
      // when protected: its protection is what guards an unasked delete.
      const removeProtection =
        options.removeProtection === true && target.dependsOnSelected === undefined;
      if (wrongAccount.has(target)) {
        // Counted like a termination-protection refusal (exit 2): the user named
        // a stack and it was not destroyed.
        logger.error(
          callerAccountUnreadable
            ? safeMsg`  ✗ Stack ${describeTarget(target)} is pinned to account ${target.synth!.account!}, and the account this run's credentials resolve to could not be read (STS GetCallerIdentity failed), so it was not destroyed: another stack of the app shares its name, and only that account's credentials address its record. Check the credentials (aws sts get-caller-identity) and re-run destroy.`
            : safeMsg`  ✗ Stack ${describeTarget(target)} is pinned to account ${target.synth!.account!}, which is not the account this run's credentials resolve to; not destroyed. Run destroy with that account's credentials.`
        );
        notDestroyed.add(target);
        totalErrors++;
        continue;
      }

      // Pick the region for this stack. If synth ran, prefer the synth region
      // (so a user changing env.region targets only that region). Otherwise,
      // use the unique state region; refuse with a helpful error when the
      // stack has multiple regions and the user did not pin one.
      const refs = stateRefsByName.get(stackName) ?? [];
      const synthStack = target.synth;

      // Stack-level terminationProtection guard. Refuse to destroy BEFORE any
      // lock acquisition or per-resource delete. In multi-stack runs (--all
      // or wildcard), a protected stack counts as a per-stack failure and
      // does NOT abort the rest — sibling unprotected stacks still get
      // destroyed, and the aggregated count surfaces as PartialFailureError
      // (exit 2) below. Mirrors CDK CLI's `cdk destroy` refusal but framed
      // through cdkd's partial-failure pipeline. `--remove-protection` is
      // the explicit opt-in bypass: log at WARN so the bypass is visible
      // in CI logs, then proceed with the destroy.
      if (synthStack?.terminationProtection === true) {
        if (removeProtection) {
          logger.warn(
            `Stack ${displaySafe(stackName)} has terminationProtection: true — bypassing because --remove-protection set`
          );
        } else {
          const err = new StackTerminationProtectionError(stackName, undefined, {
            args: stateCommandAccount.args,
            clause: withheldAccountClause(accountRecovery, 'the command below prints'),
          });
          logger.error(`  ✗ ${err.message}`);
          if (options.removeProtection === true && target.dependsOnSelected !== undefined) {
            logger.error(protectionNotNamed(target.dependsOnSelected));
          }
          notDestroyed.add(target);
          totalErrors++;
          continue;
        }
      }
      const plannedRegion = plannedRegionFor(target);
      const strict = strictRegion.get(target);
      let stackTargetRegion: string;
      if (refs.length === 0) {
        logger.warn(`No state found for stack ${displaySafe(stackName)}, skipping`);
        continue;
      } else if (strict !== undefined && plannedRegion === undefined) {
        // The name's record is another stack's, in another region (#5176).
        logger.warn(safeMsg`No state found for stack ${describeTarget(target)}, skipping`);
        continue;
      } else if (plannedRegion !== undefined) {
        stackTargetRegion = plannedRegion;
      } else {
        // Regions come from S3 KEY segments and sit beside a labelled line, so
        // each is named only when it is a plain identifier (go-to-k/cdkd#3759).
        const regions = refs
          .map((r) => (r.region === undefined ? '(legacy)' : plainOrDescribed(r.region, 'region')))
          .join(', ');
        // Both the name AND the `<region>` hole are quoted on a trailing
        // labelled line: bare, `<region>` reads stdin from a file `region`
        // and truncates the next word (go-to-k/cdkd#3436). A withheld name is
        // explained in the prose before it (go-to-k/cdkd#3759).
        const orphanOneClause = withheldAccountClause(
          accountRecovery,
          'the command below prints'
        ).trimEnd();
        const orphanOne = pasteableCommand('cdkd state orphan', [
          { value: stackName, hole: 'stack', opts: { plainIdent: true } },
          { flag: '--stack-region', hole: 'region' },
          ...stateCommandAccount.args,
        ]);
        throw new Error(
          `Stack ${quotedOrDescribed(stackName, 'stack name')} has state in multiple regions: ${regions}. ` +
            `Remove cdkd's record for ONE region with the command below (fill in the ` +
            `region), or run destroy from a CDK app whose env.region matches one of them.` +
            withheldTargetClause(orphanOne, 'stack', 'cdkd state orphan', "This stack's name") +
            (orphanOneClause === '' ? '' : ` ${orphanOneClause}`) +
            `\nRemove one record with: ${orphanOne.command}`
        );
      }

      // Load current state for the chosen region
      const stateResult = await stateBackend.getState(stackName, stackTargetRegion);
      if (!stateResult) {
        logger.warn(`No state found for stack ${displaySafe(stackName)}, skipping`);
        continue;
      }

      // go-to-k/cdkd#5238: protection the stack was DEPLOYED with counts too,
      // as in CloudFormation, where the deployed stack's setting is what a
      // delete meets: code that dropped it but was never redeployed is still
      // protected. The synth check above already ran for a synth-protected
      // stack.
      if (
        synthStack?.terminationProtection !== true &&
        stateResult.state.terminationProtection === true
      ) {
        if (removeProtection) {
          logger.warn(
            safeMsg`Stack ${stackName} was deployed with terminationProtection: true — bypassing because --remove-protection set`
          );
        } else {
          const err = new StackTerminationProtectionError(
            stackName,
            undefined,
            {
              args: stateCommandAccount.args,
              clause: withheldAccountClause(accountRecovery, 'the command below prints'),
            },
            { command: 'cdkd destroy' }
          );
          logger.error(safeMsg`  ✗ ${asIsMessage(err.message)}`);
          if (options.removeProtection === true && target.dependsOnSelected !== undefined) {
            logger.error(protectionNotNamed(target.dependsOnSelected));
          }
          notDestroyed.add(target);
          totalErrors++;
          continue;
        }
      }

      // Nested-stack child-only destroy refusal (#555 A2 / design §7). A
      // state record with `parentStack` set was written by
      // `NestedStackProvider.create` (or recursive `cdkd import
      // --migrate-from-cloudformation`) as a child of another stack;
      // directly destroying it without going through the parent would
      // leave the parent's `AWS::CloudFormation::Stack` record pointing
      // at gone-from-AWS resources, and the parent's next deploy would
      // silently try to re-create them. Mirrors CFn's own "can't
      // directly destroy a nested stack" semantic. `cdkd state destroy`
      // intentionally bypasses this guard — that's the documented
      // state-only escape hatch for users who accept the dangling
      // parent reference. Multi-stack runs (--all) count this as a
      // per-stack failure so siblings continue and the aggregated count
      // surfaces as PartialFailureError (exit 2).
      if (stateResult.state.parentStack) {
        const err = new NestedStackChildDirectDestroyError(
          stackName,
          stateResult.state.parentStack,
          stateResult.state.parentLogicalId,
          undefined,
          stateCommandAccount
        );
        logger.error(`  ✗ ${err.message}`);
        notDestroyed.add(target);
        totalErrors++;
        continue;
      }

      // A stack whose dependent this run did not destroy keeps running, as
      // `cdk destroy` stops before it (go-to-k/cdkd#6115). Below every refusal
      // above, which count as errors on their own. Not counted as an error: a
      // dependent that failed counted already, and one the user declined is
      // the user's choice. A later run destroys both.
      const keptDependents = (dependentsOf.get(target) ?? []).filter((d) => notDestroyed.has(d));
      if (keptDependents.length > 0) {
        logger.warn(
          safeMsg`Not destroying stack ${describeTarget(target)}: ${keptDependents.map(describeTarget).join(', ')} depends on it and was not destroyed in this run.`
        );
        notDestroyed.add(target);
        continue;
      }

      // Issue #2117: the last check before any delete is issued, and it sits
      // ABOVE `startRunRecorder` deliberately. The two guards at the end of the
      // loop body cannot cover a signal that lands DURING this iteration but
      // before dispatch — the state read and the per-stack prompt both happen
      // in here — and starting a destroy after the user pressed Ctrl-C is the
      // same defect one stack earlier. Breaking BELOW the recorder would emit a
      // RUN_STARTED and then finalize it SUCCEEDED, so `cdkd events` would show
      // a clean destroy run for a stack nothing touched.
      //
      // Unconditionally `stoppedEarly`: THIS stack is the one left undestroyed,
      // whether or not any follow it.
      if (runInterrupted()) {
        stoppedEarly = true;
        break;
      }

      // Issue [#808] — best-effort structured deployment-event recorder
      // for this destroy run. The runner emits per-resource DELETE events
      // through it; this CLI emits RUN_STARTED (inside startRunRecorder) /
      // RUN_FINISHED and finalize()s below. Failures are swallowed inside
      // the store. (Destroy never runs under --dry-run, so the recorder is
      // always created here.)
      const eventRecorder = startRunRecorder({
        backend: stateBackend,
        stackName,
        region: stackTargetRegion,
        command: 'destroy',
      })!;
      let destroyRunResult: DeploymentRunResult = 'SUCCEEDED';
      // The runner's PER-STACK verdict, hoisted out of the `try` so
      // `purgeEventsAfterDestroy` below can read it (`result` is block-scoped).
      // That helper asks "did this stack finish?", which is the per-stack
      // question, not the command-level one — see the call site.
      let stackInterrupted = false;
      // The OTHER way this stack can finish with its resources still standing:
      // the user answered `n` at the runner's per-stack confirmation prompt.
      // Hoisted for the same reason and read at the same call site — see the
      // `--purge-events` gate below for why `interrupted` alone is not the
      // question that gate needs to ask.
      let stackCancelled = false;

      // The per-stack destroy, bracketed by `interruptWatch.runStack` (issue
      // #2117) so a second Ctrl-C in this window escalates through the RUNNER's
      // handler — the only one that can release this stack's lock best-effort
      // and print the region-qualified `cdkd force-unlock` recovery command.
      //
      // Inside the bracket, set the NestedStackProvider context for this
      // destroy. The provider is registered globally (it's state-less) and only
      // fires when the state file actually carries an
      // AWS::CloudFormation::Stack record; for stacks without nested children
      // this is a cheap no-op.
      try {
        const result = await interruptWatch.runStack(() =>
          withNestedStackContext(
            {
              stateBackend,
              lockManager,
              providerRegistry,
              parentStackName: stackName,
              parentRegion: stackTargetRegion,
              accountId,
              awsClients,
              stateBucket,
              exportIndexStore,
              destroyOptions: {
                ...(options.profile && { profile: options.profile }),
                statePrefix: options.statePrefix,
                ...(removeProtection && { removeProtection: true }),
                ...(options.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
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
              },
            },
            () =>
              runDestroyForStack(stackName, stateWithRegion(stateResult.state, stackTargetRegion), {
                stateBackend,
                lockManager,
                providerRegistry,
                baseAwsClients: awsClients,
                baseRegion: region,
                // `getState` adopted the KEY's region into the record above, so
                // this is the only place the divergence is still visible; the
                // runner refuses on it when the record still lists resources
                // (issue #3328).
                ...(stateResult.divergentBodyRegion !== undefined && {
                  divergentBodyRegion: stateResult.divergentBodyRegion,
                }),
                ...(options.profile && { profile: options.profile }),
                stateBucket,
                statePrefix: options.statePrefix,
                skipConfirmation: options.yes || options.force,
                // go-to-k/cdkd#6115: a stack the run added says why at its prompt.
                ...(target.dependsOnSelected !== undefined && {
                  confirmationNote: `it depends on ${describeStack(target.dependsOnSelected)}`,
                }),
                removeProtection,
                skipFinalSnapshot: options.skipFinalSnapshot === true,
                // go-to-k/cdkd#4150: a top-level destroy may resolve a
                // secret-derived principal list; a deploy never does.
                resolveSecretDerivedPrincipals: {},
                // go-to-k/cdkd#2115: a whole-stack teardown, where a delete cdkd
                // cannot confirm keeps its record (CloudFormation DELETE_FAILED);
                // a deploy-engine delete never sets it.
                stackDestroy: true,
                // go-to-k/cdkd#4705: refuse when another state prefix records the stack.
                crossPrefixCheck,
                ...(deferRegistryTail !== undefined && { deferRegistryTail }),
                exportIndexStore,
                // go-to-k/cdkd#4682: the synthesized template, so a custom
                // resource reading a NoEcho parameter gets its value back on
                // delete. A macro-carrying template was never expanded here,
                // and one synthesized for another region is not what this
                // record deployed.
                ...(TemplateNoEchoReresolver.usable(synthStack?.template) &&
                  (synthStack.region === undefined || synthStack.region === stackTargetRegion) && {
                    noEchoReresolver: new TemplateNoEchoReresolver({
                      template: synthStack.template,
                      stackName,
                      region: stackTargetRegion,
                      ...(synthStack.nestedTemplates !== undefined && {
                        nestedTemplates: synthStack.nestedTemplates,
                      }),
                    }),
                  }),
                ...(options.allowUnsupportedTypes?.length && {
                  allowUnsupportedTypes: options.allowUnsupportedTypes,
                }),
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
                eventRecorder,
              })
          )
        );
        totalErrors += result.errorCount;
        totalSkipped += result.skippedCount;
        totalOrphanSkips += result.journaledOrphanSkips;
        stackInterrupted = result.interrupted;
        stackCancelled = result.cancelled === true;
        if (result.interrupted) interrupted = true;
        // `skippedCount` counts journaled orphans the run kept too: a resource
        // of the dependent may still exist, so its producer is kept as well.
        if (
          result.errorCount > 0 ||
          result.skippedCount > 0 ||
          result.interrupted ||
          result.cancelled === true
        ) {
          notDestroyed.add(target);
        }

        // Map the per-stack runner outcome to a run-level result. A
        // partial-failure (errorCount > 0) is a FAILED run, and so is a run
        // that SKIPPED a resource (issue #1752 — the stack is not destroyed
        // and state was preserved); cancelled / empty-skip / clean destroy
        // are all SUCCEEDED. The RUN_FINISHED event mirrors deploy's shape.
        destroyRunResult =
          result.errorCount > 0 || result.skippedCount > 0 ? 'FAILED' : 'SUCCEEDED';
        eventRecorder.record({
          eventType: 'RUN_FINISHED',
          stackName,
          result: destroyRunResult,
          counts: {
            created: 0,
            updated: 0,
            deleted: result.deletedCount,
            ...(result.errorCount > 0 && { failed: result.errorCount }),
            // Issue #1752: a skip-only run is recorded FAILED, so without this
            // the event says a run failed and names nothing that failed.
            ...(result.skippedCount > 0 && { skipped: result.skippedCount }),
          },
        });
      } catch (destroyError) {
        destroyRunResult = 'FAILED';
        recordRunFailed(eventRecorder, stackName, destroyError);
        throw destroyError;
      } finally {
        await eventRecorder.finalize(destroyRunResult);
      }

      // Issue [#885] — --purge-events: after a CLEAN destroy, also delete this
      // stack's deployment-event history, every earlier version under its
      // deployments/ prefix included (issue #2624; the helper's doc comment
      // carries the fail-soft bound).
      // Runs AFTER the recorder finalizes (see the helper's contract).
      //
      // PER-STACK answers, because the question the helper asks — "are these
      // events the post-mortem for a retry?" — is per-stack: it is about THIS
      // stack's own history. `runInterrupted()` (the command-level read)
      // disagreed with the exit code in the shape BLOCKER 1 of this PR fixed:
      // a signal in the tail of a fully-completed run made this skip the purge
      // while the command exited 0, so the user was told the destroy succeeded
      // and the events stayed behind.
      //
      // `stackCancelled` is the SECOND of the two ways a stack can come back
      // with its resources still standing, and reading only `stackInterrupted`
      // missed it. When the user answers `n` at the runner's per-stack prompt,
      // the runner returns `{cancelled: true, deletedCount: 0}` — nothing was
      // deleted, but `errorCount` and `skippedCount` are both 0, so
      // `destroyRunResult` maps to `SUCCEEDED` and `interrupted` is false.
      // `cdkd destroy --purge-events` then DELETED the event history of a
      // stack that still exists, which is the one thing the flag's own docs
      // promise it will not do. Probed on the round-2 code: a runner returning
      // `{cancelled: true, deletedCount: 0}` for two stacks called `pruneRuns`
      // twice.
      //
      // Pre-existing rather than introduced by this PR — but round 2 rewrote
      // this line and asserted in its comment that the flag is "true exactly
      // when there IS something to retry", and that claim is what was false.
      await purgeEventsAfterDestroy(
        new DeploymentEventsReader(stateBackend),
        stackName,
        stackTargetRegion,
        {
          purgeEvents: options.purgeEvents,
          runResult: destroyRunResult,
          interrupted: stackInterrupted || stackCancelled,
        },
        logger
      );

      // Graceful SIGINT (issue #816): do not start destroying further stacks
      // once the user has asked to stop. The interrupted stack already
      // finished its in-flight deletes, preserved state, and released its lock.
      // Issue #2117: read LIVE rather than the once-sampled `result.interrupted`
      // — a signal delivered anywhere above (including after the runner dropped
      // its own listener, and during the event finalize / purge just done) must
      // stop the loop just as a signal during the deletes does.
      //
      // `stoppedEarly` only when a stack actually remains. On the LAST
      // iteration this break exits a loop that had nothing left to do, so the
      // run completed — a signal that landed in this stack's own deletes is
      // already carried by `interrupted`, and one that landed in the tail after
      // it must not turn a finished destroy into exit 2.
      //
      // `stackIndex < targets.length - 1` is the INDEX form, and the
      // `state destroy` twin deliberately does NOT use it — see
      // `targetRemainsAfter` there, whose comment says `destroy.ts` needs no
      // counterpart because `candidateStacks` is pre-filtered to names that
      // have state, "so an index there IS a target". That holds at the ENTRY
      // filter and is over-claimed past it: three `continue`s in this loop body
      // can still leave a remaining index that would never have been destroyed
      // — termination protection without `--remove-protection`, a
      // nested-stack child refusal, and, the one that is a genuine RACE rather
      // than a policy refusal, `getState` returning null a few lines above
      // (`No state found for stack ..., skipping`) because the record was
      // deleted between the pre-filter and this read.
      //
      // That last one reproduces exactly the over-claim `targetRemainsAfter`
      // was written to close: a signal here reports exit 2 with "State
      // preserved -- re-run" over a run whose only remaining name has no state
      // to destroy. Left as the index form deliberately — the two policy
      // refusals already count into `totalErrors`, which exits 2 on its own,
      // so the race is the only case that differs and it errs toward telling
      // the user to re-run. Naming it here so the next reader does not have to
      // re-derive that the twin's rationale is narrower than it reads.
      if (runInterrupted()) {
        if (stackIndex < targets.length - 1) stoppedEarly = true;
        break;
      }
    }

    if (totalErrors > 0) {
      // Partial failure: per-stack runner already wrote the warning
      // banner and preserved state.json. Surface this distinctly from
      // "command crashed" so CI / bench scripts can detect the case
      // via exit code (PartialFailureError → exit 2, vs general
      // failures → exit 1).
      throw new PartialFailureError(
        `Destroy completed with ${totalErrors} resource error(s). State preserved — ` +
          `inspect 'cdkd state show <stack>' and re-run 'cdkd destroy' to retry. ` +
          `If the same resource keeps failing, 'cdkd state orphan <stack> --stack-region <region>' removes the stack's state in that region (every resource's record) without deleting AWS resources.`
      );
    }
    if (interrupted || (interruptWatch.interrupted() && stoppedEarly)) {
      // Graceful SIGINT (issue #816): in-flight deletes finished, state was
      // preserved (trimmed), and the lock was released. Surface a non-zero
      // exit so scripts / CI see the destroy did not complete.
      //
      // NOT `runInterrupted()`: this is the one decision point that must ask
      // "did anything go UNDESTROYED?" rather than "was a signal seen?". See
      // `stoppedEarly` above — a signal in the tail of a fully-completed run
      // reaches here with the command-level flag set and nothing left to
      // finish, and the message would then be false in both halves.
      throw new PartialFailureError(
        `Destroy interrupted by Ctrl-C. State preserved — re-run 'cdkd destroy' to finish.`
      );
    }
    if (totalSkipped > 0) {
      // Issue #1752: nothing FAILED, but cdkd left resources it could not
      // address. Exit 2 rather than 0 — exiting 0 is exactly the mis-report
      // this issue was filed for. The message, and why it counts entries
      // rather than resources, is `skippedDestroyMessage`'s.
      throw new PartialFailureError(
        skippedDestroyMessage(totalSkipped, totalOrphanSkips, 'cdkd destroy')
      );
    }
  } finally {
    // go-to-k/cdkd#4705: every stack's deferred post-record writes and lock
    // release, before any handler or client goes away.
    await Promise.allSettled(deferredTails);
    unforwardSigterm();
    // Issue #2117: disposed LAST of the destroy-side handlers — the runner
    // drops its own listener before its lock release and its `return`, so this
    // one has to outlive that, exactly as `deploy.ts`'s top-level handler
    // outlives `deploy-engine.ts`'s.
    interruptWatch.dispose();
    // Cleanup AWS clients
    awsClients.destroy();
    stateBackendForCleanup?.destroyClient();
  }
}
