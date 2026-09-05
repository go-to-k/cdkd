/**
 * Interactive confirmation prompt for `cdkd deploy --recreate-via-cc-api`
 * (issue [#649]).
 *
 * Mirror of {@link ../prefix-migration-check.ts}'s `promptMigrationConfirm`
 * but for the recreate-via-cc-api destroy+recreate cycle:
 *
 *   - `opts.yes` (CDK CLI parity `-y` / `--yes`) skips the prompt and
 *     prints the per-target plan as a `WARN` block (the existing v1
 *     surface). CI use case.
 *   - When `opts.yes` is false, the prompt fires after the per-target
 *     plan. Default is `N` because the side effect is destructive
 *     (a per-resource destroy + recreate cycle).
 *   - Non-TTY guard: if `opts.yes` is false AND stdin is not a TTY,
 *     throws with an actionable message rather than hanging or
 *     silently declining. CI runs without `--yes` would otherwise look
 *     like a successful skipped-deploy.
 *
 * The per-target plan surfaces a **DATA LOSS** prefix for stateful
 * targets; a target reaches this prompt still carrying a stateful reason only
 * because the user opted in with `--force-stateful-recreation`, so the
 * **DATA LOSS** wording is the third "stop and think" moment.
 *
 * **The prefix is NOT read off `statefulReason` alone**, and the reason is the
 * flag that makes the prompt reachable in the first place (issue [#2558]'s
 * review round). `probeAndRevalidateStateful` returns EARLY under
 * `--force-stateful-recreation` — it never issues the live
 * `s3:ListObjectVersions` / `logs:DescribeLogStreams` probes — so under that
 * flag every target still carries the SYNC verdict, and for the two
 * CONDITIONAL types the sync verdict of a deferral is `null`. `null` there
 * does not mean "holds nothing": an `AWS::S3::Bucket` always defers, and an
 * `AWS::Logs::LogGroup` with no recorded retention is CloudWatch Logs'
 * NEVER EXPIRE. Rendering that as "not stateful" is precisely the reading
 * issue [#2558] exists to retire, and it was already wrong for a non-empty
 * bucket before that. So when the probe did not run, a `null` reason is
 * re-derived through {@link isStatefulRecreateTargetForReplace} — the
 * conservative mid-deploy predicate, a pure function of the type with no AWS
 * call, chosen over re-running the probe because re-running it under the force
 * flag would repopulate `blockedStatefulTargets` and turn the opt-in into a
 * refusal.
 */

import readline from 'node:readline/promises';
import { getLogger } from '../../utils/logger.js';
import type { RecreateTarget } from '../../deployment/recreate-targets.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../../provisioning/stateful-types.js';
import {
  renderDownstreamConsumers,
  type DownstreamConsumer,
} from './recreate-downstream-consumers.js';

