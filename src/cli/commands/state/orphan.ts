import {
  commandHole,
  pasteableCommand,
  plainOrDescribed,
  withheldTargetClause,
} from '../../../utils/pasteable-command.js';
import { Command, InvalidArgumentError } from 'commander';
import { commonOptions, deprecatedRegionOption, stateOptions } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { confirmOrRefuse } from '../confirm-prompt.js';
import { withErrorHandling } from '../../../utils/error-handler.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import {
  displayAwsMessage,
  displayIdent,
  displayStackName,
  isPasteableIdent,
  safeMsg,
  displaySafe,
} from '../../../utils/display-safe.js';
import { buildForceUnlockCommand } from '../../../state/lock-contention-message.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
  UNREPRODUCIBLE_LOCK_CLAUSE,
} from '../../../state/lock-contention-message.js';
import {
  accountArgs,
  refuseMalformedOrphansForOrphan,
  refuseMalformedOutputs,
  refuseMalformedResourceAttributesForOrphan,
  refuseMalformedResourceEntriesForOrphan,
  refuseMalformedResourcePropertiesForOrphan,
  refuseMalformedState,
  withheldAccountClause,
} from '../../../state/malformed-resources-bag.js';
import { AwsClients, runWithStackAwsClients } from '../../../utils/aws-clients.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import { orphanPrintingBag, printRewriteSummary, printUnresolvable } from '../orphan.js';
import { rewriteResourceReferences } from '../../../analyzer/orphan-rewriter.js';
import { releaseRegistryMarkerQuietly } from '../registry-release.js';
import {
  describedStackRef,
  legacyRecordRefusal,
  STATE_LIST_POINTER,
  refIsDescribed,
  capitalize,
  describedStackSubject,
  noStateInRegionError,
  resolveSingleRegion,
} from './refs.js';
import { setupStateBackend, stackRegionOption, warnOnLiveForeignLock } from './setup.js';

/**
 * `cdkd state orphan <stacks...>` command implementation
 *
 * Removes the cdkd state record (state.json + any lingering lock.json) for
 * one or more stacks. **Does not** touch the underlying AWS resources —
 * `cdkd destroy` is the command that deletes those.
 *
 * The name mirrors the new `cdk orphan` command in aws-cdk-cli: cdkd "orphans"
 * the stack from its own state without touching the AWS resources it was
 * tracking.
 *
 * Behavior:
 * - Default: removes all region keys recorded for the stack, with a single
 *   confirmation that lists every region being affected. Use
 *   `--region <region>` to scope removal to one region when a stack name has
 *   state in multiple regions.
 * - Refuses to remove a locked region's state unless `--force` is set, since
 *   tearing the lock out from under an in-flight deploy can corrupt state.
 * - Confirmation prompt defaults to `(y/N)`, requiring an explicit `y` —
 *   this is more cautious than `cdkd destroy` because the operation orphans
 *   AWS resources from cdkd's view rather than reconciling them.
 * - `--yes` / `--force` skip the prompt.
 * - Skips cleanly when a stack has no state (idempotent).
 */
interface StateOrphanOptions {
  force: boolean;
  yes: boolean;
  /** `--resource <logicalId>`, repeatable (go-to-k/cdkd#4602). */
  resource?: string[];
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  stackRegion?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
}

/**
 * go-to-k/cdkd#4705: drop the stack's kept-resource record under this prefix
 * (`retained.json`): after `state orphan`, a later create no longer takes a
 * kept resource back by name. Best-effort.
 */
async function clearRetainedQuietly(
  backend: Pick<S3StateBackend, 'saveRetainedResources'>,
  stackName: string,
  region: string,
  logger: { warn(message: string): void }
): Promise<boolean> {
  try {
    await backend.saveRetainedResources(stackName, region, []);
    return true;
  } catch (error) {
    logger.warn(
      safeMsg`Could not empty the kept-resource record of ${displayStackName(stackName)} ` +
        safeMsg`(${describeAwsFailure(error).summary}): a later deploy here may still take a kept ` +
        `resource back. Re-run 'cdkd state orphan' once it can write.`
    );
    return false;
  }
}

