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
 * / `DeleteLogGroup`, and for a Cognito user pool `DescribeUserPool` /
 * `UpdateUserPool` / `DeleteUserPool`; the argument is the same.
 */

import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { ElapsedBudget, monotonicNowMs } from '../../utils/elapsed-budget.js';
import { isInterruptedWaitError } from '../interrupt-watch.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../deployment/retryable-errors.js';
import type { Logger } from '../../types/config.js';
import { injectiveKey } from '../../state/record-keys.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';

/**
 * What THIS delete run did to the deletion guard, threaded from the
 * `--remove-protection` flip down to the error path that may have to undo it.
 *
 * Mutable-by-reference on purpose: the flip happens deep inside `delete()`
 * while the compensation runs in the `catch` that wraps it, and a returned
 * value cannot cross a `throw`.
 */
export interface ProtectionFlipRecord {
  /**
   * True only when BOTH halves held: the pre-flip `DescribeTable` OBSERVED the
   * guard on, and the `UpdateTable` that turned it off was accepted.
   *
   * The observation is what keeps the compensation from becoming a state change
   * the user never asked for. A table whose protection was ALREADY off before
   * the run must never be "re-enabled" — cdkd would then be turning a failed
   * destroy into a configuration change, which is strictly worse than the
   * residue this whole mechanism exists to clean up. `undefined`-shaped
   * uncertainty resolves the same way: if the observing describe failed, we do
   * not know what the user had, so we leave it alone.
   *
   * LATCHING, and that is the whole reason this record is keyed rather than
   * per-call (see {@link ProtectionFlipRegistry}). A re-entered `delete()`
   * observes the guard already OFF — *because the previous attempt turned it
   * off* — so a writer that ASSIGNED its own observation here would erase what
   * the first attempt recorded, and the terminal failure on the second attempt
   * would compensate nothing. Writers set it to `true` or leave it; only a
   * `release()` clears it.
   */
  flippedOffByThisRun: boolean;

  /**
   * Whether AWS ACCEPTED a `DeleteTable` for this resource in this run.
   *
   * Once it has, the table is on its way out and the guard must NOT be put
   * back: a later throw on this path is a WAIT failing, not the delete. The
   * concrete case is `waitForTableGone`'s `Table X did not disappear within
   * Ns`, which is raised after `DeleteTable` already succeeded and matches no
   * retryable pattern, so it is terminal by this module's own predicate. Left
   * ungated, the compensation would issue `UpdateTable(true)` against a
   * `DELETING` table and then narrate that the table is "LIVE with its deletion
   * protection still off" — false, and pointing the user at a table that is
   * already gone.
   *
   * Latching for the same reason as the field above: an accepted delete stays
   * accepted across the outer loop's re-entry.
   */
  deleteAccepted: boolean;
}

/**
 * {@link ProtectionFlipRecord}s keyed by the resource they describe, so a
 * `delete()` that is RE-ENTERED remembers what an earlier attempt did.
 *
 * Shaped after `ElapsedBudgetRegistry` in `../../utils/elapsed-budget.ts`,
 * because it is the same re-entry: `destroy-runner.ts` wraps its outer retry
 * loop — up to four `delete()` calls — in ONE deadline, and re-invokes
 * `delete()` for anything it classes as retryable. A record created per call
 * cannot see that. Attempt 1 observes the guard ON, flips it off and fails on
 * a throttle; attempt 2's pre-flip `DescribeTable` now reports the guard OFF
 * (attempt 1 is why), so a per-call record starts and stays `false` and a
 * TERMINAL failure on attempt 2 compensates nothing. That is precisely the
 * retry-then-fail case of issue #1978.
 *
 * A provider INSTANCE FIELD would be wrong for the same reason the budget is
 * not one: providers are singletons serving concurrent resources, so one field
 * would carry another resource's flip. The key qualifies the physical id by
 * region (and, for a provider serving several types, by type — see
 * {@link protectionFlipKey}).
 *
 * Entries are RETAINED on a throw — that is the point — and released by the
 * caller on a terminal outcome (a completed delete, or a NotFound), so the map
 * holds at most one entry per in-flight resource.
 */
