import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displayStackName, safeMsg } from '../../utils/display-safe.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';

/**
 * go-to-k/cdkd#4705: delete a top-level stack's registry marker when it names
 * this prefix, once its record is gone, so "a marker exists" keeps meaning
 * "a record exists under its prefix". `known` is the marker this run already
 * read (released by that version, no second read). Conditional (`If-Match`),
 * so another prefix's re-claim in between is left alone. Best-effort: a
 * marker left behind names a prefix with no record, which another prefix's
 * next check treats as stale; never throws. A nested child (`Parent~Child`)
 * has no marker of its own.
 */
export async function releaseRegistryMarkerQuietly(
  backend: Pick<S3StateBackend, 'releaseRegistryMarker'>,
  stackName: string,
  region: string,
  logger: { warn(message: string): void; debug(message: string): void },
  known?: { prefix: string; etag: string } | null
): Promise<void> {
  if (stackName.includes('~')) return;
  try {
    const released =
      known === undefined
        ? await backend.releaseRegistryMarker(stackName, region)
        : await backend.releaseRegistryMarker(stackName, region, known);
    logger.debug(safeMsg`Stack registry marker: ${released}`);
  } catch (error) {
    logger.warn(
      safeMsg`Could not delete the stack registry marker of ${displayStackName(stackName)} ` +
        safeMsg`(${describeAwsFailure(error).summary}). It names this state prefix, which no longer ` +
        `records the stack, so a deploy under another prefix treats it as stale.`
    );
  }
}
