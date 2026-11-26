import { displayPhysicalId } from '../../provisioning/secret-physical-id.js';
import type { DeployEngine } from '../deploy-engine.js';
import type { ResourceState, StackState, SupersededResourceRecord } from '../../types/state.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { green } from '../../utils/colors.js';
import { safeMsg } from '../../utils/display-safe.js';
import { deleteSkippedMessage } from '../delete-outcome.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import { createSecretMasker, maskSecretsInText, unionOfSecretBags } from '../secret-redaction.js';
import { orphanRecordsPrintingBag } from '../secret-name-needles.js';
import { withStackRecords } from '../stack-records-scope.js';
import {
  SUPERSEDED_KEPT_REMEDY,
  addSuperseded,
  deleteSupersededEntry,
  removeSuperseded,
  supersededDependentsFirst,
  supersededHeldByOtherTypeWarning,
  supersededHolderOf,
} from '../superseded-resources.js';
import { secretNameBagFor, stackSecretNameMasker } from './masking.js';

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
  resources: Record<string, ResourceState>,
  options: {
    waitInUse?: boolean;
    /** go-to-k/cdkd#7076: what a failure's warning names as next, when not the default. */
    keptRemedy?: string;
  } = {}
): Promise<boolean> {
  let changed = false;
  if (carried.length === 0) return changed;
  // Every record survives these deletes: only the superseded copy goes.
  const view = {
    live: () => Object.entries(resources),
    survivors: () => Object.entries(resources),
  };
  // go-to-k/cdkd#6770: dependents first, so a replaced profile or membership
  // goes before the replaced role or group it holds, which would otherwise
  // refuse it as a holder outside the stack.
  for (const entry of supersededDependentsFirst(carried)) {
    if (engine.interrupted) break;
    const { logicalId } = entry;
    const { physicalId, resourceType } = entry.state;
    // The id can spell a secret-derived name (go-to-k/cdkd#3869): the OLD
    // record's own, judged as an orphan's is, beside the row's current one.
    const bag = unionOfSecretBags([
      secretNameBagFor(engine.secretsRun, logicalId),
      orphanRecordsPrintingBag([entry]),
    ]);
    const holder = supersededHolderOf(entry, resources);
    if (holder !== undefined) {
      removeSuperseded(host, entry);
      changed = true;
      if (holder.resourceType !== resourceType) {
        withPrintingSecrets(bag, () =>
          engine.logger.warn(
            safeMsg`  ⚠ ${supersededHeldByOtherTypeWarning(entry, holder.resourceType)}`
          )
        );
        continue;
      }
      withPrintingSecrets(bag, () =>
        engine.logger.debug(
          safeMsg`Superseded ${logicalId} (${displayPhysicalId(resourceType, physicalId)}) is held by a record again; not deleting it`
        )
      );
      continue;
    }
    await withPrintingSecrets(bag, () =>
      withStackRecords(view, async () => {
        engine.logger.info(
          safeMsg`  Deleting old ${logicalId} (${displayPhysicalId(resourceType, physicalId)}), superseded by an earlier deploy...`
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
            maskSecrets: createSecretMasker(bag),
            // go-to-k/cdkd#6772: a refusal naming a sibling the stack retained.
            maskStackSecretNames: stackSecretNameMasker(engine.secretsRun),
            stop: () => engine.interrupted,
            // One attempt unless this deploy released a possible user: an
            // entry still in use must not slow every deploy.
            once: options.waitInUse !== true,
            // go-to-k/cdkd#6668: the TYPE's provider reads who holds the name
            // of an entry carrying `identity`.
            holderProvider: () => engine.providerRegistry.getProvider(resourceType),
            warn: (message) =>
              engine.logger.warn(
                safeMsg`  ⚠ Old ${logicalId} (${displayPhysicalId(resourceType, physicalId)}): ${message}`
              ),
            // go-to-k/cdkd#6463: an entry owing its pre-delete snapshot.
            preDeleteSnapshot: {
              clients: engine.options.finalSnapshotClients ?? getAwsClients(),
              logger: {
                info: (message) => engine.logger.info(maskSecretsInText(message, bag)),
                debug: (message) => engine.logger.debug(maskSecretsInText(message, bag)),
              },
            },
          });
        } catch (error) {
          outcome = { kind: 'failed' as const, error };
        }
        if (outcome.kind === 'failed') {
          // go-to-k/cdkd#6463: its snapshot was taken, so it is not owed again.
          if (outcome.replacement !== undefined) {
            addSuperseded(host, outcome.replacement);
            changed = true;
          }
          const detail = maskSecretsInText(describeAwsFailure(outcome.error).detail, bag);
          engine.logger.warn(
            safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${displayPhysicalId(resourceType, physicalId)}): ${detail}. ${options.keptRemedy ?? SUPERSEDED_KEPT_REMEDY}.`
          );
          return;
        }
        removeSuperseded(host, entry);
        changed = true;
        // go-to-k/cdkd#6668: nothing was sent; the old resource left the name.
        if (outcome.kind === 'gone') {
          engine.logger.info(
            safeMsg`  ${green('✓')} Old ${logicalId} (${displayPhysicalId(resourceType, physicalId)}) is already gone; no delete was sent`
          );
          return;
        }
        if (outcome.kind === 'notOurs') {
          engine.logger.warn(
            safeMsg`  ⚠ Old ${logicalId} (${displayPhysicalId(resourceType, physicalId)}) was not deleted: ${outcome.cause}. The replaced resource is gone, and cdkd no longer tracks it in state.`
          );
          return;
        }
        if (outcome.kind === 'notDeleted') {
          engine.logger.warn(
            safeMsg`  ⚠ ${deleteSkippedMessage(logicalId, displayPhysicalId(resourceType, physicalId), outcome.reason, 'while cleaning up the superseded resource', { commandFreeLine: true })}. Delete it manually — it is no longer tracked in state.`
          );
          return;
        }
        engine.logger.info(
          safeMsg`  ${green('✓')} Old ${logicalId} (${displayPhysicalId(resourceType, physicalId)}) deleted`
        );
      })
    );
  }
  return changed;
}