export class ProtectionFlipRegistry {
  private readonly records = new Map<
    string,
    { readonly record: ProtectionFlipRecord; idle: ElapsedBudget }
  >();

  /**
   * The record for `key`, creating it on first use and REUSING it on re-entry.
   *
   * `reuseWithinMs` bounds how long an entry may sit UNUSED, and the window
   * SLIDES: every reuse restarts the stopwatch, so what is bounded is the idle
   * time since the last `acquire` rather than the entry's total lifetime. It is
   * still needed for the reason it was introduced: entries are RETAINED on a
   * throw, so without any bound a retained record would let a much LATER
   * destroy of the same resource re-enable a guard it never touched — the
   * inverse hazard of the one this record exists for.
   *
   * Measuring from FIRST acquisition instead is what issue #2211 reported, and
   * it re-creates issue #1978's residue through this very mechanism. The retry
   * sequence is unbounded while the window is a wall clock, so a
   * `--resource-timeout` overshoot past the window lets a LIVE sequence age
   * out MID-flight: `acquire` drops the entry and hands the next attempt a
   * fresh `{ flippedOffByThisRun: false }`, whose pre-flip readback then
   * observes the guard already OFF — because attempt 1 turned it off — so the
   * latch stays `false` and a terminal failure compensates nothing.
   *
   * KNOWN BOUND, stated because the obvious reading overclaims it. `acquire` is
   * called ONCE per `delete()`, at the top, and nothing touches the entry's
   * idle STOPWATCH again (the record's fields are mutated throughout, and
   * `release` drops it) — so the interval this measures is not a gap BETWEEN
   * operations, it is the previous ATTEMPT's own duration plus the outer loop's
   * backoff. What can still age out a successor is therefore an attempt that
   * OVERRUNS the window rather than one that merely spends it. The slide
   * removes the ACCUMULATION case — many attempts summing past the window, the
   * common shape and the one issue #2211 reported — not the overrun one.
   * Closing the remainder means sliding at attempt END too (a `touch(key)` in
   * `delete()`'s catch), which is a behaviour change to the delete path and
   * belongs in its own change.
   */
  acquire(
    key: string,
    reuseWithinMs: number,
    clock: () => number = monotonicNowMs
  ): ProtectionFlipRecord {
    const existing = this.records.get(key);
    if (existing) {
      if (existing.idle.elapsedMs() <= reuseWithinMs) {
        // The SLIDE. Restarting the stopwatch on every reuse is what keeps a
        // long retry sequence from aging out its own record mid-flight.
        //
        // Note this rebases on the CALLER's clock, where the sibling
        // `ElapsedBudgetRegistry.acquire` documents that a re-entry must not
        // grant itself a fresh one. Inert in production -- both resolve to
        // `monotonicNowMs`, and the divergence is only reachable from a test
        // that injects different clocks to the same key -- but the two
        // registries genuinely differ here, so do not read one's contract onto
        // the other.
        existing.idle = new ElapsedBudget(reuseWithinMs, clock);
        return existing.record;
      }
      this.records.delete(key);
    }
    const created = {
      record: { flippedOffByThisRun: false, deleteAccepted: false },
      // Only a monotonic stopwatch is wanted here; the total is never read.
      idle: new ElapsedBudget(reuseWithinMs, clock),
    };
    this.records.set(key, created);
    return created.record;
  }

  /** Drop `key`'s record — call on a TERMINAL outcome, never between retries. */
  release(key: string): void {
    this.records.delete(key);
  }

