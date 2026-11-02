import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { isThrottlingError, isTransientServerError } from '../../deployment/retryable-errors.js';
import { reportedCreatedResource } from '../created-resource-sink.js';
import type { MaskedLogSinks } from '../masked-retry-logger.js';

/** Whether an IAM call failed because the name it asked for is already held. */
export function isEntityAlreadyExists(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'EntityAlreadyExistsException';
}

export interface LeftByThisCreateQuery<T> {
  readonly logicalId: string;
  readonly resourceType: string;
  /** What the operator reads the entity as: `role`, `managed policy`, ... */
  readonly noun: string;
  /** The name the warnings print; masked here. */
  readonly displayName: string;
  /** What the create call threw. */
  readonly createError: unknown;
  /** Whether a report's physical id is the entity this create asks for. */
  readonly namesThisEntity: (reportedPhysicalId: string) => boolean;
  /** Read the live entity. Only called once the report names it. */
  readonly read: (reportedPhysicalId: string) => Promise<T | undefined>;
  /** The identity token of what `read` answered, as `create` reports it. */
  readonly identityOf: (entity: T | undefined) => string | undefined;
  readonly log: MaskedLogSinks;
}

/**
 * go-to-k/cdkd#5656 / #5660: the IAM entity a create's `EntityAlreadyExists`
 * hit, when it provably is the one an earlier attempt of THIS operation made
 * and failed to clean up; `undefined` when it is not proven, so the caller
 * rethrows the collision and touches nothing.
 *
 * The proof is the operation's `reportCreatedResource` of this entity, whose
 * identity token the create call itself answered with, against the live
 * token: IAM never reuses a unique id (`AROA…`, `AIDA…`, `AGPA…`, `AIPA…`,
 * `ANPA…`), and a name or a name-built ARN says nothing about who holds it. A
 * failed attempt's cleanup withdraws the report once its delete landed. The
 * report lives only as long as the operation, so a later deploy, or a replay
 * outside a deploy operation, has none and fails as before.
 *
 * Finishing is re-running the create's own wiring, not reconciling the entity:
 * the engine resolves the properties once, before its retries, so the replay's
 * bag is the one the earlier attempt sent, and what the create call itself
 * carries is already on the entity. Each caller's wiring must be safe to repeat,
 * and restores what that attempt's partial cleanup removed. Once adopted, a
 * caller strips and deletes nothing: the identity was read once and every later
 * call goes by name. It keeps the entity reported and marked; the journal's
 * settle compares the identity before deleting.
 *
 * A throttled or 5xx read rethrows, so the engine retries; another read failure
 * leaves the identity unproven.
 */
export async function iamEntityLeftByThisCreate<T>(
  query: LeftByThisCreateQuery<T>
): Promise<T | undefined> {
  const { logicalId, resourceType, noun, displayName, createError, log } = query;
  if (!isEntityAlreadyExists(createError)) return undefined;
  const report = reportedCreatedResource(logicalId, resourceType);
  if (report?.createdResourceIdentity === undefined || !query.namesThisEntity(report.physicalId)) {
    return undefined;
  }
  const { value: v } = log;
  let entity: T | undefined;
  try {
    entity = await query.read(report.physicalId);
  } catch (probeError) {
    if (isThrottlingError(probeError) || isTransientServerError(probeError)) throw probeError;
    log.debug(
      `IAM ${noun} ${logicalId}: could not read ${v(displayName)} to identify it: ${v(describeAwsFailure(probeError).detail)}`
    );
    return undefined;
  }
  if (query.identityOf(entity) !== report.createdResourceIdentity) {
    log.warn(
      `IAM ${noun} ${logicalId}: ${v(displayName)} is not the ${noun} an earlier attempt of this create made, so it is left untouched. Do not delete it unless you know it is yours, whatever the failure below suggests.`
    );
    return undefined;
  }
  log.warn(
    `IAM ${noun} ${logicalId}: finishing ${v(displayName)}, the ${noun} an earlier attempt of this create made and could not delete. No manual deletion is needed if this create succeeds.`
  );
  return entity;
}
