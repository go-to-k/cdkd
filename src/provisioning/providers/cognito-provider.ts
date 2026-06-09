import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
  UpdateUserPoolCommand,
  DescribeUserPoolCommand,
  ListUserPoolsCommand,
  ListTagsForResourceCommand,
  SetUserPoolMfaConfigCommand,
  GetUserPoolMfaConfigCommand,
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
  type UserPoolTierType,
  type UserVerificationType,
  type CreateUserPoolCommandInput,
  type UpdateUserPoolCommandInput,
  type SetUserPoolMfaConfigCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
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
 * Class 2 sanitize: empty `{}` placeholders that `readCurrentState` emits
 * for sub-objects whose AWS schema requires a sub-field would be rejected
 * by `UpdateUserPool` if shipped as-is. The known-rejected shapes:
 *
 * - `SmsConfiguration: {}`         — `SnsCallerArn` is required
 * - `UsernameConfiguration: {}`    — `CaseSensitive` is required (also
 *                                    immutable on update; AWS rejects any
 *                                    UsernameConfiguration on UpdateUserPool
 *                                    that differs from create-time, but a
 *                                    no-drift round-trip should never reach
 *                                    here in the first place)
 * - `UserPoolAddOns: {}`           — `AdvancedSecurityMode` is required
 *
 * The other sub-objects emitted as `{}` placeholders (LambdaConfig,
 * AdminCreateUserConfig, AccountRecoverySetting, UserAttributeUpdateSettings,
 * EmailConfiguration, VerificationMessageTemplate, DeviceConfiguration)
 * have all-optional sub-fields per the SDK types and AWS accepts the empty
 * object as "no overrides / clear all".
 *
 * Returns `true` when the value is a non-null object with zero keys.
 */