/**
 * go-to-k/cdkd#4705: for a stack with NO record under this prefix, write the
 * empty `retained.json` (the tombstone) in `stackRegion`, or in every region
 * that still holds anything of the stack here (a kept-resource record, or the
 * event history an older cdkd's destroy left, which would otherwise license
 * taking a kept resource back), and release the registry marker there when it
 * names this prefix. The regions cleared. Best-effort: a failure is warned.
 */
async function clearRetainedWithoutRecord(
  backend: S3StateBackend,
  stackName: string,
  stackRegion: string | undefined,
  logger: { warn(message: string): void; debug(message: string): void }
): Promise<{ cleared: string[]; attempted: number }> {
  if (stackName.includes('/')) return { cleared: [], attempted: 0 };
  const base = `${backend.prefix}/${stackName}/`;
  let regions: string[];
  try {
    const keys = (await backend.listRawKeys(base))
      .map((key) => key.slice(base.length).split('/'))
      .filter((parts) => parts.length >= 2 && parts[0] !== '');
    // A region that still has a region-scoped record keeps its kept list and
    // its marker: only a region with no record here is this sweep's (review
    // O-m1 -- a legacy orphan sweeps every region the stack has). A filter
    // over the keys already listed; no further request.
    const recorded = new Set(
      keys
        .filter((parts) => parts.length === 2 && parts[1] === 'state.json')
        .map((parts) => parts[0]!)
    );
    regions = [
      ...new Set(
        keys
          .map((parts) => parts[0]!)
          .filter((region) => stackRegion === undefined || region === stackRegion)
          .filter((region) => !recorded.has(region))
      ),
    ];
  } catch (error) {
    logger.warn(
      safeMsg`Could not look for a kept-resource record of ${displayStackName(stackName)} ` +
        safeMsg`(${describeAwsFailure(error).summary}).`
    );
    return { cleared: [], attempted: 0 };
  }
  const cleared: string[] = [];
  for (const region of regions) {
    if (await clearRetainedQuietly(backend, stackName, region, logger)) cleared.push(region);
    await releaseRegistryMarkerQuietly(backend, stackName, region, logger);
  }
  return { cleared, attempted: regions.length };
}

