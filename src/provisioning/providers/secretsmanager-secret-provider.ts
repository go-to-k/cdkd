import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  UpdateSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
    _previousProperties: Record<string, unknown>
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
    _properties?: Record<string, unknown>
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
}
