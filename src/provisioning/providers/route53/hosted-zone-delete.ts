import type { Route53Provider } from '../route53-provider.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import {
  DeleteHostedZoneCommand,
  GetHostedZoneCommand,
  UpdateHostedZoneFeaturesCommand,
} from '@aws-sdk/client-route-53';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../../import-helpers.js';
import { logicalIdShown } from '../../composite-id.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';

export async function deleteHostedZone(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Route 53 hosted zone ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#4946: set by either helper once it sends a change, so a
  // refused `DeleteHostedZone` is never read as a whole survivor.
  const progress: DeleteProgress = { stripped: false };

  try {
    // Delete query logging config before deleting hosted zone
    await this.deleteQueryLoggingConfigForZone(physicalId, logicalId, progress);

    // AWS rejects DeleteHostedZone when Accelerated Recovery is ENABLED
    // (or ENABLING / any non-DISABLED state) with
    // "Cannot delete a hosted zone with accelerated recovery enabled.
    // Please disable first.". The feature toggle is an async control
    // plane API (UpdateHostedZoneFeatures) and the transition takes
    // ~2-10 minutes to settle. Issue the disable + poll for DISABLED
    // BEFORE attempting the zone delete so the destroy path is closed.
    await this.ensureAcceleratedRecoveryDisabledForDelete(physicalId, logicalId, progress);

    await this.getClient().send(new DeleteHostedZoneCommand({ Id: physicalId }));
    this.logger.debug(`Successfully deleted hosted zone ${logicalId}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchHostedZone') {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Hosted zone ${physicalId} does not exist, skipping deletion`);
      return;
    }
    // Preserve actionable ProvisioningError messages thrown by
    // `ensureAcceleratedRecoveryDisabledForDelete` (e.g. the
    // operator-recovery prompt on `*_FAILED` / timeout) — re-wrapping
    // them with the generic "Failed to delete hosted zone" prefix
    // would bury the actionable text in the `cause` chain. Mirrors
    // the same guard in `createHostedZone`.
    const cause = error instanceof Error ? error : undefined;
    const failure =
      error instanceof ProvisioningError
        ? error
        : this.wrapDeleteError(
            context?.maskSecrets,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to delete hosted zone ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                physicalId,
                cause
              )
          );
    throw progress.stripped ? markDeleteStarted(failure) : failure;
  }
}

/**
 * Pre-delete guard for `AWS::Route53::HostedZone:HostedZoneFeatures`.
 *
 * AWS rejects `DeleteHostedZone` while AcceleratedRecovery is anything
 * other than DISABLED (the feature uses an async control plane API —
 * `UpdateHostedZoneFeatures` — and AWS won't tear down a zone whose
 * feature state is still in flight). This helper:
 *
 *   1. Reads the current `HostedZone.Features.AcceleratedRecoveryStatus`.
 *      DISABLED / undefined / NoSuchHostedZone → return early (nothing
 *      to do, the delete will proceed normally or hit the existing
 *      NoSuchHostedZone short-circuit).
 *   2. ENABLING / ENABLING_HOSTED_ZONE_LOCKED → wait for the enable to
 *      settle (AWS rejects a disable while enabling is in flight), then
 *      fall through to the disable below.
 *   3. ENABLED → issue `UpdateHostedZoneFeatures(false)` then poll
 *      `GetHostedZone` until the status settles to DISABLED.
 *   4. DISABLING / DISABLING_HOSTED_ZONE_LOCKED → poll without re-issuing
 *      the toggle. The `*_HOSTED_ZONE_LOCKED` states are transient
 *      sub-states of the enable/disable transition (AWS briefly locks the
 *      zone mid-transition) — they settle to ENABLED / DISABLED on their
 *      own, so cdkd waits through them rather than treating them as a
 *      terminal failure.
 *   5. *_FAILED → surface the AWS error to the operator (out of scope for
 *      cdkd to recover automatically).
 *
 * Poll budget: env-overridable timeout (default 10 min) + interval
 * (default 15s; tests override via env to keep runs fast). Failure to
 * settle within the budget throws — the operator can either re-run
 * `cdkd state destroy` (poll resets) or disable manually.
 */
