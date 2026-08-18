import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
  UpdateUserPoolCommand,
  DescribeUserPoolCommand,
  ListUserPoolsCommand,
  SetUserPoolMfaConfigCommand,
  GetUserPoolMfaConfigCommand,
  AddCustomAttributesCommand,
  ResourceNotFoundException,
  type VerifiedAttributeType,
  type UsernameAttributeType,
  type AliasAttributeType,
  type UserPoolMfaType,
  type DeletionProtectionType,
  type SchemaAttributeType,
  type LambdaConfigType,
  type PasswordPolicyType,
  type SignInPolicyType,
  type UserPoolPolicyType,
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
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * The standard (OIDC) Cognito User Pool attribute names. A Schema entry whose
 * Name is NOT in this set is a custom attribute (AWS stores it as
 * `custom:<name>`). Used by the update path to tell which added Schema entries
 * can be added in place via AddCustomAttributes (custom only) versus which
 * require replacement (standard attributes are immutable on update).
 *
 * This list is a snapshot of AWS's standard claim set and may lag AWS. If AWS
 * ever adds a new standard attribute, a user adding it would be misclassified
 * as custom and routed to AddCustomAttributes — which AWS rejects with a clear
 * error (surfaced as a ProvisioningError, never a silent drop), so the failure
 * is loud and the fix is to append the new name here.
 */
const STANDARD_USER_POOL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'address',
  'birthdate',
  'email',
  'email_verified',
  'family_name',
  'gender',
  'given_name',
  'locale',
  'middle_name',
  'name',
  'nickname',
  'phone_number',
  'phone_number_verified',
  'picture',
  'preferred_username',
  'profile',
  'sub',
  'updated_at',
  'website',
  'zoneinfo',
]);

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
 * Read `EnabledMfas` as the pair (recognized list, "the template asked for a
 * factor at all").
 *
 * The second half exists because `Array.isArray` is not the same question as
 * "did the user declare a factor". A hand-written YAML scalar
 * (`EnabledMfas: SOFTWARE_TOKEN_MFA`) or an intrinsic that resolves to a String
 * parameter is a factor DECLARATION that happens to be mis-shaped. Treating it
 * as absence lets the MfaConfiguration default resolve to `OFF`, which AWS
 * ACCEPTS — so the pool ships with MFA disabled and the declared factor
 * dropped, silently. Treating it as intent keeps the default at `OPTIONAL`
 * instead, which AWS refuses loudly — unless the template pinned
 * `MfaConfiguration: OFF`, or another factor is enabled. The warning in
 * `buildMfaConfigRequest` reports which of those three actually happened.
 * Same reasoning as the unrecognized-spelling case there; this is that hole
 * reached through the SHAPE instead of the spelling.
 */
function readEnabledMfas(properties: Record<string, unknown>): {
  factors: string[] | undefined;
  declaresFactor: boolean;
  malformed: boolean;
} {
  const raw = properties['EnabledMfas'];
  if (Array.isArray(raw)) {
    const factors = raw as string[];
    return { factors, declaresFactor: factors.length > 0, malformed: false };
  }
  // `null` / `''` are absence, not a mis-shaped declaration: the intrinsic
  // resolver deletes `AWS::NoValue` keys outright rather than emitting null, so
  // a literal null is "explicitly nothing", and an empty string declares no
  // factor either. Treating them as intent would fire a spurious
  // SetUserPoolMfaConfig and turn a previously-working deploy into a hard AWS
  // rejection. This matches the truthy gating used for every sibling string
  // property below.
  const malformed = raw !== undefined && raw !== null && raw !== '';
  return { factors: undefined, declaresFactor: malformed, malformed };
}

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
  // `declaresFactor` (not just a non-empty array) so a mis-shaped declaration
  // still routes through SetUserPoolMfaConfig and fails loudly, rather than
  // skipping the call and dropping the factor in silence.
  return (
    readEnabledMfas(properties).declaresFactor ||
    !!(properties['EmailAuthenticationMessage'] as string | undefined) ||
    !!(properties['EmailAuthenticationSubject'] as string | undefined) ||
    !!(properties['WebAuthnRelyingPartyID'] as string | undefined) ||
    !!(properties['WebAuthnUserVerification'] as string | undefined)
  );
}

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
 * when present; when the template omitted it, default by whether this call
 * enables an MFA FACTOR — `OPTIONAL` if it does, `OFF` (CloudFormation's own
 * default) if it does not. The body comment on that decision explains why both
 * halves of the factor test are load-bearing.
 */
