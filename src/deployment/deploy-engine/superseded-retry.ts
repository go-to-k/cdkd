import type { DeployEngine } from '../deploy-engine.js';
import type { ResourceState, StackState, SupersededResourceRecord } from '../../types/state.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { green } from '../../utils/colors.js';
import { safeMsg } from '../../utils/display-safe.js';
import { deleteSkippedMessage } from '../delete-outcome.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import { createSecretMasker, maskSecretsInText } from '../secret-redaction.js';
import { withStackRecords } from '../stack-records-scope.js';
import {
  SUPERSEDED_KEPT_REMEDY,
  deleteSupersededEntry,
  isSupersededHeld,
  removeSuperseded,
} from '../superseded-resources.js';
import { secretNameBagFor } from './masking.js';

/**
 * Retry the deletes an EARLIER deploy recorded in
 * `StackState.supersededResources` (go-to-k/cdkd#5111), at this deploy's
 * cleanup: after its creates, updates and deletes, so whatever still used the
 * old resource has been updated. One a record holds (a rollback took it back)
 * is dropped unsent. A deleted or provider-skipped one leaves the record (a
 * skip warns as untracked, as a replacement's own skip does); a failure keeps
 * it, warned. Sequential: the set is small and each is a single call.
 *
 * MUTATES `host.supersededResources`; returns whether it changed.
 */
export async function retryCarriedSupersededResources(
  engine: DeployEngine,
  host: Pick<StackState, 'supersededResources'>,
  carried: readonly SupersededResourceRecord[],
  resources: Record<string, ResourceState>
): Promise<boolean> {
  let changed = false;
  if (carried.length === 0) return changed;
  // Every record survives these deletes: only the superseded copy goes.
  const view = {
    live: () => Object.entries(resources),
    survivors: () => Object.entries(resources),
  };
  for (const entry of carried) {
    if (engine.interrupted) break;
    const { logicalId } = entry;
    const { physicalId, resourceType } = entry.state;
    // The id can spell a secret-derived name (go-to-k/cdkd#3869).
    const bag = secretNameBagFor(engine.secretsRun, logicalId);
    if (isSupersededHeld(entry, resources)) {
      removeSuperseded(host, entry);
      changed = true;
      withPrintingSecrets(bag, () =>
        engine.logger.debug(
          safeMsg`Superseded ${logicalId} (${physicalId}) is held by a record again; not deleting it`
        )
      );
      continue;
    }
    await withPrintingSecrets(bag, () =>
      withStackRecords(view, async () => {
        engine.logger.info(
          safeMsg`  Deleting old ${logicalId} (${physicalId}), superseded by an earlier deploy...`
        );
        let outcome;
        try {
          const route = engine.providerRegistry.getProviderFor({
            resourceType,
            ...(entry.state.provisionedBy !== undefined && {
              provisionedBy: entry.state.provisionedBy,
            }),
          });
          outcome = await deleteSupersededEntry(entry, {
            provider: route.provider,
            region: engine.stackRegion,
            skipFinalSnapshot: engine.options.skipFinalSnapshot === true,
            maskSecrets: createSecretMasker(bag),
            stop: () => engine.interrupted,
          });
        } catch (error) {
          outcome = { outcome: 'failed' as const, error };
        }
        if (outcome.outcome === 'failed') {
          const detail = maskSecretsInText(describeAwsFailure(outcome.error).detail, bag);
          engine.logger.warn(
            safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${physicalId}): ${detail}. ${SUPERSEDED_KEPT_REMEDY}.`
          );
          return;
        }
        removeSuperseded(host, entry);
        changed = true;
        if (outcome.outcome === 'skipped') {
          engine.logger.warn(
            safeMsg`  ⚠ ${deleteSkippedMessage(logicalId, physicalId, outcome.reason, 'while cleaning up the superseded resource', { commandFreeLine: true })}. Delete it manually — it is no longer tracked in state.`
          );
          return;
        }
        engine.logger.info(safeMsg`  ${green('✓')} Old ${logicalId} (${physicalId}) deleted`);
      })
    );
  }
  return changed;
}
