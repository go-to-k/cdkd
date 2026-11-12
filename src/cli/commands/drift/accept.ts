/**
 * `cdkd drift`: `--accept`: write the AWS-current values into state.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { getLogger } from '../../../utils/logger.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import {
  type LockRecoveryContext,
  buildLockContentionMessage,
} from '../../../state/lock-contention-message.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import type { PropertyDrift } from '../../../analyzer/drift-calculator.js';
import { hasOwnKey, ownValue, defineOwnKey } from '../../../utils/own-keys.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { refusedBaselineRemedy } from '../refused-baseline-remedy.js';
import { withPhysicalNameCopies, redactForState } from '../../../deployment/secret-redaction.js';
import {
  type ResourceState,
  type StackState,
  stackInstanceIdCarriedFrom,
} from '../../../types/state.js';
import { type StackDriftReport, matchOutcome, type DriftedOutcome } from './outcome.js';
import { acceptRefusalReason, maskMarkedNoEchoBaseline } from './redaction.js';
import { otherPhysicalIds } from './baseline-keys.js';
import { deepEqualUnordered } from './revert-payload.js';
import { humanTextSink, printAcceptPlan, confirmPrompt, revertCommandLine } from './plan.js';
import { settleUnsettled } from './report-json.js';
import { displayDriftPath } from './report.js';

/**
 * Read the value at a dotted path, or `undefined` when any segment is missing.
 * The read counterpart of {@link setAtPath}, and it parses the same subset:
 * the drift comparator only synthesizes paths through plain objects.
 */
/**
 * Read a dotted path out of a bag, OWN keys only.
 *
 * Own keys, because the bag is `JSON.parse`d state, whose one exotic key is an
 * OWN `__proto__` (issue #2899's class): on a plain object a bare
 * `cursor['__proto__']` read for a segment the bag does NOT own answers with
 * `Object.prototype` — an inherited value that the `--accept` post-write check
 * below would then compare against the accepted one. `undefined` is the answer
 * "the bag has nothing here", which is what an absent segment means.
 *
 * Exported, like `setAtPath`, as a test seam: the own-key rule is pinned on
 * the helpers directly, and since issue #3121 (the comparison chain's
 * normalisers keep the key as an own key on both sides) a top-level
 * `__proto__` drift also reaches both through the command.
 */
