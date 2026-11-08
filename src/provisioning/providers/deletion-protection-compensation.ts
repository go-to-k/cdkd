/**
 * Undoing a `--remove-protection` flip whose delete then failed terminally
 * (issues #1978 and #2204).
 *
 * `cdkd destroy --remove-protection` turns a resource's deletion guard off and
 * then deletes it. When the delete fails for good, the run ends with the
 * resource still LIVE and its guard silently stripped: the failure is loud, the
 * side effect is not. Everything here exists to put the guard back in that case,
 * and only in that case.
 *
 * Three properties, settled by #1978 and reused by every adopter rather than
 * re-argued per provider:
 *
 *  1. **Compensate from the method boundary**, not from the delete call's own
 *     `try`, so every exit after the flip — the delete refusing, an interrupted
 *     wait — reaches the compensation. {@link deleteWithProtectionCompensation}
 *     is that boundary.
 *  2. **Never mask the original error.** The re-enable runs in its own `try`,
 *     never throws, and its failure is a secondary log line naming the resource
 *     and the command that fixes it. The thrown error is never annotated:
 *     `isRetryableTransientError` substring-matches the message, so splicing
 *     text in can turn a terminal failure into a retryable one.
 *  3. **Only compensate what this run changed.** The pre-flip value is OBSERVED
 *     with a readback — never read from state, which can be stale — and
 *     recorded only after AWS accepts the flip. A failed observation means "do
 *     not know, so do not touch".
 *
 * The first adopter was the DynamoDB pair, so the narrative below uses a table
 * (`DescribeTable` / `UpdateTable` / `DeleteTable`) as its running example. For
 * the RDS family read `Describe*` / `Modify*` / `Delete*` on a cluster or an
 * instance, for a log group `DescribeLogGroups` / `PutLogGroupDeletionProtection`
 * / `DeleteLogGroup`, for a Cognito user pool `DescribeUserPool` /
 * `UpdateUserPool` / `DeleteUserPool`, for an EMR cluster `DescribeCluster` /
 * `SetTerminationProtection` / `TerminateJobFlows`, for an ELBv2 load balancer
 * `DescribeLoadBalancerAttributes` / `ModifyLoadBalancerAttributes` /
 * `DeleteLoadBalancer`, for an Auto Scaling group `DescribeAutoScalingGroups` /
 * `UpdateAutoScalingGroup` / `DeleteAutoScalingGroup` (plus, per instance the
 * group launched, `DescribeInstanceAttribute` / `ModifyInstanceAttribute`
 * against that same group delete), for an EC2 instance
 * (both delete routes) `DescribeInstanceAttribute` / `ModifyInstanceAttribute`
 * / the delete, and for a Cloud Control protection-registry type
 * `GetResource` / an `UpdateResource` patch / `DeleteResource`; the argument
 * is the same.
 */

import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import type { Logger } from '../../types/config.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import {
  ProtectionFlipRegistry,
  PROTECTION_FLIP_REUSE_WINDOW_MS,
  isTerminalDeleteFailure,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation/flip-record.js';

export type { ProtectionFlipRecord } from './deletion-protection-compensation/flip-record.js';
export {
  ProtectionFlipRegistry,
  protectionFlipKey,
  PROTECTION_FLIP_REUSE_WINDOW_MS,
  runDeleteAttempt,
  isTerminalDeleteFailure,
} from './deletion-protection-compensation/flip-record.js';
export type {
  FlipSettleReading,
  FlipSettleOptions,
} from './deletion-protection-compensation/final-snapshot-wait.js';
export {
  PROTECTION_FLIP_RETRY_WAIT_MS,
  FINAL_SNAPSHOT_SETTLE_WAIT_MS,
  FINAL_SNAPSHOT_COMPENSATION_MARGIN_MS,
  FLIP_TRANSITION_GRACE_MS,
  isProceedDbStatus,
  isTerminalDbStatus,
  isTerminalDbWaitStatus,
  waitForFlipToSettleBeforeFinalSnapshot,
  isFinalSnapshotNotAvailableRefusal,
  deleteAfterProtectionFlipWithFinalSnapshot,
} from './deletion-protection-compensation/final-snapshot-wait.js';