function isEmptyObjectPlaceholder(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

/**
 * The CFn `EnabledMfas` factor names AND their MFA-config-API meaning.
 *
 * `EnabledMfas` is a CFn-level `Array of String`, but Cognito has no
 * `EnabledMfas` field on `CreateUserPool` / `UpdateUserPool`. The factors are
 * activated via the separate `SetUserPoolMfaConfig` control-plane API, one
 * sub-block per factor:
 *
 * - `SMS_MFA`            -> `SmsMfaConfiguration` (needs the pool's
 *                           `SmsConfiguration` SNS-caller ARN to be set too)
 * - `SOFTWARE_TOKEN_MFA` -> `SoftwareTokenMfaConfiguration.Enabled = true`
 * - `EMAIL_OTP`          -> `EmailMfaConfiguration` (carries the email-OTP
 *                           message/subject template — i.e. CFn's
 *                           `EmailAuthenticationMessage` / `Subject`)
 */
const MFA_FACTOR_SMS = 'SMS_MFA';
const MFA_FACTOR_SOFTWARE_TOKEN = 'SOFTWARE_TOKEN_MFA';
const MFA_FACTOR_EMAIL_OTP = 'EMAIL_OTP';

/**
 * Build the `SetUserPoolMfaConfig` request from the CFn-level MFA properties,
 * or return `undefined` when none of the MFA-config-API-routed properties are
 * present (so the caller skips the extra control-plane call entirely).
 *
 * The properties that route through `SetUserPoolMfaConfig` (NOT CreateUserPool):
 * - `EnabledMfas`               -> per-factor sub-blocks (see constants above)
 * - `EmailAuthenticationMessage`/`EmailAuthenticationSubject` -> the
 *   `EmailMfaConfiguration` message/subject (email-OTP template)
 * - `WebAuthnRelyingPartyID`/`WebAuthnUserVerification` -> `WebAuthnConfiguration`
 *
 * `MfaConfiguration` (ON/OFF/OPTIONAL) MUST be threaded into this request:
 * `SetUserPoolMfaConfig` is a full-replace of the pool's MFA state, and an
 * omitted `MfaConfiguration` defaults to OFF on the wire — which resets the
 * pool to MFA-disabled and makes AWS reject (or silently drop) the per-factor
 * sub-blocks we are trying to enable. Use the template's `MfaConfiguration`
 * when present; default to `OPTIONAL` when factors are present but the template
 * omitted it (factors are meaningless under OFF, and OPTIONAL enables them
 * without forcing MFA on every user).
 */
/**
 * True when any MFA-config-API-routed property is present, i.e. a
 * `SetUserPoolMfaConfig` call will run post-create. When true, `create()` must
 * NOT forward `MfaConfiguration` to `CreateUserPool`: AWS rejects
 * `CreateUserPool` with `MfaConfiguration: ON/OPTIONAL` unless the pool already
 * has SMS configured (+ phone_number auto-verification) OR software-token MFA
 * enabled — but software-token / email-OTP MFA can only be enabled via the
 * post-create `SetUserPoolMfaConfig` call, not on `CreateUserPool`. So the
 * correct sequence is: `CreateUserPool` WITHOUT `MfaConfiguration` (defaults
 * OFF) -> `SetUserPoolMfaConfig` sets `MfaConfiguration` + the factor blocks
 * together (the factor satisfies the MFA requirement, no SMS needed). This
 * mirrors how CloudFormation/CDK sequence the two calls.
 */
function hasMfaConfigProps(properties: Record<string, unknown>): boolean {
  const enabledMfas = Array.isArray(properties['EnabledMfas'])
    ? (properties['EnabledMfas'] as string[])
    : undefined;
  return (
    (enabledMfas !== undefined && enabledMfas.length > 0) ||
    !!(properties['EmailAuthenticationMessage'] as string | undefined) ||
    !!(properties['EmailAuthenticationSubject'] as string | undefined) ||
    !!(properties['WebAuthnRelyingPartyID'] as string | undefined) ||
    !!(properties['WebAuthnUserVerification'] as string | undefined)
  );
}

function buildMfaConfigRequest(
  physicalId: string,
  properties: Record<string, unknown>
): SetUserPoolMfaConfigCommandInput | undefined {
  const enabledMfas = Array.isArray(properties['EnabledMfas'])
    ? (properties['EnabledMfas'] as string[])
    : undefined;
  // Truthy (non-empty) gating — NOT `!== undefined` — because
  // `readCurrentState` ALWAYS emits these as empty-string / empty-array
  // placeholders (so a console-side ADD surfaces as drift). A `!== undefined`
  // gate would issue a wasteful SetUserPoolMfaConfig with an empty
  // EmailMfaConfiguration on every no-drift deploy of a pool that never used
  // MFA — which AWS may also reject (email-OTP needs the Essentials tier). The
  // trade-off vs. EmailVerificationMessage's `!== undefined` gate: clearing an
  // email-OTP template back to "" via drift-revert is not supported here, but
  // a no-op deploy staying a true no-op is the more important property for the
  // post-create control-plane API.
  const emailMessage =
    (properties['EmailAuthenticationMessage'] as string | undefined) || undefined;
  const emailSubject =
    (properties['EmailAuthenticationSubject'] as string | undefined) || undefined;
  const webAuthnRpId = (properties['WebAuthnRelyingPartyID'] as string | undefined) || undefined;
  const webAuthnUserVerification =
    (properties['WebAuthnUserVerification'] as UserVerificationType | undefined) || undefined;

  if (!hasMfaConfigProps(properties)) return undefined;

  const request: SetUserPoolMfaConfigCommandInput = { UserPoolId: physicalId };

  // SetUserPoolMfaConfig is a full-replace: an omitted MfaConfiguration resets
  // the pool to OFF, which would disable the very factors we are enabling.
  // Thread the template value; default to OPTIONAL when factors are present.
  const mfaConfiguration = properties['MfaConfiguration'] as UserPoolMfaType | undefined;
  request.MfaConfiguration = mfaConfiguration ?? 'OPTIONAL';

  const factors = new Set(enabledMfas ?? []);

  if (factors.has(MFA_FACTOR_SOFTWARE_TOKEN)) {
    request.SoftwareTokenMfaConfiguration = { Enabled: true };
  }
  if (factors.has(MFA_FACTOR_SMS)) {
    // SMS MFA needs the pool's SNS-caller config; reuse the UserPool's own
    // SmsConfiguration property (the same SNS-caller ARN the pool was created
    // with). AWS rejects SMS MFA enablement without it.
    request.SmsMfaConfiguration = {
      ...(properties['SmsConfiguration']
        ? { SmsConfiguration: properties['SmsConfiguration'] as SmsConfigurationType }
        : {}),
    };
  }
  // The email-OTP factor and the email message/subject share one sub-block.
  // Emit it when EMAIL_OTP is enabled OR a custom message/subject is supplied
  // (the message/subject customization implies email-OTP usage).
  if (
    factors.has(MFA_FACTOR_EMAIL_OTP) ||
    emailMessage !== undefined ||
    emailSubject !== undefined
  ) {
    request.EmailMfaConfiguration = {
      ...(emailMessage !== undefined ? { Message: emailMessage } : {}),
      ...(emailSubject !== undefined ? { Subject: emailSubject } : {}),
    };
  }
  if (webAuthnRpId !== undefined || webAuthnUserVerification !== undefined) {
    request.WebAuthnConfiguration = {
      ...(webAuthnRpId !== undefined ? { RelyingPartyId: webAuthnRpId } : {}),
      ...(webAuthnUserVerification !== undefined
        ? { UserVerification: webAuthnUserVerification }
        : {}),
    };
  }
  return request;
}

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
        'UserPoolTier',
        // Routed through the SetUserPoolMfaConfig control-plane API
        // (NOT CreateUserPool/UpdateUserPool) — see buildMfaConfigRequest.
        'EnabledMfas',
        'EmailAuthenticationMessage',
        'EmailAuthenticationSubject',
        'WebAuthnRelyingPartyID',
        'WebAuthnUserVerification',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Cognito::UserPool',
      new Map<string, string>([
        [
          'WebAuthnFactorConfiguration',
          'No SDK wire path: @aws-sdk/client-cognito-identity-provider has no field accepting SINGLE_FACTOR | MULTI_FACTOR_WITH_USER_VERIFICATION (not on CreateUserPool/UpdateUserPool, nor SetUserPoolMfaConfig.WebAuthnConfiguration which only carries RelyingPartyId/UserVerification); CC-API-registry-only property',
        ],
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

    // Tracks whether CreateUserPool succeeded this call, so the catch can roll
    // back a pool whose post-create MFA-config step (SetUserPoolMfaConfig)
    // failed — otherwise create() throws before returning the physicalId, the
    // deploy engine never learns the pool exists, and it orphans (mirrors the
    // DynamoDBTableProvider PITR/TTL post-create atomicity pattern).
    let createdUserPoolId: string | undefined;

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
      // Only forward MfaConfiguration to CreateUserPool when NO MFA factor is
      // applied post-create. When factors are present, SetUserPoolMfaConfig
      // owns MfaConfiguration (and enables the factor in the same call) —
      // setting ON/OPTIONAL on CreateUserPool here would be rejected by AWS
      // ("SMS configuration and Auto verification for phone_number are required
      // when MFA is required/optional") because the factor is not yet enabled.
      if (properties['MfaConfiguration'] && !hasMfaConfigProps(properties)) {
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
      if (properties['UserPoolTier']) {
        createParams.UserPoolTier = properties['UserPoolTier'] as UserPoolTierType;
      }

      const response = await this.getClient().send(new CreateUserPoolCommand(createParams));

      const userPool = response.UserPool;
      if (!userPool?.Id) {
        throw new Error('CreateUserPool did not return UserPool.Id');
      }

      const userPoolId = userPool.Id;
      createdUserPoolId = userPoolId;
      const userPoolArn = userPool.Arn;
      const region = await this.getClient().config.region();
      const providerName = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
      const providerUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

      // EnabledMfas / Email-OTP message+subject / WebAuthn config do NOT ride
      // on CreateUserPool — they go through the SetUserPoolMfaConfig
      // post-create control-plane API. Skip the extra call when none of them
      // are present.
      await this.applyMfaConfig(userPoolId, properties);

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
      // Atomicity: if CreateUserPool succeeded but the post-create
      // SetUserPoolMfaConfig step failed, the pool exists but create() is
      // about to throw without returning its physicalId — the deploy engine
      // can't roll it back, so best-effort delete it here to avoid an orphan
      // pool + a name-collision on the next deploy attempt.
      if (createdUserPoolId) {
        try {
          await this.getClient().send(new DeleteUserPoolCommand({ UserPoolId: createdUserPoolId }));
          this.logger.debug(`Rolled back partially-created Cognito User Pool ${createdUserPoolId}`);
        } catch (rollbackError) {
          this.logger.warn(
            `Failed to roll back partially-created Cognito User Pool ${createdUserPoolId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
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
   * Apply the MFA-config-API-routed properties (EnabledMfas / email-OTP
   * message+subject / WebAuthn) via SetUserPoolMfaConfig. No-op when none are
   * present. Wrapped in a transient-error retry because back-to-back
   * control-plane writes on a freshly-created pool can briefly conflict
   * (mirrors DynamoDBTableProvider.retryOnTransientControlPlane).
   */
  private async applyMfaConfig(
    physicalId: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    const request = buildMfaConfigRequest(physicalId, properties);
    if (!request) return;
    await this.retryOnTransientControlPlane(
      () => this.getClient().send(new SetUserPoolMfaConfigCommand(request)),
      `SetUserPoolMfaConfig(${physicalId})`
    );
  }

  /**
   * Retry a Cognito control-plane call on transient "settling" errors. A
   * SetUserPoolMfaConfig issued immediately after CreateUserPool (or another
   * control-plane write) can briefly hit `ConcurrentModificationException` /
   * "please retry". Backoff 1s -> 2s -> 4s, default 3 attempts.
   */
  private async retryOnTransientControlPlane<T>(
    fn: () => Promise<T>,
    label: string,
    maxAttempts = 3
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : '';
        const transient =
          name === 'ConcurrentModificationException' ||
          /concurrent modification|please retry|try again|in progress/i.test(msg);
        if (!transient || attempt >= maxAttempts) throw error;
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 4000);
        this.logger.debug(
          `Transient error on "${label}" (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
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
      // Class 2 sanitize: `SmsConfiguration: {}` would be rejected by
      // UpdateUserPool because `SnsCallerArn` is a required sub-field.
      // Skip the empty-object placeholder so a no-drift round-trip
      // (state == AWS, both empty) is a logical no-op.
      if (
        properties['SmsConfiguration'] &&
        !isEmptyObjectPlaceholder(properties['SmsConfiguration'])
      ) {
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
      // Class 2 sanitize: `UserPoolAddOns: {}` would be rejected because
      // `AdvancedSecurityMode` is a required sub-field.
      if (properties['UserPoolAddOns'] && !isEmptyObjectPlaceholder(properties['UserPoolAddOns'])) {
        updateParams.UserPoolAddOns = properties['UserPoolAddOns'] as UserPoolAddOnsType;
      }
      // `!== undefined` (not truthy) so empty-string placeholders that
      // `readCurrentState` emits for unset message fields reach AWS — a
      // truthy gate would silently drop `''` and `cdkd drift --revert`
      // (which round-trips observed → desired) would report `✓ reverted`
      // while leaving the AWS-side message untouched. The next drift run
      // re-detects the same drift — silent fail.
      if (properties['EmailVerificationMessage'] !== undefined) {
        updateParams.EmailVerificationMessage = properties['EmailVerificationMessage'] as string;
      }
      if (properties['EmailVerificationSubject'] !== undefined) {
        updateParams.EmailVerificationSubject = properties['EmailVerificationSubject'] as string;
      }
      if (properties['SmsAuthenticationMessage'] !== undefined) {
        updateParams.SmsAuthenticationMessage = properties['SmsAuthenticationMessage'] as string;
      }
      if (properties['SmsVerificationMessage'] !== undefined) {
        updateParams.SmsVerificationMessage = properties['SmsVerificationMessage'] as string;
      }
      if (properties['UserPoolTier']) {
        updateParams.UserPoolTier = properties['UserPoolTier'] as UserPoolTierType;
      }

      await this.getClient().send(new UpdateUserPoolCommand(updateParams));

      // EnabledMfas / email-OTP message+subject / WebAuthn config are NOT on
      // UpdateUserPool — apply them via SetUserPoolMfaConfig after the main
      // update (no-op when none are present).
      await this.applyMfaConfig(physicalId, properties);

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
   * Delete a Cognito User Pool.
   *
   * When `context.removeProtection === true`, `DeletionProtection` is flipped
   * from `ACTIVE` to `INACTIVE` via `UpdateUserPool` before deletion. The
   * call is idempotent — AWS accepts the no-op already-disabled case
   * without error. Without `removeProtection`, AWS rejects the delete on a
   * protected pool with `InvalidParameterException` and the destroy fails;
   * the user is expected to set `--remove-protection` explicitly.
   *
   * Pre-PR behavior was an unconditional flip-off; that silent bypass has
   * been gated on `--remove-protection` to match the rest of the
   * deletion-protection-bearing types and CDK CLI's refuse-on-protected
   * semantics. See PR body for migration notes.
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
      if (context?.removeProtection === true) {
        // Templated state may not reflect the current AWS-side flag (the
        // user could have flipped it via console); describe to check
        // before issuing the flip-off, and skip the call when already
        // INACTIVE so we don't waste an API request.
        const templatedActive =
          (properties?.['DeletionProtection'] as string | undefined) === 'ACTIVE';
        let needsFlip = templatedActive;
        if (!templatedActive) {
          try {
            const describeResponse = await this.getClient().send(
              new DescribeUserPoolCommand({ UserPoolId: physicalId })
            );
            needsFlip = describeResponse.UserPool?.DeletionProtection === 'ACTIVE';
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
              this.logger.debug(
                `Cognito User Pool ${physicalId} does not exist, skipping deletion`
              );
              return;
            }
            // If describe fails for another reason, attempt the flip
            // anyway — UpdateUserPool against an already-INACTIVE pool
            // is a harmless no-op.
            this.logger.debug(
              `Failed to describe Cognito User Pool ${physicalId}, attempting flip-off anyway`
            );
            needsFlip = true;
          }
        }
        if (needsFlip) {
          this.logger.debug(
            `Disabling DeletionProtection on Cognito User Pool ${physicalId} before deletion (--remove-protection)`
          );
          try {
            await this.getClient().send(
              new UpdateUserPoolCommand({
                UserPoolId: physicalId,
                DeletionProtection: 'INACTIVE',
              })
            );
          } catch (flipError) {
            // Idempotent — log and proceed. The actual delete below will
            // surface any real authorization / state error.
            this.logger.debug(
              `Could not disable DeletionProtection for ${physicalId}: ${flipError instanceof Error ? flipError.message : String(flipError)}`
            );
          }
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

  /**
   * Read the AWS-current Cognito User Pool configuration in CFn-property shape.
   *
   * Issues `DescribeUserPool` and surfaces the keys cdkd's `create()` accepts.
   * AWS-managed fields (Arn, Id, CreationDate, LastModifiedDate, EstimatedNumberOfUsers,
   * etc.) are filtered at the wire layer.
   *
   * **Note**: Cognito only supports `AWS::Cognito::UserPool` in this provider;
   * `UserPoolClient`, `UserPoolGroup`, and other Cognito sub-resources go
   * through the CC API fallback (which has its own `readCurrentState`).
   *
   * `UserPoolTags` is surfaced from the same `DescribeUserPool` response —
   * Cognito's CFn property is a tag-name → value map (NOT an array of
   * `{Key, Value}`), so we keep the map shape and just filter out CDK's
   * `aws:*` auto-tags. The result key is omitted when no user tags remain.
   *
   * Returns `undefined` when the pool is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    if (resourceType !== 'AWS::Cognito::UserPool') return undefined;

    let resp;
    try {
      resp = await this.getClient().send(new DescribeUserPoolCommand({ UserPoolId: physicalId }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
    const pool = resp.UserPool;
    if (!pool) return undefined;

    // Cognito UserPool is mutated via UpdateUserPool which accepts every
    // field below (except UserPoolName, Schema which are immutable on
    // create). Always emit user-controllable top-level keys with
    // placeholders so a console-side ADD on a property the pool wasn't
    // templated with at deploy time surfaces as drift.
    const result: Record<string, unknown> = {};
    if (pool.Name !== undefined) result['UserPoolName'] = pool.Name;
    result['AutoVerifiedAttributes'] = pool.AutoVerifiedAttributes
      ? [...pool.AutoVerifiedAttributes]
      : [];
    result['UsernameAttributes'] = pool.UsernameAttributes ? [...pool.UsernameAttributes] : [];
    result['AliasAttributes'] = pool.AliasAttributes ? [...pool.AliasAttributes] : [];
    result['Policies'] = pool.Policies ?? {};
    if (pool.SchemaAttributes && pool.SchemaAttributes.length > 0) {
      // Schema is immutable on create — only emit when present so a pool
      // without a custom schema doesn't surface an empty Schema array as
      // a phantom diff.
      result['Schema'] = pool.SchemaAttributes;
    }
    result['LambdaConfig'] = pool.LambdaConfig ?? {};
    result['MfaConfiguration'] = pool.MfaConfiguration ?? 'OFF';
    result['AdminCreateUserConfig'] = pool.AdminCreateUserConfig ?? {};
    result['AccountRecoverySetting'] = pool.AccountRecoverySetting ?? {};
    result['UserAttributeUpdateSettings'] = pool.UserAttributeUpdateSettings ?? {};
    result['DeletionProtection'] = pool.DeletionProtection ?? 'INACTIVE';
    result['EmailConfiguration'] = pool.EmailConfiguration ?? {};
    result['SmsConfiguration'] = pool.SmsConfiguration ?? {};
    result['VerificationMessageTemplate'] = pool.VerificationMessageTemplate ?? {};
    result['UsernameConfiguration'] = pool.UsernameConfiguration ?? {};
    result['DeviceConfiguration'] = pool.DeviceConfiguration ?? {};
    result['UserPoolAddOns'] = pool.UserPoolAddOns ?? {};
    result['EmailVerificationMessage'] = pool.EmailVerificationMessage ?? '';
    result['EmailVerificationSubject'] = pool.EmailVerificationSubject ?? '';
    result['SmsAuthenticationMessage'] = pool.SmsAuthenticationMessage ?? '';
    result['SmsVerificationMessage'] = pool.SmsVerificationMessage ?? '';
    // UserPoolTags is a map in CFn (NOT an array of {Key, Value}). Filter
    // aws:* auto-tags but keep the map shape to match what cdkd state holds.
    // Always emit (even when empty) so a console-side tag ADD on an
    // initially-untagged pool surfaces as drift.
    const userTags: Record<string, string> = {};
    if (pool.UserPoolTags) {
      for (const [k, v] of Object.entries(pool.UserPoolTags)) {
        if (!k.startsWith('aws:')) userTags[k] = v;
      }
    }
    result['UserPoolTags'] = userTags;
    // UserPoolTier rides on DescribeUserPool; defaults to ESSENTIALS per AWS.
    result['UserPoolTier'] = pool.UserPoolTier ?? 'ESSENTIALS';

    // EnabledMfas / email-OTP message+subject / WebAuthn config live on the
    // separate GetUserPoolMfaConfig API, not DescribeUserPool. Fetch them and
    // reconstruct the CFn-shape properties. A pool with no MFA factors and no
    // WebAuthn config returns empty/absent sub-blocks; emit the keys so a
    // console-side ADD surfaces as drift, mirroring the always-emit policy
    // above. Tolerate a failure on this secondary call (e.g. a permission gap
    // on the MFA API) by skipping the MFA-derived keys rather than failing the
    // whole drift read.
    try {
      const mfa = await this.getClient().send(
        new GetUserPoolMfaConfigCommand({ UserPoolId: physicalId })
      );
      // Reconstructed in a fixed canonical order (SMS -> SOFTWARE_TOKEN ->
      // EMAIL_OTP). A template that lists EnabledMfas in a different order can
      // surface a spurious array-order drift; the canonical order is documented
      // so authors can match it. (A future order-insensitive array compare in
      // drift-calculator would remove the caveat entirely.)
      const enabledMfas: string[] = [];
      if (mfa.SmsMfaConfiguration) enabledMfas.push(MFA_FACTOR_SMS);
      if (mfa.SoftwareTokenMfaConfiguration?.Enabled) enabledMfas.push(MFA_FACTOR_SOFTWARE_TOKEN);
      if (mfa.EmailMfaConfiguration) enabledMfas.push(MFA_FACTOR_EMAIL_OTP);
      result['EnabledMfas'] = enabledMfas;
      result['EmailAuthenticationMessage'] = mfa.EmailMfaConfiguration?.Message ?? '';
      result['EmailAuthenticationSubject'] = mfa.EmailMfaConfiguration?.Subject ?? '';
      result['WebAuthnRelyingPartyID'] = mfa.WebAuthnConfiguration?.RelyingPartyId ?? '';
      result['WebAuthnUserVerification'] = mfa.WebAuthnConfiguration?.UserVerification ?? '';
    } catch (mfaErr) {
      this.logger.debug(
        `GetUserPoolMfaConfig failed for ${physicalId}, skipping MFA-derived drift keys: ${mfaErr instanceof Error ? mfaErr.message : String(mfaErr)}`
      );
    }
    return result;
  }

  /**
   * Adopt an existing Cognito User Pool into cdkd state.
   *
   * User Pool physical id is the AWS-generated `<region>_<random>` id.
   * Lookup chain:
   *  1. `--resource` override → `DescribeUserPool` to verify.
   *  2. `Properties.UserPoolName` (when CDK template carries it) →
   *     `ListUserPools` walk + name match.
   *  3. `aws:cdk:path` tag match via `ListUserPools` +
   *     `ListTagsForResource(<arn>)`. Cognito's tag map uses the same
   *     `Tags: { [key]: value }` shape as Lambda.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.getClient().send(
          new DescribeUserPoolCommand({ UserPoolId: input.knownPhysicalId })
        );
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    const desiredName =
      typeof input.properties?.['UserPoolName'] === 'string'
        ? input.properties['UserPoolName']
        : undefined;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListUserPoolsCommand({
          MaxResults: 60,
          ...(nextToken && { NextToken: nextToken }),
        })
      );
      for (const pool of list.UserPools ?? []) {
        if (!pool.Id) continue;
        if (desiredName && pool.Name === desiredName) {
          return { physicalId: pool.Id, attributes: {} };
        }
        if (input.cdkPath) {
          // Need the ARN for ListTagsForResource. Construct from id —
          // physical id format is `<region>_<random>`, ARN is
          // `arn:aws:cognito-idp:<region>:<account>:userpool/<id>`.
          // Use DescribeUserPool to fetch the ARN cheaply.
          try {
            const desc = await this.getClient().send(
              new DescribeUserPoolCommand({ UserPoolId: pool.Id })
            );
            const arn = desc.UserPool?.Arn;
            if (!arn) continue;
            const tagsResp = await this.getClient().send(
              new ListTagsForResourceCommand({ ResourceArn: arn })
            );
            if (tagsResp.Tags?.[CDK_PATH_TAG] === input.cdkPath) {
              return { physicalId: pool.Id, attributes: {} };
            }
          } catch (err) {
            if (err instanceof ResourceNotFoundException) continue;
            throw err;
          }
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }
}
