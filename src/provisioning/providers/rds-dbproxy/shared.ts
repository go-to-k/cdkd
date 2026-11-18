import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { waitForGoneAfterDelete } from '../../delete-gone-wait.js';
import { createMaskedLogSinks } from '../../masked-retry-logger.js';
import { markWaitAbandoned } from '../../wait-abandoned.js';
import type { InterruptWatch } from '../../interrupt-watch.js';

export const POLL_INTERVAL_MS = 5000;
export const POLL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Budget kept back from the enclosing per-resource deadline, so a poll's own
 * "Timed out" error is what fails the resource rather than the deadline's.
 */
export const DEADLINE_MARGIN_MS = 30_000;

/**
 * go-to-k/cdkd#6517: the pause between two reads of a DBProxy or
 * DBProxyEndpoint status poll (the create and post-modify waits; the delete
 * waits are {@link waitForDBProxyDeleteGone}).
 * Sleeps up to {@link POLL_INTERVAL_MS} in steps of at most a second,
 * throwing the watch's error as soon as Ctrl-C is seen. Answers `false`,
 * without sleeping, once the poll's own `deadline` or the enclosing resource
 * deadline (less {@link DEADLINE_MARGIN_MS}) leaves no room, so the caller
 * stops and throws its own timeout instead of polling on after the engine
 * has failed the resource.
 */
export async function pauseBeforeNextPoll(
  deadline: number,
  watch: InterruptWatch
): Promise<boolean> {
  if (watch.isInterrupted()) throw watch.onInterrupted();
  const left = Math.min(deadline - Date.now(), enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS);
  if (left <= 0) return false;
  let remaining = Math.min(POLL_INTERVAL_MS, left);
  while (remaining > 0) {
    const step = Math.min(1_000, remaining);
    await new Promise((resolve) => setTimeout(resolve, step));
    remaining -= step;
    if (watch.isInterrupted()) throw watch.onInterrupted();
  }
  return true;
}

/**
 * go-to-k/cdkd#6522: the wait after an ACCEPTED `DeleteDBProxy` or
 * `DeleteDBProxyEndpoint`, until the read reports the resource gone. It runs
 * through the shared post-delete wait (`delete-gone-wait.ts`), so a Ctrl-C,
 * the cap and an unreadable status behave as for every other accepted delete:
 * they warn and RETURN, since AWS finishes the delete whatever cdkd does next.
 * The cap is the poll's own, less what the enclosing resource deadline leaves
 * (less {@link DEADLINE_MARGIN_MS}), so the wait stops before the engine fails
 * the resource rather than polling on behind it.
 *
 * The exits that throw, keeping the state record, are the two where AWS may
 * not be removing the resource, so returning would drop the record of one
 * that stays: it LEFT `deleting` for another status, or the wait ended (cap,
 * Ctrl-C, unreadable status) without ever reading `deleting` while its last
 * read named another status. A status before the first `deleting` does not
 * end the wait early (the read can lag the accepted delete), and a read with
 * no status (`unknown`) keeps it going.
 *
 * `readStatus` resolves `undefined` once the resource is gone, else its status
 * (`unknown` when the answer carries none). `what` names the resource in log
 * lines; every line the wait logs goes through `mask`, the class of an
 * unreadable status's error included.
 */
export async function waitForDBProxyDeleteGone(opts: {
  what: string;
  resourceType: string;
  logicalId: string;
  physicalId: string;
  readStatus: () => Promise<string | undefined>;
  logger: { debug(message: string): void; warn(message: string): void };
  mask: (text: string) => string;
}): Promise<void> {
  const what = opts.mask(opts.what);
  let sawDeleting = false;
  let gone = false;
  let lastStatus: string | undefined;
  const stays = (text: string): Error =>
    markWaitAbandoned(
      new ProvisioningError(
        opts.mask(`${opts.what} ${text}. The state record is kept: check it, then re-run.`),
        opts.resourceType,
        opts.logicalId,
        opts.physicalId
      )
    );
  await waitForGoneAfterDelete({
    what,
    resourceType: opts.resourceType,
    describe: async () => {
      const status = await opts.readStatus();
      if (status === undefined) gone = true;
      else if (status !== 'unknown') lastStatus = status;
      return status;
    },
    consequence:
      'AWS finishes the delete on its side; until it does, a create of the same name can be ' +
      'refused, and the subnets and security groups it uses stay in use.',
    failedStatus: (status) => {
      if (status === 'deleting') {
        sawDeleting = true;
        return undefined;
      }
      if (!sawDeleting || status === 'unknown') return undefined;
      return stays(
        `left the deleting state for ${status} after its delete was accepted, so AWS is not removing it`
      );
    },
    logger: createMaskedLogSinks(opts.logger, opts.mask),
    pollIntervalMs: POLL_INTERVAL_MS,
    maxWaitMs: Math.max(
      0,
      Math.min(POLL_TIMEOUT_MS, enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS)
    ),
  });
  if (!gone && !sawDeleting && lastStatus !== undefined) {
    throw stays(
      `still read ${lastStatus}, never deleting, when cdkd stopped waiting after its delete was accepted`
    );
  }
}