export async function ensureAcceleratedRecoveryDisabledForDelete(
  this: Route53Provider,
  physicalId: string,
  logicalId: string,
  progress: DeleteProgress
): Promise<void> {
  const client = this.getClient();
  const pollIntervalMs = Number.parseInt(
    process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] ?? '15000',
    10
  );
  const timeoutMs = Number.parseInt(
    process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] ?? '600000',
    10
  );

  const readStatus = async (): Promise<string | undefined> => {
    try {
      const resp = await client.send(new GetHostedZoneCommand({ Id: physicalId }));
      return resp.HostedZone?.Features?.AcceleratedRecoveryStatus;
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchHostedZone') return undefined;
      throw err;
    }
  };

  const deadline = Date.now() + timeoutMs;

  // Genuinely terminal failure states — operator-recovery only. The
  // sentinel set is shared by both the initial check below and the
  // in-flight `waitFor` loop (a zone that transitions to `*_FAILED`
  // during the wait must surface the actionable failure error
  // immediately rather than racing the 10-min timeout). NOTE: the
  // `*_HOSTED_ZONE_LOCKED` states are deliberately NOT here — they are
  // transient sub-states of an in-flight enable/disable (AWS briefly
  // locks the zone mid-transition) and settle to ENABLED / DISABLED on
  // their own, so `waitFor` polls through them like any other in-flight
  // status instead of failing the destroy.
  const TERMINAL_FAILED = new Set<string>(['ENABLE_FAILED', 'DISABLE_FAILED']);

  // Helper: poll until status reaches one of `targets`, or throw on
  // timeout / failed-state transition.
  const waitFor = async (
    targets: ReadonlySet<string>,
    label: string
  ): Promise<string | undefined> => {
    while (Date.now() < deadline) {
      const status = await readStatus();
      if (status === undefined || targets.has(status)) return status;
      if (TERMINAL_FAILED.has(status)) {
        throw new ProvisioningError(
          `Cannot delete hosted zone ${logicalId} (${physicalId}): AcceleratedRecoveryStatus transitioned to '${status}' while waiting for ${label} — operator must resolve before destroy can proceed`,
          'AWS::Route53::HostedZone',
          logicalId,
          physicalId
        );
      }
      this.logger.debug(
        `Polling AcceleratedRecoveryStatus for ${physicalId}: ${status} (waiting for ${label}, will re-poll in ~${pollIntervalMs}ms)`
      );
      // Sleep in 1s slices to stay SIGINT-responsive (CTRL-C surfaces
      // within a second) while still respecting the configured
      // `pollIntervalMs` between AWS API hits — break early when the
      // overall deadline runs out.
      const sliceEnd = Math.min(Date.now() + pollIntervalMs, deadline);
      while (Date.now() < sliceEnd) {
        const tick = Math.min(1000, sliceEnd - Date.now());
        if (tick <= 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, tick));
      }
    }
    // Names `cdkd state destroy` and an `aws` command, so the logical id and
    // the recorded zone id are shown only when plain (go-to-k/cdkd#4226).
    throw new ProvisioningError(
      `Timed out after ${timeoutMs}ms waiting for AcceleratedRecoveryStatus to reach ${label} on hosted zone ${logicalIdShown(logicalId)} ${isPlainImportValue(physicalId) ? `(${physicalId})` : VALUE_NOT_SHOWN}; re-run ${proseQuoted(cdkdRemedy('cdkd state destroy'), '`')} or disable manually via ${pasteableAwsCommand()`aws route53 update-hosted-zone-features --hosted-zone-id ${physicalId} --no-enable-accelerated-recovery`.render()}`,
      'AWS::Route53::HostedZone',
      logicalId,
      physicalId
    );
  };

  let current = await readStatus();
  if (current === undefined || current === 'DISABLED') return;

  // Failed / locked states are operator-recovery only.
  if (TERMINAL_FAILED.has(current)) {
    throw new ProvisioningError(
      `Cannot delete hosted zone ${logicalId} (${physicalId}): AcceleratedRecoveryStatus is '${current}' — operator must resolve before destroy can proceed`,
      'AWS::Route53::HostedZone',
      logicalId,
      physicalId
    );
  }

  // Phase 1: if ENABLING, wait for the transition to settle (AWS rejects
  // `UpdateHostedZoneFeatures(false)` while ENABLING is in flight —
  // "Accelerated recovery is already being enabled for this hosted zone").
  if (current === 'ENABLING' || current === 'ENABLING_HOSTED_ZONE_LOCKED') {
    this.logger.debug(
      `Hosted zone ${physicalId} is ${current} (an enabling phase); waiting for it to settle before issuing disable`
    );
    current = await waitFor(new Set(['ENABLED', 'DISABLED']), 'ENABLED or DISABLED');
    if (current === undefined || current === 'DISABLED') return;
  }

  // Phase 2: issue disable when ENABLED, then wait for DISABLED. When
  // already DISABLING (raced with a prior in-flight disable), skip the
  // toggle and just wait.
  if (current === 'ENABLED') {
    this.logger.debug(
      `Hosted zone ${physicalId} is ENABLED; issuing UpdateHostedZoneFeatures(false) before delete`
    );
    await client.send(
      new UpdateHostedZoneFeaturesCommand({
        HostedZoneId: physicalId,
        EnableAcceleratedRecovery: false,
      })
    );
    progress.stripped = true;
  } else if (current === 'DISABLING' || current === 'DISABLING_HOSTED_ZONE_LOCKED') {
    this.logger.debug(
      `Hosted zone ${physicalId} AcceleratedRecovery is already ${current} (a disabling phase); waiting for settle`
    );
  }

  const settled = await waitFor(new Set(['DISABLED']), 'DISABLED');
  this.logger.debug(
    `Hosted zone ${physicalId} AcceleratedRecoveryStatus settled to ${settled ?? 'undefined (zone gone)'}`
  );
}