async function stateOrphanCommand(stackArgs: string[], options: StateOrphanOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  if (stackArgs.length === 0) {
    throw new Error(`Stack name is required. Usage: cdkd state orphan ${commandHole('stacks...')}`);
  }

  if (options.resource !== undefined && options.resource.length > 0) {
    if (stackArgs.length !== 1) {
      throw new Error(
        `--resource names resources of ONE stack, but ${stackArgs.length} stacks were given. ` +
          `Run 'cdkd state orphan' once per stack.`
      );
    }
    await stateOrphanResources(stackArgs[0]!, options.resource, options);
    return;
  }

  const setup = await setupStateBackend(options);
  try {
    const refs = await setup.stateBackend.listStacks();

    for (const stackName of stackArgs) {
      const stackRefs = refs.filter((r) => r.stackName === stackName);
      if (stackRefs.length === 0) {
        // go-to-k/cdkd#4705: a destroyed stack keeps its `retained.json`
        // (what that destroy kept, which a redeploy here takes back by name).
        // With no record left, orphan clears that, and the registry marker.
        const { cleared, attempted } = await clearRetainedWithoutRecord(
          setup.stateBackend,
          stackName,
          options.stackRegion,
          logger
        );
        // A region whose write failed was warned about, and is not claimed.
        if (attempted > 0 && cleared.length === 0) continue;
        if (cleared.length > 0) {
          logger.info(
            safeMsg`Cleared the kept-resource record of ${plainOrDescribed(stackName, 'stack name')} ` +
              safeMsg`(${cleared.map((r) => displaySafe(r, { asciiOnly: true })).join(', ')}): ` +
              `a later deploy here no longer takes a kept resource back.`
          );
          continue;
        }
        // Every line `state orphan` prints can sit beside a labelled
        // `Destroy with:` row -- this one above the NEXT stack's banner -- so
        // it names the stack only when it is a plain identifier
        // (go-to-k/cdkd#3760).
        logger.info(
          safeMsg`No state found for stack: ${plainOrDescribed(stackName, 'stack name')}, skipping` +
            (isPasteableIdent(stackName) ? '' : safeMsg`. ${STATE_LIST_POINTER}`)
        );
        continue;
      }

      // Pick which region(s) to remove. With --stack-region, restrict to
      // one. The legacy entry (region: undefined) is matched only when the
      // flag is absent — there's no legacy-only flag because the legacy key
      // is self-identifying via its missing region.
      //
      // Presence, not truthiness: `--stack-region ''` is falsy, so a truthy
      // test skipped the filter and silently widened the removal to EVERY
      // region — the opposite of what the caller asked for, on a destructive
      // command.
      //
      // Unreachable defence in depth since issue #2556: `parseStackRegion`
      // refuses an empty value before any command runs, so nothing can drive
      // this branch with one. Kept because it is the correct test either
      // way.
      const targets =
        options.stackRegion !== undefined
          ? stackRefs.filter((r) => r.region === options.stackRegion)
          : stackRefs;

      if (targets.length === 0) {
        // Every value here is an S3 key segment or a legacy state body, so a
        // planted newline forged a line in this very sentence (issue #2170);
        // the shared builder's `described` mode shows each value only when it
        // is a plain identifier, since in a multi-stack run this refusal can
        // print below an earlier stack's `Destroy with:` row (go-to-k/cdkd#3760).
        // The presence check above routes more traffic onto this branch.
        throw noStateInRegionError(stackName, options.stackRegion ?? '', stackRefs, {
          described: true,
        });
      }

      // Lock check applies per region; --force bypasses it.
      if (!options.force) {
        for (const target of targets) {
          const locked = await setup.lockManager.isLocked(stackName, target.region);
          if (locked) {
            // The REGION needs the same treatment as the stack name beside
            // it (issue #2170 round 4): it is an S3 key segment or a legacy
            // state body, so a planted `\n` forged a line in this very
            // sentence — the provenance this file already cites two lines down
            // as the reason to route the hint through the shared builder.
            // Bare word, not '(legacy)': the template below already wraps
            // `where` in parentheses, so the parenthesised form rendered
            // `Stack 'X' ((legacy)) is locked.` Described unless plain: a
            // region keeping its spaces could carry this sentence's own
            // `) is locked.` (go-to-k/cdkd#3179), or wrap into a counterfeit
            // `Run:` row -- the only one on screen when the builder withholds
            // the real command (go-to-k/cdkd#3760).
            const where = target.region ? plainOrDescribed(target.region, 'region') : 'legacy';
            const recoveryCommand = buildForceUnlockCommand(stackName, target.region, {
              profile: options.profile,
              stateBucket: setup.bucket,
              statePrefix: options.statePrefix,
            });
            // Never inside cdkd's own `'...'`: `asciiOnly` kept `'`, `$` and
            // `(`, so a name `x'$(touch OWNED) #` closed a hand-written quote and
            // the rest ran when the sentence was pasted (go-to-k/cdkd#3436). And
            // not in `displayIdent`'s quotes either, as `buildLockContentionMessage`
            // renders it: this refusal belongs to `state orphan`'s run, where a
            // padded name kept inside quotes could wrap into a counterfeit `Run:`
            // row -- the only one on screen when the builder withholds the real
            // command -- so a name that is not a plain identifier is DESCRIBED,
            // as the region beside it is (go-to-k/cdkd#3760). A plain name holds
            // no shell metacharacter, so the pasted sentence is inert.
            throw new Error(
              `${capitalize(describedStackSubject(stackName))} (${where}) is locked. ` +
                // Through the shared builder rather than hand-interpolated
                // (issue #2170): `target.region` comes from an S3 key segment
                // or a legacy state body, so a raw `\n` here forged a second
                // instruction line INSIDE the quotes. It also picks up the
                // bucket / prefix / profile qualification this hint lacked.
                // ONE call. A legacy lock key has no region, which the
                // builder expresses as `undefined` — passing `''` made its
                // emptiness guard suppress the whole command, so that branch
                // ALWAYS fell through to a hand-built UNQUOTED fallback that
                // also dropped --profile / --state-bucket, i.e. exactly the
                // wrong-lock-object harm this hint exists to prevent.
                // `UNREPRODUCIBLE_LOCK_CLAUSE`, not a local copy, and as its
                // OWN SENTENCE rather than spliced into `Run: ... first`.
                //
                // This site used to carry its own noun phrase naming "the
                // recorded name or region", which is what let it splice. Issue
                // go-to-k/cdkd#3377 gave the builder three more values it can
                // suppress on — the profile, the state bucket and the state
                // prefix, all three of which THIS call site passes just above —
                // so the copy blamed the stack name for a bad profile, at the
                // one call site that change made newly reachable. A third
                // spelling of a sentence enumerating a growing list is how the
                // list goes stale, so the shared constant wins; but it is a
                // full sentence, and go-to-k/cdkd#3390 round 3 measured the
                // first attempt reading `Run: Inspect the lock object
                // directly: ... . first, or pass --force`. Branching is what
                // the shared wording costs, and it is cheaper than a fourth
                // copy. `lock-manager.ts` reached the same conclusion.
                //
                // Still NOT a `<unrenderable>` placeholder: the builder
                // suppresses both for a value with nothing renderable AND for
                // one sanitization merely ALTERED, and a placeholder would
                // contradict the sentence above, which renders `my stack`
                // perfectly well.
                (recoveryCommand
                  ? `Run: ${recoveryCommand} first, or pass --force to remove anyway.`
                  : `${UNREPRODUCIBLE_LOCK_CLAUSE} Or pass --force to remove anyway.`)
            );
          }
        }
      }

      // Single confirmation listing all regions being affected.
      if (!options.yes && !options.force) {
        // Both the warning banner and the question below render this one
        // string, beside the labelled `Destroy with:` line, so each half is
        // shown only when it is a plain identifier and DESCRIBED otherwise
        // (`describedStackRef`, go-to-k/cdkd#3760): a planted REGION padded to
        // the terminal width wrapped into a counterfeit `Destroy with:` row
        // two lines above the real one. A forged line in this sentence is
        // worse than one in an error — it is the one the operator answers `y`
        // to (issue #2170 round 4) — and a described half carries no `,`, so
        // the `[...]` list cannot gain an entry either (go-to-k/cdkd#3179).
        const targetList = targets.map((t) => describedStackRef(t)).join(', ');
        // `plainIdent` for the same reason as the legacy refusals in this file
        // (go-to-k/cdkd#3696): a labelled `Destroy with:` line names a target
        // only when it is a plain identifier, and a hole says why.
        // The run's account flags (go-to-k/cdkd#4648), so the pasted destroy
        // acts on the bucket this command read.
        const bannerAccount = {
          profile: options.profile,
          stateBucket: setup.bucket,
          statePrefix: options.statePrefix,
        };
        const destroyCmd = pasteableCommand('cdkd destroy', [
          { value: stackName, hole: 'stack', opts: { patternMatched: true, plainIdent: true } },
          ...accountArgs(bannerAccount),
        ]);
        const bannerAccountClause = withheldAccountClause(
          bannerAccount,
          'the command below prints'
        ).trimEnd();
        process.stdout.write(
          `\nWARNING: This removes cdkd's state record for [${targetList}] only. ` +
            `AWS resources will NOT be deleted.` +
            // A described half is not an identity: two records of one stack
            // with non-plain regions read the same at the `y` prompt.
            (targets.some(refIsDescribed) ? ` ${STATE_LIST_POINTER}` : '') +
            `\n` +
            `Delete the actual resources instead with the command below.` +
            withheldTargetClause(destroyCmd, 'stack', 'cdkd destroy') +
            (bannerAccountClause === '' ? '' : ` ${bannerAccountClause}`) +
            `\nDestroy with: ${destroyCmd.command}\n\n`
        );
        const ok = await confirmStateOrphanRemoval(
          `Remove state for ${targetList} from s3://${setup.bucket}/${setup.prefix}/?`
        );
        if (!ok) {
          logger.info(
            // No pointer: this line only follows the banner, which printed it
            // for any described target (`refIsDescribed` covers the name).
            safeMsg`Cancelled removal of state for stack: ${plainOrDescribed(stackName, 'stack name')}`
          );
          continue;
        }
      }

      // Iterate over every selected region. forceReleaseLock is idempotent
      // (no-op when no lock present). The two arms below delete DIFFERENT
      // keys: see the comments on each.
      for (const target of targets) {
        if (target.region) {
          // Issue #2171: this force-release takes no lock of its own and
          // deletes whatever is there, including a LIVE one belonging to an
          // in-flight deploy. That is deliberate — a stuck lock must not make
          // a state record unremovable — but it was silent, so say what is
          // being destroyed. Best-effort: a failed read must not block the rm.
          await warnOnLiveForeignLock(setup.lockManager, stackName, target.region, logger);
          await setup.stateBackend.deleteState(stackName, target.region);
          await setup.lockManager.forceReleaseLock(stackName, target.region);
          // go-to-k/cdkd#4705: what a destroy kept stops licensing a later
          // create to take it back by name (the tombstone), then -- the record
          // being gone -- the stack registry marker naming this prefix goes
          // too: record, tombstone, marker, as the no-record path does.
          await clearRetainedQuietly(setup.stateBackend, stackName, target.region, logger);
          await releaseRegistryMarkerQuietly(setup.stateBackend, stackName, target.region, logger);
        } else {
          // Pure legacy record without a region body field. Both keys are the
          // region-less ones, and they are separate objects: issue #2537, the
          // state file was never deleted here because `forceReleaseLock`
          // targets `{prefix}/{stack}/lock.json` — the LOCK — while the record
          // itself sits at `{prefix}/{stack}/state.json`. The success line
          // below printed regardless, so a removal was reported that had not
          // happened. `deleteState` cannot be used: it requires a region.
          await warnOnLiveForeignLock(setup.lockManager, stackName, undefined, logger);
          await setup.stateBackend.deleteLegacyState(stackName);
          await setup.lockManager.forceReleaseLock(stackName, undefined);
          // go-to-k/cdkd#4705: no region-scoped record is left, so the
          // tombstone, and the release of any marker naming this prefix, in
          // every region the stack still has anything under this prefix --
          // as the no-record path does. Non-fatal (it warns).
          await clearRetainedWithoutRecord(setup.stateBackend, stackName, undefined, logger);
        }
        // After the operator's `y`, just below the banner's `Destroy with:`
        // row: `describedStackRef`, as the banner, since a padded region in
        // `formatStackRefSafe`'s quotes still wraps (go-to-k/cdkd#3760).
        // Under `--yes` / `--force` no banner printed the pointer, so this line
        // carries it when it described anything. Interactively the banner
        // already did, once for the whole run.
        logger.info(
          safeMsg`✓ Removed state for stack: ${describedStackRef(target)}` +
            ((options.yes || options.force) && refIsDescribed(target)
              ? safeMsg`. ${STATE_LIST_POINTER}`
              : '')
        );
      }
    }
  } finally {
    setup.dispose();
  }
}