/**
 * What {@link compensateProtectionFlip} actually did, which the caller needs
 * because it decides whether the flip record may be DROPPED.
 *
 *  - `not-applicable` — there was nothing to put back: this run never flipped
 *    the guard, AWS had already accepted the delete, or the failure is
 *    retryable and a re-entry is coming.
 *  - `restored` — the compensating re-enable succeeded, so the guard is back
 *    on.
 *  - `failed` — the compensating re-enable was attempted and did NOT succeed
 *    (either arm: the not-found one that cannot tell "gone" from "not in a
 *    modifiable state", or any other error). The guard is, as far as cdkd
 *    knows, still OFF and cdkd is the one that turned it off.
 *
 * The three-way split exists for that last case alone. A caller that releases
 * the flip record on it throws away the only in-process memory that cdkd owes
 * this resource a re-enable, and the record is what a LATER delete of the same
 * key reads: released, that delete observes the guard already off, records
 * `flippedOffByThisRun: false`, and compensates NOTHING — so a resource cdkd
 * stripped stays stripped. Retaining it does not re-open the hazard the
 * release closes, because the unwanted-re-enable hazard is about a guard cdkd
 * has already PUT BACK; here it demonstrably has not.
 *
 * ONE residual this does NOT cover, named because every other one here is:
 * the resource really is gone, one of the SAME name is recreated in the same
 * region inside the sliding window, and THAT delete fails terminally. The
 * inherited record then has cdkd re-enable a guard it never flipped. The trade
 * is still the right one -- the alternative leaves a resource cdkd stripped
 * still stripped, which is the worse direction -- but the argument above does
 * not reach this case, so it is stated rather than implied away.
 */
export type ProtectionCompensationOutcome = 'not-applicable' | 'restored' | 'failed';

/**
 * The per-site wording and commands for {@link compensateProtectionFlip}. The
 * mechanism is shared; what each adopter says about ITS resource is not.
 */
export interface ProtectionGuardSite {
  /** What leads every line, e.g. `DynamoDB table`, `RDS DBCluster`. */
  readonly subject: string;
  /** The guard as AWS spells it: `DeletionProtectionEnabled` / `DeletionProtection`. */
  readonly guardName: string;
  /** `table` / `cluster` / `instance`, for "that <noun> is LIVE". */
  readonly noun: string;
  /**
   * Whether the re-enable's error is the service's not-found answer. Not a
   * `cause`-chain walk: a `reEnable` throws the SDK error unwrapped, the
   * RDS-family ones included, whose busy-refusal retry wraps only its own
   * give-up (budget spent, terminal status) and passes a not-found through
   * as-is. A wrapped error makes a name-keyed predicate answer `false`, so the
   * compensation keeps the LOUD error line — the safe direction.
   */
  readonly isNotFound: (error: unknown) => boolean;
  /**
   * The sentence(s) the not-found arm uses for what the service answered and
   * what it can mean. It must NOT claim the resource is gone: a not-found
   * answer is the service's, and on the region-mismatch race that reaches
   * this arm the resource can be live elsewhere.
   */
  readonly notFoundMeaning: string;
  /**
   * The pasteable commands, rendered only on a FAILED re-enable. Each runs
   * through `pasteableAwsCommand` (issue #3136), which withholds a command it
   * cannot print exactly rather than naming another resource.
   *
   *  - `check` / `restoreAfterNotFound` — the not-found arm's check and fix.
   *  - `restoreLive` — the other arm's fix, where the resource is known live.
   */
  readonly commands: () => {
    readonly check: string;
    readonly restoreAfterNotFound: string;
    readonly restoreLive: string;
  };
  /**
   * A sentence rendered right after either restore command, for a site whose
   * restore command is not safe to paste on its own. Cognito's is the case:
   * `update-user-pool` resets some members a call omits, so the bare flag
   * would re-enable the guard and reset `AutoVerifiedAttributes` with it.
   * Kept OUTSIDE the command, since prose inside a pasteable span is itself a
   * defect (#3136).
   */
  readonly restoreCaveat?: string;
}

/**
 * The {@link ProtectionGuardSite} for an RDS-family cluster or instance. RDS,
 * DocDB and Neptune share the `DeletionProtection` spelling and the
 * `describe-db-*` / `modify-db-*` CLI shape, so one builder serves all three
 * services and both kinds rather than six hand-written copies.
 *
 * `--region` is rendered into every command whenever the caller knows it (the
 * state's region), for the reason the DynamoDB wording gives: on the
 * region-mismatch race that reaches the not-found arm, a check run against the
 * operator's default region answers the same not-found and reads as "gone".
 */