/**
 * The settle wait after this zone's own UpdateHostedZoneFeatures (issue
 * #5465): polls until the status is the one the call asked for.
 * `freshZone`: the zone was created by this call, so no earlier `*_FAILED`
 * can be read back and the first one is final.
 */
export async function waitForAcceleratedRecoveryFeatureSettled(
  this: Route53Provider,
  zoneId: string,
  logicalId: string,
  resourceType: string,
  enabled: boolean,
  freshZone = false
): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  await this.waitForAcceleratedRecoveryMutable(zoneId, logicalId, resourceType, {
    blocked: `the hosted zone ${logicalId} can be deployed`,
    retry: `after the ${verb} of Accelerated Recovery (hosted zone ${logicalId}); re-run the deploy once the transition settles`,
    settledAt: enabled ? 'ENABLED' : 'DISABLED',
    freshZone,
  });
}

/**
 * Wait until the hosted zone's AcceleratedRecoveryStatus reaches a state
 * that ALLOWS mutations again (issue #1467).
 *
 * While the feature is transitioning (ENABLING / DISABLING /
 * *_HOSTED_ZONE_LOCKED) Route 53 marks the zone "disabled for mutation" and
 * refuses `ChangeResourceRecordSets`. Unlike the zone-delete guard
 * (`ensureAcceleratedRecoveryDisabledForDelete`) this helper does NOT
 * disable the feature — a record-set mutation is legal on an ENABLED zone,
 * and flipping a zone-level setting from a record delete would be a side
 * effect the template never asked for. It only polls until the status is
 * terminal-stable (ENABLED / DISABLED / zone gone), throwing on the
 * `*_FAILED` operator-recovery states and on timeout. Same env-overridable
 * poll knobs as the zone guard.
 *
 * Also the settle wait after a hosted zone's own UpdateHostedZoneFeatures
 * on create and update (issue #5465): CloudFormation returns only once the
 * status settles, and a dependent record-set change in the same deploy
 * would otherwise hit the transition's lock. `blocked` names what the
 * transition holds up and `retry` the next step, for the two errors;
 * `settledAt` narrows "settled" to the status the call asked for, so a read
 * that still shows the PRE-call status (DISABLED right after an enable) is
 * not taken as done.
 */
