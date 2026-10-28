/**
 * `TimeToLiveSpecification` planning shared by `AWS::DynamoDB::Table` and
 * `AWS::DynamoDB::GlobalTable` (issue #5447). TTL never rides on
 * CreateTable / UpdateTable: it is the separate `UpdateTimeToLive` API, which
 * needs an `AttributeName` even to DISABLE TTL, while the CFn schema requires
 * only `Enabled`. Each provider sends the planned call through its own
 * retry / error wrapping, inside {@link sendTtlWaitingOutRateLimit}.
 */

import { enclosingDeadlineRemainingMs } from '../deployment/resource-deadline.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { startInterruptWatch } from './interrupt-watch.js';

/** Normalize a `TimeToLiveSpecification` value into `{ enabled, attributeName }`. */
export function readTtlSpec(spec: unknown): {
  enabled: boolean;
  attributeName: string | undefined;
} {
  if (spec === undefined || spec === null) {
    return { enabled: false, attributeName: undefined };
  }
  const s = spec as Record<string, unknown>;
  const rawName = s['AttributeName'];
  const attributeName = typeof rawName === 'string' && rawName !== '' ? rawName : undefined;
  // CFn `Enabled` is a boolean for CDK L2 synth, but a hand-written L1
  // template can carry the stringified `"true"` / `"false"`. `Boolean("false")`
  // is `true`, so coerce strings case-insensitively rather than via the bare
  // `Boolean()` cast (which would treat `"false"` as enabled and either
  // re-enable a disabled TTL or fire the rename guard spuriously). Absent
  // `Enabled` defaults to `true` (CFn default).
  const rawEnabled = s['Enabled'];
  const enabled =
    rawEnabled === undefined
      ? true
      : typeof rawEnabled === 'string'
        ? rawEnabled.toLowerCase() === 'true'
        : Boolean(rawEnabled);
  return { enabled, attributeName };
}

/**
 * The `UpdateTimeToLive` call a TTL change needs:
 *
 * - `enable` / `disable` carry the attribute name to send;
 * - `disable-live` means the name is unknown (no enabled spec was recorded):
 *   read it with `DescribeTimeToLive` and disable only when TTL is
 *   `ENABLED` / `ENABLING`;
 * - `none` sends nothing.
 *
 * Disabling a TTL that is not enabled is refused by AWS ("TimeToLive is
 * already disabled"), so a desired-disabled spec sends nothing on create (a
 * new table starts with TTL disabled), and with no enabled spec recorded the
 * live status decides.
 */
export type TtlPlan =
  | { kind: 'none' }
  | { kind: 'enable'; attributeName: string }
  | { kind: 'disable'; attributeName: string }
  | { kind: 'disable-live' };

/**
 * Plan the TTL call for a desired spec. `previousSpec` is the recorded spec on
 * update; `mode: 'create'` means a brand-new table. Called only when the spec
 * changed.
 */
export function planTimeToLive(
  spec: unknown,
  previousSpec: unknown,
  mode: 'create' | 'update'
): TtlPlan {
  const desired = readTtlSpec(spec);
  if (spec !== undefined && spec !== null && desired.enabled) {
    // `Enabled: true` without a name is unsendable; nothing to do.
    return desired.attributeName
      ? { kind: 'enable', attributeName: desired.attributeName }
      : { kind: 'none' };
  }

  // Desired state: TTL disabled, either `Enabled: false` or the whole block
  // removed (CloudFormation disables TTL on a removal too).
  if (mode === 'create') return { kind: 'none' };

  const previousPresent = previousSpec !== undefined && previousSpec !== null;
  const previous = readTtlSpec(previousSpec);
  if (previousPresent && previous.enabled && previous.attributeName) {
    // The disable must name the attribute TTL is ACTIVE on, which is the
    // recorded one, not a name the desired disabled spec may carry.
    return { kind: 'disable', attributeName: previous.attributeName };
  }
  // No enabled spec recorded: the live state is the only source of the
  // attribute name. A spec recorded as disabled is not trusted either: before
  // #5447 a name-less `Enabled: false` was recorded while TTL stayed enabled.
  return { kind: 'disable-live' };
}

/**
 * AWS's refusal of a disable whose goal already holds ("TimeToLive is already
 * disabled", measured). A disable sent on the RECORDED name skips the live read,
 * so a retry after a partial failure, or a table disabled out of band, meets it.
 */
export function isTtlAlreadyDisabled(awsDetail: string): boolean {
  return /TimeToLive is already disabled/i.test(awsDetail);
}

/**
 * AWS's refusal of an `UpdateTimeToLive` sent too soon after the previous TTL
 * change on the table (measured wording; issue #5451).
 */
export function isTtlRateLimited(awsDetail: string): boolean {
  return /Time to live has been modified multiple times/i.test(awsDetail);
}

/** How often a rate-limited `UpdateTimeToLive` is re-sent. */
export const TTL_RATE_LIMIT_RETRY_MS = 60_000;
/** Slice of the retry sleep between Ctrl-C checks. */
const TTL_RATE_LIMIT_SLICE_MS = 1_000;

/**
 * Send an `UpdateTimeToLive`, waiting out DynamoDB's TTL rate-limit interval
 * the way CloudFormation does (issue #5451): AWS refuses a second TTL change
 * for a while after the previous one (about half an hour measured after an
 * enable; AWS documents up to an hour), and CloudFormation re-sends until it
 * is accepted, where cdkd used to fail the deploy.
 *
 * Re-sends every {@link TTL_RATE_LIMIT_RETRY_MS} while the refusal repeats,
 * bounded by the enclosing per-resource deadline (`--resource-timeout`): once
 * that runs out, the last refusal is rethrown for the caller to report, and
 * nothing is sent after it. A path with no enclosing deadline (a rollback,
 * `cdkd drift --revert`) waits until AWS accepts, as CloudFormation's rollback
 * does. Ctrl-C ends the wait. Any other failure is rethrown at once.
 *
 * `announce` is called once, on the first refusal, so the user knows why the
 * deploy sits there; the caller masks it.
 */
export async function sendTtlWaitingOutRateLimit(
  send: () => Promise<unknown>,
  options: {
    what: string;
    announce: () => void;
    retryMs?: number;
  }
): Promise<void> {
  const retryMs = options.retryMs ?? TTL_RATE_LIMIT_RETRY_MS;
  const watch = startInterruptWatch(options.what);
  let announced = false;
  try {
    for (;;) {
      try {
        await send();
        return;
      } catch (error) {
        if (!isTtlRateLimited(describeAwsFailure(error).detail)) throw error;
        if (enclosingDeadlineRemainingMs() <= 0) throw error;
        if (!announced) {
          options.announce();
          announced = true;
        }
        const until = Date.now() + Math.min(retryMs, enclosingDeadlineRemainingMs());
        while (Date.now() < until) {
          if (watch.isInterrupted()) throw watch.onInterrupted();
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(TTL_RATE_LIMIT_SLICE_MS, until - Date.now()))
          );
        }
        if (watch.isInterrupted()) throw watch.onInterrupted();
        // The sleep ends AT the deadline when less than a minute was left: a
        // send now could land after the resource was already reported failed,
        // changing TTL on AWS while state keeps the old spec.
        if (enclosingDeadlineRemainingMs() <= 0) throw error;
      }
    }
  } finally {
    watch.dispose();
  }
}