export function rdsFamilyProtectionSite(opts: {
  /** The AWS CLI service: `rds` / `docdb` / `neptune`. */
  readonly cliService: 'rds' | 'docdb' | 'neptune';
  /** `RDS` / `DocDB` / `Neptune`, for the narration. */
  readonly serviceLabel: string;
  readonly kind: 'cluster' | 'instance';
  readonly physicalId: string;
  readonly region: string | undefined;
  /** The fault the service answers for a missing resource, for the narration. */
  readonly notFoundFault: string;
  readonly isNotFound: (error: unknown) => boolean;
}): ProtectionGuardSite {
  const subject = `${opts.serviceLabel} ${opts.kind === 'cluster' ? 'DBCluster' : 'DBInstance'}`;
  return {
    subject,
    guardName: 'DeletionProtection',
    noun: opts.kind,
    isNotFound: opts.isNotFound,
    notFoundMeaning:
      `${opts.serviceLabel} answered ${opts.notFoundFault}. That most commonly means the ` +
      `${opts.kind} is gone, and it can also mean it is not in this region or account.`,
    commands: () => {
      const aws = pasteableAwsCommand();
      const regionArg = opts.region ? aws` --region ${opts.region}` : aws``;
      const id = opts.physicalId;
      const svc = opts.cliService;
      // The service is a cdkd literal from a closed union, never a value from
      // state, so it is spliced as a nested fragment of the SAME tag rather
      // than quoted as an argument.
      const service = svc === 'rds' ? aws`rds` : svc === 'docdb' ? aws`docdb` : aws`neptune`;
      const check =
        opts.kind === 'cluster'
          ? aws`aws ${service} describe-db-clusters --db-cluster-identifier ${id}${regionArg}`
          : aws`aws ${service} describe-db-instances --db-instance-identifier ${id}${regionArg}`;
      const restore =
        opts.kind === 'cluster'
          ? aws`aws ${service} modify-db-cluster --db-cluster-identifier ${id}${regionArg} --deletion-protection --apply-immediately`
          : aws`aws ${service} modify-db-instance --db-instance-identifier ${id}${regionArg} --deletion-protection --apply-immediately`;
      return {
        check: check.render(),
        restoreAfterNotFound: restore.render(),
        restoreLive: restore.render(),
      };
    },
  };
}

/**
 * Whether `error` is an SDK `ResourceNotFoundException`, keyed on `name` so this
 * module stays free of a per-service SDK import and a second client instance
 * of the class still matches. CloudWatch Logs and Cognito both spell their
 * not-found answer this way.
 */
function isResourceNotFoundException(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ResourceNotFoundException'
  );
}

/**
 * The {@link ProtectionGuardSite} for an `AWS::Logs::LogGroup`.
 *
 * Built here rather than in `logs-loggroup-provider.ts` or its companion
 * `logs-loggroup/` files, whose LogGroupClass refusal pins its own
 * `put-log-group-deletion-protection` spelling as UNIQUE across them
 * (`logs-loggroup-provider-class-guard.test.ts`).
 */
export function logGroupProtectionSite(
  physicalId: string,
  region: string | undefined
): ProtectionGuardSite {
  return {
    subject: 'Log group',
    guardName: 'DeletionProtectionEnabled',
    noun: 'log group',
    isNotFound: isResourceNotFoundException,
    notFoundMeaning:
      'CloudWatch Logs answered ResourceNotFoundException. That most commonly means the ' +
      'log group is gone, and it can also mean it is not in this region or account.',
    commands: () => {
      const aws = pasteableAwsCommand();
      const regionArg = region ? aws` --region ${region}` : aws``;
      const restore = aws`aws logs put-log-group-deletion-protection --log-group-identifier ${physicalId}${regionArg} --deletion-protection-enabled`;
      return {
        check:
          aws`aws logs describe-log-groups --log-group-identifiers ${physicalId}${regionArg}`.render(),
        restoreAfterNotFound: restore.render(),
        restoreLive: restore.render(),
      };
    },
  };
}

/**
 * The {@link ProtectionGuardSite} for an `AWS::Cognito::UserPool`.
 *
 * The restore command carries a caveat rather than standing alone: it omits
 * every other `UpdateUserPool` member, and the Lambda triggers, advanced
 * security, `AutoVerifiedAttributes` and a customer-managed `KeyConfiguration`
 * are measured to RESET on omission (`USER_POOL_ECHO_MEMBERS` in
 * `cognito/shared.ts`). cdkd's own re-enable
 * echoes the pool back and does not reset them (issue #4066); the pasted
 * command cannot.
 */
