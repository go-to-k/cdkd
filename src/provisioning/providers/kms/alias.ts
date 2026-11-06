import type { KMSProvider } from '../kms-provider.js';
import { CreateAliasCommand, UpdateAliasCommand } from '@aws-sdk/client-kms';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../types/resource.js';

export async function createAlias(
  this: KMSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating KMS Alias ${logicalId}`);

  const aliasName = properties['AliasName'] as string | undefined;
  if (!aliasName) {
    throw new ProvisioningError(
      `AliasName is required for KMS Alias ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const targetKeyId = properties['TargetKeyId'] as string | undefined;
  if (!targetKeyId) {
    throw new ProvisioningError(
      `TargetKeyId is required for KMS Alias ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    await this.getClient().send(
      new CreateAliasCommand({
        AliasName: aliasName,
        TargetKeyId: targetKeyId,
      })
    );

    this.logger.debug(`Successfully created KMS Alias ${logicalId}: ${aliasName}`);

    return {
      physicalId: aliasName,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create KMS Alias ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function updateAlias(
  this: KMSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating KMS Alias ${logicalId}: ${physicalId}`);

  const targetKeyId = properties['TargetKeyId'] as string | undefined;
  if (!targetKeyId) {
    throw new ProvisioningError(
      `TargetKeyId is required for KMS Alias update ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.getClient().send(
      new UpdateAliasCommand({
        AliasName: physicalId,
        TargetKeyId: targetKeyId,
      })
    );

    this.logger.debug(`Successfully updated KMS Alias ${logicalId}`);

    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update KMS Alias ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
