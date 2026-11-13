import { commandHole, plainOrDescribed } from '../../../utils/pasteable-command.js';
import { CrossPrefixGuard } from '../../../state/stack-registry.js';
import { Command, Option } from 'commander';
import {
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  resourceTimeoutOptions,
  allowUnsupportedTypesOption,
  skipFinalSnapshotOption,
  noLocalCustomResourcesOption,
  validateResourceTimeouts,
  type ResourceTimeoutOption,
} from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import {
  CdkdError,
  PartialFailureError,
  StackTerminationProtectionError,
  withErrorHandling,
} from '../../../utils/error-handler.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import {
  asIsMessage,
  displayIdent,
  displayStackName,
  safeMsg,
} from '../../../utils/display-safe.js';
import { accountArgs, withheldAccountClause } from '../../../state/malformed-resources-bag.js';
import { stateWithRegion } from '../../region-options.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import { setResolvedResourceTimeouts } from '../../../provisioning/resource-timeout-registry.js';
import { withNestedStackContext } from '../../../provisioning/nested-stack-context.js';
import { runDestroyForStack, type DestroyRunnerResult } from '../destroy-runner.js';
import { skippedDestroyMessage } from '../destroy-skip-message.js';
import { startRunRecorder, recordRunFailed, recordRunOutcome } from '../deployment-events-run.js';
import type { DeploymentRunResult } from '../../../types/deployment-events.js';
import type { StackState } from '../../../types/state.js';
import { forwardSigtermToSigint, watchCommandInterrupt } from '../../../utils/interrupt-signals.js';
import { removeProtectionTypeList } from '../../../provisioning/remove-protection-types.js';
import {
  stateDestroyTargets,
  formatStackRefSafe,
  listedStackName,
  multipleRegionsError,
} from './refs.js';
import { setupStateBackend, renderRecovery, stackRegionOption } from './setup.js';
import { refuseDestroyTargetsWithoutApp } from '../destroy-runner/emulator-custom-resources.js';

/**
 * The stack whose recorded `terminationProtection` covers `stackName`
 * (go-to-k/cdkd#5238): the stack itself, or the root its `parentStack` chain
 * leads to, read record by record. `undefined` when none is protected. A
 * chain that cycles or runs deeper than any nesting cdkd writes stops there,
 * unprotected by what it could not read; a missing parent record likewise.
 */
async function protectedRootOf(
  stackName: string,
  state: StackState,
  region: string,
  backend: { getState: S3StateBackend['getState'] }
): Promise<string | undefined> {
  let name = stackName;
  let record: StackState | undefined = state;
  const seen = new Set<string>();
  for (let depth = 0; record !== undefined && depth < 32; depth++) {
    if (record.terminationProtection === true) return name;
    const parent: unknown = record.parentStack;
    if (typeof parent !== 'string' || parent === '' || seen.has(parent)) return undefined;
    seen.add(name);
    const parentRegion: string =
      typeof record.parentRegion === 'string' ? record.parentRegion : region;
    name = parent;
    record = (await backend.getState(parent, parentRegion))?.state;
  }
  return undefined;
}