/** Accumulate `--resource <logicalId>` (repeatable), refusing an empty value. */
function collectResourceOption(value: string, previous: string[] | undefined): string[] {
  if (value.trim() === '') {
    throw new InvalidArgumentError('expected a logical id, got an empty value.');
  }
  return [...(previous ?? []), value];
}

/**
 * `cdkd state orphan <stack> --resource <logicalId>...` (go-to-k/cdkd#4602).
 *
 * The state-driven sibling of `cdkd orphan <constructPath>`: removes the named
 * records from ONE stack's state without a CDK app, and leaves every AWS
 * resource in place. It is the way to drop the record of a resource whose
 * construct has already left the template (a delete the deploy skipped),
 * which `cdkd orphan` cannot address and whole-stack `cdkd state orphan`
 * over-reaches on: that drops every record of a still-deployed stack.
 *
 * Shares `cdkd orphan`'s write path: the same malformed-record refusals at the
 * load, `rewriteResourceReferences` for the `Ref` / `Fn::GetAtt` / `Fn::Sub` /
 * `dependencies` / `outputs` other records hold to a removed one (unresolvable
 * refuses unless `--force`), the create-token rotation, and an If-Match save
 * under the stack's lock. Unlike the whole-stack form, `--force` does NOT
 * bypass a held lock: this is a read-modify-write of a record another run may
 * be writing.
 *
 * Refuses: more than one stack, a region-ambiguous stack without
 * `--stack-region` (`resolveSingleRegion`), a legacy region-less record, an id
 * not in the record, and an `AWS::CloudFormation::Stack` record whose child
 * state record still exists (the child's records would be left with nothing
 * that removes them).
 */
