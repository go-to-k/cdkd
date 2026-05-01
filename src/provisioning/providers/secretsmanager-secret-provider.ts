import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
  UpdateSecretCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ReplicateSecretToRegionsCommand,
  RemoveRegionsFromReplicationCommand,
  ResourceNotFoundException,
  type Tag,
} from '@aws-sdk/client-secrets-manager';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS Secrets Manager Secret Provider
 *
 * Implements resource provisioning for AWS::SecretsManager::Secret using the Secrets Manager SDK.
 * WHY: CreateSecret is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class SecretsManagerSecretProvider implements ResourceProvider {
  private smClient: SecretsManagerClient;
  private logger = getLogger().child('SecretsManagerSecretProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SecretsManager::Secret',
      new Set([
        'Name',
        'GenerateSecretString',
        'SecretString',
        'Description',
        'KmsKeyId',
        'Tags',
        'ReplicaRegions',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.smClient = awsClients.secretsManager;
  }

  /**
   * Create a Secrets Manager secret
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating secret ${logicalId}`);

    const name =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 512, allowedPattern: /[^a-zA-Z0-9-/_]/g });

    try {
      // Build the secret value from GenerateSecretString or SecretString
      let secretString: string | undefined;
      const generateConfig = properties['GenerateSecretString'] as
        | Record<string, unknown>
        | undefined;

      if (generateConfig) {
        secretString = this.generateSecretString(generateConfig);
      } else if (properties['SecretString']) {
        secretString = properties['SecretString'] as string;
      }

      const createParams: import('@aws-sdk/client-secrets-manager').CreateSecretCommandInput = {
        Name: name,
      };
      if (secretString) createParams.SecretString = secretString;
      if (properties['Description']) createParams.Description = properties['Description'] as string;
      if (properties['KmsKeyId']) createParams.KmsKeyId = properties['KmsKeyId'] as string;
      if (properties['Tags']) {
        createParams.Tags = properties['Tags'] as Tag[];
      }
      if (properties['ReplicaRegions']) {
        const replicaRegions = properties['ReplicaRegions'] as Array<Record<string, unknown>>;
        createParams.AddReplicaRegions = replicaRegions.map((r) => ({
          Region: r['Region'] as string,
          KmsKeyId: r['KmsKeyId'] as string | undefined,
        }));
      }

      const response = await this.smClient.send(new CreateSecretCommand(createParams));

      const secretArn = response.ARN;
      if (!secretArn) {
        throw new Error('CreateSecret did not return ARN');
      }

      this.logger.debug(`Successfully created secret ${logicalId}: ${secretArn}`);

      return {
        physicalId: secretArn,
        attributes: {
          Id: secretArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create secret ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        name,
        cause
      );
    }
  }

  /**
   * Update a Secrets Manager secret
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating secret ${logicalId}: ${physicalId}`);

    try {
      let secretString: string | undefined;
      const generateConfig = properties['GenerateSecretString'] as
        | Record<string, unknown>
        | undefined;

      if (generateConfig) {
        secretString = this.generateSecretString(generateConfig);
      } else if (properties['SecretString']) {
        secretString = properties['SecretString'] as string;
      }

      const updateParams: import('@aws-sdk/client-secrets-manager').UpdateSecretCommandInput = {
        SecretId: physicalId,
      };
      if (secretString) updateParams.SecretString = secretString;
      if (properties['Description']) updateParams.Description = properties['Description'] as string;
      if (properties['KmsKeyId']) updateParams.KmsKeyId = properties['KmsKeyId'] as string;

      await this.smClient.send(new UpdateSecretCommand(updateParams));

      // Update Tags if changed
      const newTags = properties['Tags'] as Tag[] | undefined;
      const oldTags = previousProperties['Tags'] as Tag[] | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        // Remove old tags
        if (oldTags && oldTags.length > 0) {
          const oldTagKeys = oldTags.map((t) => t.Key).filter((k): k is string => !!k);
          if (oldTagKeys.length > 0) {
            await this.smClient.send(
              new UntagResourceCommand({
                SecretId: physicalId,
                TagKeys: oldTagKeys,
              })
            );
          }
        }
        // Apply new tags
        if (newTags && newTags.length > 0) {
          await this.smClient.send(
            new TagResourceCommand({
              SecretId: physicalId,
              Tags: newTags,
            })
          );
        }
        this.logger.debug(`Updated tags for secret ${physicalId}`);
      }

      // Update ReplicaRegions if changed
      const newReplicas = properties['ReplicaRegions'] as
        | Array<Record<string, unknown>>
        | undefined;
      const oldReplicas = previousProperties['ReplicaRegions'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (JSON.stringify(newReplicas) !== JSON.stringify(oldReplicas)) {
        // Remove old replica regions that are no longer present
        if (oldReplicas && oldReplicas.length > 0) {
          const newRegionSet = new Set((newReplicas || []).map((r) => r['Region'] as string));
          const regionsToRemove = oldReplicas
            .map((r) => r['Region'] as string)
            .filter((region) => !newRegionSet.has(region));
          if (regionsToRemove.length > 0) {
            await this.smClient.send(
              new RemoveRegionsFromReplicationCommand({
                SecretId: physicalId,
                RemoveReplicaRegions: regionsToRemove,
              })
            );
          }
        }
        // Add new replica regions
        if (newReplicas && newReplicas.length > 0) {
          const oldRegionSet = new Set((oldReplicas || []).map((r) => r['Region'] as string));
          const regionsToAdd = newReplicas.filter((r) => !oldRegionSet.has(r['Region'] as string));
          if (regionsToAdd.length > 0) {
            await this.smClient.send(
              new ReplicateSecretToRegionsCommand({
                SecretId: physicalId,
                AddReplicaRegions: regionsToAdd.map((r) => ({
                  Region: r['Region'] as string,
                  KmsKeyId: r['KmsKeyId'] as string | undefined,
                })),
              })
            );
          }
        }
        this.logger.debug(`Updated replica regions for secret ${physicalId}`);
      }

      this.logger.debug(`Successfully updated secret ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Id: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update secret ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Secrets Manager secret
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting secret ${logicalId}: ${physicalId}`);

    try {
      await this.smClient.send(
        new DeleteSecretCommand({
          SecretId: physicalId,
          ForceDeleteWithoutRecovery: true,
        })
      );
      this.logger.debug(`Successfully deleted secret ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.smClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Secret ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete secret ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Generate a secret string from GenerateSecretString configuration
   *
   * Simple implementation that generates a random string based on the config.
   */
  private generateSecretString(config: Record<string, unknown>): string {
    const length = (config['PasswordLength'] as number) || 32;
    const excludeUppercase = config['ExcludeUppercase'] as boolean;
    const excludeLowercase = config['ExcludeLowercase'] as boolean;
    const excludeNumbers = config['ExcludeNumbers'] as boolean;
    const excludePunctuation = config['ExcludePunctuation'] as boolean;
    const excludeCharacters = (config['ExcludeCharacters'] as string) || '';

    let chars = '';
    if (!excludeUppercase) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (!excludeLowercase) chars += 'abcdefghijklmnopqrstuvwxyz';
    if (!excludeNumbers) chars += '0123456789';
    if (!excludePunctuation) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';

    // Remove excluded characters
    if (excludeCharacters) {
      for (const c of excludeCharacters) {
        chars = chars.replaceAll(c, '');
      }
    }

    if (chars.length === 0) {
      chars = 'abcdefghijklmnopqrstuvwxyz';
    }

    // Generate random password
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars[bytes[i]! % chars.length];
    }

    // If GenerateStringKey is specified, wrap in JSON
    const generateStringKey = config['GenerateStringKey'] as string | undefined;
    const secretStringTemplate = config['SecretStringTemplate'] as string | undefined;

    if (generateStringKey && secretStringTemplate) {
      try {
        const template = JSON.parse(secretStringTemplate) as Record<string, unknown>;
        template[generateStringKey] = password;
        return JSON.stringify(template);
      } catch {
        return password;
      }
    }

    return password;
  }

  /**
   * Adopt an existing Secrets Manager secret into cdkd state.
   *
   * Secrets Manager physical IDs are full secret ARNs. The CDK template's
   * `Properties.Name` (secret name) is enough to fetch the ARN via
   * `DescribeSecret`.
   *
   * Lookup order:
   *  1. `--resource` override (ARN) → verify via `DescribeSecret`.
   *  2. `Properties.Name` → `DescribeSecret` (accepts name).
   *  3. `aws:cdk:path` tag match via `ListSecrets` (which already returns Tags).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.smClient.send(
          new DescribeSecretCommand({ SecretId: input.knownPhysicalId })
        );
        return resp.ARN ? { physicalId: resp.ARN, attributes: {} } : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    const name =
      typeof input.properties?.['Name'] === 'string' ? input.properties['Name'] : undefined;
    if (name) {
      try {
        const resp = await this.smClient.send(new DescribeSecretCommand({ SecretId: name }));
        return resp.ARN ? { physicalId: resp.ARN, attributes: {} } : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.smClient.send(
        new ListSecretsCommand({ ...(nextToken && { NextToken: nextToken }) })
      );
      for (const s of list.SecretList ?? []) {
        if (s.ARN && matchesCdkPath(s.Tags, input.cdkPath)) {
          return { physicalId: s.ARN, attributes: {} };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }
}
