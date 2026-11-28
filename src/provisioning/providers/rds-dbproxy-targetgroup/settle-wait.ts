import {
  DescribeDBProxyTargetsCommand,
  type DBProxyTarget,
  type RDSClient,
} from '@aws-sdk/client-rds';
import { startInterruptWatch } from '../../interrupt-watch.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';

/**
 * The wait after `RegisterDBProxyTargets` (go-to-k/cdkd#7132). The call
 * answers `TargetHealth.State: REGISTERING`, and `DescribeDBProxyTargets`
 * then reads `UNAVAILABLE` with `Reason: PENDING_PROXY_CAPACITY`, then
 * `UNAVAILABLE` with no reason, then `AVAILABLE` (measured us-east-1: 11 s on
 * a warm proxy, ~5.5 min on a proxy created minutes earlier).
 * CloudFormation's `AWS::RDS::DBProxyTargetGroup` create completes only once
 * the targets read `AVAILABLE` (~22 s on the warm proxy, `AVAILABLE` read
 * right after `CREATE_COMPLETE`). Returning earlier froze the drift baseline
 * on a registration that had not landed, and a target that ends
 * `CONNECTION_FAILED` / `AUTH_FAILURE` was never reported.
 *
 * UNPROVABLE CAVEAT: a DB the proxy cannot reach (a security group without
 * the egress) leaves its target `UNAVAILABLE` / `PENDING_PROXY_CAPACITY`
 * with no failure reason, so this wait runs to its cap and throws "not
 * confirmed" — CloudFormation also sat in `CREATE_IN_PROGRESS` there for 22+
 * minutes. No status tells that case from a cold proxy still starting.
 *
 * UNMEASURED CHOICE: `UNUSED` counts as settled, like `AVAILABLE`, on any
 * row. It is a state a target rests in (an Aurora reader the proxy's
 * endpoint does not use), so waiting cannot change it, and holding it
 * pending would run every such create to the cap. No probe has seen it; it
 * was chosen so that a resting state never hangs the deploy.
 *
 * `--no-wait` (`CDKD_NO_WAIT=true`) skips the wait and keeps the old early
 * return. The wait is bounded by its poll cap and by the enclosing
 * per-resource deadline (`--resource-timeout`), and is Ctrl-C-aware. Running
 * out of either throws: the registration is not confirmed, never reported as
 * applied. A throttled or 5xx read counts as one more pending poll; any other
 * read failure ends the wait through `wrapReadError`. Every failure the wait
 * itself decides is non-retryable: a retry would register the targets again.
 */

export interface ProxyTargetsWaitOptions {
  /** Overrides for tests. */
  readonly pollMs?: number;
  readonly maxPolls?: number;
}

/** `DescribeDBProxyTargets` every 3 seconds, for up to 15 minutes. */
export const PROXY_TARGETS_POLL_MS = 3000;
export const PROXY_TARGETS_POLLS = 300;
/**
 * A failure reason must read on this many CONSECUTIVE polls before it fails
 * the wait: a cold proxy passes through `UNAVAILABLE` states on its way to
 * `AVAILABLE`, and one such read is not the result.
 */
export const PROXY_TARGET_FAILURE_GRACE_POLLS = 3;

/** The `TargetHealth.Reason` values under `UNAVAILABLE` that fail the wait. */
const FAILURE_REASONS: ReadonlySet<string> = new Set([
  'CONNECTION_FAILED',
  'AUTH_FAILURE',
  'INVALID_REPLICATION_STATE',
]);

/** The targets one `RegisterDBProxyTargets` call named. */
export interface RegisteredProxyTargets {
  readonly clusters: readonly string[];
  readonly instances: readonly string[];
}

/**
 * The health rows a registered target is judged by. An instance is its own
 * `RDS_INSTANCE` row (no `TrackedClusterId`). A cluster is the rows carrying
 * its id as `TrackedClusterId` — its member instances — and never its
 * `TRACKED_CLUSTER` row, which names the registration, not a connection the
 * proxy health-checks.
 */
function rowsFor(targets: readonly DBProxyTarget[], kind: 'cluster' | 'instance', id: string) {
  return targets.filter((t) =>
    kind === 'cluster'
      ? t.Type !== 'TRACKED_CLUSTER' && t.TrackedClusterId === id
      : t.Type !== 'TRACKED_CLUSTER' && !t.TrackedClusterId && t.RdsResourceId === id
  );
}

const healthOf = (t: DBProxyTarget): string =>
  [t.TargetHealth?.State ?? 'no state', t.TargetHealth?.Reason].filter(Boolean).join('/');

/**
 * After `RegisterDBProxyTargets`: wait until every row of every target the
 * call registered reads `AVAILABLE` (or the resting `UNUSED`). `REGISTERING`,
 * `UNAVAILABLE` with `PENDING_PROXY_CAPACITY` or with no reason, a target not
 * yet listed, and any state or reason not named here (`UNREACHABLE`,
 * `PROMOTED`) are
 * pending, so only the cap ends them. `UNAVAILABLE` with `CONNECTION_FAILED`,
 * `AUTH_FAILURE` or `INVALID_REPLICATION_STATE` read on
 * {@link PROXY_TARGET_FAILURE_GRACE_POLLS} consecutive polls fails; AWS's
 * `Description` goes to debug only, masked.
 */
