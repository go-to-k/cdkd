/**
 * go-to-k/cdkd#6824: `cdkd drift --revert` re-resolves each secret reference
 * at its CURRENT version and sends it, while the record it rewrites keeps its
 * `referenceProvenance` verbatim. A record whose provenance attests the
 * version AWS was last sent (`versionsSent`) would then attest a version AWS
 * may no longer hold, and a later deploy would leave a rotated password unsent.
 * So before any revert is sent, the reverted records lose that attestation, in
 * a state write of its own that must succeed first; the next deploy re-sends.
 */
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import { withoutVersionAttestation } from '../../../deployment/reference-provenance-record.js';
import type { StackDriftReport } from './outcome.js';

/**
 * Persist `report`'s records named by `logicalIds` without their attestation,
 * and carry the result into `report` (its records and ETag) for the revert's
 * own later write. A no-op, with no write, when none carries one. Rejects when
 * the write fails: the caller then reverts nothing.
 */
export async function writeAheadRevertAttestations(
  report: StackDriftReport,
  logicalIds: readonly string[],
  stateBackend: Pick<S3StateBackend, 'saveState'>
): Promise<void> {
  const resources = { ...report.state.resources };
  let changed = false;
  for (const logicalId of logicalIds) {
    if (!Object.hasOwn(resources, logicalId)) continue;
    const record = resources[logicalId]!;
    const stripped = withoutVersionAttestation(record);
    if (stripped === record) continue;
    resources[logicalId] = stripped;
    changed = true;
  }
  if (!changed) return;
  const state = { ...report.state, resources, lastModified: Date.now() };
  const etag = await stateBackend.saveState(report.stackName, report.region, state, {
    expectedEtag: report.etag,
    ...(report.migrationPending && { migrateLegacy: true }),
  });
  report.state = state;
  report.etag = etag;
  report.migrationPending = false;
}