/**
 * `cdkd state destroy <stacks...>` command implementation
 *
 * Destroys a stack's AWS resources AND removes its state record, **without**
 * requiring the CDK app (no synth). The intended audience is anyone who
 * needs to clean up a stack from a working directory that doesn't have the
 * CDK source — a teammate on a different machine, a CI cleanup job after the
 * source repo is gone, etc.
 *
 * Naming distinction:
 * - `cdkd destroy` — synth-driven, requires the CDK app, deletes resources +
 *   state.
 * - `cdkd state destroy` — state-driven, no synth needed, deletes resources +
 *   state.
 * - `cdkd orphan` — synth-driven, requires the CDK app, deletes ONLY the
 *   state record. AWS resources are left intact.
 * - `cdkd state orphan` — state-driven, no synth needed, deletes ONLY the
 *   state record. AWS resources are left intact.
 *
 * Region scoping: when a stack name has multiple state records spread across
 * regions (PR 1 territory), `--stack-region` selects one — it picks WHICH
 * record is loaded, because the region is part of the S3 key.
 *
 * What it does with a record whose BODY names a different region than that key
 * is two things, neither of which this comment described until issue
 * [#3328](https://github.com/go-to-k/cdkd/issues/3328) — it claimed a refusal
 * on `state.region` that had never existed anywhere in the command, while the
 * measured behaviour was the opposite: a planted record at
 * `.../us-east-1/state.json` carrying `"region": "eu-west-1"` locked, saved
 * and deleted against `eu-west-1` and reported `✓ State deleted` while the
 * us-east-1 key survived.
 *
 * 1. `S3StateBackend.getState` normalizes the loaded record's `region` to the
 *    KEY's and WARNS, so this command — which hands `stateResult.state`
 *    straight to `runDestroyForStack` — acts on the region it was pointed at.
 *    The read itself refuses NOTHING; `adoptKeyRegion` carries why, and it is
 *    what keeps `state show` / `state list` / `state orphan` working on such a
 *    record.
 * 2. The DESTROY refuses it when the record still lists resources
 *    (`refuseDivergentRecordRegionForDestroy`, reached through
 *    `runDestroyForStack`), because which region those resources are in is
 *    exactly what the divergence makes undecidable. A resource-less record is
 *    not refused, so cleaning one up still works.
 */