export async function waitForAcceleratedRecoveryMutable(
  this: Route53Provider,
  zoneId: string,
  logicalId: string,
  resourceType: string,
  purpose: {
    blocked: string;
    retry: string;
    settledAt?: 'ENABLED' | 'DISABLED';
    freshZone?: boolean;
  } = {
    blocked: `the record set ${logicalId} can be deleted`,
    retry: `(record set ${logicalId}); re-run the destroy once the transition settles`,
  }
): Promise<void> {
  const client = this.getClient();
  // Number.isFinite guards: a garbage env value would otherwise make the
  // deadline NaN (loop runs zero times and reports "Timed out after
  // NaNms") or interval 0 a busy-poll.
  const parsedInterval = Number.parseInt(
    process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] ?? '15000',
    10
  );
  const pollIntervalMs =
    Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 15000;
  const parsedTimeout = Number.parseInt(
    process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] ?? '600000',
    10
  );
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 600000;
  const deadline = Date.now() + timeoutMs;
  // A settle wait fails only on its OWN direction's failure: the other
  // direction's `*_FAILED` is the pre-call status still being read (a
  // disable sent to recover an ENABLE_FAILED zone first reads ENABLE_FAILED).
  // Its own direction's counts only once a transition was read since the
  // call: a re-sent enable on an ENABLE_FAILED zone first reads the old
  // failure too, and an unbroken failure is left to the deadline.
  const TERMINAL_FAILED = new Set<string>(
    purpose.settledAt === 'ENABLED'
      ? ['ENABLE_FAILED']
      : purpose.settledAt === 'DISABLED'
        ? ['DISABLE_FAILED']
        : ['ENABLE_FAILED', 'DISABLE_FAILED']
  );
  const MUTABLE = new Set<string>(
    purpose.settledAt !== undefined ? [purpose.settledAt] : ['ENABLED', 'DISABLED']
  );
  let sawTransition = purpose.settledAt === undefined || purpose.freshZone === true;
  let lastStatus: string | undefined;

  while (Date.now() < deadline) {
    let status: string | undefined;
    try {
      const resp = await client.send(new GetHostedZoneCommand({ Id: zoneId }));
      status = resp.HostedZone?.Features?.AcceleratedRecoveryStatus;
    } catch (err) {
      // Gone is "nothing left to wait for" on a record delete, but a settle
      // wait is for a zone this deploy is creating or updating.
      if (
        err instanceof Error &&
        err.name === 'NoSuchHostedZone' &&
        purpose.settledAt === undefined
      ) {
        return;
      }
      throw err;
    }
    // An absent status is the never-enabled zone: settled, unless the call
    // being waited on was the enable itself.
    if (status === undefined) {
      if (purpose.settledAt !== 'ENABLED') return;
    } else if (MUTABLE.has(status)) {
      return;
    }
    lastStatus = status;
    if (status?.includes('ING') === true) sawTransition = true;
    if (status !== undefined && sawTransition && TERMINAL_FAILED.has(status)) {
      throw new ProvisioningError(
        `Cannot mutate hosted zone ${zoneId}: AcceleratedRecoveryStatus is '${status}' — operator must resolve before ${purpose.blocked}`,
        resourceType,
        logicalId,
        zoneId
      );
    }
    this.logger.debug(
      `Polling AcceleratedRecoveryStatus for ${zoneId}: ${status} (waiting for a mutable state, will re-poll in ~${pollIntervalMs}ms)`
    );
    // Sleep in 1s slices to stay SIGINT-responsive (same shape as the
    // zone-delete guard's poll loop).
    const sliceEnd = Math.min(Date.now() + pollIntervalMs, deadline);
    while (Date.now() < sliceEnd) {
      const tick = Math.min(1000, sliceEnd - Date.now());
      if (tick <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, tick));
    }
  }
  throw new ProvisioningError(
    `Timed out after ${timeoutMs}ms waiting for AcceleratedRecoveryStatus to reach a mutable state on hosted zone ${zoneId} ${purpose.retry}${purpose.settledAt !== undefined ? ` (last status: ${lastStatus ?? 'none'})` : ''}`,
    resourceType,
    logicalId,
    zoneId
  );
}
