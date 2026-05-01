import {
  KMSClient,
  CreateKeyCommand,
  DescribeKeyCommand,
  ListAliasesCommand,
  ListKeysCommand,
  ListResourceTagsCommand,
  ScheduleKeyDeletionCommand,
  CreateAliasCommand,
  DeleteAliasCommand,
  UpdateAliasCommand,
  EnableKeyRotationCommand,
  DisableKeyRotationCommand,
  UpdateKeyDescriptionCommand,
  PutKeyPolicyCommand,
  EnableKeyCommand,
  DisableKeyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
  type KeyUsageType,
  type KeySpec,
  type OriginType,
} from '@aws-sdk/client-kms';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { CDK_PATH_TAG } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('KMSProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::KMS::Key',
      new Set([
        'Description',
        'KeyPolicy',
        'KeySpec',
        'KeyUsage',
        'EnableKeyRotation',
        'Tags',
        'Enabled',
        'MultiRegion',
        'PendingWindowInDays',
        'RotationPeriodInDays',
        'Origin',
        'BypassPolicyLockoutSafetyCheck',
      ]),
    ],
    ['AWS::KMS::Alias', new Set(['AliasName', 'TargetKeyId'])],
  ]);

  private getClient(): KMSClient {
    if (!this.client) {
      this.client = new KMSClient(this.providerRegion ? { region: this.providerRegion } : {});
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.deleteKey(logicalId, physicalId, resourceType, _properties, context);
      case 'AWS::KMS::Alias':
        return this.deleteAlias(logicalId, physicalId, resourceType, context);
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
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    const multiRegion = properties['MultiRegion'] as boolean | undefined;
    const origin = properties['Origin'] as string | undefined;
    const bypassPolicyLockoutSafetyCheck = properties['BypassPolicyLockoutSafetyCheck'] as
      | boolean
      | undefined;

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
          Tags: tags ? tags.map((t) => ({ TagKey: t.Key, TagValue: t.Value })) : undefined,
          MultiRegion: multiRegion,
          Origin: origin as OriginType | undefined,
          BypassPolicyLockoutSafetyCheck: bypassPolicyLockoutSafetyCheck,
        })
      );

      const keyId = result.KeyMetadata!.KeyId!;
      const keyArn = result.KeyMetadata!.Arn!;

      // EnableKeyRotation must be called separately after key creation
      if (enableKeyRotation) {
        const rotationPeriodInDays = properties['RotationPeriodInDays'] as number | undefined;
        this.logger.debug(`Enabling key rotation for KMS Key ${logicalId}`);
        await this.getClient().send(
          new EnableKeyRotationCommand({
            KeyId: keyId,
            ...(rotationPeriodInDays !== undefined && {
              RotationPeriodInDays: rotationPeriodInDays,
            }),
          })
        );
      }

      // Disable key if Enabled is explicitly false
      const enabled = properties['Enabled'] as boolean | undefined;
      if (enabled === false) {
        this.logger.debug(`Disabling KMS Key ${logicalId}`);
        await this.getClient().send(new DisableKeyCommand({ KeyId: keyId }));
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
          const rotationPeriodInDays = properties['RotationPeriodInDays'] as number | undefined;
          this.logger.debug(`Enabling key rotation for KMS Key ${logicalId}`);
          await this.getClient().send(
            new EnableKeyRotationCommand({
              KeyId: physicalId,
              ...(rotationPeriodInDays !== undefined && {
                RotationPeriodInDays: rotationPeriodInDays,
              }),
            })
          );
        } else {
          this.logger.debug(`Disabling key rotation for KMS Key ${logicalId}`);
          await this.getClient().send(new DisableKeyRotationCommand({ KeyId: physicalId }));
        }
      }

      // Update Enabled if changed
      const newEnabled = properties['Enabled'] as boolean | undefined;
      const oldEnabled = previousProperties['Enabled'] as boolean | undefined;
      if (newEnabled !== oldEnabled) {
        if (newEnabled === false) {
          this.logger.debug(`Disabling KMS Key ${logicalId}`);
          await this.getClient().send(new DisableKeyCommand({ KeyId: physicalId }));
        } else {
          this.logger.debug(`Enabling KMS Key ${logicalId}`);
          await this.getClient().send(new EnableKeyCommand({ KeyId: physicalId }));
        }
      }

      // Update Tags if changed
      const newTags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      const oldTags = previousProperties['Tags'] as
        | Array<{ Key: string; Value: string }>
        | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        // Remove old tags
        if (oldTags && oldTags.length > 0) {
          await this.getClient().send(
            new UntagResourceCommand({
              KeyId: physicalId,
              TagKeys: oldTags.map((t) => t.Key),
            })
          );
        }
        // Add new tags
        if (newTags && newTags.length > 0) {
          await this.getClient().send(
            new TagResourceCommand({
              KeyId: physicalId,
              Tags: newTags.map((t) => ({ TagKey: t.Key, TagValue: t.Value })),
            })
          );
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
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

  /**
   * Adopt an existing KMS key or alias into cdkd state.
   *
   * KMS keys have no `Properties.KeyName` field — physical IDs are
   * AWS-generated UUIDs. So:
   *  - For `AWS::KMS::Key`: `--resource MyKey=<keyId>` is the only explicit
   *    path; auto-lookup walks `ListKeys` + `ListResourceTags` matching
   *    `aws:cdk:path`.
   *  - For `AWS::KMS::Alias`: `Properties.AliasName` is explicit and reliable.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.resourceType === 'AWS::KMS::Alias') {
      const aliasName =
        input.knownPhysicalId ??
        (typeof input.properties?.['AliasName'] === 'string'
          ? input.properties['AliasName']
          : undefined);
      if (!aliasName) return null;
      try {
        // ListAliases doesn't support filtering by name; walk to verify.
        let marker: string | undefined;
        do {
          const list = await this.getClient().send(
            new ListAliasesCommand({ ...(marker && { Marker: marker }) })
          );
          const found = list.Aliases?.find(
            (a: { AliasName?: string | undefined }) => a.AliasName === aliasName
          );
          if (found) return { physicalId: aliasName, attributes: {} };
          marker = list.NextMarker;
        } while (marker);
        return null;
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
    }

    // AWS::KMS::Key
    if (input.knownPhysicalId) {
      try {
        await this.getClient().send(new DescribeKeyCommand({ KeyId: input.knownPhysicalId }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListKeysCommand({ ...(marker && { Marker: marker }) })
      );
      for (const key of list.Keys ?? []) {
        if (!key.KeyId) continue;
        try {
          const tagsResp = await this.getClient().send(
            new ListResourceTagsCommand({ KeyId: key.KeyId })
          );
          for (const tag of tagsResp.Tags ?? []) {
            if (tag.TagKey === CDK_PATH_TAG && tag.TagValue === input.cdkPath) {
              return { physicalId: key.KeyId, attributes: {} };
            }
          }
        } catch (err) {
          // AWS-managed keys lack ListResourceTags permission. Skip silently.
          const name = (err as { name?: string }).name;
          if (name === 'AccessDeniedException' || err instanceof NotFoundException) continue;
          throw err;
        }
      }
      marker = list.NextMarker;
    } while (marker);
    return null;
  }
}
