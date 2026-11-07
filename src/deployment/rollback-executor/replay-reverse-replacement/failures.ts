import { withReplayDeletePrinting } from '../replay-scope.js';
import { samePhysicalId } from '../../replacement-name-holder/name-keys.js';
import type { ResourceProvider } from '../../../types/resource.js';
import { createdBeforeFailure } from '../../../provisioning/auxiliary-failure.js';
import { deleteSkipReason } from '../../delete-outcome.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure, VERBOSE_POINTER } from '../../../utils/aws-failure-text.js';
import { markRedactedCause } from '../../retryable-errors.js';
import { refusalResourceType, shownLogicalId } from '../messages.js';
import type { ReplayOpScope } from '../replay-scope.js';

/** What {@link deleteMarkedRecreate} needs from the reverse-replacement arm. */
export interface MarkedRecreateScope {
  op: ReplayOpScope['op'];
  /** The OLD resource's type: what the re-create made. */
  oldType: string;
  /** The provider the re-create ran through, which deletes what it made. */
  provider: ResourceProvider;
  properties: Record<string, unknown> | undefined;
  /** The old record's effective `DeletionPolicy`. */
  deletionPolicy: string | undefined;
  stateResources: ReplayOpScope['stateResources'];
  region: string;
  logger: ReplayOpScope['logger'];
  mask: ReplayOpScope['mask'];
  /** The delete's printing bags ({@link withReplayDeletePrinting}). */
  ctx: ReplayOpScope['ctx'];
  secrets: ReplayOpScope['secrets'];
}

/**
 * A caught failure as a reverse-replacement message embeds it
 * (go-to-k/cdkd#2319). These messages are persisted to
 * `deployments/{runId}.jsonl` (a thrown one as the failed op's error, a
 * survivor reason as its event's `reason`), and an AWS-authored failure (an
 * SDK error a provider let escape) names the caller's ARN on an access denial.
 * Such a failure is reduced to its class plus a FLAG-FREE pointer
 * ({@link REPLAY_VERBOSE_POINTER}) and its own text handed to `logDetail` for
 * a `debug` line; a cdkd-authored or transport failure (a provider's own
 * wrap), or a non-`Error` value (#3361), keeps its text, a pointer it already
 * carries made flag-free the same way. `redacted` says to
 * stamp a wrap ({@link stampRedacted}).
 */
export function embeddedFailureText(
  error: unknown,
  logDetail?: (detail: string) => void
): { text: string; redacted: boolean } {
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error) || !failure.redacted) {
    // A provider's own wrap can already carry the pointer; flag-free here too.
    return {
      text: failure.detail.replaceAll(VERBOSE_POINTER, REPLAY_VERBOSE_POINTER),
      redacted: false,
    };
  }
  logDetail?.(failure.detail);
  return {
    text: failure.summary.replace(VERBOSE_POINTER, REPLAY_VERBOSE_POINTER),
    redacted: true,
  };
}

/**
 * {@link VERBOSE_POINTER} without its `--verbose`: every line these messages
 * land on displays an untrusted value (a logical id, a physical id from state,
 * a provider's collision text), and a line that displays one carries no
 * pasteable flag (go-to-k/cdkd#3950). The wording matches open #5218's
 * `COLLISION_VERBOSE_POINTER`.
 */
const REPLAY_VERBOSE_POINTER = "Re-run with verbose logging for AWS's own message.";

/** {@link markRedactedCause} when `redacted` and the wrap has a cause to read. */
export function stampRedacted(error: Error, redacted: boolean): Error {
  return redacted && error.cause instanceof Error ? markRedactedCause(error) : error;
}

/**
 * go-to-k/cdkd#4604: a rollback's re-create of the OLD resource whose provider
 * proved it made the resource before failing (`markCreatedBeforeFailure`).
 * Nothing will record it: no state record names it and this rollback is
 * consuming the journal. The proof says this very call made it, so it is
 * deleted here, through the provider that made it — not recorded as a
 * rollback orphan, which the next deploy would ADOPT as the old resource
 * although its configuration is the half-applied one the create failed on.
 * Kept, and named for the user, when the old record's `DeletionPolicy` is
 * `Retain` or `Snapshot` (no snapshot is taken of a resource the rollback
 * never finished making) or the delete does not complete. Never deletes a
 * physical id a state record of that type holds. Never throws: the
 * re-create's own failure is what the caller rethrows. Returns whether it
 * deleted the resource.
 */
export async function deleteMarkedRecreate(
  error: unknown,
  s: MarkedRecreateScope
): Promise<boolean> {
  const madeId = createdBeforeFailure(error, s.op.logicalId, s.oldType);
  if (madeId === undefined) return false;
  const shown = `${shownLogicalId(s.op.logicalId)} (${refusalResourceType(s.oldType)})`;
  const id = s.mask(madeId);
  // Under the type's case rule (go-to-k/cdkd#4692).
  if (
    Object.values(s.stateResources).some(
      (r) =>
        r?.resourceType === s.oldType &&
        typeof r.physicalId === 'string' &&
        samePhysicalId(s.oldType, r.physicalId, madeId)
    )
  ) {
    return false;
  }
  if (s.deletionPolicy === 'Retain' || s.deletionPolicy === 'Snapshot') {
    s.logger.warn(
      safeMsg`  Rollback: the failed re-create of ${shown} made ${id} before failing; ` +
        safeMsg`it is left in AWS (DeletionPolicy: ${s.deletionPolicy}) and no record holds it — delete it yourself if it is not needed`
    );
    return false;
  }
  s.logger.info(
    safeMsg`  Rollback: deleting ${id}, which the failed re-create of ${shown} made before failing`
  );
  let failure: string | undefined;
  try {
    const outcome = await withReplayDeletePrinting(s, () =>
      s.provider.delete(s.op.logicalId, madeId, s.oldType, s.properties, {
        expectedRegion: s.region,
        deletionPolicy: 'Delete',
        // go-to-k/cdkd#2007: the mask `id` above is rendered with.
        maskSecrets: s.mask,
      })
    );
    failure = deleteSkipReason(outcome);
  } catch (deleteError) {
    failure = describeAwsFailure(deleteError).detail;
  }
  if (failure === undefined) return true;
  s.logger.warn(
    safeMsg`  Rollback: could not delete ${id}, which the failed re-create of ${shown} made before ` +
      safeMsg`failing (${s.mask(failure)}); no record holds it — delete it yourself`
  );
  return false;
}