export async function promptRecreateConfirm(input: {
  stackName: string;
  targets: ReadonlyArray<RecreateTarget>;
  yes: boolean;
  /**
   * Whether the run carries `--force-stateful-recreation`, i.e. whether the
   * live emptiness probe was SKIPPED. Required rather than defaulted: an
   * omitted value would have to pick a side, and the permissive side is the
   * one that hides a never-expiring log group's **DATA LOSS** line. See the
   * module JSDoc for why a `null` reason is untrustworthy under the flag.
   */
  forceStatefulRecreation: boolean;
  /**
   * Optional per-target downstream consumer enumeration (issue [#650]).
   * Empty / undefined → no per-target consumer list is rendered (the
   * generic caveat still fires). When supplied, each entry is rendered
   * below the corresponding target.
   */
  downstreamConsumers?: ReadonlyArray<DownstreamConsumer>;
}): Promise<boolean> {
  if (input.targets.length === 0) return true;

  const logger = getLogger();
  const toCcCount = input.targets.filter((t) => t.direction === 'to-cc-api').length;
  const toSdkCount = input.targets.filter((t) => t.direction === 'to-sdk').length;
  logger.warn('');
  if (toCcCount > 0 && toSdkCount > 0) {
    logger.warn(
      `recreate-via-cc-api / recreate-via-sdk-provider will destroy + recreate ` +
        `${input.targets.length} resource(s) on stack ${input.stackName} ` +
        `(${toCcCount} → Cloud Control, ${toSdkCount} → SDK Provider):`
    );
  } else if (toCcCount > 0) {
    logger.warn(
      `--recreate-via-cc-api will destroy + recreate ${toCcCount} ` +
        `resource(s) via Cloud Control API on stack ${input.stackName}:`
    );
  } else {
    logger.warn(
      `--recreate-via-sdk-provider will destroy + recreate ${toSdkCount} ` +
        `resource(s) via SDK Provider on stack ${input.stackName}:`
    );
  }
  for (const t of input.targets) {
    // A recorded reason is trusted as-is; only a `null` under the force flag
    // is re-derived, and only ever UPWARDS (the conservative predicate can
    // promote a deferral, never clear a positive verdict). Passing `undefined`
    // for the recorded bag is deliberate: `RecreateTarget` does not carry one,
    // and the only bag-driven verdict — a log group's `has-retention` — is
    // already non-null here and never reaches this line.
    // ONE call to the predicate, deliberately: `stateful-replace-message-doc-sync`
    // scans `src/` for readers of the guard and asserts an exact list, one
    // entry per call site, so a second spelling here reads as a second reader.
    const rederivedReason =
      t.statefulReason === null && input.forceStatefulRecreation
        ? isStatefulRecreateTargetForReplace(t.resourceType, undefined)
        : null;
    const rederived = rederivedReason !== null;
    const reason = t.statefulReason ?? rederivedReason;
    const stateful = reason !== null;
    const dataLossPrefix = stateful ? '**DATA LOSS** ' : '';
    const directionTag = t.direction === 'to-cc-api' ? ' [SDK → CC]' : ' [CC → SDK]';
    // Two wordings, because the two cases KNOW different things.
    //
    // A verdict the probe produced renders through `renderStatefulReason` —
    // the sentence the refusal path already shows — never the raw
    // discriminator (`has-log-events` is internal).
    //
    // A RE-DERIVED verdict may not borrow that sentence.
    // `renderStatefulReason('has-objects')` is the assertive "S3 bucket is
    // non-empty", and on this path nothing was measured: the force flag is
    // exactly what skipped the probe. Printing it would tell a user with an
    // empty bucket that it is non-empty — asserting an emptiness verdict cdkd
    // does not hold, which is the same class of overstatement, pointed the
    // other way, that issue [#2558] is about. (The log group's own reason IS
    // hedged, but the bucket shares this line, so the hedge has to live here.)
    // The THIRD state (issue [#2595]): the probe ran and FAILED, so the
    // verdict is `null` — the S3 arm fails open by design — but nothing was
    // established. Rendered like neither of the other two: silence would be
    // the bug (indistinguishable from a bucket measured EMPTY on the only
    // screen the user reads before consenting), and `**DATA LOSS**` would
    // assert contents cdkd did not observe, the overstatement the two
    // sentences above already refuse to make. So: no prefix, no DATA line,
    // and an explicit note that the question is open.
    // The `!stateful` term and the consumer ORDERING below are MUTUALLY
    // redundant: both consumers test `stateful` first, and this term repeats
    // that. Measured, each mutation in isolation — dropping the term alone:
    // suite green; reordering both consumers alone: suite green; doing BOTH:
    // one case reds. So neither is load-bearing by itself, and the invariant
    // worth stating is the one they jointly enforce — a MEASURED verdict wins
    // over this display-only flag. Kept because a reader arriving at the
    // consumers should not have to re-derive that from their order.
    const unresolved = !stateful && t.probeUnresolved === true;
    const stateNote = stateful
      ? ` — stateful (${
          rederived
            ? 'emptiness not established — --force-stateful-recreation skips the probe'
            : renderStatefulReason(reason)
        }); --force-stateful-recreation acknowledged`
      : unresolved
        ? ' — emptiness NOT established: the live probe failed, so cdkd does not know whether this resource holds data'
        : '';
    logger.warn(
      `  - ${dataLossPrefix}${t.logicalId} (${t.resourceType})${directionTag}${stateNote}`
    );
    if (stateful) {
      logger.warn(
        `    DATA: all data in ${t.logicalId} will be lost (no automatic data migration)`
      );
    } else if (unresolved) {
      logger.warn(
        `    UNKNOWN: if ${t.logicalId} holds data, the destroy + recreate loses it (no automatic data migration)`
      );
    }
  }
  // Issue [#650] — per-target downstream consumer enumeration.
  // Fires once (consumers are stack-wide, not per-target — every
  // Fn::ImportValue from this stack lands in the same list).
  if (input.downstreamConsumers && input.downstreamConsumers.length > 0) {
    const rendered = renderDownstreamConsumers(input.stackName, input.downstreamConsumers);
    if (rendered) logger.warn(rendered);
  }
  logger.warn(
    '  The destroy + recreate cycle is per-resource; sibling resources are unaffected. ' +
      "Downstream consumers of any recreated resource's outputs (Fn::GetStackOutput / " +
      'Fn::ImportValue) will need a re-deploy to see the new physical id.'
  );

  if (input.yes) return true;

  // Non-TTY guard: reject explicitly rather than hanging on a closed
  // stdin or silently treating EOF as decline. CI runs without `--yes`
  // would otherwise look like a successful skipped-deploy; surface the
  // misconfiguration with an actionable error instead.
  if (process.stdin.isTTY !== true) {
    throw new Error(
      '--recreate-via-cc-api confirm prompt cannot run in a non-interactive ' +
        'environment. Pass --yes / -y to confirm the destroy + recreate cycle, ' +
        'or run the deploy from a real terminal.'
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question('\nContinue? (y/N): ');
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === 'y' || trimmed === 'yes') return true;
    logger.info('Deploy cancelled — no resources modified.');
    return false;
  } finally {
    rl.close();
  }
}
