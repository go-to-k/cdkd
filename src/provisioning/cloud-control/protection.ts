import type { CloudControlProvider } from '../cloud-control-provider.js';
import { UpdateResourceCommand, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { isDeepStrictEqual } from 'node:util';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import {
  isTerminalDeleteFailure,
  observeThenDisableProtection,
  type ProtectionFlipRecord,
  type ProtectionGuardSite,
} from '../providers/deletion-protection-compensation.js';
import { isAmbiguousCcHandlerErrorCode } from '../../deployment/retryable-errors.js';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import type { CcProtectionEntry } from '../cc-protection-properties.js';
import { isWaitAbandonedError } from '../wait-abandoned.js';
import { CloudControlOperationFailedError } from './shared.js';
import { describePollFailure } from './poll-failure.js';

/**
 * Set a registry-declared deletion-protection property to its "off" value
 * in-place via a CC UpdateResource patch (issues #1312 / #1314).
 * Best-effort: failures are logged at warn and swallowed — the subsequent
 * DeleteResource surfaces the real error if the protection is still on.
 * The `add` patch op is used (RFC 6902: replaces when the path exists,
 * adds when absent), so the flip is idempotent regardless of whether the
 * live model carries the property.
 *
 * Resolves whether the flip LANDED (the patch was accepted and its wait
 * succeeded), so the compensation records only a flip that did (#2204).
 */
export async function disableCcProtection(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  entry: CcProtectionEntry
): Promise<boolean> {
  const protectionProperty = entry.property;
  this.logger.debug(
    `Disabling ${protectionProperty} on ${logicalId} (${resourceType}) before delete (--remove-protection)`
  );
  try {
    const patch = [{ op: 'add', path: `/${protectionProperty}`, value: entry.offValue }];
    const response = await this.cloudControlClient.send(
      new UpdateResourceCommand({
        TypeName: resourceType,
        Identifier: physicalId,
        PatchDocument: JSON.stringify(patch),
      })
    );
    if (!response.ProgressEvent?.RequestToken) {
      this.logger.warn(
        `Could not disable ${protectionProperty} on ${logicalId}: no request token received; proceeding with delete`
      );
      return false;
    }
    // A SHORT transient grace, not the poll's usual two minutes (issue
    // go-to-k/cdkd#3253 item 1). This flip is best-effort by construction —
    // the catch below swallows every failure and proceeds — so waiting out a
    // network outage here buys nothing: the `DeleteResource` that follows
    // surfaces the real error if the protection is still on, and under the
    // same outage that delete fails too. Spending the full grace would add
    // two minutes of dead wall clock per protected resource to a destroy
    // that is going to fail anyway.
    //
    // Not ZERO, which would abandon on the FIRST failure and lose the cheap
    // recovery the fence exists for: a one-second blip mid-flip is exactly
    // the case re-polling handles, and ten seconds covers it at the 1s ->
    // 1.5s -> 2.25s -> 3.4s schedule (8.125s of sleep across five re-polls,
    // giving up at ~13.2s of wall clock).
    //
    // The TRADEOFF this buys, stated because the paragraph above does not
    // cover it: for an outage of roughly 13s to 120s the old behaviour
    // recovered — the flip re-polled, the link came back, the delete
    // succeeded — and now the flip is abandoned and `delete()` issues its
    // `DeleteResource` while the link is still down. That delete gets ONE
    // attempt on this path and `isRetryableTransientError` answers false for
    // a socket error, so it fails hard and the user re-runs. Accepted
    // deliberately: the destroy runner's own retry plus the idempotent `add`
    // patch recover on that re-run, the cost is a retry rather than data
    // loss, and the alternative charges every `--remove-protection` destroy
    // two minutes per protected resource to serve that one band. Every
    // UNPROTECTED sibling in the same destroy keeps the full grace.
    await this.waitForOperation(
      response.ProgressEvent.RequestToken,
      logicalId,
      'UPDATE',
      resourceType,
      this.PROTECTION_FLIP_TRANSIENT_GRACE_MS
    );
    this.logger.debug(`Disabled ${protectionProperty} on ${logicalId}`);
    return true;
  } catch (error) {
    // `displaySafe` for the same reason the poll warn above carries it: this
    // message is not fully cdkd-controlled. An abandonment arrives
    // pre-sanitized, but a NON-transient `UpdateResource` failure does not —
    // an `AccessDeniedException` here quotes
    // `User: arn:aws:sts::<acct>:assumed-role/<role>/<session>` — and
    // `ConsoleLogger.formatMessage` sanitizes EXTRA ARGS only, never the
    // message string.
    // `describePollFailure(...).display` rather than a bare
    // `String(error)`: this catch exists to SWALLOW so the delete can
    // proceed, and `String(value)` throws on a null-prototype object — an
    // out-throw here would abort a `--remove-protection` delete from the one
    // place built to let it continue. It also reduces a credential failure,
    // which the raw read did not: this line is default-verbosity.
    const described = describePollFailure(error);
    // Sanitize BEFORE testing for emptiness, and render NO clause when the
    // result is empty -- the same shape `abandonWait` uses, for the same
    // reachable case: `asSdkError` normalizes a non-`Error` rejection into an
    // `Error` with `message: ''`, and this catch encloses the
    // `UpdateResource` SEND, so one arrives here. Without the guard the line
    // ends `proceeding with delete: ` -- a colon promising a reason and then
    // giving none.
    const safeMessage = displaySafe(described.display);
    // `proceeding with delete` goes BEFORE the interpolated message, not
    // after it: an abandonment reaches this catch (the flip's own 10s grace),
    // and its message ends with the pasteable `aws cloudcontrol` line, whose
    // newline `displaySafe` flattens — so appending cdkd prose puts a second
    // clause after a command an operator may paste. Same rule as the two
    // remnant warns and as `buildResumeCommand` itself.
    this.logger.warn(
      `Could not disable ${protectionProperty} on ${logicalId} (${resourceType}), proceeding with delete${safeMessage === '' ? '' : `: ${safeMessage}`}`
    );
    // The DETAIL half of the split, and it is REQUIRED rather than tidy: the
    // warn above now carries a REDUCED text, and a reduction with nothing
    // behind it is a DELETION. An `AccessDeniedException` here is the case
    // that matters -- the wire name says "authorization", and the sentence
    // that says WHICH action and WHICH principal is the one an operator needs
    // to fix their policy. `logger.debug` is where it belongs: this line
    // quotes the caller's own assumed-role ARN.
    const detail = described.detail;
    if (detail !== '') {
      this.logger.debug(
        `Could not disable ${protectionProperty} on ${logicalId}, underlying failure: ${displaySafe(detail)}`
      );
    }
    // An ABANDONED wait, or a FAILED with an ambiguous handler code, counts
    // as landed: the patch may still have applied, and the compensation only
    // ever writes back a value the pre-flip read observed, so re-enabling a
    // flip that never landed is a no-op while skipping one that did would
    // leave the guard stripped.
    return (
      isWaitAbandonedError(error) ||
      (error instanceof CloudControlOperationFailedError &&
        error.ccOperation === 'UPDATE' &&
        isAmbiguousCcHandlerErrorCode(error.ccErrorCode))
    );
  }
}

/**
 * Read the guard, then flip it off through {@link disableCcProtection},
 * recording the flip on `flip` only when the read found the registry's
 * `onValue` exactly and the flip landed (issue #2204). A failed read records
 * nothing, so the compensation leaves the resource alone; the delete still
 * proceeds either way, as it always has.
 */
export async function observeThenDisableCcProtection(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  entry: CcProtectionEntry,
  flip: ProtectionFlipRecord,
  mask: MaskerFn | undefined
): Promise<void> {
  try {
    await observeThenDisableProtection({
      flip,
      logger: this.logger,
      physicalId,
      mask,
      guardName: entry.property,
      observe: async () => {
        const model = await this.getResourceState(resourceType, physicalId);
        return model !== null && isDeepStrictEqual(model[entry.property], entry.onValue);
      },
      disable: async () => {
        if (!(await this.disableCcProtection(logicalId, physicalId, resourceType, entry))) {
          // Already warned by the flip; this only keeps the record unset.
          throw new Error(`the ${entry.property} flip-off did not land`);
        }
      },
    });
  } catch {
    // The flip did not land: nothing recorded, the delete proceeds.
  }
}

/**
 * The compensating write for a CC protection registry type: patch the guard
 * back to its `onValue` and wait for it. Throws on any failure, which
 * `compensateProtectionFlip` turns into the secondary log line naming the
 * restore command.
 *
 * It WAITS, unlike the SDK adopters' single call, because a Cloud Control
 * update is asynchronous and "accepted" is not "applied". The wait takes the
 * flip's short transient grace, and is not interruptible.
 */
export async function reEnableCcProtection(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  entry: CcProtectionEntry
): Promise<void> {
  const patch = [{ op: 'add', path: `/${entry.property}`, value: entry.onValue }];
  const response = await this.cloudControlClient.send(
    new UpdateResourceCommand({
      TypeName: resourceType,
      Identifier: physicalId,
      PatchDocument: JSON.stringify(patch),
    })
  );
  const token = response.ProgressEvent?.RequestToken;
  if (!token) {
    throw new Error(`Cloud Control returned no request token for the ${entry.property} patch`);
  }
  await this.waitForOperation(
    token,
    logicalId,
    'UPDATE',
    resourceType,
    this.PROTECTION_FLIP_TRANSIENT_GRACE_MS
  );
}

/**
 * The one line a terminal Cloud Control delete gets when the compensation
 * STANDS DOWN because the attempt may already be deleting (issue #2204):
 * cdkd cannot tell a delete in flight from a refusal filed under an
 * ambiguous code, so it does not write the guard back, and says so with the
 * check and restore commands rather than leaving the guard silently off.
 * Never throws: it runs on the way to re-throwing the delete failure.
 */
export function warnGuardLeftOff(
  this: CloudControlProvider,
  flip: ProtectionFlipRecord,
  error: unknown,
  site: ProtectionGuardSite,
  logicalId: string,
  physicalId: string
): void {
  try {
    if (!flip.flippedOffByThisRun || !flip.deleteAccepted || !isTerminalDeleteFailure(error)) {
      return;
    }
    const commands = site.commands();
    this.logger.warn(
      safeMsg`${site.subject} ${logicalId}: the delete failed after --remove-protection had ` +
        safeMsg`turned ${site.guardName} off, and cdkd cannot tell whether AWS had started ` +
        safeMsg`deleting ${physicalId}, so it did not turn the guard back on. If it still ` +
        safeMsg`exists, its ${site.guardName} may be off. Check with: ${commands.check} and if ` +
        safeMsg`it is there, restore it with: ${commands.restoreLive}. The delete failure below ` +
        safeMsg`is the outcome.`
    );
  } catch {
    // The delete failure stays the outcome.
  }
}

/**
 * The Cloud Control client's own region, for a command the compensation
 * prints when the state records none; `undefined` when it cannot be read.
 */
export async function ccClientRegion(this: CloudControlProvider): Promise<string | undefined> {
  try {
    return canonicalizeRegion((await this.cloudControlClient.config.region())?.trim()) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get current state of a resource
 */
export async function getResourceState(
  this: CloudControlProvider,
  resourceType: string,
  physicalId: string
): Promise<Record<string, unknown> | null> {
  try {
    const response = await this.cloudControlClient.send(
      new GetResourceCommand({
        TypeName: resourceType,
        Identifier: physicalId,
      })
    );

    if (!response.ResourceDescription?.Properties) {
      return null;
    }

    return this.parseResourceModel(response.ResourceDescription.Properties);
  } catch (error) {
    const err = error as { name?: string };
    if (err.name === 'ResourceNotFoundException') {
      return null;
    }
    throw error;
  }
}