export function getAtPath(source: unknown, path: string): unknown {
  if (path.length === 0) return source;
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    if (!hasOwnKey(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Write a dotted path into a bag as OWN keys.
 *
 * `Object.defineProperty` rather than assignment, and a null-prototype
 * intermediate node (issue #2899's class): the target is `JSON.parse`d state
 * cloned by `runAccept`, a plain object, and a drifted top-level key literally
 * named `__proto__` (which `JSON.parse` yields as an ordinary own key and the
 * comparator enumerates like any other) would be ASSIGNED as the prototype —
 * the accepted value silently dropped from the baseline while the summary
 * counts it recorded. Defining it makes it the own data property the record
 * round-trips through `JSON.stringify`.
 */
export function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (path.length === 0) {
    return;
  }
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = ownValue(cursor, key);
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      defineOwnKey(cursor, key, fresh);
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  defineOwnKey(cursor, segments[segments.length - 1]!, value);
}

/**
 * {@link setAtPath}, or REMOVE the leaf when `value` is `undefined` (the
 * source bag holds nothing there), OWN keys only.
 */
function restoreAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (value !== undefined) {
    setAtPath(target, path, value);
    return;
  }
  const segments = path.split('.');
  const parent = segments.length === 1 ? target : getAtPath(target, segments.slice(0, -1).join('.'));
  if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) return;
  const leaf = segments[segments.length - 1]!;
  if (hasOwnKey(parent, leaf)) delete (parent as Record<string, unknown>)[leaf];
}

// `hasOwnKey` / `ownValue` / `defineOwnKey` / `hasPlainPrototype` were
// file-local here until issue #3121 moved them to `src/utils/own-keys.ts`, so
// the analyzer-side canonicalizers rebuild by the same rule.

/**
 * `--accept`: state ← AWS.
 *
 * For each drifted resource, walk every property drift and write the
 * AWS-current value into the state-side `properties` map. Then, under a
 * stack lock, persist the updated state via `S3StateBackend.saveState`
 * with the captured etag (optimistic locking).
 *
 * `--dry-run` short-circuits before the lock and the write.
 */
export async function runAccept(
  reports: StackDriftReport[],
  // go-to-k/cdkd#5380: only to ask a provider whether an unsettled key is
  // still in transition before the accept clears it.
  regionScope: (region: string) => { clients: AwsClients; registry: ProviderRegistry },
  stateBackend: S3StateBackend,
  stateConfig: { bucket: string; prefix: string },
  awsClients: AwsClients,
  options: { yes?: boolean; dryRun?: boolean; json?: boolean; profile?: string | undefined }
): Promise<false | void> {
  const logger = getLogger();
  // Issue #2230: stdout carries the `--json` payload, so this run's plan and
  // prompt go to stderr. The `logger.*` lines below need no such threading —
  // `reserveStdoutForPayload` already re-routed them.
  const out = humanTextSink(options.json);
  // The recovery command a contention message suggests must resolve to the
  // SAME lock object this command was working on — `cdkd force-unlock`
  // re-resolves the bucket from the ambient profile otherwise (issue #2170).
  const lockRecovery: LockRecoveryContext = {
    profile: options.profile,
    stateBucket: stateConfig.bucket,
    statePrefix: stateConfig.prefix,
  };

  // Print a per-resource summary of the planned state mutations BEFORE we
  // ask for confirmation (or short-circuit on --dry-run). Mirrors `cdkd
  // import`'s confirm-then-write flow.
  printAcceptPlan(reports, out);

  if (options.dryRun) {
    logger.info('--dry-run: state will NOT be written. Re-run without --dry-run to apply.');
    return;
  }

  if (!options.yes) {
    const ok = await confirmPrompt(
      `Update cdkd state with the AWS-current values shown above?`,
      out
    );
    if (!ok) {
      logger.info('Aborted.');
      return false;
    }
  }

  const lockManager = new LockManager(awsClients.s3, stateConfig);
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;

  for (const report of reports) {
    // Issue #2135: an exhaustive `matchOutcome` rather than a `kind` filter, so
    // a new outcome variant has to say what `--accept` does with it instead of
    // being dropped by a predicate that keeps compiling.
    const driftedOutcomes = report.outcomes.flatMap((o) =>
      matchOutcome<DriftedOutcome[]>(o, {
        drifted: (d) => [d],
        // `--accept` writes AWS-current values into state, and only a drifted
        // outcome carries any. `notCompared` is the one worth saying out loud:
        // cdkd never READ those properties, so there is nothing to accept, and
        // writing anything for them would persist a comparison that did not
        // happen. The drift keeps being reported on the next run, which is the
        // honest outcome.
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

    // Check the boolean (issue #2161): a bare `acquireLock` returns `false` for
    // a live foreign lock without throwing, so the discarded return let `drift
    // --accept` mutate state under a concurrent deploy and then release that
    // deploy's lock via the `finally` below. Throwing on `!acquired` aborts
    // before that `try` is entered.
    const acquired = await lockManager.acquireLock(
      report.stackName,
      report.region,
      owner,
      'drift-accept'
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
    try {
      // Build the mutated resources map. The drift comparator's baseline
      // is `observedProperties ?? properties` (see runDriftForStack), so
      // `--accept` writes `observedProperties` to match AWS-current and
      // leaves `properties` (= the user's last-deployed template intent)
      // untouched — on EVERY record (go-to-k/cdkd#6125). A record with no
      // `observedProperties` yet (an older binary's state) gets one, captured
      // from the live readback. It used to have the readback written INTO
      // `properties`,
      // the previous side of the next deploy's diff: an accepted list entry
      // that exists only in AWS became recorded, the template's shorter list
      // then read as its REMOVAL, and a provider deriving deletes from the
      // recorded list (RDS `AdditionalStorageVolumes` -> `SetForDelete`)
      // destroyed what the user had just accepted.
      const resources: Record<string, ResourceState> = { ...report.state.resources };
      // Resources that actually gained a RECORDED value, which is not the same
      // as resources that DRIFTED (issue #1958). Every outcome reaches the loop
      // below, but one whose every change hit `acceptRefusalReason` accepts
      // nothing — and the state is still written, because the positioned
      // re-redaction below runs regardless. Counting outcomes therefore let the
      // summary claim an acceptance the run had just declined, in the one case
      // where the user has already been warned per change that it would not
      // happen. Before the refusal existed the two counts could not differ.
      //
      // Counted AFTER the not-recorded loop rather than at `accepted.length`
      // (issue #1958 review): there is a SECOND refusal site further along, the
      // positioned re-redaction winning over an accepted value at a public
      // `{{resolve:...}}` reference, which the comment beside it calls a real
      // hole rather than a hypothetical one. Counting before it reproduced the
      // very shape this item removes — a summary contradicting the per-change
      // warnings printed just above it — one site later.
      let acceptedResourceCount = 0;
      for (const outcome of driftedOutcomes) {
        const existing = resources[outcome.logicalId];
        if (!existing) continue;
        // Schema v10+ (issue #2944). A THIRD writer of the refused-baseline
        // class, found by that fix's sibling sweep rather than named in the
        // issue -- the issue enumerates the deploy auto-refresh and `cdkd state
        // refresh-observed`, and this is the same defect one command over.
        //
        // A marked record USUALLY has no `observedProperties`, and then the
        // write below captures a baseline from the readback and positions the
        // redaction against `existing.properties` -- which after an import refusal can hold
        // the WRONG-BRANCH LITERAL the refusal distrusted. A literal source leaf
        // against a string readback PAIRS as an ordinary drifted literal, so
        // nothing refuses and the DECRYPTED value lands in the record. (Before
        // go-to-k/cdkd#6125 that write went INTO `properties`, the bag
        // `--revert` later pushes to AWS; it is a baseline now, the same shape
        // as the two writers the issue names.)
        //
        // SECOND LAYER since issue #2952. Detection now reports a marked record
        // `notCompared`, so it never becomes `drifted` and never reaches this
        // loop — this arm is unreachable BY CONSTRUCTION today. It is kept
        // rather than deleted because a write path to AWS (and to `state.json`)
        // should not depend on a detection decision staying where it is, and
        // the cost of keeping it is one branch. What fences it is the detection
        // case in `drift.test.ts`: if the gate there is removed, that case reds
        // and this arm starts carrying the refusal again.
        // The marker is exactly the evidence this command lacks -- it has no
        // template either -- so REFUSING is the only correct answer here, and
        // the record is left untouched rather than partially accepted. The
        // remedy is the same one the other two sites name: a deploy that
        // actually CHANGES the resource rebuilds its record from the template
        // and discharges the refusal — except an unverifiable-parameter one,
        // which `refusedBaselineRemedy` words (issue #3465).
        if (existing.observedBaselineRefused === true) {
          logger.warn(
            `  ! ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
              `NOT accepted — a 'cdkd import' run refused to capture this resource's ` +
              `observed-properties baseline, because its recorded properties can no longer ` +
              `position the secret redaction. Accepting would write a baseline positioned against ` +
              `those properties, which can persist a resolved secret into state.json in ` +
              `plaintext. ` +
              safeMsg`${
                refusedBaselineRemedy(existing) ??
                'Deploy a change to this resource to restore a baseline first.'
              }`
          );
          continue;
        }
        // go-to-k/cdkd#6125: written to `observedProperties` either way. A
        // record with no baseline gets one SEEDED from the live readback, as
        // `cdkd state refresh-observed` captures it, never from `properties`:
        // every reader of a present baseline takes it for a full readback (the
        // drift walk descends the union of its keys and AWS's, `--revert`
        // overlays without preserving untemplated paths, the deploy-start
        // auto-refresh skips it), so a template-shaped one would surface every
        // AWS-defaulted sub-key as drift and let `--revert` strip it. A
        // refused path is put back to what drift compared it against below.
        const seeded = existing.observedProperties === undefined;
        const compared = existing.observedProperties ?? existing.properties ?? {};
        const newBaseline = seeded
          ? structuredClone(outcome.awsProperties)
          : (JSON.parse(JSON.stringify(compared)) as Record<string, unknown>);
        const accepted: PropertyDrift[] = [];
        for (const change of outcome.changes) {
          // Issue #1914: anything the report had to MASK is not a value — it
          // is the statement that cdkd could not identify what AWS holds. The
          // path is left as state has it and the user is told which one and
          // why; the drift keeps being reported, which is the honest outcome
          // (`--revert` can fix it, `--accept` cannot).
          const refusal = acceptRefusalReason(change, outcome.maskedPaths);
          if (refusal !== undefined) {
            // A command carrying an interpolated TARGET is never inside the
            // sentence -- a pasted prose `'...'` span ran the value it carried
            // (go-to-k/cdkd#3363). It rides a labelled line when both
            // identifiers clear `revertCommandLine`'s gate. When they do not,
            // the labelled line is not printed and the prose names the command
            // only as the fixed literal `'cdkd drift --revert' for this stack`,
            // which interpolates nothing. The block still carries the property
            // path and the resource type, which is why the targeted command is
            // on its own line rather than in the sentence.
            const revert = revertCommandLine(report.stackName, report.region);
            logger.warn(
              `  ! ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
                `not accepting '${displayDriftPath(outcome, change.path)}' — ${refusal}, so cdkd will not write it to ` +
                (revert === undefined
                  ? `state. Run 'cdkd drift --revert' for this stack to push the referenced ` +
                    `value back to AWS, or re-deploy if the reference changed.`
                  : `state. Push the referenced value back to AWS with the command below, or ` +
                    `re-deploy if the reference changed.` +
                    `\nRevert with: ${revert}`)
            );
            // The seed carries the readback here; what is not accepted stays
            // what the record held.
            if (seeded) restoreAtPath(newBaseline, change.path, getAtPath(compared, change.path));
            continue;
          }
          setAtPath(newBaseline, change.path, change.awsValue);
          accepted.push(change);
        }
        // Issue #1914: `--accept` is a WRITE-TO-STATE surface fed by a live AWS
        // readback, so it is exactly the shape GHSA-p5qg-v9gv-hc7w covers — a
        // resolved secret reaching `state.json` re-introduces the disclosure
        // for anyone with read access to the state bucket.
        //
        // `redactDriftChanges` has already redacted every value written just
        // above, so this pass is NOT a duplicate of it: what it reaches is the
        // rest of the bag, i.e. the untouched clone of the record's own
        // baseline. That clone is exactly where a plaintext survives today —
        // any user who ran `--accept` on a pre-fix binary has an
        // `observedProperties` holding the resolved secret while `properties`
        // still holds the expression, and re-accepting for an unrelated key
        // would re-persist it verbatim. Measured: without this line that state
        // round-trips the plaintext.
        //
        // The POSITIONED form, and the two arms differ for a reason. Normally
        // the record's own `properties` are the source: they hold no PUBLIC
        // expression — a `String` ssm reference is stored resolved — so any
        // `{{resolve:...}}` leaf in them is by construction a secret and may be
        // copied over verbatim (`trustAnyExpression`), while BLIND array
        // descent stays OFF because this bag came back from AWS and may be
        // reordered — blind, because this same rules constant still inherits
        // the keyed descent of issue #1915 and the corroborated positional walk
        // of issue #2012; see the `--revert` site below for what licenses the
        // second one.
        // That is what catches a stored plaintext the VALUE map cannot: after a
        // rotation the map holds today's secret and the stored one is last
        // week's, so only position can name it.
        //
        // The same call covers the resolution-FAILED resource with no extra arm,
        // which is why there is no flag for it: the map is empty there, so
        // `redactSecretsForState` runs its path pass alone — the #1900 offline
        // mechanism, which works precisely because it needs no secret fetch.
        //
        // Positioning cannot mis-pin a drifted SECRET leaf: the masked values
        // above remove that input entirely, since such a path is refused before
        // it can reach `newBaseline`.
        //
        // It can still overwrite an accepted value at a PUBLIC reference,
        // though, and that is a real hole rather than a hypothetical one: a
        // public `{{resolve:ssm:...}}` CAN sit in `properties` (a LEGACY
        // record: an older `cdkd import` warn path, since #2944 a refused
        // baseline this command skips), such a path is not secret-bearing so
        // the change is accepted normally, and `trustAnyExpression` then copies
        // the source expression over it — unless the per-bag proof (issue
        // #2036) shows AWS holds exactly the source with the parameter's
        // current public value, as on the `--revert` twin. Rather than claim it
        // cannot happen, the write is CHECKED below and the user is told — a
        // silent permanent no-op is the failure mode worth naming, and the
        // check catches any future cause of it too.
        //
        // THE RULES CONSTANT FOLLOWS THE DESTINATION (issue
        // [#2939](https://github.com/go-to-k/cdkd/issues/2939)), and since
        // go-to-k/cdkd#6125 the destination is always `observedProperties`.
        // The bag IS a drift baseline, so an uncertifiable position is written
        // as `SECRET_MASK` by the same reasoning #2852 applied to `cdkd state
        // refresh-observed` and #2885 to `cdkd import`: the re-redaction exists
        // to clean a stored plaintext the value map cannot recognise (a
        // pre-GHSA record, or last week's rotated-away value), and at a
        // position the walk cannot pair the non-failing constant left it in
        // the clear. The non-failing constant belongs to a write into
        // `properties`, where a mask is a REGRESSION rather than a refusal
        // (`cdkd export` blocks the record and the rollback replay refuses the
        // operation over a template value that was never unknown) — the write
        // this site no longer makes.
        // go-to-k/cdkd#4810: a reader's copy of another record's physical id is
        // kept as the id is. Scoped to THIS write: the bag also redacts the
        // drift report, which keeps rewriting it.
        const redactedBaseline = withPhysicalNameCopies(
          outcome.secrets,
          otherPhysicalIds(report.state.resources, outcome.logicalId),
          () =>
            redactForState(newBaseline, {
              provenance: 'state-baseline',
              secrets: outcome.secrets,
              source: existing.properties ?? {},
            })
        );
        let recordedChanges = 0;
        for (const change of accepted) {
          // `deepEqualUnordered` calls a NON-PLAIN value (a `Date` the raw
          // readback carries) equal only to ITSELF (issue #2897): a rebuilt
          // stand-in for it — which the redaction pass still produces for any
          // non-plain value but an unmodified `Date` (issue #2427) — is a
          // value the baseline does not hold, and the warning below is the
          // only signal that the accept did not land.
          if (deepEqualUnordered(getAtPath(redactedBaseline, change.path), change.awsValue)) {
            recordedChanges++;
            continue;
          }
          logger.warn(
            `  ! ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
              `'${displayDriftPath(outcome, change.path)}' was NOT recorded — after redaction cdkd state holds a different ` +
              `value at that property. Usually an unresolved '{{resolve:...}}' reference sits ` +
              `there and wins over an accepted value (change the template if that reference ` +
              `is wrong); a readback value cdkd cannot compare is never called recorded.`
          );
        }
        if (recordedChanges > 0) acceptedResourceCount++;
        // go-to-k/cdkd#4043 Phase C: AFTER the recorded check, which compares
        // what the user accepted: a marked coordinate is `***` in what is
        // written, whatever a changed parent path carried there.
        // Readback-shaped on both record shapes since go-to-k/cdkd#6125 (a
        // seeded baseline IS the readback), so the readback arm: lists paired
        // by their identity field, as the deploy-start refresh masks them.
        const written = maskMarkedNoEchoBaseline(redactedBaseline, existing, true);
        // go-to-k/cdkd#5380: the baseline now records what AWS holds, so what
        // a failed deploy left unsettled on this resource is settled, except a
        // key AWS is still changing (the readback is not where it will end).
        // No post-update proof as on the deploy / revert side (#5487): an
        // accept writes the live readback AS the record, so record == live by
        // construction; only a value still moving can disagree later.
        const settled = await settleUnsettled(
          existing,
          outcome.logicalId,
          () =>
            regionScope(report.region).registry.getProviderFor({
              resourceType: outcome.resourceType,
              provisionedBy: existing.provisionedBy,
            }).provider
        );
        resources[outcome.logicalId] = { ...settled, observedProperties: written };
      }

      // `skippedOutputs` (issue #2740) is dropped rather than spread through,
      // by the flat rule `cdkd import` and `cdkd state refresh-observed` follow
      // too: every writer that rebuilds state outside a deploy drops the
      // record. Since go-to-k/cdkd#6125 this one writes only
      // `observedProperties`, which no attribute is built from — but that is
      // a per-writer safety argument of exactly the kind that was wrong three
      // times for this field (before #6125 this very site rewrote
      // `properties`, the values an attribute IS constructed from), so the
      // rule is applied rather than re-argued. Left in place a stale record
      // would make `cdkd diff` preview a key as absent while the next deploy
      // publishes it. The field is informational and the next deploy rewrites it, so
      // dropping it is the safe direction: that key returns to pre-#2740
      // behaviour until the next deploy recomputes the record — a row where
      // the diff can resolve it, the ordinary whole-section suppression where
      // it cannot, and in neither case an assertion that nothing is coming.
      const { skippedOutputs: _droppedByAccept, ...carriedState } = report.state;
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
      await stateBackend.saveState(report.stackName, report.region, newState, saveOptions);
      logger.info(
        `✓ State updated for ${report.stackName} (${report.region}): ` +
          (acceptedResourceCount === 0
            ? `0 resource(s) accepted — no drifted change was recorded, and this write carried ` +
              `only the positioned re-redaction.`
            : `accepted drift on ${acceptedResourceCount} resource(s).`)
      );
    } finally {
      await lockManager.releaseLock(report.stackName, report.region).catch((err) => {
        logger.warn(
          `Failed to release lock for ${report.stackName} (${report.region}): ` +
            describeAwsFailure(err).detail
        );
      });
    }
  }
}
