import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
  UpdateUserPoolCommand,
  DescribeUserPoolCommand,
  ResourceNotFoundException,
  type VerifiedAttributeType,
  type UsernameAttributeType,
  type UserPoolMfaType,
  type DeletionProtectionType,
  type SchemaAttributeType,
  type LambdaConfigType,
  type PasswordPolicyType,
  type AdminCreateUserConfigType,
  type AccountRecoverySettingType,
  type UserAttributeUpdateSettingsType,
  type CreateUserPoolCommandInput,
  type UpdateUserPoolCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS Cognito User Pool Provider
 *
 * Implements resource provisioning for AWS::Cognito::UserPool using the Cognito SDK.
 * WHY: CreateUserPool is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class CognitoUserPoolProvider implements ResourceProvider {
  private cognitoClient?: CognitoIdentityProviderClient;
  private logger = getLogger().child('CognitoUserPoolProvider');

  private getClient(): CognitoIdentityProviderClient {
    if (!this.cognitoClient) {
      this.cognitoClient = new CognitoIdentityProviderClient({});
    }
    return this.cognitoClient;
  }

  /**
   * Create a Cognito User Pool
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Cognito User Pool ${logicalId}`);

    const poolName = (properties['UserPoolName'] as string | undefined) || logicalId;

    try {
      const createParams: CreateUserPoolCommandInput = {
        PoolName: poolName,
      };

      if (properties['AutoVerifiedAttributes']) {
        createParams.AutoVerifiedAttributes = properties[
          'AutoVerifiedAttributes'
        ] as VerifiedAttributeType[];
      }
      if (properties['UsernameAttributes']) {
        createParams.UsernameAttributes = properties[
          'UsernameAttributes'
        ] as UsernameAttributeType[];
      }
      if (properties['Policies']) {
        const policies = properties['Policies'] as Record<string, unknown>;
        if (policies['PasswordPolicy']) {
          createParams.Policies = {
            PasswordPolicy: policies['PasswordPolicy'] as PasswordPolicyType,
          };
        }
      }
      if (properties['Schema']) {
        createParams.Schema = properties['Schema'] as SchemaAttributeType[];
      }
      if (properties['LambdaConfig']) {
        createParams.LambdaConfig = properties['LambdaConfig'] as LambdaConfigType;
      }
      if (properties['MfaConfiguration']) {
        createParams.MfaConfiguration = properties['MfaConfiguration'] as UserPoolMfaType;
      }
      if (properties['UserPoolTags']) {
        createParams.UserPoolTags = properties['UserPoolTags'] as Record<string, string>;
      }
      if (properties['AdminCreateUserConfig']) {
        createParams.AdminCreateUserConfig = properties[
          'AdminCreateUserConfig'
        ] as AdminCreateUserConfigType;
      }
      if (properties['AccountRecoverySetting']) {
        createParams.AccountRecoverySetting = properties[
          'AccountRecoverySetting'
        ] as AccountRecoverySettingType;
      }
      if (properties['UserAttributeUpdateSettings']) {
        createParams.UserAttributeUpdateSettings = properties[
          'UserAttributeUpdateSettings'
        ] as UserAttributeUpdateSettingsType;
      }
      if (properties['DeletionProtection']) {
        createParams.DeletionProtection = properties[
          'DeletionProtection'
        ] as DeletionProtectionType;
      }

      const response = await this.getClient().send(new CreateUserPoolCommand(createParams));

      const userPool = response.UserPool;
      if (!userPool?.Id) {
        throw new Error('CreateUserPool did not return UserPool.Id');
      }

      const userPoolId = userPool.Id;
      const userPoolArn = userPool.Arn;
      const region = await this.getClient().config.region();
      const providerName = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
      const providerUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

      this.logger.debug(`Successfully created Cognito User Pool ${logicalId}: ${userPoolId}`);

      return {
        physicalId: userPoolId,
        attributes: {
          Arn: userPoolArn,
          ProviderName: providerName,
          ProviderURL: providerUrl,
          UserPoolId: userPoolId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Cognito User Pool ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        poolName,
        cause
      );
    }
  }

  /**
   * Update a Cognito User Pool
   *
   * Note: PoolName (UserPoolName) and Schema are immutable and cannot be changed after creation.
   * Changes to these properties require resource replacement.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Cognito User Pool ${logicalId}: ${physicalId}`);

    try {
      const updateParams: UpdateUserPoolCommandInput = {
        UserPoolId: physicalId,
      };

      if (properties['Policies']) {
        const policies = properties['Policies'] as Record<string, unknown>;
        if (policies['PasswordPolicy']) {
          updateParams.Policies = {
            PasswordPolicy: policies['PasswordPolicy'] as PasswordPolicyType,
          };
        }
      }
      if (properties['LambdaConfig']) {
        updateParams.LambdaConfig = properties['LambdaConfig'] as LambdaConfigType;
      }
      if (properties['AutoVerifiedAttributes']) {
        updateParams.AutoVerifiedAttributes = properties[
          'AutoVerifiedAttributes'
        ] as VerifiedAttributeType[];
      }
      if (properties['MfaConfiguration']) {
        updateParams.MfaConfiguration = properties['MfaConfiguration'] as UserPoolMfaType;
      }
      if (properties['AdminCreateUserConfig']) {
        updateParams.AdminCreateUserConfig = properties[
          'AdminCreateUserConfig'
        ] as AdminCreateUserConfigType;
      }
      if (properties['AccountRecoverySetting']) {
        updateParams.AccountRecoverySetting = properties[
          'AccountRecoverySetting'
        ] as AccountRecoverySettingType;
      }
      if (properties['UserPoolTags']) {
        updateParams.UserPoolTags = properties['UserPoolTags'] as Record<string, string>;
      }
      if (properties['DeletionProtection']) {
        updateParams.DeletionProtection = properties[
          'DeletionProtection'
        ] as DeletionProtectionType;
      }
      if (properties['UserAttributeUpdateSettings']) {
        updateParams.UserAttributeUpdateSettings = properties[
          'UserAttributeUpdateSettings'
        ] as UserAttributeUpdateSettingsType;
      }

      await this.getClient().send(new UpdateUserPoolCommand(updateParams));

      this.logger.debug(`Successfully updated Cognito User Pool ${logicalId}`);

      // Describe the user pool to get updated attributes
      const describeResponse = await this.getClient().send(
        new DescribeUserPoolCommand({ UserPoolId: physicalId })
      );

      const userPool = describeResponse.UserPool;
      const region = await this.getClient().config.region();
      const providerName = `cognito-idp.${region}.amazonaws.com/${physicalId}`;
      const providerUrl = `https://cognito-idp.${region}.amazonaws.com/${physicalId}`;

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: userPool?.Arn,
          ProviderName: providerName,
          ProviderURL: providerUrl,
          UserPoolId: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Cognito User Pool ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Cognito User Pool
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting Cognito User Pool ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteUserPoolCommand({ UserPoolId: physicalId }));
      this.logger.debug(`Successfully deleted Cognito User Pool ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        this.logger.debug(`Cognito User Pool ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Cognito User Pool ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