export function userPoolProtectionSite(
  physicalId: string,
  region: string | undefined
): ProtectionGuardSite {
  return {
    subject: 'Cognito User Pool',
    guardName: 'DeletionProtection',
    noun: 'user pool',
    isNotFound: isResourceNotFoundException,
    notFoundMeaning:
      'Cognito answered ResourceNotFoundException. That most commonly means the user pool ' +
      'is gone, and it can also mean it is not in this region or account.',
    commands: () => {
      const aws = pasteableAwsCommand();
      const regionArg = region ? aws` --region ${region}` : aws``;
      const restore = aws`aws cognito-idp update-user-pool --user-pool-id ${physicalId}${regionArg} --deletion-protection ACTIVE`;
      return {
        check:
          aws`aws cognito-idp describe-user-pool --user-pool-id ${physicalId}${regionArg}`.render(),
        restoreAfterNotFound: restore.render(),
        restoreLive: restore.render(),
      };
    },
    restoreCaveat:
      'Note UpdateUserPool resets some members a call omits (self sign-up, Lambda triggers, advanced security, AutoVerifiedAttributes and a customer-managed KeyConfiguration among them), ' +
      'so send your complete pool configuration alongside that flag rather than the flag alone.',
  };
}

/** Inputs to {@link compensateProtectionFlip}. */
export interface ProtectionFlipCompensationOptions {
  readonly flip: ProtectionFlipRecord;
  /** The failure that is about to be re-thrown. Never replaced, never annotated. */
  readonly error: unknown;
  readonly logicalId: string;
  readonly physicalId: string;
  readonly logger: Logger;
  readonly site: ProtectionGuardSite;
  /**
   * Issues the write that turns the guard back ON.
   *
   * A site that reads the resource first may resolve:
   *  - `'already-on'` -- the read found the guard ON, and the site wrote it
   *    back anyway (a read can lag a write that landed; re-sending ON is
   *    idempotent), AWS accepting the write. The narration says so instead of
   *    claiming the guard had been off.
   *  - `'read-on-write-failed'` -- the read found the guard ON but the
   *    write-back failed. The guard was on as of that read, so this is NOT
   *    the "still off" ERROR (whose pasted restore command could itself
   *    change the resource); it is a warn naming the check command. The read
   *    may have lagged, so the flip record is KEPT (`failed`) for a later
   *    delete of the same resource to retry.
   */
  readonly reEnable: () => Promise<void | 'already-on' | 'read-on-write-failed'>;
  /**
   * The delete's `DeleteContext.maskSecrets`. A failed re-enable is reported
   * by its error CLASS at warn / error, through this masker, and AWS's text
   * goes to debug under the same head, masked (go-to-k/cdkd#2319): a denied
   * write names the caller's assumed-role ARN, and a validation refusal can
   * quote the echoed members.
   */
  readonly mask?: MaskerFn | undefined;
}

/**
 * Put the deletion guard back after a `--remove-protection` flip whose delete
 * then failed terminally.
 *
 * BEST-EFFORT, and it says so:
 *
 *  - **It never masks the original error.** This function does not throw —
 *    including when the re-enable itself fails — because it runs inside the
 *    `catch` that is about to re-throw the delete failure, and a secondary
 *    write that throws would REPLACE the reported outcome with its own. The
 *    delete failure stays the outcome; this is a secondary line.
 *  - **It never edits the primary message either.** Splicing the re-enable's
 *    text into the thrown error would change what `isRetryableTransientError`
 *    substring-matches on, so a compensation failure carrying a throttle phrase
 *    could flip a terminal delete failure into a retryable one and re-run the
 *    whole path. The narration goes to the logger, not into the throw.
 *  - **It names the resource when it fails.** A silent failure here leaves a
 *    LIVE resource with its guard down, which is the exact residue this
 *    mechanism exists to remove, so the message carries the physical id and
 *    the one command that fixes it.
 *
 * The not-found arm is `warn`, not `error` and not `debug` (issue #2224): the
 * ERROR line asserts the resource is LIVE, which cdkd does not know there, but
 * a not-found answer to a write also covers a live resource in a state the
 * service will not modify, so silencing it would hide, at default verbosity,
 * exactly the case this line exists to report. It states the ambiguity and
 * gives both the check and the remedy.
 */
