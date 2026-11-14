/**
 * `cdkd drift`: `--revert`: the per-stack driver and its summary.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { getLogger, type ConsoleLogger } from '../../../utils/logger.js';
import {
  cdkdRemedy,
  deployReplaceCommand,
  pasteableCommand,
  proseQuoted,
} from '../../../utils/pasteable-command.js';
import { PartialFailureError } from '../../../utils/error-handler.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import {
  type LockRecoveryContext,
  buildLockContentionMessage,
} from '../../../state/lock-contention-message.js';
import { AwsClients, runWithStackAwsClients } from '../../../utils/aws-clients.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import { hasOwnKey, defineOwnKey } from '../../../utils/own-keys.js';
import type { ProducerRegionEvidence } from '../../../deployment/producer-regions-scope.js';
import {
  type ResourceState,
  type StackState,
  stackInstanceIdCarriedFrom,
} from '../../../types/state.js';
import {
  withUnsettledProperties,
  withoutUnsettledProperties,
  unsettledPropertiesOf,
  unsettledItemsField,
} from '../../../state/unsettled-properties.js';
import { secretNamePrintingBag } from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import { type StackDriftReport, matchOutcome, type DriftedOutcome } from './outcome.js';
import { DriftSecretResolvers } from './secret-resolution.js';
import { maskMarkedNoEchoBaseline } from './redaction.js';
import { revertDriftedOutcome } from './revert-outcome.js';
import {
  humanTextSink,
  printRevertPlan,
  confirmPrompt,
  runWithConcurrency,
  revertCommandLine,
} from './plan.js';

/**
 * `--revert`: AWS ← state.
 *
 * For each drifted resource, call `provider.update(logicalId, physicalId,
 * resourceType, properties /*new*\/, previousProperties /*old*\/)` with:
 *   - `properties` = `buildRevertNewProperties(...)` — the AWS-current
 *     snapshot with the drifted top-level subtrees overlaid by the
 *     state-recorded `observedProperties`. Non-drifted keys carry their
 *     AWS-current values, so a diff-based provider's update sees
 *     `newVal === oldVal` and produces no AWS-side mutation for them
 *     (load-bearing — see helper docstring for why "drifted-only
 *     partial" is not safe).
 *   - `previousProperties` = AWS-current properties (the previous-known
 *     truth, captured during the drift read so we don't re-issue it).
 *
 * Per-resource failures are collected and surface as `PartialFailureError`
 * (exit 2) at the end. State is otherwise NOT updated by `--revert` — once the
 * update succeeds, AWS values match state by definition. The ONE exception is
 * a provider-reported NARROWING (issue #1644): see
 * {@link collectNarrowedTopLevelKeys}.
 *
 * The per-stack lock is acquired before any update so a concurrent
 * `cdkd deploy` cannot race the in-flight property changes.
 */
