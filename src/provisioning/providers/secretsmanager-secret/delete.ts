import type { SecretsManagerSecretProvider } from '../secretsmanager-secret-provider.js';
import {
  DeleteSecretCommand,
  DescribeSecretCommand,
  RemoveRegionsFromReplicationCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNotGone } from '../../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';

/**
 * Secrets Manager refuses `DeleteSecret` on a primary that still has replica
 * regions (`InvalidParameterException`). CloudFormation removes them first
 * (`RemoveRegionsFromReplication` deletes each replica), so on that refusal
 * read the secret's `ReplicationStatus` and return the regions `delete()`
 * removes before it retries (#5323). Only the refusal path pays the extra
 * calls; an ordinary delete makes none. Returns undefined for any other
 * error, when the read fails, or when the secret has no replica to remove.
 */
export async function replicaRegionsBlockingDelete(
  this: SecretsManagerSecretProvider,
  error: unknown,
  physicalId: string
): Promise<string[] | undefined> {
  // AWS's text: "You can't delete secret <arn> that still has replica regions [...]".
  // The class alone is not enough: another InvalidParameterException must not
  // cost the secret its replicas.
  const refusal = error as { name?: unknown; message?: unknown } | null;
  if (
    refusal?.name !== 'InvalidParameterException' ||
    typeof refusal.message !== 'string' ||
    !/replica/i.test(refusal.message)
  ) {
    return undefined;
  }
  // A failed read leaves the delete's own refusal as the reported cause.
  const resp = await this.smClient
    .send(new DescribeSecretCommand({ SecretId: physicalId }))
    .catch(() => undefined);
  const regions = (resp?.ReplicationStatus ?? [])
    .map((r) => r.Region)
    .filter((r): r is string => typeof r === 'string' && r.length > 0);
  return regions.length > 0 ? regions : undefined;
}

/**
 * Delete a Secrets Manager secret
 */
export async function deleteImpl(
  this: SecretsManagerSecretProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting secret ${logicalId}: ${physicalId}`);

  const deleteSecret = (): Promise<unknown> =>
    this.smClient.send(
      new DeleteSecretCommand({
        SecretId: physicalId,
        ForceDeleteWithoutRecovery: true,
      })
    );
  // Set only when RemoveRegionsFromReplication itself failed, so the wrap
  // below names that step and how to finish it by hand.
  let unremovedReplicaRegions: string[] | undefined;
  try {
    try {
      await deleteSecret();
    } catch (error) {
      const regions = await this.replicaRegionsBlockingDelete(error, physicalId);
      if (!regions) throw error;
      try {
        await this.smClient.send(
          new RemoveRegionsFromReplicationCommand({
            SecretId: physicalId,
            RemoveReplicaRegions: regions,
          })
        );
      } catch (removeError) {
        unremovedReplicaRegions = regions;
        throw removeError;
      }
      this.logger.debug(
        safeMsg`Removed replica regions ${regions.join(', ')} from secret ${physicalId} before deleting it`
      );
      await deleteSecret();
    }
    this.logger.debug(`Successfully deleted secret ${logicalId}`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.smClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Secret ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const mask = maskerOrIdentity(context?.maskSecrets);
    const regions = unremovedReplicaRegions?.join(' ');
    const step = regions
      ? ` (removing its replica regions ${regions} first, which DeleteSecret requires).` +
        ` Remove them, then re-run destroy: aws secretsmanager remove-regions-from-replication` +
        ` --secret-id ${mask(physicalId)} --remove-replica-regions ${regions}`
      : '';
    const thrown = this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete secret ${logicalId}: ${text}${step}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, which the delete classifiers
    // read as "already deleted" on a `NotFound` needle: only the typed
    // not-found above means this one is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