export async function compensateProtectionFlip(
  opts: ProtectionFlipCompensationOptions
): Promise<ProtectionCompensationOutcome> {
  if (!opts.flip.flippedOffByThisRun) return 'not-applicable';
  // AWS took the delete, so whatever threw afterwards was a WAIT, not the
  // delete: the resource is being deleted and there is no guard to restore on
  // it. Gated on the RECORD rather than on the shape of the error, because the
  // error that gets here in that case (`... did not disappear within ...`)
  // reads exactly like a terminal refusal and would otherwise be answered with
  // a re-enable against a dying resource plus a log line claiming it is
  // "LIVE with its deletion protection still off" — both false.
  if (opts.flip.deleteAccepted) return 'not-applicable';
  if (!isTerminalDeleteFailure(opts.error)) return 'not-applicable';

  const { site } = opts;
  try {
    const result = await opts.reEnable();
    if (result === 'read-on-write-failed') {
      opts.logger.warn(
        safeMsg`${site.subject} ${opts.logicalId}: the delete failed after ` +
          safeMsg`--remove-protection tried to turn ${site.guardName} off; ${opts.physicalId} ` +
          safeMsg`read it on afterwards, but writing it back failed, so cdkd cannot confirm ` +
          safeMsg`it. Check with: ${site.commands().check}. The delete failure below is the outcome.`
      );
      return 'failed';
    }
    opts.logger.warn(
      result === 'already-on'
        ? safeMsg`${site.subject} ${opts.logicalId}: the delete failed after ` +
            safeMsg`--remove-protection tried to turn ${site.guardName} off; ${opts.physicalId} ` +
            safeMsg`already read it on, and cdkd wrote it back (AWS accepted the write). The ` +
            safeMsg`delete failure below is the outcome.`
        : safeMsg`${site.subject} ${opts.logicalId}: the delete failed after ` +
            safeMsg`--remove-protection had turned ${site.guardName} off, so it was ` +
            safeMsg`re-enabled on ${opts.physicalId}. The delete failure below is the outcome.`
    );
    return 'restored';
  } catch (reEnableError) {
    const mask = maskerOrIdentity(opts.mask);
    const failure = describeAwsFailure(reEnableError);
    // The class (or a cdkd-authored text) in the line; AWS's own text at debug.
    const detail = mask(failure.summary);
    if (failure.redacted) {
      // Masked before `safeMsg` too: it flattens line breaks and control
      // characters inside the value, which can split a secret the outer pass
      // would then miss (the #5180 shape of `observeThenDisableProtection`).
      opts.logger.debug(
        mask(
          safeMsg`${site.subject} ${opts.logicalId}: re-enabling ${site.guardName} on ` +
            safeMsg`${opts.physicalId} failed: ${mask(failure.detail)}`
        )
      );
    }
    const commands = site.commands();
    const caveat = site.restoreCaveat ? ` ${site.restoreCaveat}` : '';
    if (site.isNotFound(reEnableError)) {
      opts.logger.warn(
        safeMsg`${site.subject} ${opts.logicalId}: could not re-enable ` +
          safeMsg`${site.guardName} on ${opts.physicalId} after the delete failed — ` +
          safeMsg`${site.notFoundMeaning} If it still exists, its deletion protection is OFF. ` +
          safeMsg`Check with: ${commands.check} and if it is there, restore it with: ` +
          safeMsg`${commands.restoreAfterNotFound}.${caveat} (${detail})`
      );
      // `failed`, not `not-applicable`: the re-enable was ATTEMPTED and did not
      // land. Whether the resource is gone or merely not modifiable is exactly
      // what this arm says cdkd cannot tell, so the record is kept and a later
      // delete of the same key may try again — the safe direction for the one
      // case that is not "gone".
      return 'failed';
    }
    opts.logger.error(
      safeMsg`${site.subject} ${opts.logicalId}: could NOT re-enable ` +
        safeMsg`${site.guardName} on ${opts.physicalId} after the delete failed — ` +
        safeMsg`that ${site.noun} is LIVE with its deletion protection still off. Restore it with: ` +
        safeMsg`${commands.restoreLive}.${caveat} (${detail})`
    );
    return 'failed';
  }
}

/**
 * Observe the guard, then turn it off, recording the flip only when BOTH
 * halves held (property 3 above).
 *
 * `observe` answers whether AWS currently has the guard ON; its failure is
 * logged at debug and treated as "do not know", so nothing is recorded and the
 * delete still proceeds. `disable`'s failure PROPAGATES: every caller already
 * wraps the flip in a non-fatal `try`, and a rejected flip left the guard
 * where it was, so there is nothing to record.
 *
 * LATCHED, never assigned: on a re-entry the observation reports the guard OFF
 * because the PREVIOUS attempt turned it off, so assigning the observation
 * would erase what that attempt recorded (issue #1978).
 */