export async function runRevert(
  reports: StackDriftReport[],
  // go-to-k/cdkd#4283: each stack's WRITES go through its own region's clients
  // and providers, as its detection reads do. Through the command's registry a
  // stack in another region was updated in the wrong one, and an upsert there
  // (`PutMetricAlarm`, `PutParameter`, `PutRule`) created an untracked twin.
  regionScope: (region: string) => { clients: AwsClients; registry: ProviderRegistry },
  stateBackend: S3StateBackend,
  stateConfig: { bucket: string; prefix: string },
  awsClients: AwsClients,
  options: {
    yes?: boolean;
    dryRun?: boolean;
    json?: boolean;
    concurrency?: number;
    profile?: string | undefined;
  }
): Promise<false | void> {
  const logger = getLogger();
  // Issue #2230: see the note in `runAccept`.
  const out = humanTextSink(options.json);
  // The recovery command a contention message suggests must resolve to the
  // SAME lock object this command was working on — `cdkd force-unlock`
  // re-resolves the bucket from the ambient profile otherwise (issue #2170).
  const lockRecovery: LockRecoveryContext = {
    profile: options.profile,
    stateBucket: stateConfig.bucket,
    statePrefix: stateConfig.prefix,
  };

  printRevertPlan(reports, out, lockRecovery);

  if (options.dryRun) {
    logger.info('--dry-run: AWS will NOT be modified. Re-run without --dry-run to apply.');
    return;
  }

  if (!options.yes) {
    const ok = await confirmPrompt(
      `Push cdkd state values back into AWS for the resources shown above?`,
      out
    );
    if (!ok) {
      logger.info('Aborted.');
      return false;
    }
  }

  const lockManager = new LockManager(awsClients.s3, stateConfig);
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const tally: RevertTally = {
    totalFailed: 0,
    totalUnsupported: 0,
    totalSucceeded: 0,
    // Issue #1914 (minor): counted apart from `totalFailed`, whose summary line
    // calls every entry an "AWS update failure". A resource cdkd could not
    // re-resolve never reached `provider.update` at all, and telling the user to
    // look at an update that did not happen sends them to the wrong place.
    totalUnresolvable: 0,
  };

  for (const report of reports) {
    // Issue #2135: exhaustive for the same reason `--accept` is — and the
    // stakes are higher here, since this is the arm that WRITES to AWS.
    const driftedOutcomes = report.outcomes.flatMap((o) =>
      matchOutcome<DriftedOutcome[]>(o, {
        drifted: (d) => [d],
        // Only a drifted outcome has a state value worth pushing back. A
        // `notCompared` one must never be swept in with `clean`: cdkd could not
        // resolve what its state records, so it does not know what to write —
        // and a revert that guesses installs a wrong value on a live resource,
        // which is the #2108 defect this file already refuses per resource.
        clean: () => [],
        notCompared: () => [],
        unsupported: () => [],
        skipped: () => [],
        // Refused by name before this runs (`refuseDeletedForRemediation`,
        // go-to-k/cdkd#4283): there is no AWS-current value for a resource
        // AWS reports gone, and nothing here can recreate one.
        deleted: () => [],
      })
    );
    if (driftedOutcomes.length === 0) {
      continue;
    }
    const scope = regionScope(report.region);
    await runWithStackAwsClients(scope.clients, async () => {
      // Check the boolean (issue #2161): a bare `acquireLock` returns `false` for
      // a live foreign lock without throwing, so the discarded return let `drift
      // --revert` issue `provider.update` against live AWS under a concurrent
      // deploy and then release that deploy's lock. Throwing on `!acquired`
      // aborts before any provider call.
      const acquired = await lockManager.acquireLock(
        report.stackName,
        report.region,
        owner,
        'drift-revert'
      );
      if (!acquired) {
        throw new Error(
          await buildLockContentionMessage({
            lockManager,
            stackName: report.stackName,
            region: report.region,
            recovery: lockRecovery,
          })
        );
      }
      // Provider-reported narrowings, keyed by logical id (issue #1644).
      // Collected inside the concurrent tasks and applied to state ONCE, under
      // the same lock, after they all settle.
      const narrowedByLogicalId = new Map<string, Record<string, unknown>>();
      // go-to-k/cdkd#4476: the identity half of each revert's answer — the
      // physical id and the redacted `attributes` the record takes from
      // `update()`'s result, keyed by logical id and present only where they
      // differ from the record. Applied in the same single write as the
      // narrowings above.
      const reRecordedByLogicalId = new Map<
        string,
        { physicalId: string; attributes: Record<string, unknown> | undefined }
      >();
      // go-to-k/cdkd#5380: the reverted records whose `unsettledProperties`
      // the same write clears.
      const settledByRevert = new Map<string, ResourceState>();
      // Issue #1914: one resolver per stack, re-resolving the secret expressions
      // the state baseline stores so the provider is handed the concrete value.
      // Deliberately NOT the drift-detection run's map: that one is keyed
      // plaintext -> expression (the redaction direction), and a revert needs the
      // resolution direction, against AWS as it is NOW rather than as it was when
      // the report was built.
      //
      // Issue [#2108](https://github.com/go-to-k/cdkd/issues/2108): a BAG of
      // resolvers, one per region that must answer, because this is the arm that
      // WRITES. `desiredProperties` goes straight to `provider.update`, so a
      // reference re-resolved in the wrong region does not fail — it succeeds
      // with a foreign credential and installs it on a live resource. Each
      // reference is routed by `classifyReplaySecretRegion`, and a reference
      // whose origin cannot be established is REFUSED before any update.
      try {
        const revertSecretResolvers = new DriftSecretResolvers(report.region);
        // The foreign-region evidence for this stack, as the detection site read
        // it — a nested child's ancestors included (go-to-k/cdkd#4213).
        const revertProducerRegions = report.producerRegions;
        // go-to-k/cdkd#3869: each revert runs under the resource's printing bag,
        // so a name derived from a secret is masked on every line it logs: the
        // provider's own, the retry lines and the failure line naming AWS's text.
        const tasks = driftedOutcomes.map(
          (outcome) => () =>
            withPrintingSecrets(
              secretNamePrintingBag(outcome.logicalId, report.state.resources),
              async () => {
                await revertDriftedOutcome({
                  logger,
                  tally,
                  report,
                  scope,
                  revertSecretResolvers,
                  revertProducerRegions,
                  narrowedByLogicalId,
                  reRecordedByLogicalId,
                  settledByRevert,
                  outcome,
                });
              }
            )
        );

        await runWithConcurrency(tasks, concurrency);

        // Persist the provider-reported narrowings (issue #1644), still under
        // the stack lock. Written to the SAME field the drift comparator uses as
        // its baseline — `observedProperties` when the resource has one, else
        // `properties` — exactly as `--accept` does, so the next `cdkd drift`
        // compares AWS against what the provider said it delivered. `properties`
        // is left alone when an observed capture exists: it is the user's
        // last-deployed TEMPLATE intent, and a narrowing is an AWS-side fact,
        // not a template edit.
        //
        // The same write carries each revert's returned identity
        // (go-to-k/cdkd#4476), applied after the narrowing to the same record.
        if (
          narrowedByLogicalId.size > 0 ||
          reRecordedByLogicalId.size > 0 ||
          settledByRevert.size > 0
        ) {
          const resources: Record<string, ResourceState> = { ...report.state.resources };
          let settledCount = 0;
          for (const [logicalId, settled] of settledByRevert) {
            const existing = resources[logicalId];
            if (!existing) continue;
            // go-to-k/cdkd#5498: a name the revert kept keeps its attempted
            // items (`withUnprovenUnsettled` carried them onto `settled`).
            resources[logicalId] = {
              ...withUnsettledProperties(
                withoutUnsettledProperties(existing),
                unsettledPropertiesOf(settled)
              ),
              ...unsettledItemsField(settled, unsettledPropertiesOf(settled)),
            };
            settledCount++;
          }
          let recordedCount = 0;
          for (const [logicalId, delta] of narrowedByLogicalId) {
            const existing = resources[logicalId];
            if (!existing) continue;
            const hasObserved = existing.observedProperties !== undefined;
            const baselineSource = hasObserved ? existing.observedProperties : existing.properties;
            const newBaseline = JSON.parse(JSON.stringify(baselineSource ?? {})) as Record<
              string,
              unknown
            >;
            let changed = false;
            for (const [key, value] of Object.entries(delta)) {
              // ONLY a key the baseline already declares may move. The bag sent
              // to `update()` starts as the AWS-CURRENT snapshot, so it carries
              // keys the baseline never had (an out-of-band tag, an AWS-computed
              // field); a provider that echoes one back in a changed shape would
              // otherwise INSERT it into state — `--revert` behaving like
              // `--accept`, the thing the per-key delta exists to prevent.
              if (!hasOwnKey(newBaseline, key)) continue;
              if (value === undefined) {
                delete newBaseline[key];
                changed = true;
                continue;
              }
              // A VALUE is recorded only against an `observedProperties`
              // baseline. Without one the baseline is the raw TEMPLATE, and
              // `buildRevertNewProperties` ran in `preserveUntemplated` mode —
              // so the value that was sent deliberately carries every AWS-
              // authored path the template never declared. Writing it into
              // `properties` would make the DESIRED baseline describe AWS-side
              // values and silently disable the #1160 absent-field removal
              // derivation, which reads that side (`.claude/rules/providers.md`:
              // what you return is what you SENT, AWS-side defaults belong in
              // `observedProperties`). A DROP is still safe there — it removes,
              // never imports — so the loop this fix exists to break still
              // closes for the shape that actually produces it.
              if (!hasObserved) continue;
              defineOwnKey(newBaseline, key, value);
              changed = true;
            }
            if (!changed) continue;
            recordedCount++;
            // go-to-k/cdkd#4043 Phase C: the delta carries the value the revert
            // SENT at a marked coordinate (the live value kept there), which
            // the value arm misses for a number or a value under 4 characters.
            const writtenBaseline = maskMarkedNoEchoBaseline(newBaseline, existing, hasObserved);
            resources[logicalId] = hasObserved
              ? { ...existing, observedProperties: writtenBaseline }
              : { ...existing, properties: writtenBaseline };
          }
          let reRecordedCount = 0;
          for (const [logicalId, identity] of reRecordedByLogicalId) {
            const existing = resources[logicalId];
            if (!existing) continue;
            reRecordedCount++;
            // Absent rather than `undefined` when the answer dropped them —
            // `recordAfterRollbackUpdate`'s shape for a replaced resource that
            // reported none.
            const { attributes: _replaced, ...rest } = existing;
            resources[logicalId] = {
              ...rest,
              physicalId: identity.physicalId,
              ...(identity.attributes !== undefined && { attributes: identity.attributes }),
            };
          }

          if (recordedCount === 0 && reRecordedCount === 0 && settledCount === 0) {
            // Every reported narrowing was on a key state does not track, or was
            // a value on a template-only baseline — nothing to persist.
            return;
          }
          const recordedParts: string[] = [];
          if (recordedCount > 0) {
            recordedParts.push(
              `the value the provider actually applied on ${recordedCount} resource(s)`
            );
          }
          if (reRecordedCount > 0) {
            recordedParts.push(
              `the identity the revert returned on ${reRecordedCount} resource(s)`
            );
          }
          if (settledCount > 0) {
            recordedParts.push(
              `that a failed deploy's unsettled properties are settled on ${settledCount} resource(s)`
            );
          }
          const recordedWhat = recordedParts.join(' and ');

          // `skippedOutputs` (issue #2740) is dropped here for the same reason
          // `--accept` drops it above: every writer that rebuilds state OUTSIDE
          // a deploy drops it, without a per-writer argument about whether this
          // one can repair an output. Three such arguments were written for this
          // field; two were shown wrong, and whether a deletion here can make an
          // output resolve (by exposing an attribute of the same name, or by
          // removing a hit the lookup already falls through past) was not
          // settled — so this arm drops on the rule, not on a verdict.
          const { skippedOutputs: _droppedByRevert, ...carriedState } = report.state;
          const newState: StackState = {
            ...carriedState,
            ...stackInstanceIdCarriedFrom(report.state),
            resources,
            lastModified: Date.now(),
          };
          const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {
            expectedEtag: report.etag,
          };
          if (report.migrationPending) {
            saveOptions.migrateLegacy = true;
          }
          // BEST-EFFORT, unlike `--accept`'s write. There the state write IS the
          // operation; here AWS has ALREADY been reverted and this is a secondary
          // convergence step, so a failure must not abort the command — under
          // `--all` a throw here would skip every later stack's revert entirely,
          // which is a regression against the pre-#1644 behavior of not writing
          // at all. The warn path costs two things: a narrowing re-surfaces on
          // the next `cdkd drift` (the pre-#1644 state), and a returned identity
          // (go-to-k/cdkd#4476) is lost, which a re-run cannot repair because
          // the revert landed — the warning below says both.
          try {
            await stateBackend.saveState(report.stackName, report.region, newState, saveOptions);
            logger.info(
              `✓ State updated for ${report.stackName} (${report.region}): recorded ${recordedWhat}.`
            );
          } catch (err) {
            // Same treatment as site 2, and the same gate. The untrusted value in
            // this block is the STATE-WRITE error message -- the provider update
            // already succeeded; this is `saveState` failing after it.
            const revertAgain = revertCommandLine(report.stackName, report.region);
            const unrecorded = [
              ...(recordedCount > 0 ? ['the value the provider actually applied'] : []),
              ...(reRecordedCount > 0 ? ['the identity the revert returned'] : []),
              ...(settledCount > 0
                ? ["that a failed deploy's unsettled properties are settled"]
                : []),
            ].join(' and ');
            logger.warn(
              `Reverted ${report.stackName} (${report.region}), but could not record ${unrecorded}: ` +
                `${describeAwsFailure(err).detail}.` +
                // Before the narrowing's tail, whose `Revert with:` line must
                // print last. No re-run helps here: the revert landed, so the
                // next drift reports no difference to revert.
                (reRecordedCount > 0
                  ? ` The state record still holds the physical id and attributes from before ` +
                    `the revert, which a later 'Fn::GetAtt' and 'cdkd export' read. Re-running the ` +
                    `revert does not repair it, since the revert landed; a later deploy that updates ` +
                    `this resource records the identity its update returns.`
                  : '') +
                (recordedCount > 0
                  ? ` The next 'cdkd drift' will report the same difference — ` +
                    (revertAgain === undefined
                      ? `re-run ${proseQuoted(cdkdRemedy('cdkd drift', '--revert'))} for this stack once the state write can succeed.`
                      : `re-run the command below once the state write can succeed.` +
                        `\nRevert with: ${revertAgain}`)
                  : '')
            );
          }
        }
      } finally {
        await lockManager.releaseLock(report.stackName, report.region).catch((err) => {
          logger.warn(
            `Failed to release lock for ${report.stackName} (${report.region}): ` +
              describeAwsFailure(err).detail
          );
        });
      }
    });
  }

  const { totalFailed, totalUnsupported, totalSucceeded, totalUnresolvable } = tally;
  const summaryParts = [`${totalSucceeded} reverted`];
  if (totalUnsupported > 0) summaryParts.push(`${totalUnsupported} update-not-supported`);
  if (totalUnresolvable > 0) summaryParts.push(`${totalUnresolvable} reference-unresolvable`);
  if (totalFailed > 0) summaryParts.push(`${totalFailed} failed`);
  logger.info(`\nRevert summary: ${summaryParts.join(', ')}.`);

  if (totalUnsupported > 0) {
    logger.warn(
      `${totalUnsupported} resource(s) cannot be reverted in place — re-deploy the stack with ${deployReplaceCommand()}, ` +
        `or destroy + redeploy to push the cdkd-state values back into AWS.`
    );
  }

  if (totalFailed > 0 || totalUnsupported > 0 || totalUnresolvable > 0) {
    throw new PartialFailureError(
      `Revert completed with ${totalFailed + totalUnsupported + totalUnresolvable} resource ` +
        `error(s) (${totalFailed} AWS update failure(s), ${totalUnsupported} ` +
        `update-not-supported, ${totalUnresolvable} refused or unresolvable — those never ` +
        `reached provider.update; each per-resource message above names its cause and remedy, ` +
        `e.g. missing secretsmanager:GetSecretValue / ssm:GetParameter grants for an ` +
        `unresolvable reference). ` +
        // USAGE text in Commander's own spelling, matching the four sites in
        // `state.ts` and `destroy.ts` this PR converts for the same reason: the
        // reader supplies their own stack name, and `[stacks...]` is what
        // `cdkd drift --help` prints. The old `<stack>` disagreed with it.
        //
        // **The fence does NOT report this site, and the first version of this
        // comment said it did.** A hole inside a prose `'...'` span is inert
        // under the model the fence's shape A rests on -- the operator selects
        // the span WITH its quotes -- and it was reported only by an
        // intermediate, wrong version of the command-tail walk that paired
        // quotes naively. Review measured the over-report and the walk now
        // blanks quoted runs before looking for holes. The reword is kept
        // because it is right, not because a check demanded it.
        //
        // The placeholder is QUOTED, and an earlier version of this comment
        // argued the opposite -- that the brackets and the `...` are
        // Commander's GRAMMAR rather than characters to type, so wrapping them
        // would read as a literal argument name. That argument does not
        // survive measurement, and M10 of the review is the third time on this
        // lane it has been made and killed: `[stacks...]` is a bracket
        // EXPRESSION matching ONE character from `s t a c k .`, so in a
        // directory holding a file named `s` bash expands it and the line
        // silently retargets. On the `--revert` half that WRITES TO AWS. zsh
        // expands a MATCHING pattern the same way; what it does differently is
        // abort on NO match, where bash passes the literal through -- so zsh
        // is the safer shell only in the directory where nothing was at risk.
        // (A first cut of this comment said zsh "aborts instead", which is
        // false for the case that matters.)
        //
        // `commandHole('stacks...')` prints `'<stacks...>'` -- angle brackets,
        // as `state.ts`'s three `Usage:` lines print theirs -- which is NOT the
        // `[stacks...]` that `--help` shows for this optional variadic. That is
        // a deliberate trade: the quoted hole is the one spelling this repo
        // has measured inert under a shell, and a reader who types the line
        // verbatim gets the quotes stripped rather than passed. The arity is
        // unchanged; only the bracket kind differs from `--help`.
        `Re-run ${pasteableCommand('cdkd drift', [{ hole: 'stacks...' }]).command} to see the remaining drift, then ` +
        `${pasteableCommand('cdkd drift', [{ hole: 'stacks...' }, { literal: '--revert' }]).command} to retry.`
    );
  }
}

/** The per-run counters {@link runRevert} prints its summary from. */
export interface RevertTally {
  totalFailed: number;
  totalUnsupported: number;
  totalSucceeded: number;
  totalUnresolvable: number;
}

/** What one drifted resource's revert reads from {@link runRevert}'s scope. */
export interface RevertDriftedOutcomeArgs {
  logger: ConsoleLogger;
  tally: RevertTally;
  report: StackDriftReport;
  scope: { clients: AwsClients; registry: ProviderRegistry };
  revertSecretResolvers: DriftSecretResolvers;
  revertProducerRegions: ProducerRegionEvidence;
  narrowedByLogicalId: Map<string, Record<string, unknown>>;
  reRecordedByLogicalId: Map<
    string,
    { physicalId: string; attributes: Record<string, unknown> | undefined }
  >;
  settledByRevert: Map<string, ResourceState>;
  outcome: DriftedOutcome;
}
