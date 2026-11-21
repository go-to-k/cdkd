import { markNonRetryable } from '../deployment/retryable-errors.js';
import {
  SURVIVOR_IDENTITY_ATTRIBUTES,
  isUsableIdentityValue,
} from '../deployment/recorded-identity-attributes.js';
import { ProvisioningError } from '../utils/error-handler.js';
import { markNotGone } from './not-gone.js';
import type { DeleteContext } from './region-check.js';
import { stateOrphanRecordRemedy } from './state-orphan-remedy.js';
import { remedyLogicalId } from './import-helpers.js';
import { commandHole, pasteableCommand } from '../utils/pasteable-command.js';
import { safeMsg } from '../utils/display-safe.js';

/**
 * go-to-k/cdkd#6655 (D1): the AWS-minted id cdkd recorded for the resource a
 * delete addresses BY NAME, or `undefined` for a record that holds none (one
 * written before the attribute existed), holds it masked (a mask is no id),
 * or of a type {@link SURVIVOR_IDENTITY_ATTRIBUTES} does not list. Read off
 * `DeleteContext.recordedAttributes`.
 */
export function recordedIdentityId(
  resourceType: string,
  context: DeleteContext | undefined
): { key: string; value: string } | undefined {
  if (!Object.hasOwn(SURVIVOR_IDENTITY_ATTRIBUTES, resourceType)) return undefined;
  const key = SURVIVOR_IDENTITY_ATTRIBUTES[resourceType]!;
  const value = context?.recordedAttributes?.[key];
  // A mask anywhere in it, or a secret reference: no id (one predicate, both sides).
  return isUsableIdentityValue(value) ? { key, value } : undefined;
}

/**
 * What {@link assertRecordedIdentity} throws: worded by cdkd with no AWS text,
 * so a provider's catch rethrows it as is rather than wrapping it as an AWS
 * failure.
 */
export class RecordedIdentityError extends ProvisioningError {
  constructor(
    message: string,
    resourceType: string,
    logicalId: string,
    physicalId?: string,
    cause?: Error
  ) {
    super(message, resourceType, logicalId, physicalId, cause);
    // `ProvisioningError` pins its own prototype; without this the subclass
    // is lost and `instanceof` answers false.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'RecordedIdentityError';
  }
}

/**
 * The refusal of a live holder of the recorded name whose AWS-minted id is
 * not the recorded one (go-to-k/cdkd#6655, `.claude/rules/provider-delete-path.md`):
 * it was deleted and the name taken again, by this stack or another owner.
 * Thrown before any write, so nothing was sent and the record is kept.
 *
 * Non-retryable in the CONSTRUCTOR: the class refuses in every case, and a
 * retry would only read the same holder again. The message names the
 * attribute, never either value, and carries none of the already-deleted
 * classifiers' needles (it is rendered into the `Error` whose catch reads
 * those by substring).
 */
export class RecordedIdentityMismatchError extends RecordedIdentityError {
  /** The recorded attribute whose live value differs (`RoleId`, ...). */
  public readonly attribute: string;

  constructor(params: {
    /** `IAM role`, `IAM managed policy`, ... */
    label: string;
    resourceType: string;
    logicalId: string;
    physicalId: string;
    attribute: string;
    context: DeleteContext | undefined;
    /**
     * How the USER can hand the name to another resource of their own (`an
     * RDS blue/green switchover, or a restore ...`): static text, never a
     * value. When set, the message says the resource under the name is not
     * the recorded one without claiming the recorded one is gone (a
     * blue/green switchover keeps it under another name), and names
     * {@link reAdoptRemedy} for the user's own replacement before the
     * `cdkd state orphan` step. Absent: the IAM wording.
     */
    replacedBy?: string | undefined;
  }) {
    const { label, resourceType, logicalId, physicalId, attribute, context, replacedBy } = params;
    super(
      replacedBy === undefined
        ? `Cannot delete ${label} ${logicalId}: the ${label} holding the name cdkd recorded is not ` +
            `the one cdkd created (its ${attribute} differs from the recorded one), so cdkd sent no ` +
            `delete and kept the record. Leave that ${label} alone; if the one cdkd created is gone, ` +
            `drop the record with ${stateOrphanRecordRemedy(context, logicalId)}.`
        : `Cannot delete ${label} ${logicalId}: the ${label} now holding the name cdkd recorded is ` +
            `not the one cdkd recorded (its ${attribute} differs from the recorded one), so cdkd ` +
            `sent no delete and kept the record; the recorded one may still exist under another ` +
            `name. If you replaced it yourself (${replacedBy}), adopt the new one with ` +
            `${reAdoptRemedy(logicalId)} and re-run. Otherwise leave that ${label} alone, and to ` +
            `stop cdkd managing the recorded one, drop the record with ` +
            `${stateOrphanRecordRemedy(context, logicalId)}.`,
      resourceType,
      logicalId,
      physicalId
    );
    Object.setPrototypeOf(this, RecordedIdentityMismatchError.prototype);
    this.attribute = attribute;
    this.name = 'RecordedIdentityMismatchError';
    markNonRetryable(this);
  }
}

