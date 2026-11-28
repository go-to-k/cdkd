import { GetChangeCommand, type Route53Client } from '@aws-sdk/client-route-53';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { isThrottlingError, isTransientServerError } from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { describeAwsFailure, verboseAwareText } from '../../../utils/aws-failure-text.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';

/**
 * `GetChange` every 2 seconds, for up to 15 minutes. Measured us-east-1: a
 * zone or record change reaches `INSYNC` after ~25-37 s, a VPC association
 * after ~80 s.
 */
export const CHANGE_INSYNC_POLL_MS = 2000;
export const CHANGE_INSYNC_POLLS = 450;

/**
 * The `ChangeInfo.Id` a Route 53 write answered. Tolerates an absent response
 * (a mocked client answers `undefined`), which waits on nothing.
 */
export function changeIdOf(
  output: { readonly ChangeInfo?: { readonly Id?: string | undefined } | undefined } | undefined
): string | undefined {
  return output?.ChangeInfo?.Id;
}

export interface ChangeInsyncOptions {
  /** Overrides for tests. */
  readonly pollMs?: number;
  readonly maxPolls?: number;
}

/**
 * Under `--full-wait` only, wait until the Route 53 change `changeId` (the
 * `ChangeInfo.Id` a `CreateHostedZone`, `ChangeResourceRecordSets`,
 * `AssociateVPCWithHostedZone`, `DisassociateVPCFromHostedZone` or
 * `DeleteHostedZone` answered `PENDING`) reads `INSYNC` (go-to-k/cdkd#7132).
 *
 * CloudFormation waits for it (measured us-east-1: a HostedZone create
 * ~42 s, a RecordSet create ~43 s, a HostedZone `VPCs` update ~103 s), but
 * nothing in cdkd reads `INSYNC` (drift reads `ListResourceRecordSets`, which
 * already shows a `PENDING` change) and a change cannot fail once accepted
 * (the API has only `PENDING` / `INSYNC`). So by maintainer decision the
 * default deploy and `--no-wait` return at once with no extra call, and
 * `--full-wait` ("everything CloudFormation waits for") waits, as for the
 * CloudFront Distribution's `Deployed`.
 *
 * Running out of the poll cap or the enclosing per-resource deadline WARNS
 * and returns, as the CloudFront wait does: propagation finishes in the
 * background, and failing would hand rollback a healthy resource. A
 * throttled or 5xx read is one more pending poll; any other read failure
 * warns and returns. Ctrl-C throws `InterruptedWaitError`.
 */
export async function waitForRoute53ChangeInsync(
  client: Route53Client,
  changeId: string | undefined,
  what: string,
  log: MaskedLogSinks,
  opts: ChangeInsyncOptions = {}
): Promise<void> {
  if (process.env['CDKD_FULL_WAIT'] !== 'true') return;
  if (!changeId) {
    log.debug(`No Route 53 change id to wait on for ${what}`);
    return;
  }
  const pollMs = opts.pollMs ?? CHANGE_INSYNC_POLL_MS;
  const maxPolls = opts.maxPolls ?? CHANGE_INSYNC_POLLS;
  const id = changeId.replace(/^\/change\//, '');
  const manual = `To wait manually: ${pasteableAwsCommand(log.mask)`aws route53 wait resource-record-sets-changed --id ${id}`.render()}.`;
  const giveUp = (why: string): void =>
    log.warn(
      `The Route 53 change for ${what} ${why}; continuing (propagation finishes in the background). ${manual}`
    );
  const watch = startInterruptWatch(log.mask(`the Route 53 change for ${what} to reach INSYNC`));
  try {
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      if (enclosingDeadlineRemainingMs() <= 0) {
        giveUp('did not reach INSYNC before the resource timeout');
        return;
      }
      try {
        const response = await client.send(new GetChangeCommand({ Id: id }));
        if (response.ChangeInfo?.Status === 'INSYNC') return;
      } catch (error) {
        if (!(isThrottlingError(error) || isTransientServerError(error))) {
          log.debug(`GetChange for ${what} failed: ${describeAwsFailure(error).detail}`);
          giveUp(
            `could not be read (${verboseAwareText('re-run with --verbose for the reason', 'the reason is in the debug output above')})`
          );
          return;
        }
        log.debug(
          `A read while waiting for the Route 53 change for ${what} was throttled or failed server-side; reading again`
        );
      }
      if (poll === maxPolls) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(pollMs, enclosingDeadlineRemainingMs())))
      );
    }
  } finally {
    watch.dispose();
  }
  giveUp(`did not reach INSYNC within ${(maxPolls * pollMs) / 1000} seconds`);
}