async function stateDestroyCommand(
  stackArgs: string[],
  options: {
    all?: boolean;
    yes: boolean;
    removeProtection?: boolean;
    skipFinalSnapshot?: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    stackRegion?: string;
    profile?: string;
    roleArn?: string;
    verbose: boolean;
    allowUnsupportedTypes?: string[];
    resourceWarnAfter?: ResourceTimeoutOption;
    resourceTimeout?: ResourceTimeoutOption;
  }
): Promise<void> {
  // `--all` is removed (go-to-k/cdkd#3865): the state bucket is shared by
  // every CDK app deployed to the account, so it destroyed stacks ACROSS apps
  // in one command. Refused FIRST -- before any option is validated, the state
  // bucket is listed or anything is prompted, locked or deleted -- and whatever
  // else is on the command line, stack names included: an operator still
  // typing `--all` expected the old meaning, so running only the named stacks
  // would do something they did not ask for.
  if (options.all) {
    throw new CdkdError(
      'cdkd state destroy no longer accepts --all: it destroyed every stack in the state ' +
        'bucket, which every CDK app deployed to this account shares, so one command ' +
        'reached across apps. Name each stack to destroy: ' +
        `cdkd state destroy ${commandHole('stacks...')} (cdkd state list shows them), ` +
        "or run cdkd destroy --all from the CDK app, which destroys only that app's top-level " +
        "stacks (cdkd destroy '**' destroys its CDK Stage stacks too).",
      'STATE_DESTROY_ALL_REMOVED'
    );
  }

  // After the refusal above, which needs no provider; before any stack client
  // scope / globals are set, so provider construction below stays synchronous
  // (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();

  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    // Disable the live progress renderer in verbose mode — debug logs would
    // interleave too aggressively with the live area's in-flight task lines.
    process.env['CDKD_NO_LIVE'] = '1';
  }

  // Mutates `options.resourceWarnAfter` in place when auto-lowering the
  // inherited warn against a shortened --resource-timeout.
  validateResourceTimeouts(options);
  // Seed the provisioning-layer registry so providers with an INNER waiter
  // cap can lift it to the user-resolved budget (issue #1280).
  setResolvedResourceTimeouts(options.resourceTimeout);

  if (stackArgs.length === 0) {
    throw new Error(
      `Stack name is required. Usage: cdkd state destroy ${commandHole('stacks...')}`
    );
  }

  const setup = await setupStateBackend(options);
  // go-to-k/cdkd#4941: the registry below is built in the run's region, as
  // `cdkd destroy` builds its own. A provider captures `ambientRegion()` when it
  // is constructed, and the runner keeps this registry for a stack recorded in
  // `setup.region`, so under `--region X` from a shell in another region it
  // would delete by name in the shell's region. `--region` overrides
  // `AWS_REGION` (`deprecatedRegionOption`), so the SDK is told so too.
  if (options.region) {
    process.env['AWS_REGION'] = setup.region;
    process.env['AWS_DEFAULT_REGION'] = setup.region;
  }
  const providerRegistry = new ProviderRegistry();
  registerAllProviders(providerRegistry, providerClasses);
  providerRegistry.setCustomResourceResponseBucket(setup.bucket);
  if (options.allowUnsupportedTypes?.length) {
    providerRegistry.allowUnsupportedTypes(options.allowUnsupportedTypes);
  }

  // Command-scoped interrupt record (issue #2117) — see the twin in
  // `destroy.ts`. Registered BEFORE the SIGTERM forwarder below so a forwarded
  // signal can never arrive while the command owns no handler of its own.
  const interruptWatch = watchCommandInterrupt({ command: 'cdkd state destroy' });

  // CI cancellation delivers SIGTERM, not Ctrl-C (issue #1342) — route it
  // through the destroy-runner's graceful-SIGINT drain (issue #816). Guarded
  // against a throw for the same reason as the twin in `destroy/command.ts` — which
  // also records why the interrupt SCOPE half is unwound inside the helper.
  let unforwardSigterm: () => void;
  try {
    unforwardSigterm = forwardSigtermToSigint();
  } catch (error) {
    interruptWatch.dispose();
    throw error;
  }

  // go-to-k/cdkd#4705 (Fable N1): as `cdkd destroy --all` does, each stack's
  // post-record writes and lock release overlap the next stack when several
  // are destroyed, and are all awaited in the `finally` below.
  const deferredTails: Array<Promise<void>> = [];
  let deferRegistryTail: ((released: Promise<void>) => void) | undefined;
  try {
    // Resolve target stack names from S3 (no synth). After PR 1, listStacks
    // returns one ref per (stackName, region) pair — same stackName across
    // two regions is two entries.
    const stateRefs = await setup.stateBackend.listStacks();
    const knownStackNames = new Set(stateRefs.map((r) => r.stackName));
    // Be strict: every named stack must exist in state. Silently skipping
    // typos here would be more dangerous than helpful for a destroy command.
    const missing = stackArgs.filter((name) => !knownStackNames.has(name));
    if (missing.length > 0) {
      // Each name through `listedStackName`, so one carrying `, ` or a bare `,`
      // cannot read as two entries of this list (go-to-k/cdkd#3179).
      throw new Error(
        `No state found for stack(s): ${missing.map(listedStackName).join(', ')}.\n` +
          `Run 'cdkd state list' to see available stacks.`
      );
    }
    const stackNames = stackArgs;

    logger.info(
      safeMsg`Found ${stackNames.length} stack(s) to destroy: ${stackNames.map(listedStackName).join(', ')}`
    );

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
    // Issue #2117 — see the twin in `destroy/command.ts` for why the loop and the exit
    // code ask the COMMAND-level question instead, why this stays a call
    // rather than becoming a local, and why the `interrupted ||` disjunct is
    // kept rather than folded into the watch (it fences the CALLEE's reported
    // outcome, which a probe showed is not subsumed).
    const runInterrupted = (): boolean => interrupted || interruptWatch.interrupted();
    // Set only where a `break` leaves at least one target UNPROCESSED — see
    // the twin in `destroy/command.ts` for why the exit code asks this rather than
    // `runInterrupted()` (a signal in the run's tail must not report a
    // completed destroy as unfinished).
    let stoppedEarly = false;
    /**
     * Would any stack AFTER `stackIndex` actually have been destroyed?
     *
     * `stackIndex < stackNames.length - 1` answers "does an INDEX remain",
     * which is not the same question and over-claims: with
     * `--stack-region us-east-1`, a later name whose only state record lives in
     * eu-west-1 is warn-and-skipped by the `targets.length === 0` branch below
     * — it was never going to be destroyed, so a signal before it leaves
     * nothing undone and the run must still exit 0. Measured with StackA in
     * us-east-1 and StackB only in eu-west-1 under `--stack-region us-east-1`
     * (through the since-removed `--all`, go-to-k/cdkd#3865, which fed this
     * loop the same two names): the index form exited 2 having dispatched
     * StackA, i.e. every target it had.
     *
     * The predicate mirrors that branch's own filter over `stateRefs`, the
     * same list the loop selects from. `destroy.ts` needs no counterpart: its
     * `candidateStacks` is already pre-filtered by the set of stack names that
     * have state, so an index there IS a target.
     */
    const targetRemainsAfter = (stackIndex: number): boolean =>
      stackNames.slice(stackIndex + 1).some((name) => {
        const laterRefs = stateRefs.filter((r) => r.stackName === name);
        if (!options.stackRegion) return laterRefs.length > 0;
        return laterRefs.some((r) => r.region === options.stackRegion || !r.region);
      });
    // go-to-k/cdkd#4705: every target stack's scan starts NOW, before the
    // sequential loop (one listing, one run-wide probe cap), prioritized in
    // the loop's order; each stack's destroy then awaits its own memoized
    // result, which promotes it ahead of the rest.
    // Only for the records the loop below destroys (`stateDestroyTargets`).
    const crossPrefixCheck = { cache: new CrossPrefixGuard(setup.stateBackend) };
    if (stackNames.length > 1) deferRegistryTail = (released) => deferredTails.push(released);
    const customResourceTargets: Array<{ stackName: string; region: string }> = [];
    for (const name of stackNames) {
      const refs = stateRefs.filter((r) => r.stackName === name);
      for (const ref of stateDestroyTargets(refs, options.stackRegion) ?? []) {
        const targetRegion = ref.region ?? (await setup.regionFor(name));
        void crossPrefixCheck.cache.full(name, targetRegion, 'prestart');
        customResourceTargets.push({ stackName: name, region: targetRegion });
      }
    }
    // go-to-k/cdkd#6246: under `--aws-emulator`, every target (and its nested
    // stacks) is checked before the first one is touched.
    await refuseDestroyTargetsWithoutApp(
      customResourceTargets,
      setup.stateBackend,
      setup.awsClients
    );
    for (const [stackIndex, stackName] of stackNames.entries()) {
      // After PR 1, the same stackName can have state in multiple regions.
      // Pick the right ref(s):
      // - If --stack-region is given, take the matching ref (skip with warning if none).
      // - If only one region exists, take it.
      // - If multiple regions exist and no --stack-region, error out (ambiguous).
      const refs = stateRefs.filter((r) => r.stackName === stackName);
      let targets: typeof refs;
      const planned = stateDestroyTargets(refs, options.stackRegion);
      if (options.stackRegion) {
        targets = planned ?? [];
        if (targets.length === 0) {
          logger.warn(
            // The stack name is NAMED only when plain, described otherwise: the
            // line carries the `--stack-region` flag, and a block that displays
            // an untrusted value carries no pasteable command (go-to-k/cdkd#3950's
            // S1 rule). The ` (` after it stops a pasted line under bash only;
            // zsh runs a `$( )` name past it. The region beside the flag is the
            // operator's own `--stack-region` argument, not an untrusted value,
            // so it stays shown.
            safeMsg`Skipping ${plainOrDescribed(stackName, 'stack name')} (no state record matches ` +
              safeMsg`--stack-region ${displayIdent(options.stackRegion)})`
          );
          continue;
        }
      } else if (planned !== undefined) {
        targets = planned;
      } else {
        // The candidate regions are raw `listStacks()` key segments
        // (go-to-k/cdkd#3027); the shared builder gives each its boundary.
        throw multipleRegionsError(
          stackName,
          refs,
          `Use --stack-region ${commandHole('region')} to pick one.`
        );
      }

      for (const [refIndex, ref] of targets.entries()) {
        // `ref.region` is an S3 key segment beside cdkd's own ` (region)`
        // annotation, so it takes `formatStackRefSafe`'s boundary
        // (go-to-k/cdkd#3179).
        logger.info(safeMsg`\nPreparing to destroy stack: ${formatStackRefSafe(ref)}`);

        // A region-less (legacy) record is read in the region its own body
        // names, found by the same reconciliation every command uses
        // (go-to-k/cdkd#2100) rather than assumed to be the run's region.
        const refRegion = ref.region ?? (await setup.regionFor(stackName));
        const stateResult = await setup.stateBackend.getState(stackName, refRegion);
        if (!stateResult) {
          logger.warn(
            safeMsg`No state found for stack ${displayStackName(stackName)}` +
              (ref.region ? safeMsg` in ${displayIdent(ref.region)}` : '') +
              ', skipping'
          );
          continue;
        }

        // go-to-k/cdkd#5238: the stack's last deploy recorded
        // `terminationProtection: true`, or it is a nested child under a root
        // stack that did (a root's protection covers its nested stacks, as in
        // CloudFormation; only the root's record carries the setting).
        // Refused before the lock and any delete, as `cdkd destroy` does, and
        // counted toward the partial failure (exit 2) so sibling targets still
        // run; the runner checks again under the lock. `--remove-protection`
        // is the bypass, logged at WARN.
        const protectedRoot = await protectedRootOf(
          stackName,
          stateResult.state,
          refRegion,
          setup.stateBackend
        );
        if (protectedRoot !== undefined) {
          if (options.removeProtection === true) {
            logger.warn(
              safeMsg`Stack ${displayStackName(protectedRoot)} was deployed with terminationProtection: true — bypassing because --remove-protection set`
            );
          } else {
            const recovery = renderRecovery(options, setup);
            const err = new StackTerminationProtectionError(
              stackName,
              undefined,
              {
                args: accountArgs(recovery),
                clause: withheldAccountClause(recovery, 'the command below prints'),
              },
              {
                command: 'cdkd state destroy',
                stackRegion: refRegion,
                ...(protectedRoot !== stackName && { root: protectedRoot }),
              }
            );
            logger.error(safeMsg`  ✗ ${asIsMessage(err.message)}`);
            totalErrors++;
            continue;
          }
        }

        // Issue #2117 — the last check before any delete is issued; see the
        // twin in `destroy/command.ts`. Unconditionally `stoppedEarly`: THIS target is
        // the one left undestroyed, whether or not any follow it.
        if (runInterrupted()) {
          stoppedEarly = true;
          break;
        }

        // Issue #2423 — the deployment-event recorder for this target, the twin
        // of `destroy.ts`'s per-stack bracket: `RUN_STARTED` here, the runner's
        // per-resource events through `eventRecorder`, `RUN_FINISHED` below, and
        // `finalize()` in the `finally`. One run per (stack, region) TARGET, not
        // per command: the events store is keyed by stack AND region, so each
        // target's history lands beside its own state record. Created BELOW the
        // interrupt check above for the reason `destroy.ts` gives — breaking
        // after `RUN_STARTED` would finalize a run for a target nothing touched.
        //
        // `command: 'destroy'` rather than a new literal: the run IS a destroy,
        // through the same runner, and every reader's `command` switch stays
        // complete. Best-effort like every recorder: `record()` / `finalize()`
        // never throw, so a missing `deployments/` write cannot fail the destroy.
        const eventRecorder = startRunRecorder({
          backend: setup.stateBackend,
          stackName,
          region: refRegion,
          command: 'destroy',
        })!;
        let destroyRunResult: DeploymentRunResult = 'SUCCEEDED';
        let result: DestroyRunnerResult;
        try {
          // Set the NestedStackProvider context — fires only when the state
          // file carries an AWS::CloudFormation::Stack record. `state destroy`
          // does not synth, so accountId is not separately resolved here;
          // the field is unused on the destroy path (only `create` builds
          // the synthesized ARN). Bracketed by `interruptWatch.runStack` so a
          // second Ctrl-C in this window escalates through the RUNNER's handler,
          // the only one that can release this stack's lock.
          result = await interruptWatch.runStack(() =>
            withNestedStackContext(
              {
                stateBackend: setup.stateBackend,
                lockManager: setup.lockManager,
                providerRegistry,
                parentStackName: stackName,
                parentRegion: refRegion,
                accountId: 'unknown',
                awsClients: setup.awsClients,
                stateBucket: setup.bucket,
                exportIndexStore: setup.exportIndexStore,
                destroyOptions: {
                  ...(options.profile && { profile: options.profile }),
                  statePrefix: options.statePrefix,
                  // go-to-k/cdkd#2346: a cascading nested child purges its
                  // earlier record versions too (see `purgeStateHistory` below).
                  purgeStateHistory: true,
                  ...(options.removeProtection === true && { removeProtection: true }),
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
                runDestroyForStack(stackName, stateWithRegion(stateResult.state, refRegion), {
                  stateBackend: setup.stateBackend,
                  lockManager: setup.lockManager,
                  providerRegistry,
                  baseAwsClients: setup.awsClients,
                  baseRegion: setup.region,
                  // `getState` adopted the KEY's region into the record above, so
                  // this is the only place the divergence is still visible; the
                  // runner refuses on it when the record still lists resources
                  // (issue #3328).
                  ...(stateResult.divergentBodyRegion !== undefined && {
                    divergentBodyRegion: stateResult.divergentBodyRegion,
                  }),
                  ...(options.profile && { profile: options.profile }),
                  stateBucket: setup.bucket,
                  statePrefix: options.statePrefix,
                  // --yes skips the per-stack prompt inside the runner.
                  skipConfirmation: options.yes,
                  removeProtection: options.removeProtection === true,
                  stateDestroy: true,
                  skipFinalSnapshot: options.skipFinalSnapshot === true,
                  // go-to-k/cdkd#4150: a top-level destroy may resolve a
                  // secret-derived principal list; a deploy never does.
                  resolveSecretDerivedPrincipals: {},
                  // go-to-k/cdkd#2115: a whole-stack teardown (see destroy.ts).
                  stackDestroy: true,
                  // go-to-k/cdkd#2346: the explicit removal of the record, so its
                  // earlier `state.json` versions -- readable bodies of every
                  // property it recorded -- go with it. The maintainer's
                  // decision: this command only; `cdkd destroy` keeps them.
                  purgeStateHistory: true,
                  // go-to-k/cdkd#4705: refuse when another state prefix records the stack.
                  crossPrefixCheck,
                  ...(deferRegistryTail !== undefined && { deferRegistryTail }),
                  exportIndexStore: setup.exportIndexStore,
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
          // Same mapping as `destroy.ts`: a resource error or a skip (issue
          // #1752 — the target is not destroyed and its state was preserved) is
          // a FAILED run; a clean, cancelled or empty-skip destroy is SUCCEEDED.
          destroyRunResult =
            result.errorCount > 0 || result.skippedCount > 0 ? 'FAILED' : 'SUCCEEDED';
          recordRunOutcome(eventRecorder, stackName, destroyRunResult, {
            created: 0,
            updated: 0,
            deleted: result.deletedCount,
            ...(result.errorCount > 0 && { failed: result.errorCount }),
            ...(result.skippedCount > 0 && { skipped: result.skippedCount }),
          });
        } catch (destroyError) {
          destroyRunResult = 'FAILED';
          recordRunFailed(eventRecorder, stackName, destroyError);
          throw destroyError;
        } finally {
          await eventRecorder.finalize(destroyRunResult);
        }
        totalErrors += result.errorCount;
        totalSkipped += result.skippedCount;
        totalOrphanSkips += result.journaledOrphanSkips;
        if (result.interrupted) interrupted = true;
        // Graceful interrupt (issue #816): stop iterating this stack's regions.
        // Issue #2117: read LIVE — see the twin in `destroy/command.ts`. `stoppedEarly`
        // only when a target of THIS stack actually remains; the outer break
        // below decides the same question for the remaining stacks.
        if (runInterrupted()) {
          if (refIndex < targets.length - 1) stoppedEarly = true;
          break;
        }
      }

      // Graceful interrupt (issue #816): stop the outer multi-stack loop too —
      // do not start destroying further stacks once the user has asked to
      // stop. Explicit guard mirroring destroy.ts's stack-loop break (the
      // inner `break` above only exits the per-region loop). `stoppedEarly`
      // asks whether a real TARGET remains, not whether an index does — see
      // `targetRemainsAfter`.
      if (runInterrupted()) {
        if (targetRemainsAfter(stackIndex)) stoppedEarly = true;
        break;
      }
    }

    if (totalErrors > 0) {
      // Partial failure: state.json is preserved by destroy-runner so a
      // re-run picks up the remaining resources. Surface this distinctly
      // from "command crashed" via PartialFailureError → exit code 2.
      throw new PartialFailureError(
        `Destroy completed with ${totalErrors} resource error(s). State preserved — ` +
          `inspect 'cdkd state show <stack>' and re-run 'cdkd state destroy' to retry. ` +
          `If the same resource keeps failing, 'cdkd state orphan <stack> --stack-region <region>' removes the stack's state in that region (every resource's record) without deleting AWS resources.`
      );
    }
    if (interrupted || (interruptWatch.interrupted() && stoppedEarly)) {
      // Graceful SIGINT (issue #816): in-flight deletes finished, state was
      // preserved (trimmed), and the lock was released. Surface a non-zero
      // exit so scripts / CI see the destroy did not complete.
      //
      // NOT `runInterrupted()` — see the twin in `destroy/command.ts`: a signal in the
      // tail of a run that destroyed every target must not report unfinished
      // work there is none of.
      throw new PartialFailureError(
        `Destroy interrupted by Ctrl-C. State preserved — re-run 'cdkd state destroy' to finish.`
      );
    }
    if (totalSkipped > 0) {
      // Issue #1752 — see the twin branch in destroy.ts. Nothing FAILED, but
      // cdkd left resources whose delete it did not confirm, so exiting 0
      // would report a destroy that did not happen.
      throw new PartialFailureError(
        skippedDestroyMessage(totalSkipped, totalOrphanSkips, 'cdkd state destroy')
      );
    }
  } finally {
    // go-to-k/cdkd#4705: every stack's deferred writes and lock release first.
    await Promise.allSettled(deferredTails);
    unforwardSigterm();
    // Issue #2117 — disposed last of the destroy-side handlers; see the twin
    // in `destroy.ts`.
    interruptWatch.dispose();
    setup.dispose();
  }
}

/**
 * Create the `state destroy` subcommand.
 */
export function createStateDestroyCommand(): Command {
  const cmd = new Command('destroy')
    .description(
      "Destroy a stack's AWS resources and remove its state record without requiring the CDK app. " +
        "For removing only the state record (keeping AWS resources intact), use 'cdkd state orphan'."
    )
    .argument('[stacks...]', 'Stack name(s) to destroy (physical CloudFormation names)')
    // Removed (go-to-k/cdkd#3865), but still DECLARED, hidden, so passing it
    // reaches `stateDestroyCommand`'s refusal, which names the replacement,
    // rather than commander's generic `unknown option '--all'`.
    .addOption(new Option('--all').hideHelp())
    .option(
      '--remove-protection',
      'Destroy a stack deployed with terminationProtection: true, and bypass deletion ' +
        'protection on protected resources by flipping the per-resource protection flag ' +
        `off in-place before delete. Covers ${removeProtectionTypeList()}.`,
      false
    )
    .addOption(stackRegionOption())
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  cdkd state destroy MyStack',
        '  cdkd state destroy MyStack OtherStack',
        '  cdkd state destroy MyStack --state-bucket cdkd-state-test',
        '  cdkd state destroy MyStack --stack-region us-west-2',
        '',
        "For removing only the state record (keeping AWS resources intact), use 'cdkd state orphan'.",
      ].join('\n')
    )
    .action(withErrorHandling(stateDestroyCommand));

  [
    ...commonOptions,
    ...stateOptions,
    ...resourceTimeoutOptions,
    allowUnsupportedTypesOption,
    skipFinalSnapshotOption,
    noLocalCustomResourcesOption,
  ].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated on every state subcommand (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