async function stateOrphanResources(
  stackName: string,
  requested: string[],
  options: StateOrphanOptions
): Promise<void> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope is set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();
  const logicalIds = [...new Set(requested)];

  const setup = await setupStateBackend(options);
  let clients: AwsClients | undefined;
  try {
    const refs = await setup.stateBackend.listStacks();
    const ref = resolveSingleRegion(stackName, refs, options.stackRegion);
    if (!ref.region) {
      throw legacyRecordRefusal(stackName);
    }
    const region = ref.region;
    const recovery: LockRecoveryContext = {
      profile: options.profile,
      stateBucket: setup.bucket,
      statePrefix: options.statePrefix,
    };

    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    const acquired = await setup.lockManager.acquireLock(stackName, region, owner, 'state-orphan');
    if (!acquired) {
      throw new Error(
        await buildLockContentionMessage({
          lockManager: setup.lockManager,
          stackName,
          region,
          recovery,
        })
      );
    }

    try {
      const stateData = await setup.stateBackend.getState(stackName, region);
      if (!stateData) {
        throw new Error(
          `No state found for ${describedStackRef(ref)} in s3://${setup.bucket}/${setup.prefix}/. ` +
            `Run 'cdkd state list' to see available stacks.`
        );
      }
      const { state, etag, migrationPending } = stateData;

      // The refusals `cdkd orphan` makes at the load, for the same reason:
      // this run SAVES the rewritten record, so a container it cannot read is
      // refused rather than laundered into a well-formed one. Scoped to the
      // survivors where `cdkd orphan` scopes them.
      refuseMalformedState(state, stackName, region, recovery);
      refuseMalformedOutputs(state, stackName, region, recovery);
      refuseMalformedResourceEntriesForOrphan(state, logicalIds, stackName, region, recovery);
      refuseMalformedResourcePropertiesForOrphan(state, logicalIds, stackName, region, recovery);
      refuseMalformedResourceAttributesForOrphan(state, logicalIds, stackName, region, recovery);
      refuseMalformedOrphansForOrphan(state, stackName, region, recovery);

      // OWN keys: `in` would answer true for an id spelled `constructor`.
      const missing = logicalIds.filter((id) => !Object.hasOwn(state.resources, id));
      if (missing.length > 0) {
        throw new Error(
          `Resource(s) not in state for ${describedStackRef(ref)}: ` +
            `${missing.map((id) => displayIdent(id)).join(', ')}.\n` +
            `Available logical IDs: ${Object.keys(state.resources)
              .map((id) => displayIdent(id))
              .join(', ')}`
        );
      }

      // A nested stack's resources live in the CHILD's own state record
      // (`<parent>~<logicalId>`). Dropping only the parent's row would leave
      // the child's records with nothing that ever removes them: no parent
      // deploy or destroy reaches a child its record no longer names. Checked
      // for EVERY target, whatever its recorded type (a torn row's type proves
      // nothing), in any region, and listed again here under the lock so a
      // child a concurrent deploy created after the first listing is seen.
      const refsUnderLock = await setup.stateBackend.listStacks();
      for (const id of logicalIds) {
        const child = `${stackName}~${id}`;
        const childRefs = refsUnderLock.filter((r) => r.stackName === child);
        // The parent's own region first, where a nested child normally lives.
        const childRef = childRefs.find((r) => r.region === region) ?? childRefs[0];
        if (childRef === undefined) continue;
        const otherRegions = childRefs.length - 1;
        // The CHILD's own region selects its record, which need not be the
        // parent's.
        const childCommand = pasteableCommand('cdkd state orphan', [
          { value: child, hole: 'stack', opts: { plainIdent: true } },
          ...(childRef.region !== undefined
            ? [
                {
                  flag: '--stack-region',
                  value: childRef.region,
                  hole: 'region',
                  opts: { plainIdent: true },
                },
              ]
            : []),
          // The run's account flags (go-to-k/cdkd#4648): the drop removes the
          // child record in the bucket this run read.
          ...accountArgs(recovery),
        ]);
        const accountClause = withheldAccountClause(recovery, 'the command below prints').trimEnd();
        throw new Error(
          `${capitalize(plainOrDescribed(id, 'logical id'))} has a nested stack's state record ` +
            `of its own. The child's resources are recorded there, and removing this row would ` +
            `leave that record behind with nothing that removes it. Drop the child's record ` +
            `first (it keeps the child's AWS resources; a child with nested stacks of its own ` +
            `has records under '<child>~<logicalId>' too), then re-run.` +
            withheldTargetClause(childCommand, 'stack', 'cdkd state orphan') +
            (otherRegions > 0
              ? ` The child also has records in ${otherRegions} other region(s); ` +
                `'cdkd state list' shows them, and each needs the same drop.`
              : '') +
            (accountClause === '' ? '' : ` ${accountClause}`) +
            `\nDrop the child with: ${childCommand.command}`
        );
      }

      // Per-STACK-region clients and providers for the live `Fn::GetAtt`
      // reads the rewrite may make: a provider takes its clients at
      // construction, and the record lives in `region`, not the command's.
      clients = new AwsClients({
        region,
        ...(options.profile && { profile: options.profile }),
      });
      const scopedClients = clients;
      const registry = runWithStackAwsClients(scopedClients, () => {
        const scoped = new ProviderRegistry();
        registerAllProviders(scoped, providerClasses);
        return scoped;
      });
      // go-to-k/cdkd#3869: see `orphanPrintingBag`.
      const rewriteResult = await withPrintingSecrets(orphanPrintingBag(state), async () => {
        const result = await runWithStackAwsClients(scopedClients, () =>
          rewriteResourceReferences(state, logicalIds, registry, { force: options.force })
        );

        printRewriteSummary(result.rewrites, logicalIds);

        if (result.unresolvable.length > 0 && !options.force) {
          printUnresolvable(result.unresolvable);
          throw new Error(
            `Orphan aborted: ${result.unresolvable.length} reference(s) could not be resolved.\n` +
              `Re-run with --force to fall back to cached attribute values from state, ` +
              `or fix the underlying provider/AWS issue and retry.`
          );
        }
        if (result.unresolvable.length > 0) {
          printUnresolvable(result.unresolvable);
          logger.warn(
            safeMsg`--force: continuing despite ${result.unresolvable.length} unresolved reference(s); ` +
              `the original intrinsic was left in place where the cache also lacked the value.`
          );
        }
        return result;
      });

      const idList = logicalIds.map((id) => displayIdent(id)).join(', ');
      if (!options.yes && !options.force) {
        process.stdout.write(
          `\nWARNING: This removes cdkd's state record of ${logicalIds.length} resource(s) ` +
            `[${idList}] from ${describedStackRef(ref)} only. AWS resources will NOT be deleted, ` +
            `and cdkd stops managing them. The stack's other records are kept.` +
            (refIsDescribed(ref) ? ` ${STATE_LIST_POINTER}` : '') +
            `\n\n`
        );
        const ok = await confirmStateOrphanRemoval(
          `Remove the record(s) of ${idList} from state for ${describedStackRef(ref)}?`,
          { resource: true }
        );
        if (!ok) {
          logger.info(
            safeMsg`Cancelled removal of resource record(s) for stack: ${plainOrDescribed(stackName, 'stack name')}`
          );
          return;
        }
      }

      // go-to-k/cdkd#4438, as `cdkd orphan`: the removed resources still hold
      // this stack's create tokens, so the next create of them must send new
      // ones. Before the save, fail-closed.
      await setup.stateBackend.rotateCreateTokenNonce(stackName, region, logicalIds);
      await setup.stateBackend.saveState(stackName, region, rewriteResult.state, {
        expectedEtag: etag,
        ...(migrationPending && { migrateLegacy: true }),
      });

      logger.info(
        safeMsg`✓ Removed ${logicalIds.length} resource record(s) from state: ${idList} ` +
          safeMsg`(${describedStackRef(ref)}). AWS resources are still in AWS; cdkd will no longer manage them.`
      );
    } finally {
      await setup.lockManager.releaseLock(stackName, region).catch((err: unknown) => {
        logger.warn(
          safeMsg`Failed to release lock: ${displayAwsMessage(describeAwsFailure(err).detail)}`
        );
      });
    }
  } finally {
    clients?.destroy();
    setup.dispose();
  }
}

