import {
  KMSClient,
  CreateKeyCommand,
  ScheduleKeyDeletionCommand,
  CreateAliasCommand,
  DeleteAliasCommand,
  UpdateAliasCommand,
  EnableKeyRotationCommand,
  DisableKeyRotationCommand,
  UpdateKeyDescriptionCommand,
  PutKeyPolicyCommand,
  NotFoundException,
  type KeyUsageType,
  type KeySpec,
} from '@aws-sdk/client-kms';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS KMS resources
 *
 * Supports:
 * - AWS::KMS::Key
 * - AWS::KMS::Alias
 *
 * KMS CreateKey/CreateAlias are synchronous - the CC API adds unnecessary
 * polling overhead for operations that complete immediately.
 */
export class KMSProvider implements ResourceProvider {
  private client: KMSClient | undefined;
  private logger = getLogger().child('KMSProvider');

  private getClient(): KMSClient {
    if (!this.client) {
      this.client = new KMSClient({});
    }
    return this.client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.createKey(logicalId, resourceType, properties);
      case 'AWS::KMS::Alias':
        return this.createAlias(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.updateKey(logicalId, physicalId, resourceType, properties, _previousProperties);
      case 'AWS::KMS::Alias':
        return this.updateAlias(logicalId, physicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.deleteKey(logicalId, physicalId, resourceType);
      case 'AWS::KMS::Alias':
        return this.deleteAlias(logicalId, physicalId, resourceType);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::KMS::Key ─────────────────────────────────────────────────

  private async createKey(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating KMS Key ${logicalId}`);

    const description = properties['Description'] as string | undefined;
    const keyPolicy = properties['KeyPolicy'];
    const keySpec = properties['KeySpec'] as string | undefined;
    const keyUsage = properties['KeyUsage'] as string | undefined;
    const enableKeyRotation = properties['EnableKeyRotation'] as boolean | undefined;

    try {
      const result = await this.getClient().send(
        new CreateKeyCommand({
          Description: description,
          KeySpec: keySpec as KeySpec,
          KeyUsage: keyUsage as KeyUsageType,
          Policy: keyPolicy
            ? typeof keyPolicy === 'string'
              ? keyPolicy
              : JSON.stringify(keyPolicy)
            : undefined,
        })
      );

      const keyId = result.KeyMetadata!.KeyId!;
      const keyArn = result.KeyMetadata!.Arn!;

      // EnableKeyRotation must be called separately after key creation
      if (enableKeyRotation) {
        this.logger.debug(`Enabling key rotation for KMS Key ${logicalId}`);
        await this.getClient().send(new EnableKeyRotationCommand({ KeyId: keyId }));
      }

      this.logger.debug(`Successfully created KMS Key ${logicalId}: ${keyId}`);

      return {
        physicalId: keyId,
        attributes: {
          Arn: keyArn,
          KeyId: keyId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create KMS Key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating KMS Key ${logicalId}: ${physicalId}`);

    try {
      // Update Description if changed
      const newDescription = properties['Description'] as string | undefined;
      const oldDescription = previousProperties['Description'] as string | undefined;
      if (newDescription !== oldDescription) {
        this.logger.debug(`Updating description for KMS Key ${logicalId}`);
        await this.getClient().send(
          new UpdateKeyDescriptionCommand({
            KeyId: physicalId,
            Description: newDescription ?? '',
          })
        );
      }

      // Update EnableKeyRotation if changed
      const newEnableKeyRotation = properties['EnableKeyRotation'] as boolean | undefined;
      const oldEnableKeyRotation = previousProperties['EnableKeyRotation'] as boolean | undefined;
      if (newEnableKeyRotation !== oldEnableKeyRotation) {
        if (newEnableKeyRotation) {
          this.logger.debug(`Enabling key rotation for KMS Key ${logicalId}`);
          await this.getClient().send(new EnableKeyRotationCommand({ KeyId: physicalId }));
        } else {
          this.logger.debug(`Disabling key rotation for KMS Key ${logicalId}`);
          await this.getClient().send(new DisableKeyRotationCommand({ KeyId: physicalId }));
        }
      }

      // Update KeyPolicy if changed
      const newKeyPolicy = properties['KeyPolicy'];
      const oldKeyPolicy = previousProperties['KeyPolicy'];
      const newPolicyStr = newKeyPolicy
        ? typeof newKeyPolicy === 'string'
          ? newKeyPolicy
          : JSON.stringify(newKeyPolicy)
        : undefined;
      const oldPolicyStr = oldKeyPolicy
        ? typeof oldKeyPolicy === 'string'
          ? oldKeyPolicy
          : JSON.stringify(oldKeyPolicy)
        : undefined;
      if (newPolicyStr !== oldPolicyStr && newPolicyStr) {
        this.logger.debug(`Updating key policy for KMS Key ${logicalId}`);
        await this.getClient().send(
          new PutKeyPolicyCommand({
            KeyId: physicalId,
            PolicyName: 'default',
            Policy: newPolicyStr,
          })
        );
      }

      this.logger.debug(`Successfully updated KMS Key ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update KMS Key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteKey(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Scheduling deletion for KMS Key ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new ScheduleKeyDeletionCommand({
          KeyId: physicalId,
          PendingWindowInDays: 7,
        })
      );
      this.logger.debug(`Successfully scheduled deletion for KMS Key ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.debug(`KMS Key ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to schedule deletion for KMS Key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── AWS::KMS::Alias ───────────────────────────────────────────────

  private async createAlias(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
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
      throw new ProvisioningError(
        `Failed to create KMS Alias ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateAlias(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
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
      throw new ProvisioningError(
        `Failed to update KMS Alias ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteAlias(
    logicalId: string,
    physicalId: string,
    resourceType: string
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
        this.logger.debug(`KMS Alias ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete KMS Alias ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