export async function observeThenDisableProtection(opts: {
  readonly flip: ProtectionFlipRecord;
  readonly observe: () => Promise<boolean>;
  readonly disable: () => Promise<void>;
  readonly logger: Logger;
  readonly physicalId: string;
  readonly guardName: string;
  /**
   * The delete's `DeleteContext.maskSecrets`. The physical id can carry a
   * dynamic-reference plaintext, and AWS's failure text quotes it, so the
   * debug line below masks both pieces and then the finished line (#5180).
   */
  readonly mask?: MaskerFn | undefined;
}): Promise<void> {
  let observedOn = false;
  try {
    observedOn = await opts.observe();
  } catch (observeError) {
    const mask = maskerOrIdentity(opts.mask);
    opts.logger.debug(
      mask(
        safeMsg`Could not read ${opts.guardName} on ${mask(opts.physicalId)} before disabling it: ${mask(describeAwsFailure(observeError).detail)}`
      )
    );
  }
  await opts.disable();
  if (observedOn) opts.flip.flippedOffByThisRun = true;
}

/**
 * Run one resource's delete under the compensation boundary (property 1).
 *
 * `run` performs the whole delete — flip, `Delete*`, wait — and must set
 * `flip.deleteAccepted` the moment AWS accepts the `Delete*` (on the Cloud
 * Control path, the moment the handler may be deleting: see
 * `CloudControlProvider.deleteThroughCloudControl`). A normal return
 * (deleted, or already gone) releases the record. A throw is compensated,
 * then re-thrown UNCHANGED; the record is released only when the failure is
 * terminal AND the compensation did not fail, for the reasons on
 * {@link ProtectionCompensationOutcome}: a retryable failure keeps it for the
 * re-entry, and a failed re-enable keeps it because cdkd still owes it.
 *
 * The outcome DEFAULTS to `failed`, so a compensation that died part-way (a
 * throwing logger escapes it) retains the record — the safe direction — and
 * the `catch` around it keeps the ORIGINAL error's identity rather than
 * letting that exception replace the delete failure.
 */
export async function deleteWithProtectionCompensation(opts: {
  readonly registry: ProtectionFlipRegistry;
  readonly key: string;
  readonly reuseWithinMs?: number;
  readonly clock?: () => number;
  readonly run: (flip: ProtectionFlipRecord) => Promise<void>;
  readonly compensation: Omit<ProtectionFlipCompensationOptions, 'flip' | 'error'>;
}): Promise<void> {
  const flip = opts.registry.acquire(
    opts.key,
    opts.reuseWithinMs ?? PROTECTION_FLIP_REUSE_WINDOW_MS,
    opts.clock
  );
  try {
    await opts.run(flip);
  } catch (error) {
    await settleProtectionFlip({
      registry: opts.registry,
      key: opts.key,
      flip,
      error,
      compensation: opts.compensation,
    });
    throw error;
  }
  opts.registry.release(opts.key);
}

/**
 * The failure half of {@link deleteWithProtectionCompensation}, for a caller
 * that owes compensation on more than one record per delete: compensate
 * `flip` for `error`, then release `key` only when the failure is terminal AND
 * the compensation did not fail. Never throws and never touches `error`; the
 * caller re-throws it. Resolves whether `key` was released, so a caller that
 * also remembers the record elsewhere can forget it in the same step.
 *
 * The Auto Scaling group is that caller: its `delete()` flips the group's own
 * guard AND each launched instance's `DisableApiTermination` (issue #796), and
 * each instance's record is settled here against the group's delete failure.
 */
export async function settleProtectionFlip(opts: {
  readonly registry: ProtectionFlipRegistry;
  readonly key: string;
  readonly flip: ProtectionFlipRecord;
  readonly error: unknown;
  readonly compensation: Omit<ProtectionFlipCompensationOptions, 'flip' | 'error'>;
}): Promise<boolean> {
  let outcome: ProtectionCompensationOutcome = 'failed';
  try {
    outcome = await compensateProtectionFlip({
      ...opts.compensation,
      flip: opts.flip,
      error: opts.error,
    });
  } catch {
    // `outcome` stays `failed`: see deleteWithProtectionCompensation's JSDoc.
  }
  if (isTerminalDeleteFailure(opts.error) && outcome !== 'failed') {
    opts.registry.release(opts.key);
    return true;
  }
  return false;
}