/**
 * go-to-k/cdkd#6655: `cdkd import <stack> --resource <logicalId>=<physicalId>
 * --force`, which re-reads the resource under the name and replaces the
 * record, recorded identity id included (`reimportedAttributes`): the
 * remedy for a resource the user put under the name themselves. The stack,
 * region and physical id are quoted holes (no value is printed); the logical
 * id is named only when plain.
 */
export function reAdoptRemedy(logicalId: string): string {
  return pasteableCommand('cdkd import', [
    { hole: 'stack' },
    { flag: '--region', hole: 'region' },
    { literal: '--resource' },
    { literal: `${remedyLogicalId(logicalId)}=${commandHole('physicalId')}` },
    { literal: '--force' },
  ]).command;
}

/**
 * How long a delete waits before reading again when the live id differs from
 * the recorded one. IAM reads are eventually consistent: right after a
 * same-name replacement, a read can still answer for the resource just
 * deleted, so one more read separates that lag from a real successor before
 * the non-retryable refusal. Paid only on a mismatch, never on the normal path.
 * The mirror case is accepted: a re-read that is itself stale and answers the
 * recorded id lets a successor that took the name within those seconds be
 * deleted. The wait does not watch Ctrl-C (at most 5 s). A re-read that fails
 * (a throttle) throws to the caller's retry, whose next attempt reads, finds
 * the mismatch and waits again: one wait per retry attempt, bounded by the
 * retry budget.
 */
export const RECORDED_IDENTITY_REREAD_DELAY_MS = 5_000;

/**
 * Compare the id a delete's own read returned with the recorded one: returns
 * when nothing is recorded or the ids are equal. On a difference it reads once
 * more after {@link RECORDED_IDENTITY_REREAD_DELAY_MS} (`reread`), and throws
 * {@link RecordedIdentityMismatchError} when the ids still differ. A read that
 * answered without an id while one is recorded throws too (a plain
 * {@link RecordedIdentityError}, marked not gone and otherwise left to the
 * retry classifiers): it cannot tell this resource from a successor, and the
 * by-name delete is what the check exists to stop.
 */
export async function assertRecordedIdentity(params: {
  label: string;
  resourceType: string;
  logicalId: string;
  physicalId: string;
  liveId: string | undefined;
  /** The same read again, answering the live id (`undefined` when it has none). */
  reread: () => Promise<string | undefined>;
  context: DeleteContext | undefined;
  /** {@link RecordedIdentityMismatchError}'s `replacedBy`. */
  replacedBy?: string | undefined;
}): Promise<void> {
  const recorded = recordedIdentityId(params.resourceType, params.context);
  if (recorded === undefined) return;
  const { label, resourceType, logicalId, physicalId, context } = params;
  let liveId = params.liveId;
  if (typeof liveId === 'string' && liveId !== '' && liveId !== recorded.value) {
    await new Promise((resolve) => setTimeout(resolve, RECORDED_IDENTITY_REREAD_DELAY_MS));
    liveId = await params.reread();
  }
  if (typeof liveId !== 'string' || liveId === '') {
    // Marked not gone: the logical id is interpolated, and the delete
    // classifiers read a `NotFound` needle in a message as "already deleted".
    throw markNotGone(
      new RecordedIdentityError(
        `Cannot delete ${label} ${logicalId}: AWS answered without its ${recorded.key}, so cdkd ` +
          `cannot confirm it is the one cdkd created; nothing was sent and the record is kept. Re-run the operation.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  if (liveId === recorded.value) return;
  throw new RecordedIdentityMismatchError({
    label,
    resourceType,
    logicalId,
    physicalId,
    attribute: recorded.key,
    context,
    replacedBy: params.replacedBy,
  });
}

/**
 * go-to-k/cdkd#6655: the warning an in-place update answering with another
 * identity id than the recorded one gets (the recorded id is kept). Names the
 * attribute, never either value.
 */
export function differingIdentityWarning(
  logicalId: string,
  resourceType: string,
  attribute: string
): string {
  return safeMsg`${logicalId} (${resourceType}): the update answered with another ${attribute} than the recorded one, so it may have reached another resource under the same name; cdkd keeps the recorded ${attribute}. Check the resource before deleting anything by hand.`;
}

/**
 * The `onDiffering` callback a rollback revert passes: the
 * {@link differingIdentityWarning} line for `op`, through the op's masker.
 */
export function identityWarner(
  logger: { warn: (message: string) => void },
  mask: (text: string) => string,
  op: { logicalId: string; resourceType: string }
): (attribute: string) => void {
  return (attribute) =>
    logger.warn(mask(differingIdentityWarning(op.logicalId, op.resourceType, attribute)));
}