  /** Live entries; exists so a test can prove release actually released. */
  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * The {@link ProtectionFlipRegistry} key for a provider that serves SEVERAL
 * resource types from one instance (RDS / DocDB / Neptune: a cluster and an
 * instance).
 *
 * The type is part of the key because a cluster and an instance live in
 * separate identifier namespaces, so `db1` can name one of each in the same
 * region; a key without the type would hand the instance's delete the
 * cluster's flip record. Region-qualified for the same reason the DynamoDB
 * key is, and ENCODED rather than separated, since every component comes from
 * a state record (go-to-k/cdkd#3496).
 */
export function protectionFlipKey(
  resourceType: string,
  physicalId: string,
  region: string | undefined
): string {
  return injectiveKey(resourceType, region ?? '', physicalId);
}

/**
 * How long a flip record of any {@link deleteWithProtectionCompensation}
 * caller (the RDS family, the log group, the user pool) may sit idle between two `delete()`
 * attempts of one retry sequence before a later delete no longer inherits it.
 *
 * The 30-minute default per-resource deadline, which is what bounds a retry
 * sequence at default settings. Spelled here rather than imported from
 * `deploy-engine.ts`, which a provider helper must not depend on. It is
 * generous on purpose: on these types an attempt that can still be
 * compensated is SHORT — a readback, a `Modify*`, and a `Delete*` that AWS
 * refused — because once AWS accepts the `Delete*` the record's
 * `deleteAccepted` latch ends compensation for good, whatever the wait after
 * it costs.
 */
export const PROTECTION_FLIP_REUSE_WINDOW_MS = 30 * 60_000;

/**
 * Whether `error` ends the delete for good, i.e. whether `destroy-runner.ts`'s
 * outer loop will NOT re-enter `delete()` for it.
 *
 * This is the gate on the compensation, and it is issue #1978's own point:
 * re-enabling the guard after a RETRYABLE failure would flip the flag back and
 * forth across a retry sequence, since the next `delete()` immediately turns it
 * off again. Compensation belongs on the terminal failure only.
 *
 * The predicate MIRRORS `destroy-runner.ts`'s re-entry condition
 * (`!isMarkedNonRetryable && (isRetryableTransientError || 'Too Many
 * Requests')`) rather than inventing a second classification, and it is applied
 * to the error the provider is about to THROW — the same wrapped
 * `ProvisioningError` message the outer loop will classify — so the two cannot
 * disagree about who gets re-entered.
 *
 * A user abort is terminal here even though nothing classifies it: the run is
 * being torn down, so no re-entry is coming and the guard would otherwise stay
 * down. That is the Ctrl-C route recorded on issue #1978.
 *
 * KNOWN NARROWINGS, all deliberate. Each leaves the guard off in a case this
 * mechanism does not reach; none of them is silent about it here.
 *
 *  1. **Attempt-cap exhaustion.** A genuinely retryable failure that exhausts
 *     the outer loop's attempt cap ends the run with the guard still off,
 *     because the provider cannot see which attempt is the last one.
 *     Compensating on every attempt instead would trade that residue for a
 *     re-enable / disable pair per retry against a service AWS is already
 *     throttling.
 *  2. **The per-resource DEADLINE route.** `src/deployment/resource-deadline.ts`
 *     rejects the OUTER promise on its timer and does NOT cancel what it
 *     wraps — the provider's own `await` never settles as a rejection, so no
 *     `ResourceTimeoutError` ever enters `delete()`'s `catch` and nothing here
 *     runs for it. The provider keeps polling behind a run that has already
 *     reported failure (the same non-cancelling shape issue #1955 documents),
 *     and if that poll eventually succeeds the resource is gone anyway. Closing
 *     this would mean making the deadline cancel — a change to a mechanism
 *     every provider shares — so it is recorded, not fixed here.
 *  3. **The compensation itself is unbounded.** `reEnable` is one control-plane
 *     write with no timeout of its own, so on Ctrl-C it adds one SDK call per
 *     flipped resource to a teardown the user has already asked to end. Left
 *     unbounded on purpose: it is a single round trip (no polling, no wait),
 *     the SDK's own retry/timeout config already applies to it, and it is the
 *     ONLY thing standing between a Ctrl-C and a live resource with its guard
 *     stripped — a timeout short enough to be felt during teardown would mostly
 *     convert successful restores into the "could NOT re-enable" line. Revisit
 *     if the compensation ever grows a WAIT.
 */
export function isTerminalDeleteFailure(error: unknown): boolean {
  if (isInterruptedWaitError(error)) return true;
  if (isMarkedNonRetryable(error)) return true;
  // Deliberately reads the TOP-LEVEL message, unlike `destroy-runner.ts`'s and
  // `retry.ts`'s twins of this same two-arm shape, which issue #2302 moved onto
  // `retryClassificationText`. The difference is the population, not the
  // pattern: those two classify errors from ANY provider, so a provider that
  // redacts its thrown message (only `S3BucketProvider` does today) empties
  // what they match on. This one classifies only the delete throws of its
  // adopters (the DynamoDB pair, RDS, DocDB, Neptune, the Logs log group and
  // the Cognito user pool), which carry their
  // cause's text verbatim -- so the chain read would be a no-op here, and
  // `retryClassificationText` is opt-in anyway (nothing on these paths stamps
  // itself with `markRedactedCause`). Move it onto the chain text the moment an
  // adopter's throw starts redacting; the shape is otherwise identical.
  const message = error instanceof Error ? error.message : String(error);
  return !(isRetryableTransientError(error, message) || message.includes('Too Many Requests'));
}

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
   * `cause`-chain walk: every `reEnable` is a bare `send`, so the SDK error
   * arrives unwrapped. If one ever wraps its call, a name-keyed predicate
   * answers `false` and the compensation keeps the LOUD error line — the safe
   * direction.
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
 * Built here rather than in `logs-loggroup-provider.ts`, whose LogGroupClass
 * refusal pins its own `put-log-group-deletion-protection` spelling as UNIQUE
 * in that file (`logs-loggroup-provider-class-guard.test.ts`).
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
 * every other `UpdateUserPool` member, and `AutoVerifiedAttributes` is measured
 * to RESET on omission (the ledger at `readLiveMfaConfiguration` in
 * `cognito-provider.ts`).
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
      'Note UpdateUserPool resets some members a call omits (AutoVerifiedAttributes among them), ' +
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
  /** Issues the write that turns the guard back ON. */
  readonly reEnable: () => Promise<void>;
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
    await opts.reEnable();
    opts.logger.warn(
      safeMsg`${site.subject} ${opts.logicalId}: the delete failed after ` +
        safeMsg`--remove-protection had turned ${site.guardName} off, so it was ` +
        safeMsg`re-enabled on ${opts.physicalId}. The delete failure below is the outcome.`
    );
    return 'restored';
  } catch (reEnableError) {
    const detail = describeAwsFailure(reEnableError).detail;
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
}): Promise<void> {
  let observedOn = false;
  try {
    observedOn = await opts.observe();
  } catch (observeError) {
    opts.logger.debug(
      safeMsg`Could not read ${opts.guardName} on ${opts.physicalId} before disabling it: ${describeAwsFailure(observeError).detail}`
    );
  }
  await opts.disable();
  if (observedOn) opts.flip.flippedOffByThisRun = true;
}

/**
 * Run one resource's delete under the compensation boundary (property 1).
 *
 * `run` performs the whole delete — flip, `Delete*`, wait — and must set
 * `flip.deleteAccepted` the moment AWS accepts the `Delete*`. A normal return
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
    let outcome: ProtectionCompensationOutcome = 'failed';
    try {
      outcome = await compensateProtectionFlip({ ...opts.compensation, flip, error });
    } catch {
      // `outcome` stays `failed`: see the JSDoc.
    }
    if (isTerminalDeleteFailure(error) && outcome !== 'failed') {
      opts.registry.release(opts.key);
    }
    throw error;
  }
  opts.registry.release(opts.key);
}
