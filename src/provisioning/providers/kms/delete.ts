import type { KMSProvider } from '../kms-provider.js';
import {
  ScheduleKeyDeletionCommand,
  DeleteAliasCommand,
  NotFoundException,
} from '@aws-sdk/client-kms';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';

export async function deleteKey(
  this: KMSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Scheduling deletion for KMS Key ${logicalId}: ${physicalId}`);

  const pendingWindowInDays = (properties?.['PendingWindowInDays'] as number | undefined) ?? 7;

  try {
    await this.getClient().send(
      new ScheduleKeyDeletionCommand({
        KeyId: physicalId,
        PendingWindowInDays: pendingWindowInDays,
      })
    );
    this.logger.debug(`Successfully scheduled deletion for KMS Key ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`KMS Key ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to schedule deletion for KMS Key ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteAlias(
  this: KMSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting KMS Alias ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteAliasCommand({
        AliasName: physicalId,
      })
    );
    this.logger.debug(`Successfully deleted KMS Alias ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`KMS Alias ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete KMS Alias ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