/**
 * Issue #1160: the optional, mutable properties whose REMOVAL from the
 * template leaves the live value in place. `ModifyDBProxy` keeps any setting
 * it is not sent, and cdkd sends no reset. The update warns instead of
 * staying silent. `RoleArn` is required, and the create-only properties
 * replace the proxy, so neither belongs here. `Auth` is retained only where
 * the update does not refuse its removal ({@link authRemovalRefused}).
 * `DefaultAuthScheme` (go-to-k/cdkd#2762) is mutable through `ModifyDBProxy`
 * and is retained the same way; CloudFormation's behavior on its removal is
 * not measured, so it is not in {@link CFN_KEEPS_ON_REMOVAL}.
 */
export const RETAINED_ON_REMOVAL: readonly string[] = [
  'Auth',
  'DefaultAuthScheme',
  'RequireTLS',
  'IdleClientTimeout',
  'DebugLogging',
  'VpcSecurityGroupIds',
];

/**
 * The {@link RETAINED_ON_REMOVAL} properties CloudFormation is MEASURED to keep
 * too (CFn A/B us-east-1 2026-10-22: `RequireTLS` true, `IdleClientTimeout`
 * 900, `DebugLogging` true and a custom `VpcSecurityGroupIds` removed together
 * left every live value in place, and the update succeeded). `Auth` is not
 * here: CloudFormation sends its removal, so a warning naming it claims
 * nothing about CloudFormation.
 */
export const CFN_KEEPS_ON_REMOVAL: ReadonlySet<string> = new Set([
  'RequireTLS',
  'IdleClientTimeout',
  'DebugLogging',
  'VpcSecurityGroupIds',
]);

/**
 * Issue #1160: whether `update()` refuses an `Auth` removal. AWS requires
 * `Auth` while `DefaultAuthScheme` is `NONE` or unset, and CloudFormation
 * sends the removal, so its update fails (CFn A/B us-east-1 2026-10-22:
 * `UPDATE_FAILED`, "the 'Auth' parameter is required when the
 * 'defaultAuthScheme' parameter is set to NONE or not specified"). cdkd
 * refuses the same deploy before any call. With `DefaultAuthScheme` set to
 * another value (`IAM_AUTH`), CloudFormation's removal would be accepted, so
 * nothing is refused; cdkd sends no `Auth` reset, so the proxy keeps its live
 * `Auth` and the update warns ({@link RETAINED_ON_REMOVAL}).
 */
export const authRemovalRefused = (
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): boolean =>
  // The scheme the proxy will HOLD: a removed `DefaultAuthScheme` is not sent
  // (RETAINED_ON_REMOVAL), so the live value is still the previous one.
  authRequired({
    DefaultAuthScheme:
      properties['DefaultAuthScheme'] !== undefined
        ? properties['DefaultAuthScheme']
        : previousProperties['DefaultAuthScheme'],
  });

/**
 * Whether an update would leave the proxy with no `Auth` while AWS requires
 * one (go-to-k/cdkd#2762); the shapes are named at its call in `update()`.
 */
export const leavesProxyWithoutAuth = (
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): boolean => {
  const desired = properties['Auth'];
  const declaredEmpty = desired === null || (Array.isArray(desired) && desired.length === 0);
  const switchesToNone =
    properties['DefaultAuthScheme'] === 'NONE' &&
    previousProperties['DefaultAuthScheme'] !== 'NONE';
  if (switchesToNone && (desired === undefined || declaredEmpty)) return true;
  return (
    declaredEmpty &&
    JSON.stringify(desired) !== JSON.stringify(previousProperties['Auth']) &&
    authRemovalRefused(properties, previousProperties)
  );
};

/**
 * Whether AWS requires `Auth` for the proxy the bag describes: while
 * `DefaultAuthScheme` is `NONE` or unset (AWS's own refusal, quoted above;
 * the CFn schema does not list `Auth` as required).
 * `create()` refuses a proxy without `Auth` only then, so a template declaring
 * `DefaultAuthScheme: IAM_AUTH` alone deploys, as on CloudFormation
 * (go-to-k/cdkd#2762).
 */
export const authRequired = (properties: Record<string, unknown>): boolean => {
  const scheme = properties['DefaultAuthScheme'];
  return scheme === undefined || scheme === 'NONE';
};