export async function waitForProxyTargetsAvailable(
  client: RDSClient,
  logicalId: string,
  dbProxyName: string,
  targetGroupName: string,
  registered: RegisteredProxyTargets,
  log: MaskedLogSinks,
  /** Turns a non-transient read failure into the error the wait throws. */
  wrapReadError: (error: unknown) => Error,
  opts: ProxyTargetsWaitOptions = {}
): Promise<void> {
  const what = `the targets of DB proxy target group ${logicalId} to read AVAILABLE`;
  if (registered.clusters.length === 0 && registered.instances.length === 0) return;
  if (process.env['CDKD_NO_WAIT'] === 'true') {
    log.debug(`Skipping the wait for ${what} (CDKD_NO_WAIT=true)`);
    return;
  }
  const pollMs = opts.pollMs ?? PROXY_TARGETS_POLL_MS;
  const maxPolls = opts.maxPolls ?? PROXY_TARGETS_POLLS;
  const watched = [
    ...registered.clusters.map((id) => ({ kind: 'cluster' as const, id })),
    ...registered.instances.map((id) => ({ kind: 'instance' as const, id })),
  ];
  let last = 'none read';
  let failingPolls = 0;
  const watch = startInterruptWatch(log.mask(what));
  try {
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      // The engine's deadline does not cancel this call chain, so a wait that
      // outlived it would keep polling with nobody waiting on it.
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw markNonRetryable(
          new Error(
            log.mask(
              `The resource timeout expired while waiting for ${what} (last read: ${last}); ` +
                `the registration is not confirmed`
            )
          )
        );
      }
      let targets: DBProxyTarget[] | undefined;
      try {
        targets = await readTargets(client, dbProxyName, targetGroupName);
      } catch (error) {
        if (!(isThrottlingError(error) || isTransientServerError(error))) {
          throw wrapReadError(error);
        }
        log.debug(
          `A read while waiting for ${what} was throttled or failed server-side; reading again`
        );
      }
      if (targets !== undefined) {
        const pending: string[] = [];
        let failure: { id: string; row: DBProxyTarget } | undefined;
        for (const { kind, id } of watched) {
          const rows = rowsFor(targets, kind, id);
          if (rows.length === 0) {
            pending.push(`${log.value(id)} not listed`);
            continue;
          }
          for (const row of rows) {
            const state = row.TargetHealth?.State;
            if (state === 'AVAILABLE' || state === 'UNUSED') continue;
            pending.push(`${log.value(row.RdsResourceId ?? id)} ${healthOf(row)}`);
            if (
              failure === undefined &&
              row.TargetHealth?.State === 'UNAVAILABLE' &&
              FAILURE_REASONS.has(row.TargetHealth.Reason ?? '')
            ) {
              failure = { id: row.RdsResourceId ?? id, row };
            }
          }
        }
        if (pending.length === 0) return;
        last = pending.join(', ');
        failingPolls = failure === undefined ? 0 : failingPolls + 1;
        if (failure !== undefined && failingPolls >= PROXY_TARGET_FAILURE_GRACE_POLLS) {
          const reason = failure.row.TargetHealth?.Reason ?? '';
          const head =
            `DB proxy target group ${logicalId}: target ${log.value(failure.id)} of proxy ` +
            `${log.value(dbProxyName)} reads UNAVAILABLE (${reason}), expected AVAILABLE`;
          const text = describeAwsStatusReason(
            { code: reason, message: failure.row.TargetHealth?.Description },
            ''
          );
          if (text.redacted) log.debug(`${head}: ${text.detail}`);
          throw markNonRetryable(
            new Error(log.mask(text.redacted ? `${head}. ${text.summary}` : head))
          );
        }
      }
      if (poll === maxPolls) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(pollMs, enclosingDeadlineRemainingMs())))
      );
    }
  } finally {
    watch.dispose();
  }
  throw markNonRetryable(
    new Error(
      log.mask(
        `Timed out waiting for ${what}: still ${last} after ${(maxPolls * pollMs) / 1000} ` +
          `seconds; the registration is not confirmed`
      )
    )
  );
}

async function readTargets(
  client: RDSClient,
  dbProxyName: string,
  targetGroupName: string
): Promise<DBProxyTarget[]> {
  const out: DBProxyTarget[] = [];
  let marker: string | undefined;
  do {
    const page = await client.send(
      new DescribeDBProxyTargetsCommand({
        DBProxyName: dbProxyName,
        TargetGroupName: targetGroupName,
        ...(marker ? { Marker: marker } : {}),
      })
    );
    out.push(...(page.Targets ?? []));
    marker = page.Marker;
  } while (marker);
  return out;
}