/**
 * Create the `state orphan` subcommand.
 */
export function createStateOrphanCommand(): Command {
  const cmd = new Command('orphan')
    .description(
      'Orphan one or more stacks from cdkd state (removes the state record; does NOT delete AWS resources)'
    )
    .argument('<stacks...>', 'Stack name(s) to orphan from state')
    .option(
      '-f, --force',
      'Skip confirmation and remove even if the stack is locked. With --resource it does NOT ' +
        'bypass a held lock, and it ALSO enables the cached-attribute fallback: a reference ' +
        'another record holds that cannot be resolved live takes the value cached in state, ' +
        "except a value cdkd recognises as a credential (by attribute name, a custom resource's " +
        'attribute, or a known secret-valued attribute), a redaction mask or a secret ' +
        'reference, which are left unresolved',
      false
    )
    .option(
      '--resource <logicalId>',
      "Remove only this resource's record from the stack's state, rewriting the references " +
        'other records hold to it (repeatable; requires exactly one stack). The stack stays deployed',
      collectResourceOption
    )
    .addOption(stackRegionOption())
    .action(withErrorHandling(stateOrphanCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for state subcommands (PR 5). Accepted for
  // backward compatibility; warning emitted at runtime via
  // warnIfDeprecatedRegion (called from setupStateBackend).
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}

/**
 * `cdkd state orphan`'s confirmation prompt. Its only call site is inside the
 * `if (!options.yes && !options.force)` block in `stateOrphanCommand`, which
 * is what keeps `confirmOrRefuse`'s non-interactive refusal (issue #2275)
 * from firing on a flagged run.
 *
 * The `(y/N): ` suffix is preserved verbatim from before issue #2275 folded
 * the guard in: it is user-visible output, and only this prompt and
 * `cdkd rollback` ever spelled it that way.
 *
 * Exported for unit testing — internal to the state-orphan flow otherwise.
 */
export async function confirmStateOrphanRemoval(
  prompt: string,
  opts?: { readonly resource?: boolean }
): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    suffix: ' (y/N): ',
    // With `--resource`, `--force` also turns on the rewriter's cached-attribute
    // fallback, so the refusal points at `-y` alone (go-to-k/cdkd#4602).
    refusal: opts?.resource
      ? 'The cdkd state orphan confirmation prompt cannot run in a non-interactive ' +
        'environment. Pass -y / --yes to confirm the removal, or run the command from ' +
        'a real terminal.'
      : 'The cdkd state orphan confirmation prompt cannot run in a non-interactive ' +
        'environment. Pass -y / --yes (or -f / --force) to confirm the removal, or ' +
        'run the command from a real terminal.',
  });
}
