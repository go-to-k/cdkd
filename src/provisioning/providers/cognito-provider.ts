import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
  UpdateUserPoolCommand,
  DescribeUserPoolCommand,
  ResourceNotFoundException,
  type VerifiedAttributeType,
  type UsernameAttributeType,
  type AliasAttributeType,
  type UserPoolMfaType,
  type DeletionProtectionType,
  type SchemaAttributeType,
  type LambdaConfigType,
  type PasswordPolicyType,
  type AdminCreateUserConfigType,
  type AccountRecoverySettingType,
  type UserAttributeUpdateSettingsType,
  type EmailConfigurationType,
  type SmsConfigurationType,
  type VerificationMessageTemplateType,
  type UsernameConfigurationType,
  type DeviceConfigurationType,
  type UserPoolAddOnsType,
  type CreateUserPoolCommandInput,
  type UpdateUserPoolCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
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
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('CognitoUserPoolProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Cognito::UserPool',
      new Set([
        'UserPoolName',
        'AutoVerifiedAttributes',
        'UsernameAttributes',
        'AliasAttributes',
        'Policies',
        'Schema',
        'LambdaConfig',
        'MfaConfiguration',
        'UserPoolTags',
        'AdminCreateUserConfig',
        'AccountRecoverySetting',
        'UserAttributeUpdateSettings',
        'DeletionProtection',
        'EmailConfiguration',
        'SmsConfiguration',
        'VerificationMessageTemplate',
        'UsernameConfiguration',
        'DeviceConfiguration',
        'UserPoolAddOns',
        'EmailVerificationMessage',
        'EmailVerificationSubject',
        'SmsAuthenticationMessage',
        'SmsVerificationMessage',
      ]),
    ],
  ]);

  private getClient(): CognitoIdentityProviderClient {
    if (!this.cognitoClient) {
      this.cognitoClient = new CognitoIdentityProviderClient(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
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

    const poolName =
      (properties['UserPoolName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 128 });

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
      if (properties['AliasAttributes']) {
        createParams.AliasAttributes = properties['AliasAttributes'] as AliasAttributeType[];
      }
      if (properties['EmailConfiguration']) {
        createParams.EmailConfiguration = properties[
          'EmailConfiguration'
        ] as EmailConfigurationType;
      }
      if (properties['SmsConfiguration']) {
        createParams.SmsConfiguration = properties['SmsConfiguration'] as SmsConfigurationType;
      }
      if (properties['VerificationMessageTemplate']) {
        createParams.VerificationMessageTemplate = properties[
          'VerificationMessageTemplate'
        ] as VerificationMessageTemplateType;
      }
      if (properties['UsernameConfiguration']) {
        createParams.UsernameConfiguration = properties[
          'UsernameConfiguration'
        ] as UsernameConfigurationType;
      }
      if (properties['DeviceConfiguration']) {
        createParams.DeviceConfiguration = properties[
          'DeviceConfiguration'
        ] as DeviceConfigurationType;
      }
      if (properties['UserPoolAddOns']) {
        createParams.UserPoolAddOns = properties['UserPoolAddOns'] as UserPoolAddOnsType;
      }
      if (properties['EmailVerificationMessage']) {
        createParams.EmailVerificationMessage = properties['EmailVerificationMessage'] as string;
      }
      if (properties['EmailVerificationSubject']) {
        createParams.EmailVerificationSubject = properties['EmailVerificationSubject'] as string;
      }
      if (properties['SmsAuthenticationMessage']) {
        createParams.SmsAuthenticationMessage = properties['SmsAuthenticationMessage'] as string;
      }
      if (properties['SmsVerificationMessage']) {
        createParams.SmsVerificationMessage = properties['SmsVerificationMessage'] as string;
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
      if (properties['EmailConfiguration']) {
        updateParams.EmailConfiguration = properties[
          'EmailConfiguration'
        ] as EmailConfigurationType;
      }
      if (properties['SmsConfiguration']) {
        updateParams.SmsConfiguration = properties['SmsConfiguration'] as SmsConfigurationType;
      }
      if (properties['VerificationMessageTemplate']) {
        updateParams.VerificationMessageTemplate = properties[
          'VerificationMessageTemplate'
        ] as VerificationMessageTemplateType;
      }
      if (properties['DeviceConfiguration']) {
        updateParams.DeviceConfiguration = properties[
          'DeviceConfiguration'
        ] as DeviceConfigurationType;
      }
      if (properties['UserPoolAddOns']) {
        updateParams.UserPoolAddOns = properties['UserPoolAddOns'] as UserPoolAddOnsType;
      }
      if (properties['EmailVerificationMessage']) {
        updateParams.EmailVerificationMessage = properties['EmailVerificationMessage'] as string;
      }
      if (properties['EmailVerificationSubject']) {
        updateParams.EmailVerificationSubject = properties['EmailVerificationSubject'] as string;
      }
      if (properties['SmsAuthenticationMessage']) {
        updateParams.SmsAuthenticationMessage = properties['SmsAuthenticationMessage'] as string;
      }
      if (properties['SmsVerificationMessage']) {
        updateParams.SmsVerificationMessage = properties['SmsVerificationMessage'] as string;
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
   *
   * If DeletionProtection is ACTIVE, it is automatically disabled before deletion.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Cognito User Pool ${logicalId}: ${physicalId}`);

    try {
      // Check if DeletionProtection is ACTIVE and disable it before deletion
      const deletionProtection = properties?.['DeletionProtection'] as string | undefined;
      if (deletionProtection === 'ACTIVE') {
        this.logger.debug(
          `Disabling DeletionProtection on Cognito User Pool ${physicalId} before deletion`
        );
        await this.getClient().send(
          new UpdateUserPoolCommand({
            UserPoolId: physicalId,
            DeletionProtection: 'INACTIVE',
          })
        );
      } else {
        // Properties may not reflect current state; describe to check
        try {
          const describeResponse = await this.getClient().send(
            new DescribeUserPoolCommand({ UserPoolId: physicalId })
          );
          if (describeResponse.UserPool?.DeletionProtection === 'ACTIVE') {
            this.logger.debug(
              `Disabling DeletionProtection on Cognito User Pool ${physicalId} before deletion`
            );
            await this.getClient().send(
              new UpdateUserPoolCommand({
                UserPoolId: physicalId,
                DeletionProtection: 'INACTIVE',
              })
            );
          }
        } catch (descError) {
          if (descError instanceof ResourceNotFoundException) {
            const clientRegion = await this.getClient().config.region();
            assertRegionMatch(
              clientRegion,
              context?.expectedRegion,
              resourceType,
              logicalId,
              physicalId
            );
            this.logger.debug(`Cognito User Pool ${physicalId} does not exist, skipping deletion`);
            return;
          }
          // If describe fails for another reason, proceed with delete attempt anyway
          this.logger.debug(
            `Failed to describe Cognito User Pool ${physicalId}, proceeding with delete`
          );
        }
      }

      await this.getClient().send(new DeleteUserPoolCommand({ UserPoolId: physicalId }));
      this.logger.debug(`Successfully deleted Cognito User Pool ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