function buildMfaConfigRequest(
  physicalId: string,
  properties: Record<string, unknown>,
  logger?: { warn: (message: string) => void }
): SetUserPoolMfaConfigCommandInput | undefined {
  const {
    factors: enabledMfas,
    declaresFactor,
    malformed: enabledMfasMalformed,
  } = readEnabledMfas(properties);
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

  const factors = new Set(enabledMfas ?? []);

  const unrecognizedFactors = [...factors].filter(
    (factor) =>
      factor !== MFA_FACTOR_SMS &&
      factor !== MFA_FACTOR_SOFTWARE_TOKEN &&
      factor !== MFA_FACTOR_EMAIL_OTP
  );

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

  // SetUserPoolMfaConfig is a full-replace: an omitted MfaConfiguration resets
  // the pool to OFF, which would disable the very factors we are enabling. So
  // thread the template's value, and when the template omitted it, default by
  // whether this call enables an MFA FACTOR at all. OFF is CloudFormation's own
  // default, and it is REQUIRED for a passkey-only pool: WebAuthn is not an MFA
  // factor, so AWS rejects OPTIONAL there with "Invalid MFA Configuration given.
  // SMS MFA, Email MFA, or Software Token MFA must be enabled." (issue #1920).
  //
  // BOTH halves of the condition are load-bearing; neither alone is safe, and
  // the unsafe versions are exactly the ones this is natural to "simplify" to:
  //
  //  - The DECLARED-factor half is what keeps a bad factor declaration loud. It
  //    is true for any non-empty `EnabledMfas` AND for a mis-shaped one (a YAML
  //    scalar / String-param ref), neither of which emits a factor block. A
  //    sub-block-only condition would send OFF for both, AWS would ACCEPT it,
  //    and the pool would ship with MFA silently disabled and the declared
  //    factor dropped. Keeping OPTIONAL makes AWS refuse loudly and name the
  //    problem — the pre-existing behavior, preserved deliberately.
  //  - The EmailMfaConfiguration half keeps the email-OTP message/subject shape
  //    on its existing OPTIONAL default: that block is emitted for a bare
  //    EmailAuthenticationMessage/Subject customization with NO EnabledMfas, so
  //    it is the one sub-block the first half does not already imply. Whether
  //    AWS accepts it under OFF is UNVERIFIED — the integ cannot reach it
  //    (email-OTP needs a verified SES sender; see the fixture note) — so that
  //    shape is deliberately left unchanged rather than flipped on an untested
  //    wire assumption. Issue #1920 proposed keying on EnabledMfas alone, which
  //    WOULD have flipped it; issue #1923 tracks the SES-account verification
  //    that would settle it.
  //
  // Note SmsMfaConfiguration / SoftwareTokenMfaConfiguration are deliberately
  // NOT tested here: both are only ever set inside a `factors.has(...)` guard,
  // so each is strictly implied by the first half. Including them would read as
  // defensive but no input could make them decisive, and no test could fail on
  // their removal.
  const enablesMfaFactor = declaresFactor || request.EmailMfaConfiguration !== undefined;
  const mfaConfiguration = properties['MfaConfiguration'] as UserPoolMfaType | undefined;
  request.MfaConfiguration = mfaConfiguration ?? (enablesMfaFactor ? 'OPTIONAL' : 'OFF');

  // Warn about a factor declaration that enables nothing — AFTER the line
  // above, so the message can state the value actually being sent instead of
  // predicting it. Predicting is how the earlier version came to lie: it
  // claimed "left at OPTIONAL so AWS rejects the call" even when an explicit
  // `MfaConfiguration: OFF` in the template made the request OFF, which AWS
  // ACCEPTS — the one branch where the pool really does deploy with MFA off.
  //
  // Warn rather than throw for an unrecognized SPELLING: that set is a
  // hardcoded mirror of an AWS enum, so refusing would break a valid template
  // the day AWS adds a factor. cdkd would still not know the new factor's
  // sub-block, so the entry is dropped either way -- the warning is what makes
  // that visible, since the outcome varies (AWS refuses when nothing else is
  // enabled, but accepts and ignores the entry when a sibling factor is).
  // JSON.stringify, not `${f}` -- a non-string member would otherwise print as
  // [object Object] and name nothing, and for the intrinsic shape this warning
  // exists to surface (`EnabledMfas: {Ref: Param}`) that IS the likely member.
  // The `?? String(f)` tail is defensive: JSON.stringify(undefined) returns
  // undefined, which join() would render as an empty gap naming no entry at
  // all. A template cannot produce an undefined member (the resolver filters
  // AWS::NoValue out of arrays), so this guards non-template callers only --
  // but TypeScript types JSON.stringify as returning `string`, which makes the
  // tail look unreachable to a reader or a lint autofix. A unit test passes
  // [undefined] directly so deleting it fails rather than going unnoticed.
  const dropped: string[] = unrecognizedFactors.map((f) => JSON.stringify(f) ?? String(f));
  if (enabledMfasMalformed) {
    dropped.push(`${JSON.stringify(properties['EnabledMfas'])} (not a list)`);
  }
  if (dropped.length > 0) {
    // Three outcomes, not two. Splitting only on OFF made the second arm claim
    // a rejection that does not happen whenever a RECOGNIZED factor rides
    // alongside the dropped entry: the request carries that factor's block, AWS
    // accepts, and the entry is simply ignored. That is the silent-drop case
    // this warning exists to surface, so telling the user to expect a hard
    // failure there is the worst of the three things it could say.
    const anyFactorBlock =
      request.SmsMfaConfiguration !== undefined ||
      request.SoftwareTokenMfaConfiguration !== undefined ||
      request.EmailMfaConfiguration !== undefined;
    const consequence =
      request.MfaConfiguration === 'OFF'
        ? `MfaConfiguration is OFF, so this pool deploys with MFA DISABLED`
        : anyFactorBlock
          ? `MfaConfiguration is ${request.MfaConfiguration} and another factor IS enabled, so ` +
            `these entries are silently ignored rather than failing the call on their own`
          : `MfaConfiguration is ${request.MfaConfiguration} with no factor enabled, so AWS ` +
            `rejects this call rather than deploying the pool with MFA disabled`;
    logger?.warn(
      `UserPool ${physicalId}: EnabledMfas entries ${dropped.join(', ')} do not map to an MFA ` +
        `factor block (known: ${MFA_FACTOR_SMS}, ${MFA_FACTOR_SOFTWARE_TOKEN}, ` +
        `${MFA_FACTOR_EMAIL_OTP}); no factor is enabled from them. ${consequence}.`
    );
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
   * Build the SDK `Policies` input from the CFn `Policies` blob. Both
   * sub-keys must be forwarded: `SignInPolicy` (passwordless first-auth
   * factors) was silently dropped before issue #1380, and UpdateUserPool
   * resets omitted attributes to their defaults, so leaving it out also
   * wipes an existing sign-in policy on every update.
   */
  private toSdkUserPoolPolicies(policies: Record<string, unknown>): UserPoolPolicyType | undefined {
    const result: UserPoolPolicyType = {};
    if (policies['PasswordPolicy']) {
      result.PasswordPolicy = policies['PasswordPolicy'] as PasswordPolicyType;
    }
    if (policies['SignInPolicy']) {
      result.SignInPolicy = policies['SignInPolicy'] as SignInPolicyType;
    }
    return Object.keys(result).length > 0 ? result : undefined;
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
        const sdkPolicies = this.toSdkUserPoolPolicies(
          properties['Policies'] as Record<string, unknown>
        );
        if (sdkPolicies) {
          createParams.Policies = sdkPolicies;
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
      // Suffix DERIVED from the region, not hardcoded (issue #1745): outside the
      // commercial partition `amazonaws.com` names a host that does not resolve,
      // and the value is structurally valid so nothing downstream can catch it.
      const { urlSuffix } = derivePartitionAndUrlSuffix(region);
      const providerName = `cognito-idp.${region}.${urlSuffix}/${userPoolId}`;
      const providerUrl = `https://cognito-idp.${region}.${urlSuffix}/${userPoolId}`;

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
    const request = buildMfaConfigRequest(physicalId, properties, this.logger);
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
   * Note: PoolName (UserPoolName) is immutable and cannot be changed after
   * creation. The Schema (custom attributes) is partly mutable: AWS supports
   * ADDING new custom attributes in place via AddCustomAttributes, but cannot
   * modify or remove an existing attribute — those changes require replacement
   * and are rejected with ResourceUpdateNotSupportedError.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Cognito User Pool ${logicalId}: ${physicalId}`);

    try {
      const updateParams: UpdateUserPoolCommandInput = {
        UserPoolId: physicalId,
      };

      if (properties['Policies']) {
        const sdkPolicies = this.toSdkUserPoolPolicies(
          properties['Policies'] as Record<string, unknown>
        );
        if (sdkPolicies) {
          updateParams.Policies = sdkPolicies;
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

      // Schema (custom attributes): UpdateUserPool does NOT accept Schema, so a
      // template that adds a custom attribute on redeploy would otherwise be a
      // silent drop (the deploy reports success, AWS keeps the old schema, and
      // the next diff sees the change again with nothing applied). AWS lets you
      // ADD custom attributes in place via AddCustomAttributes, but it cannot
      // modify or remove an existing one. Reconcile the added attributes here;
      // reject a removal / modification of an existing attribute with a typed
      // error (replacement required).
      await this.reconcileSchemaCustomAttributes(
        logicalId,
        physicalId,
        resourceType,
        properties['Schema'] as SchemaAttributeType[] | undefined,
        previousProperties['Schema'] as SchemaAttributeType[] | undefined
      );

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
      // Same derivation as the create path (issue #1745) — the two must agree or
      // an update would rewrite a correct suffix into a commercial-only one.
      const { urlSuffix } = derivePartitionAndUrlSuffix(region);
      const providerName = `cognito-idp.${region}.${urlSuffix}/${physicalId}`;
      const providerUrl = `https://cognito-idp.${region}.${urlSuffix}/${physicalId}`;

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
      // Let the typed immutable-update rejection propagate so the deploy
      // engine's --replace fallback can catch it; wrapping it as a generic
      // ProvisioningError would hide it from that branch. Already-wrapped
      // ProvisioningErrors (e.g. the malformed-Schema guard) pass through
      // unchanged so they are not double-wrapped.
      if (error instanceof ResourceUpdateNotSupportedError || error instanceof ProvisioningError) {
        throw error;
      }
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
   * Reconcile a user pool's Schema custom attributes on update.
   *
   * AWS supports ADDING new custom attributes in place (AddCustomAttributes)
   * but cannot modify or remove an existing attribute. Standard attributes are
   * fully immutable. So:
   *  - attributes present only in the new Schema (and custom) are added;
   *  - removing or modifying an existing attribute, or adding a standard
   *    attribute, requires replacement -> ResourceUpdateNotSupportedError.
   * A byte-identical Schema is a no-op (no AddCustomAttributes call).
   */
  private async reconcileSchemaCustomAttributes(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    newSchema: SchemaAttributeType[] | undefined,
    oldSchema: SchemaAttributeType[] | undefined
  ): Promise<void> {
    const newAttrs = newSchema ?? [];
    const oldAttrs = oldSchema ?? [];

    // A Schema entry with no Name is a malformed template — `byName` below
    // would silently drop it from add/modify/remove detection, so the change
    // would be neither applied nor rejected. Fail loudly instead (CDK synth
    // always emits Name; this only fires on a hand-written L1 template).
    for (const attr of newAttrs) {
      if (attr.Name === undefined) {
        throw new ProvisioningError(
          `Cognito User Pool ${logicalId} has a Schema attribute with no Name — every Schema entry must have a Name`,
          resourceType,
          logicalId,
          physicalId
        );
      }
    }

    const byName = (attrs: SchemaAttributeType[]): Map<string, SchemaAttributeType> => {
      const map = new Map<string, SchemaAttributeType>();
      for (const attr of attrs) {
        if (attr.Name !== undefined) map.set(attr.Name, attr);
      }
      return map;
    };
    const oldByName = byName(oldAttrs);
    const newByName = byName(newAttrs);

    const added: SchemaAttributeType[] = [];
    const modified: string[] = [];
    for (const [name, attr] of newByName) {
      const prev = oldByName.get(name);
      if (!prev) {
        added.push(attr);
      } else if (JSON.stringify(prev) !== JSON.stringify(attr)) {
        modified.push(name);
      }
    }
    const removed = [...oldByName.keys()].filter((n) => !newByName.has(n));

    // Adding a STANDARD attribute (or any removal / modification of an existing
    // one) is not an in-place operation — AddCustomAttributes only adds custom
    // attributes.
    const addedStandard = added
      .filter((a) => a.Name !== undefined && STANDARD_USER_POOL_ATTRIBUTES.has(a.Name))
      .map((a) => a.Name as string);
    const immutableChanges = [
      ...removed.map((n) => `removed attribute '${n}'`),
      ...modified.map((n) => `modified attribute '${n}'`),
      ...addedStandard.map((n) => `added standard attribute '${n}'`),
    ];
    if (immutableChanges.length > 0) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `the Schema change (${immutableChanges.join('; ')}) is immutable on AWS — AWS can only ADD ` +
          `custom attributes in place, so removing or modifying an attribute requires recreating the ` +
          `pool. AWS::Cognito::UserPool is a stateful type, so re-run with ` +
          `cdkd deploy --replace --force-stateful-recreation to recreate it (this deletes all users in the pool)`
      );
    }

    const addedCustom = added.filter(
      (a) => a.Name !== undefined && !STANDARD_USER_POOL_ATTRIBUTES.has(a.Name)
    );
    if (addedCustom.length === 0) return;

    this.logger.debug(
      `Adding ${addedCustom.length} custom attribute(s) to ${physicalId}: ` +
        addedCustom.map((a) => a.Name).join(', ')
    );
    await this.getClient().send(
      new AddCustomAttributesCommand({
        UserPoolId: physicalId,
        CustomAttributes: addedCustom,
      })
    );
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
   *
   * The `aws:cdk:path` tag match that used to ride the same `ListUserPools`
   * walk is gone (issue #1134): AWS rejects `aws:`-prefixed tag writes, so
   * that tag never exists on a real resource and the walk could not match.
   * Auto-mode import resolves ids from CloudFormation's
   * `DescribeStackResources` or the template's physical name; without a
   * `UserPoolName` there is nothing to match.
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
    if (!desiredName) return null;

    // Match the template's UserPoolName against each pool's Name.
    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListUserPoolsCommand({ MaxResults: 60, ...(marker && { NextToken: marker }) })
      );
      for (const pool of list.UserPools ?? []) {
        if (pool.Id && pool.Name === desiredName) {
          return { physicalId: pool.Id, attributes: {} };
        }
      }
      marker = list.NextToken;
    } while (marker);
    return null;
  }
}
