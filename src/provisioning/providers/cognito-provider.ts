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
import { replayWarn, requireConfigString, type ConfigStringOptions } from '../config-shape.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  SecretMasker,
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
 * CFn path every `MfaConfiguration` shape refusal in this provider reports.
 * One constant so the three sites that READ the property -- `create`,
 * `update`, and `narrowMfaConfiguration` (the diff / effectiveProperties
 * side) -- cannot word the same fault differently. `buildMfaConfigRequest`
 * performs no read of its own; it is handed the already-guarded value.
 */
const MFA_CONFIGURATION_PATH = 'AWS::Cognito::UserPool MfaConfiguration';

/**
 * How the template's `MfaConfiguration` reached us, for messages that must not
 * describe the wrong input.
 *
 * `readDeclaredMfaConfiguration` folds `blank` and `refused` into the same
 * empty string -- both take the default -- so the sent value alone can no
 * longer tell them apart, and a message keyed on it would blame the wrong
 * thing. Three arms, not two: `absent` means "add the property", while `blank`
 * and `refused` both mean "repair the one you have", and only `refused`
 * produced a shape-guard warning to refer back to.
 */
type DeclaredMfaConfigurationKind = 'absent' | 'blank' | 'refused' | 'usable';

function classifyDeclaredMfaConfiguration(raw: unknown): DeclaredMfaConfigurationKind {
  if (raw === undefined) return 'absent';
  if (typeof raw !== 'string') return 'refused';
  return raw.trim() === '' ? 'blank' : 'usable';
}

/**
 * Read the template's `MfaConfiguration` through the shape guard AND fold a
 * TRIMMED-BLANK value to absence.
 *
 * The fold is the load-bearing half. `requireConfigString` short-circuits on
 * `fallback === '' && typeof value === 'string'` (config-shape.ts), so against
 * the blank fallback this site uses it returns ANY string verbatim --
 * including `'   '`. That value is truthy, so it rode the
 * `if (mfaConfiguration && ...)` gates onto `CreateUserPool` / `UpdateUserPool`
 * and the `|| default` in `buildMfaConfigRequest` onto `SetUserPoolMfaConfig`,
 * where AWS rejects the enum and the deploy fails -- while the blank-value
 * warning promised "the pool deploys with the default MFA configuration
 * instead". Two spellings of blank behaved differently and the message
 * described only one of them.
 *
 * Folding here rather than widening the guard keeps the change local to the
 * one site whose fallback is blank, and makes the wire behavior match what the
 * warning says: a blank declares nothing, so the default applies.
 *
 * Every read site MUST go through this, including `narrowMfaConfiguration` --
 * a diff side that folded differently from the wire is the phantom drift this
 * whole mechanism exists to remove.
 */
function readDeclaredMfaConfiguration(raw: unknown, options: ConfigStringOptions): string {
  const value = requireConfigString(raw, '', MFA_CONFIGURATION_PATH, options);
  return value.trim() === '' ? '' : value;
}

/**
 * Depth cap for the pre-stringify secret walk in {@link buildMfaConfigRequest}.
 *
 * Only a guard against a self-referential bag, not a real bound: a resolved
 * `EnabledMfas` is a list of factor-name scalars, so the walk never reaches
 * depth 2 on any shape this warning exists to describe. Deliberately generous
 * so no plausible mis-shape is left unmasked by it.
 */
const MASK_WALK_MAX_DEPTH = 8;

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
  blank: boolean;
} {
  const raw = properties['EnabledMfas'];
  if (Array.isArray(raw)) {
    const factors = raw as string[];
    return { factors, declaresFactor: factors.length > 0, malformed: false, blank: false };
  }
  // `null` / `''` are absence, not a mis-shaped declaration: the intrinsic
  // resolver deletes `AWS::NoValue` keys outright rather than emitting null, so
  // a literal null is "explicitly nothing", and an empty string declares no
  // factor either. Treating them as intent would fire a spurious
  // SetUserPoolMfaConfig and turn a previously-working deploy into a hard AWS
  // rejection. This matches the truthy gating used for every sibling string
  // property below.
  //
  // `blank` reports the EMPTY-STRING half of that absence separately (issue
  // #1932). It stays absence on the wire — nothing about the request changes —
  // but a MANGLED-but-intended declaration collapses to exactly this shape (a
  // broken `Fn::Join`, or a `String` parameter left empty), and it is the one
  // mis-shape that produced no message at all. `null` is deliberately NOT
  // reported: per the paragraph above the resolver never emits it for an
  // omitted key, so a literal null is an explicit "nothing" rather than a
  // collapse, and warning on it would fire on a hand-written template that
  // means what it says.
  const malformed = raw !== undefined && raw !== null && raw !== '';
  return { factors: undefined, declaresFactor: malformed, malformed, blank: raw === '' };
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
 * `SetUserPoolMfaConfig` is a full-replace of the pool's MFA state, and AWS
 * reads an omitted `MfaConfiguration` as OFF. That splits into two MUTUALLY
 * EXCLUSIVE arms — both MEASURED against THIS API, not read off
 * `UpdateUserPool`'s blanket reset sentence, which holds only field by field:
 *
 * - WITH a per-factor sub-block in the request, AWS REJECTS the call: nothing
 *   is reset, and the deploy FAILS.
 * - WITHOUT one, AWS accepts the call and the pool is silently reset to
 *   MFA-disabled.
 *
 * Use the template's `MfaConfiguration`
 * when present; when the template omitted it, default by whether this call
 * enables an MFA FACTOR — `OPTIONAL` if it does, `OFF` (CloudFormation's own
 * default) if it does not. The body comment on that decision explains why both
 * halves of the factor test are load-bearing.
 *
 * `declaredMfaConfiguration` is the caller's ALREADY-GUARDED read of
 * `properties['MfaConfiguration']` (issue #1925 item 2), with `''` meaning
 * "the template declared none, or declared a value the shape guard refused".
 * The read happens at the caller so it runs ONCE per deploy path — the value
 * is also needed for the `CreateUserPool` / `UpdateUserPool` forward — and so
 * the create path can REFUSE a malformed value while the update path only
 * warns, which is the split `requireConfigString`'s `onUnusable` encodes.
 *
 * `maskSecrets` is the caller's secret masker (issue #1932 item 3), threaded
 * from `CreateContext` / `UpdateContext` — see `SecretMaskingContext` in
 * `src/types/resource.ts`. Every warning below is routed through it because
 * they name RESOLVED property values: by the time a provider is called a
 * `{{resolve:secretsmanager:...}}` scalar is already plaintext, and cdkd's
 * other two masking boundaries (the deploy engine's error/reason text and the
 * resolver's debug line) do not cover a provider's own `logger.warn`.
 *
 * Typed as the contract's own `SecretMasker`, imported from
 * `src/types/resource.ts` (which re-exports it for exactly this reason, the
 * same way it re-exports `DeleteContext`). An earlier draft re-declared it
 * structurally as `(text: string) => string` on a layering argument — keeping
 * `src/provisioning/**` clear of `src/deployment/secret-redaction.ts` — but
 * `types/resource.ts` already crosses that boundary with a type-only import,
 * so the re-declaration bought nothing and left the provider's parameter type
 * free to drift from the contract. The layering argument survives where it is
 * still true: providers import from `types/resource.ts`, never from the
 * deployment module, and never the secrets BAG. It defaults to IDENTITY so the
 * diff-side caller (`resolveSentMfaConfiguration`) and every unit test keep
 * working unchanged.
 */
function buildMfaConfigRequest(
  physicalId: string,
  properties: Record<string, unknown>,
  logger?: { warn: (message: string) => void },
  declaredMfaConfiguration = '',
  maskSecrets: SecretMasker = (text) => text
): SetUserPoolMfaConfigCommandInput | undefined {
  const {
    factors: enabledMfas,
    declaresFactor,
    malformed: enabledMfasMalformed,
    blank: enabledMfasBlank,
  } = readEnabledMfas(properties);
  // ONE masked sink for every warning in this function (issue #1932 item 3),
  // rather than a `maskSecrets(...)` at each `logger?.warn` call: a warning
  // added later is then masked by construction instead of by the author
  // remembering.
  //
  // This is the OUTER of two layers, and it is deliberately not the only one.
  // A finished message is always longer than the value inside it, so it can
  // only ever reach `maskSecretsInText`'s SUBSTRING arm, which ignores needles
  // below `MIN_NEEDLE_LENGTH` (4). A 1-3 character secret therefore survives
  // this sink. `maskLeaf` below is the inner layer: it hands the masker the raw
  // string, which reaches the WHOLE-VALUE arm at any length. Neither layer
  // subsumes the other — the sink catches a secret embedded in a structure and
  // any interpolation added later, the leaf pass catches the short ones — and
  // the mask is idempotent, so applying both is free.
  const warn = (message: string): void => logger?.warn(maskSecrets(message));
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
  // the pool to OFF, which would disable the very factors we are enabling.
  //
  // That is a property of THIS API, MEASURED (us-east-1, 2026-08-19, issue
  // #1968) — it is NOT the `UpdateUserPool` blanket "unspecified parameters are
  // set to their default value" sentence, which holds only field by field (the
  // ledger is in `readLiveMfaConfiguration`). On a pool sitting at
  // MfaConfiguration ON with software-token enabled: a bare
  // SetUserPoolMfaConfig carrying only the pool id reset it to OFF and dropped
  // SoftwareTokenMfaConfiguration, while the same omission WITH a factor
  // sub-block was rejected outright — `InvalidParameterException: Invalid MFA
  // configuration given, can't turn off MFA and configure an MFA together`,
  // whose wording is AWS itself confirming it read the absent field as "turn
  // off". The sub-block case therefore fails loudly rather than shipping a
  // silently MFA-disabled pool; threading the value is what avoids both.
  //
  // Reproduced 2026-08-19 with an EXPLICIT `MfaConfiguration: OFF` instead of
  // an omitted one -- same rejection, same message, for every member of
  // `anyFactorBlock`. That transcript lives at the pinned-OFF warning below,
  // which is the site it decides. `readLiveMfaConfiguration`'s ledger carries
  // this API in a SECTION OF ITS OWN: `SetUserPoolMfaConfig` and
  // `UpdateUserPool` are different APIs with different rules, and neither
  // list licenses a claim about the other.
  //
  // So thread the template's value, and when the template omitted it, default by
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
  //    it is the one sub-block the first half does not already imply. Keeping
  //    it on OPTIONAL is now MEASURED-correct rather than merely untested:
  //    `{MfaConfiguration: OFF, EmailMfaConfiguration: {...}}` is REJECTED by
  //    AWS (2026-08-19, issue #1968 — the same exclusion message every other
  //    factor block draws under OFF), so flipping this shape to OFF would turn
  //    a deploy that works into one that fails. Issue #1920 proposed keying on
  //    EnabledMfas alone, which WOULD have flipped it. Only the under-OFF
  //    ACCEPTANCE question is settled; what issue #1923 still tracks is the
  //    SES-account verification the INTEG needs to exercise email-OTP end to
  //    end, which is unchanged.
  //
  // Note SmsMfaConfiguration / SoftwareTokenMfaConfiguration are deliberately
  // NOT tested here: both are only ever set inside a `factors.has(...)` guard,
  // so each is strictly implied by the first half. Including them would read as
  // defensive but no input could make them decisive, and no test could fail on
  // their removal.
  const enablesMfaFactor = declaresFactor || request.EmailMfaConfiguration !== undefined;
  // `||` rather than `??`: the caller's guarded read reports BOTH an absent
  // template value and a refused one as `''`, and both must take the default.
  // Before issue #1925 this was a `??` over the raw property, so a declared
  // `MfaConfiguration: ''` went on the wire verbatim (`''` is not nullish) and
  // a declared `null` silently took the default — which for a pool declaring no
  // factor is OFF, i.e. MFA DISABLED with nothing said.
  request.MfaConfiguration =
    (declaredMfaConfiguration as UserPoolMfaType) || (enablesMfaFactor ? 'OPTIONAL' : 'OFF');

  // Reaching this line means `hasMfaConfigProps` was true. With `EnabledMfas`
  // blank that predicate cannot have been satisfied by `EnabledMfas` itself
  // (a blank one declares no factor), so ANOTHER MFA-routed property is
  // present — which is exactly the condition issue #1932 item 1 scopes the
  // warning to. Placed after the line above so the message can state the value
  // actually being sent, matching the dropped-entry warning below.
  if (enabledMfasBlank) {
    warn(
      `UserPool ${physicalId}: EnabledMfas is an empty string, which declares no MFA factor and ` +
        `is treated as absent — a mangled Fn::Join or an empty String parameter collapses to ` +
        `this shape. Nothing is enabled from it and MfaConfiguration is ` +
        `${request.MfaConfiguration}; declare the factor names as a list (e.g. ` +
        `["${MFA_FACTOR_SOFTWARE_TOKEN}"]) if a factor was intended.`
    );
  }

  const anyFactorBlock =
    request.SmsMfaConfiguration !== undefined ||
    request.SoftwareTokenMfaConfiguration !== undefined ||
    request.EmailMfaConfiguration !== undefined;

  // Issue #1932 item 2: a RECOGNIZED factor is configured AND MfaConfiguration
  // is OFF, so the pool ships with the factor set up and MFA disabled — the
  // same "declared a factor, got no MFA" surprise the dropped-entry warning
  // below exists to surface, reached through a template that is otherwise
  // valid.
  //
  // Keyed on `anyFactorBlock` ALONE, deliberately, and NOT on `declaresFactor`.
  // The issue scopes this arm to a RECOGNIZED factor, and `declaresFactor` is
  // also true for a MIS-SHAPED `EnabledMfas` (a YAML scalar / String-param
  // ref), which emits no block: including it made this fire alongside the
  // dropped-entry warning below and CONTRADICT it, since that one correctly
  // reports the entry as enabling nothing. `anyFactorBlock` is exactly the
  // recognized set — every factor sub-block is set inside a `factors.has(...)`
  // guard, and `EmailMfaConfiguration` additionally covers a bare
  // message/subject customization — so the two warnings now partition the
  // cases instead of overlapping.
  //
  // It also still implies the value was PINNED rather than defaulted: an
  // emitted block makes `enablesMfaFactor` true, whose default is OPTIONAL, so
  // OFF here can only have come from the template. No explicit "was it
  // declared" test is needed and adding one could not change any outcome.
  //
  // MEASURED us-east-1 2026-08-19 (issue #1968): AWS REJECTS every request in
  // which a factor block rides alongside `MfaConfiguration: OFF`, with
  // `InvalidParameterException: Invalid MFA configuration given, can't turn off
  // MFA and configure an MFA together`:
  //
  //   {ON,  SoftwareTokenMfaConfiguration: {Enabled: true}}   -> ACCEPTED (control)
  //   {OFF, SoftwareTokenMfaConfiguration: {Enabled: true}}   -> rejected
  //   {OFF, SoftwareTokenMfaConfiguration: {Enabled: false}}  -> rejected
  //   {OFF, EmailMfaConfiguration: {Message, Subject}}        -> rejected
  //
  // The `Enabled: false` arm is what settles the KEY: a block that enables
  // nothing is still refused, so the rule is about the block's PRESENCE, which
  // is exactly what `anyFactorBlock` tests. `anyFactorBlock` is precisely
  // {Sms, SoftwareToken, Email}MfaConfiguration, so no accepted case survives.
  //
  // Qualifier, stated because it bounds the EmailMfaConfiguration arm: an
  // OPTIONAL control with that block on the same pool failed with a DIFFERENT
  // error ("Cannot set EmailMfaConfiguration when user pool EmailConfiguration
  // contains an EmailSendingAccount of COGNITO_DEFAULT"), so there was no clean
  // isolated control for it. That divergence is itself informative -- the
  // exclusion rule is evaluated BEFORE the email-sending-account check, which
  // is why the OFF rejection is the exclusion and not an email-config artifact
  // -- but the arm rests on the shared message, not on a control of its own.
  //
  // So the outcome is a DEPLOY FAILURE, not a silently MFA-disabled pool. The
  // earlier message claimed the latter; it was wrong, and issue #1968 replaced
  // it with the line below.
  //
  // STILL A WARNING, never a refusal -- but no longer because it is "correct
  // under either answer", since there is only one answer now. It earns its
  // place by firing BEFORE the call and naming the one-line fix, which the raw
  // AWS error does not, while leaving the request untouched so cdkd is not the
  // thing deciding a template is invalid. Promoting it to a pre-flight refusal
  // is a behavior change needing its own integ and review round, and is filed
  // separately rather than done here.
  if (request.MfaConfiguration === 'OFF' && anyFactorBlock) {
    warn(
      `UserPool ${physicalId}: MfaConfiguration is pinned to OFF while an MFA factor block is ` +
        `configured. AWS REJECTS that combination ("Invalid MFA configuration given, can't ` +
        `turn off MFA and configure an MFA together"), so this deploy FAILS rather than ` +
        `producing a pool with MFA disabled. Remove MfaConfiguration (or set it to ON / ` +
        `OPTIONAL) to enable the declared factor.`
    );
  }

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
  //
  // Both halves of `dropped` are RESOLVED property values -- the unrecognized
  // members come out of `EnabledMfas`, and the `(not a list)` entry is the
  // whole property -- so both are masked, by the shared `warn` sink at the
  // bottom of this block rather than here (issue #1932 item 3).
  //
  // NO LENGTH CAP, and that is a decision rather than an omission: the issue
  // offered a cap as an alternative to (or alongside) the mask, and it buys
  // nothing here. A cap is not a confidentiality control -- a SHORT secret
  // survives it untouched, which is the realistic content of an MFA-factor
  // enum field, while a LONG value it truncates was one the masker already
  // judged not to be a secret. What it does cost is exactly this warning's
  // job: naming the offending entry so the user can find it in the template.
  // Truncating the one string the message exists to show, to guard against a
  // log-volume problem that an enum-valued field does not have, is a net loss.
  // If a cap is ever wanted it belongs at the logger, applied to every line,
  // not hand-rolled into one provider's warning.
  //
  // `maskDeep` runs BEFORE `JSON.stringify`, and that ordering is the whole
  // point rather than a tidiness preference. The `warn` sink alone CANNOT mask
  // these, for two independent reasons:
  //
  //  1. ESCAPING. `JSON.stringify` escapes `"`, `\` and newlines, so a secret
  //     containing any of them no longer OCCURS in the finished line and the
  //     sink's substring scan cannot find it. That is not an exotic case: it
  //     is every Secrets Manager JSON document, the commonest real secret
  //     shape. Measured on the pre-fix code: a plaintext of
  //     `super"secret-plaintext-value` came through the sink completely
  //     unchanged.
  //  2. LENGTH. The sink only ever sees a string longer than the value inside
  //     it, so it can only reach `maskSecretsInText`'s SUBSTRING arm, which
  //     ignores needles below `MIN_NEEDLE_LENGTH` (4). Handing the masker the
  //     RAW value reaches the WHOLE-VALUE arm, which has no floor.
  //
  // So the sink is the fallback and this is the primary pass; neither subsumes
  // the other (the sink still covers interpolations added later, and text this
  // walk never sees).
  //
  // It WALKS rather than testing `typeof v === 'string'` at the top level,
  // because `EnabledMfas` can be an object or an array of them and a secret
  // nested inside one is stringified — and therefore escaped — exactly the
  // same way. Keys are masked too: they are stringified into the message
  // alongside the values. The depth cap keeps a self-referential bag from
  // hanging here; `JSON.stringify` below would throw on one anyway, and a hang
  // is a worse failure than the throw this preserves.
  const maskDeep = (v: unknown, depth = 0): unknown => {
    if (typeof v === 'string') return maskSecrets(v);
    if (depth >= MASK_WALK_MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map((e) => maskDeep(e, depth + 1));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          maskSecrets(k),
          maskDeep(x, depth + 1),
        ])
      );
    }
    return v;
  };
  const dropped: string[] = unrecognizedFactors.map(
    (f) => JSON.stringify(maskDeep(f)) ?? String(f)
  );
  if (enabledMfasMalformed) {
    dropped.push(`${JSON.stringify(maskDeep(properties['EnabledMfas']))} (not a list)`);
  }
  if (dropped.length > 0) {
    // FOUR outcomes, not three. Splitting only on OFF made the second arm claim
    // a rejection that does not happen whenever a RECOGNIZED factor rides
    // alongside the dropped entry: the request carries that factor's block, so
    // the dropped entry is not what fails the call. That is the silent-drop
    // case this warning exists to surface, so telling the user to expect a hard
    // failure there is the worst thing it could say. The arm says
    // a block IS SENT rather than that a factor IS ENABLED, because that is all
    // this code knows -- e.g. SMS_MFA without SmsConfiguration sends a block
    // AWS then rejects. (`anyFactorBlock` is hoisted above, shared with the
    // pinned-OFF warning -- one definition of "a factor block IS sent" so the
    // two messages cannot disagree about the same request.)
    // The OFF case splits again on that same flag, because its two halves have
    // OPPOSITE outcomes and the measurement (2026-08-19, issue #1968) covers
    // only one of them: OFF WITH a block is REJECTED by AWS, while OFF with no
    // block is accepted and really does deploy an MFA-disabled pool. Unsplit,
    // the OFF arm contradicted the pinned-OFF warning -- which fires on exactly
    // the OFF-plus-block request and now says "rejected" -- and that
    // disagreement is what sharing `anyFactorBlock` exists to prevent.
    const consequence =
      request.MfaConfiguration === 'OFF' && anyFactorBlock
        ? `MfaConfiguration is OFF while another factor block IS sent, so AWS REJECTS this ` +
          `call outright and the deploy fails`
        : request.MfaConfiguration === 'OFF'
          ? `MfaConfiguration is OFF, so this pool deploys with MFA DISABLED`
          : anyFactorBlock
            ? `MfaConfiguration is ${request.MfaConfiguration} and another factor block IS ` +
              `sent, so these entries are silently ignored rather than failing the call on ` +
              `their own`
            : `MfaConfiguration is ${request.MfaConfiguration} with no factor enabled, so AWS ` +
              `rejects this call rather than deploying the pool with MFA disabled`;
    warn(
      `UserPool ${physicalId}: EnabledMfas entries ${dropped.join(', ')} do not map to an MFA ` +
        `factor block (known: ${MFA_FACTOR_SMS}, ${MFA_FACTOR_SOFTWARE_TOKEN}, ` +
        `${MFA_FACTOR_EMAIL_OTP}); no factor is enabled from them. ${consequence}.`
    );
  }

  return request;
}

/**
 * The `MfaConfiguration` cdkd actually SENDS for this bag, or `undefined` when
 * no call carries the field at all (nothing declared and no MFA-routed
 * property, so AWS applies its own default of OFF).
 *
 * Exactly one call ever carries it: `SetUserPoolMfaConfig` owns it whenever any
 * MFA-routed property is present -- and always sets it, because that API is a
 * full replace -- otherwise the `CreateUserPool` / `UpdateUserPool` forward
 * carries it, and only when it is non-blank.
 *
 * Delegates to {@link buildMfaConfigRequest} rather than re-deriving the
 * OPTIONAL/OFF default, so the recorded value and the wire value cannot
 * disagree. That function is pure and synchronous, which is what lets
 * `canonicalizeDesiredProperties` -- which runs inside the diff -- call it too.
 * The empty `physicalId` and absent logger are unused on this path: every
 * message it can emit is behind `logger?.`, so passing none makes the call
 * silent, which is required of the diff side.
 */
function resolveSentMfaConfiguration(
  properties: Record<string, unknown>,
  declaredMfaConfiguration: string
): string | undefined {
  const request = buildMfaConfigRequest('', properties, undefined, declaredMfaConfiguration);
  if (request) return request.MfaConfiguration;
  return declaredMfaConfiguration || undefined;
}

/**
 * Replace a DECLARED-but-unusable `MfaConfiguration` with the value cdkd
 * actually sends, or drop the key when nothing is sent. Returns the input
 * object unchanged when nothing applies, so the common case compares
 * byte-for-byte as before.
 *
 * ONE helper feeding BOTH sides of the decision, per `.claude/rules/
 * providers.md`: the provisioning path returns it as `effectiveProperties` so
 * STATE describes what AWS holds, and `canonicalizeDesiredProperties` applies
 * it to the DESIRED bag so the next diff compares the same thing. Shipping
 * only the first half is worse than shipping neither -- the template would keep
 * declaring the malformed value, and every later deploy would read the
 * narrowing back as a user-made change.
 *
 * Without this, all three substitution arms (the replay-CREATE downgrade, the
 * update-path warn-and-default, and the blank-string default) recorded the
 * declared `null` / `''` while AWS held `OPTIONAL` / `OFF` -- permanent phantom
 * drift that `cdkd drift --revert` re-issues forever with nothing to apply.
 *
 * A value that is merely ABSENT is deliberately NOT filled in. Reaching for
 * `effectiveProperties` is licensed only where the provider KNOWS it
 * substituted something it was told, and an omitted property was never a
 * declaration to contradict; writing the resolved default into the DESIRED
 * baseline there would also disable the #1160 absent-field removal derivation,
 * which reads that side.
 */
function narrowMfaConfiguration(properties: Record<string, unknown>): Record<string, unknown> {
  const raw = properties['MfaConfiguration'];
  if (raw === undefined) return properties;
  // A silent callback, matching `EC2Provider.canonicalizeDesiredProperties`: a
  // diff must not throw, and must not warn either -- the provisioning path
  // announces the identical substitution, and warning here would emit it a
  // second time for a resource nothing is changing.
  const declared = readDeclaredMfaConfiguration(raw, { onUnusable: () => {} });
  const sent = resolveSentMfaConfiguration(properties, declared);
  if (sent === raw) return properties;
  if (sent === undefined) {
    // Copy-and-`delete` rather than a rest-destructure: the
    // handled-property-wiring walk recognizes a `{ X, ...rest }` destructure as
    // a property READ, and the repo pins that recognizer at zero real-tree
    // instances so it can never become the only evidence for a property (see
    // `gen-handled-property-wiring.test.ts`). Same result, no new instance.
    const withoutMfaConfiguration = { ...properties };
    delete withoutMfaConfiguration['MfaConfiguration'];
    return withoutMfaConfiguration;
  }
  return { ...properties, MfaConfiguration: sent };
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

  /**
   * Warn when `MfaConfiguration` is declared as a BLANK string (issue #1925
   * item 2, review round 2).
   *
   * `requireConfigString` accepts any string against a blank fallback, so `''`
   * passes the shape guard and is then substituted by the OPTIONAL/OFF default
   * downstream. That is the exact silent-default class the guard exists to
   * kill, reached one shape further in: on main a WebAuthn-only pool declaring
   * `MfaConfiguration: ''` failed LOUDLY with an AWS enum rejection, and with
   * the guard alone it would deploy MFA OFF with no message anywhere. A
   * collapsed `Fn::Join` or an empty `String` parameter produces exactly this.
   *
   * The twin of the blank-`EnabledMfas` warning one property over, and warned
   * for the same reason it is: the value stays absence ON THE WIRE (the
   * substitution is what CloudFormation's own default does), so only the
   * silence is removed.
   *
   * `.trim()` matches the fold in {@link readDeclaredMfaConfiguration}, and the
   * two must agree: `requireConfigString` does NOT treat whitespace-only as
   * blank against the blank fallback this site uses, so before that fold a
   * `'   '` was warned about here and then sent to AWS verbatim -- this message
   * describing a default that never applied.
   */
  private warnOnBlankMfaConfiguration(raw: unknown): void {
    if (typeof raw !== 'string' || raw.trim() !== '') return;
    this.logger.warn(
      `AWS::Cognito::UserPool MfaConfiguration is an empty string, which declares no MFA mode ` +
        `and is treated as absent -- a collapsed Fn::Join or an empty String parameter ` +
        `produces this shape. The pool deploys with the default MFA configuration instead; ` +
        `declare ON / OPTIONAL / OFF explicitly, or omit the property, to say which was meant.`
    );
  }

  /**
   * The DIFF-side half of the `MfaConfiguration` substitution record.
   *
   * Applied by `DiffCalculator` to BOTH comparison sides, so a template that
   * declares a malformed / blank `MfaConfiguration` compares equal to the state
   * record holding the value cdkd actually sent for it. Without this half, the
   * `effectiveProperties` above would make every later deploy read the
   * substitution back as a user-made change and re-run the update forever.
   *
   * Shares ONE helper with the provisioning path rather than re-deriving the
   * rule, per `.claude/rules/providers.md` -- state and template narrowed by
   * different code is how this fix would become the bug.
   */
  canonicalizeDesiredProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::Cognito::UserPool') return properties;
    return narrowMfaConfiguration(properties);
  }

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
   * factors) was silently dropped before issue #1380, so a template that
   * declared -- or later CHANGED -- the allowed first-auth factors never
   * reached AWS at all.
   *
   * **Forwarding is what APPLIES a declared value; it is NOT what keeps an
   * existing one alive.** The original rationale here was AWS's blanket "if
   * you don't provide a value for an attribute, Amazon Cognito sets it to its
   * default value", i.e. that omitting `SignInPolicy` would WIPE it. MEASURED
   * us-east-1 2026-08-19 (issue #1968), on a pool created with
   * `SignInPolicy.AllowedFirstAuthFactors = [PASSWORD, EMAIL_OTP]` on the
   * default `ESSENTIALS` tier -- no explicit `UserPoolTier` was needed for the
   * field to be settable:
   *
   * - `UpdateUserPool` sending `Policies` with ONLY `PasswordPolicy` left
   *   `SignInPolicy` at `[PASSWORD, EMAIL_OTP]`. Control: that same call's
   *   `--auto-verified-attributes email` applied, so the update really ran.
   * - `UpdateUserPool` omitting `Policies` entirely left BOTH sub-keys intact
   *   (a non-default `RequireSymbols: false` survived too), while
   *   `AutoVerifiedAttributes` reset from `[email]` to none in that very call
   *   -- the control proving the omission was processed, not ignored.
   * - An explicit `SignInPolicy` write landed in both directions
   *   (`[PASSWORD]`, then back to `[PASSWORD, EMAIL_OTP]`), so the field is
   *   reachable and writable here rather than silently dropped.
   * - The MIRROR image holds too, so the ledger entry is measured rather than
   *   generalised from one sub-key: a container carrying ONLY `SignInPolicy`
   *   updated it to `[PASSWORD, WEB_AUTHN]` while leaving a non-default
   *   `PasswordPolicy` (`MinimumLength: 12`, `RequireSymbols: false`) intact,
   *   with the same `--auto-verified-attributes` control.
   *
   * So the forwarding stays -- it is the only way a CHANGED sign-in policy is
   * applied -- but on the measured reason, not the blanket sentence. Do not
   * generalise that sentence to another field from this site: see
   * `readLiveMfaConfiguration`'s docstring, which carries the one ledger of
   * which fields were measured to reset and which were not.
   *
   * **Consequence of that measurement, NOT fixed here: there is no removal
   * path.** This builder forwards only what the template DECLARES, so deleting
   * `SignInPolicy` from a template sends nothing for it -- and nothing sent
   * means nothing changed. A user tightening their auth by removing a
   * passwordless first-auth factor therefore leaves it live on the pool
   * indefinitely, and `readCurrentState` keeps reporting a drift that
   * `cdkd drift --revert` cannot clear, since the revert routes through this
   * same builder. Clearing it needs an explicit reset value on the wire, which
   * is a behavior change with its own integ and is out of this lane's scope.
   * Whether CloudFormation removes it on the same template edit is UNMEASURED
   * -- do not assume parity in either direction.
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
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Cognito User Pool ${logicalId}`);

    const poolName =
      (properties['UserPoolName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 128 });

    // The shape guard for `MfaConfiguration` (issue #1925 item 2). A declared
    // `null` / `[]` / `{Ref: ...}` used to slip past the `as UserPoolMfaType`
    // cast, fail the truthy gate below, and be forwarded nowhere — so the pool
    // came up with AWS's own default of MFA OFF, which is frequently the
    // OPPOSITE of what the template declared. The reverse-replacement rollback
    // creates from a STATE record, so the refusal downgrades to a warning
    // there (`replayWarn`) — the user has no template-side remedy for a value
    // an older binary recorded.
    //
    // The fallback is `''` rather than a real default so the guard reports
    // ONLY the malformed shapes: with a blank fallback `requireConfigString`
    // accepts any string (including `''`, which the truthy gates below then
    // treat as absent, unchanged from before) and refuses everything else.
    //
    // Wrapped the way `DynamoDBGlobalTableProvider`'s `BillingMode` guard is:
    // the read sits OUTSIDE `create()`'s try, so an unwrapped throw would
    // escape untyped into the deploy engine's retry loop. It stays outside so
    // the refusal cannot be mis-reported as an AWS creation failure, and so it
    // runs before `CreateUserPool` — nothing to roll back.
    let mfaConfiguration: string;
    try {
      mfaConfiguration = readDeclaredMfaConfiguration(
        properties['MfaConfiguration'],
        replayWarn(this.logger, context)
      );
      this.warnOnBlankMfaConfiguration(properties['MfaConfiguration']);
    } catch (error) {
      throw new ProvisioningError(
        error instanceof Error ? error.message : String(error),
        resourceType,
        logicalId,
        poolName,
        error instanceof Error ? error : undefined
      );
    }

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
      if (mfaConfiguration && !hasMfaConfigProps(properties)) {
        createParams.MfaConfiguration = mfaConfiguration as UserPoolMfaType;
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
      await this.applyMfaConfig(userPoolId, properties, mfaConfiguration, {
        // Issue #1932 item 3. Conditional spread because
        // `exactOptionalPropertyTypes` rejects an explicit `undefined` here.
        ...(context?.maskSecrets && { maskSecrets: context.maskSecrets }),
      });

      this.logger.debug(`Successfully created Cognito User Pool ${logicalId}: ${userPoolId}`);

      // Record what was SENT, not what the template declared, whenever the
      // guard substituted (see `narrowMfaConfiguration`). Reachable on create
      // only via the reverse-replacement replay -- a template-path create with
      // a refused value throws above -- plus the blank-string arm, which is
      // reachable from a template.
      const effectiveProperties = narrowMfaConfiguration(properties);

      return {
        physicalId: userPoolId,
        attributes: {
          Arn: userPoolArn,
          ProviderName: providerName,
          ProviderURL: providerUrl,
          UserPoolId: userPoolId,
        },
        ...(effectiveProperties !== properties ? { effectiveProperties } : {}),
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
   *
   * `options.maskSecrets` is the caller's secret masker (issue #1932 item 3),
   * forwarded straight to {@link buildMfaConfigRequest} where every warning is
   * routed through it. Both `create()` and `update()` supply it from their own
   * context, so the two paths cannot diverge on whether a resolved value is
   * masked. Absent (an older caller, a test, a provider invoked directly) means
   * unmasked, exactly as before.
   */
  private async applyMfaConfig(
    physicalId: string,
    properties: Record<string, unknown>,
    declaredMfaConfiguration: string,
    options: {
      liveMfaConfiguration?: string;
      liveReadFailed?: boolean;
      declaredKind?: DeclaredMfaConfigurationKind;
      maskSecrets?: SecretMasker;
    } = {}
  ): Promise<void> {
    const request = buildMfaConfigRequest(
      physicalId,
      properties,
      this.logger,
      declaredMfaConfiguration,
      // `?? identity` rather than a conditional spread on the call: the
      // parameter has a default, but passing `undefined` explicitly would
      // ALSO take it, so this is belt-and-braces and reads at the call site.
      options.maskSecrets ?? ((text) => text)
    );
    if (!request) return;

    await this.retryOnTransientControlPlane(
      () => this.getClient().send(new SetUserPoolMfaConfigCommand(request)),
      `SetUserPoolMfaConfig(${physicalId})`
    );

    // Reported AFTER the call, so the past tense is true. Emitted before it,
    // these lines asserted an OFF that never landed whenever
    // SetUserPoolMfaConfig failed -- cosmetic, since the deploy then fails
    // loudly, but a log line that describes a state AWS never reached is the
    // kind of thing a later reader trusts.
    this.reportMfaConfigurationOff(physicalId, request, declaredMfaConfiguration, options);
  }

  /**
   * Say so when this deploy sends `MfaConfiguration=OFF` without the template
   * having asked for OFF (issue #1925, third item).
   *
   * Everything here keys on the BUILT request, so there is exactly one
   * definition of "this deploy resolves to OFF", and on `declaredMfaConfiguration
   * === ''`, i.e. the template did not pin a usable value. `create()` passes
   * neither a live value nor a `declaredKind`, so it reports nothing -- correct,
   * since a fresh pool has no value to downgrade.
   *
   * Three outcomes rather than one, because the live value can be KNOWN,
   * known-and-harmless, or UNAVAILABLE, and only the first is a downgrade that
   * can be named:
   *
   *  - live `ON` / `OPTIONAL` -- a real downgrade; name the value being lost.
   *  - live `OFF` -- not a downgrade at all; say nothing. This is the arm the
   *    live-value test protects, and it is load-bearing in the SILENT
   *    direction: without it every already-OFF pool and every failed probe
   *    warned, the latter reading `live value was undefined`.
   *  - live UNKNOWN (the probe failed) -- the case that made this necessary.
   *    A malformed but TRUTHY value used to reach `UpdateUserPool`, AWS
   *    rejected the enum, MFA stayed as it was and the deploy failed; now the
   *    guard substitutes and the deploy exits 0 with MFA off. On a role lacking
   *    `cognito-idp:GetUserPoolMfaConfig` -- exactly the role this arm exists
   *    for -- the probe returns nothing, so without this the ONLY path that got
   *    quieter than main would say nothing at all.
   */
  private reportMfaConfigurationOff(
    physicalId: string,
    request: SetUserPoolMfaConfigCommandInput,
    declaredMfaConfiguration: string,
    options: {
      liveMfaConfiguration?: string;
      liveReadFailed?: boolean;
      declaredKind?: DeclaredMfaConfigurationKind;
    }
  ): void {
    if (declaredMfaConfiguration !== '' || request.MfaConfiguration !== 'OFF') return;

    // `declaredMfaConfiguration === ''` folds THREE different inputs and they
    // need different sentences: the template omitted the property, declared a
    // blank one, or declared one the shape guard REFUSED. Saying "declares no
    // MfaConfiguration" for the latter two is false -- one WAS declared -- and
    // points the user at adding a property they already have. Only `refused`
    // emitted a shape-guard warning, so only it may refer back to one.
    const kind = options.declaredKind ?? 'absent';
    const cause =
      kind === 'refused'
        ? `the declared MfaConfiguration was refused as malformed (see the warning above), so ` +
          `this update sent MfaConfiguration=OFF instead`
        : kind === 'blank'
          ? `the declared MfaConfiguration is blank, so it is treated as absent and this update ` +
            `sent MfaConfiguration=OFF`
          : `the template declares no MfaConfiguration, so this update sent ` +
            `MfaConfiguration=OFF (CloudFormation's own default)`;
    const remedy = (value: string) =>
      kind === 'absent'
        ? `Declare MfaConfiguration: ${value} in the template to keep it.`
        : `Repair MfaConfiguration to a literal ${value} to keep it.`;

    if (options.liveMfaConfiguration === 'ON' || options.liveMfaConfiguration === 'OPTIONAL') {
      this.logger.warn(
        `UserPool ${physicalId}: ${cause} to a pool whose live value was ` +
          `${options.liveMfaConfiguration} — SetUserPoolMfaConfig is a full replace, so MFA is ` +
          `now OFF. ${remedy(options.liveMfaConfiguration)}`
      );
      return;
    }

    if (options.liveReadFailed !== true) return;

    // The live value could not be read, so whether this was a downgrade is
    // unknowable -- but the OFF is not, and a DECLARED value that could not be
    // used is the shape that turned a loud AWS rejection into a silent
    // MFA-off deploy. Reported for an absent declaration too, one notch softer,
    // since that path is unchanged from main.
    const declaredClause =
      kind === 'absent'
        ? `the template declares no MfaConfiguration`
        : `the declared MfaConfiguration could not be used`;
    this.logger.warn(
      `UserPool ${physicalId}: ${declaredClause}, so this update sent MfaConfiguration=OFF — ` +
        `and the pool's previous MFA setting could not be read, so cdkd cannot say whether that ` +
        `turned MFA off. Grant cognito-idp:GetUserPoolMfaConfig to the deploy role to have this ` +
        `reported precisely. ${remedy('ON or OPTIONAL')}`
    );
  }

  /**
   * Read the pool's live `MfaConfiguration` for the undeclared-downgrade
   * announcement (issue #1925, third item), or `undefined` when it cannot be
   * determined.
   *
   * `SetUserPoolMfaConfig` is a full replace and this provider re-issues it on
   * every update carrying an MFA-routed property, unconditioned on the MFA
   * configuration having CHANGED. So a WebAuthn-only template applied to a pool
   * whose live `MfaConfiguration` is `ON` / `OPTIONAL` — console drift, or a
   * `cdkd import` of an MFA-enabled pool — writes `OFF` on the next unrelated
   * property change. That is defensible template-is-truth / CloudFormation
   * parity and is NOT changed here; only its silence is.
   *
   * **Called BEFORE `UpdateUserPool`, defensively — NOT because AWS resets the
   * field.** MEASURED us-east-1 2026-08-18: a pool at `ON` with software-token
   * enabled keeps `ON` through an `UpdateUserPool` that omits
   * `MfaConfiguration`, confirmed by both `get-user-pool-mfa-config` and
   * `describe-user-pool`, with controls proving the call really ran (a
   * `--auto-verified-attributes` change in the same request applied) and that
   * the field is writable here rather than ignored (an explicit
   * `--mfa-configuration OFF` did reset it). So AWS's blanket "unspecified
   * parameters are set to their default value" holds field by field — and
   * there is no MFA-OFF window to design around.
   *
   * **This paragraph is the single ledger of that field-by-field result; a
   * per-field verdict belongs at that field's own site, pointing here.** Every
   * line below was taken with a control proving the omitting call really ran.
   *
   * `UpdateUserPool`, on omission:
   *
   * - `AutoVerifiedAttributes` — DOES reset when omitted (2026-08-18).
   * - `MfaConfiguration` — does NOT reset when omitted (2026-08-18, above).
   * - `Policies` — neither sub-key resets, measured in BOTH directions
   *   (2026-08-19, issue #1968; details at `toSdkUserPoolPolicies`): a
   *   container sent without `SignInPolicy` left `SignInPolicy` intact, a
   *   container sent without `PasswordPolicy` left `PasswordPolicy` intact,
   *   and omitting the container outright left both. Forwarding is still
   *   REQUIRED to APPLY a changed sub-key — preservation is not application —
   *   and no omission can express a REMOVAL.
   *
   * `SetUserPoolMfaConfig` — a DIFFERENT API with a DIFFERENT rule, kept in
   * its own section so neither list is read as evidence for the other:
   *
   * - `MfaConfiguration` — an omitted value is read as OFF. With a factor
   *   sub-block in the request AWS REJECTS the call; with none it accepts and
   *   resets the pool to MFA-disabled. An EXPLICIT OFF beside a block is
   *   rejected the same way (2026-08-19, issue #1968; the transcript lives at
   *   the pinned-OFF warning in `buildMfaConfigRequest`).
   *
   * Nothing here licenses a claim about a field on neither list, or about one
   * API from the other's section. Measure it.
   *
   * The earlier ordering was reached from that doc sentence alone and is kept
   * only because it is strictly safer and already tested: reading first cannot
   * report a value this same call clobbered, whatever AWS does later. Do not
   * re-derive a redesign from the doc sentence — it has been measured.
   *
   * Best-effort by construction: the read exists only to ANNOUNCE, so a
   * failure must not fail the update the user asked for.
   *
   * **This adds `cognito-idp:GetUserPoolMfaConfig` to the permissions a deploy
   * role wants.** The action was previously needed only by `readCurrentState`
   * (drift / import), so a role scoped to deploying could legitimately lack it.
   *
   * A failure is REPORTED rather than swallowed, but not here: this method's
   * gate is a deliberate SUPERSET of the announcement condition (see the call
   * site in `update()`), so warning at the point of failure fired on templates
   * that structurally cannot downgrade -- an `EnabledMfas` with no
   * `MfaConfiguration` resolves to OPTIONAL, and a least-privileged role saw
   * "cdkd cannot say whether it turns MFA off" on every deploy of it. The flag
   * returned here is consumed by `reportMfaConfigurationOff`, which speaks only
   * where the request actually resolves to OFF.
   */
  private async readLiveMfaConfiguration(
    physicalId: string
  ): Promise<{ value?: string; failed: boolean }> {
    try {
      const live = await this.getClient().send(
        new GetUserPoolMfaConfigCommand({ UserPoolId: physicalId })
      );
      return live.MfaConfiguration !== undefined
        ? { value: live.MfaConfiguration, failed: false }
        : { failed: false };
    } catch (error) {
      // The raw message stays at debug and never reaches the warning built from
      // this flag. It is not neutral text -- an `AccessDeniedException` here
      // reads `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is
      // not authorized to perform: cognito-idp:GetUserPoolMfaConfig ...` -- so
      // a default-verbosity line would print the account id, the role name and
      // the session name, into a warning that is persisted to the events store.
      // Same split as the `dynamodb-index-busy-delete` DescribeTable arm.
      this.logger.debug(
        `GetUserPoolMfaConfig failed for UserPool ${physicalId} ` +
          `(${error instanceof Error ? error.name : typeof error}): ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return { failed: true };
    }
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
   *
   * The `context` parameter is read for ONE thing today: `maskSecrets` (issue
   * #1932 item 3), forwarded to `applyMfaConfig` so the MFA warnings mask a
   * resolved secret the same way they do on the create path. It deliberately
   * does NOT consult `desiredFromAwsReadback` -- this provider has no
   * empty-collection-means-delete shape, so reading that flag would be a
   * behavior change with no motivating case, and the `MfaConfiguration`
   * refusal below stays UNCONDITIONALLY downgraded for the reason its own
   * comment gives (a refusal against a state-borne bag leaves the resource
   * un-rollbackable). Accepting the context does not change that.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Cognito User Pool ${logicalId}: ${physicalId}`);

    // The update-path twin of `create()`'s guard (issue #1925 item 2). The
    // downgrade is UNCONDITIONAL here rather than gated on a replay context —
    // and it stays that way now that `update()` DOES take a context (issue
    // #1932 item 3 added one for `maskSecrets`). Nothing on `UpdateContext`
    // distinguishes a template push from the state-borne bag `cdkd drift
    // --revert` and the rollback executor's revert arm hand it:
    // `desiredFromAwsReadback` is set by `drift --revert` ALONE and is
    // deliberately NOT set by the rollback arms (see its own doc), so gating on
    // it would re-introduce the refusal on exactly the rollback path — and a
    // refusal against a historical state record leaves the resource not merely
    // un-updatable but UN-ROLLBACKABLE, with no template-side remedy. Same
    // shape as `IAMAccessKeyProvider`'s `Status` and
    // `RDSDBProxyTargetGroupProvider`'s `TargetGroupName`.
    const mfaConfiguration = readDeclaredMfaConfiguration(properties['MfaConfiguration'], {
      onUnusable: (message) => this.logger.warn(message),
    });
    this.warnOnBlankMfaConfiguration(properties['MfaConfiguration']);

    // Capture the live MFA configuration BEFORE `UpdateUserPool` can touch it
    // (issue #1925, third item) -- see `readLiveMfaConfiguration` for why the
    // ordering is load-bearing. Gated by a cheap SUPERSET of the announcement
    // condition, built only from predicates that already exist: a template that
    // DECLARED a value is never a defaulted downgrade, and one with no
    // MFA-routed property never reaches `SetUserPoolMfaConfig` at all. Whether
    // the resolved value is actually `OFF` is decided later, off the BUILT
    // request, so the OPTIONAL/OFF default rule is never restated here -- the
    // cost of the looser gate is one extra read on an update that declares a
    // factor without an MfaConfiguration, and the result is simply unused.
    const liveMfa =
      mfaConfiguration === '' && hasMfaConfigProps(properties)
        ? await this.readLiveMfaConfiguration(physicalId)
        : undefined;

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
      // The one field measured to RESET when omitted -- see the ledger in
      // `readLiveMfaConfiguration`. So a template that drops this property
      // really does clear it at AWS, unlike `Policies` above, whose sub-keys
      // survive their own omission.
      if (properties['AutoVerifiedAttributes']) {
        updateParams.AutoVerifiedAttributes = properties[
          'AutoVerifiedAttributes'
        ] as VerifiedAttributeType[];
      }
      // The same `!hasMfaConfigProps` gate the create path applies (issue
      // #1925 item 1). AWS rejects an `UpdateUserPool` carrying ON / OPTIONAL
      // unless a factor is ALREADY enabled on the pool, and the only call that
      // can enable one is the post-update `SetUserPoolMfaConfig` below — so an
      // update that FIRST turns MFA on (`MfaConfiguration: OPTIONAL` +
      // `EnabledMfas`) hit exactly the rejection the create path's comment
      // describes. The forward bought nothing either way: `applyMfaConfig`
      // always sets `MfaConfiguration` on the same update, overwriting it.
      if (mfaConfiguration && !hasMfaConfigProps(properties)) {
        updateParams.MfaConfiguration = mfaConfiguration as UserPoolMfaType;
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
      await this.applyMfaConfig(physicalId, properties, mfaConfiguration, {
        ...(liveMfa?.value !== undefined ? { liveMfaConfiguration: liveMfa.value } : {}),
        ...(liveMfa?.failed === true ? { liveReadFailed: true } : {}),
        declaredKind: classifyDeclaredMfaConfiguration(properties['MfaConfiguration']),
        // The UPDATE twin of the masker `create()` passes (issue #1932 item 3).
        // The two paths reach the SAME `buildMfaConfigRequest` warnings with the
        // same resolved bag, so masking one and not the other would leave the
        // fix conditional on which path a given deploy happens to take.
        ...(context?.maskSecrets && { maskSecrets: context.maskSecrets }),
      });

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

      // The update-path twin of the create-side record (see
      // `narrowMfaConfiguration`). This is the arm that mattered most: every
      // `update()` caller honours `effectiveProperties`, including
      // `cdkd drift --revert` and the rollback executor's revert arms, so
      // without it a `--revert` re-issued the same substitution forever while
      // the record kept describing a value AWS does not hold.
      const effectiveProperties = narrowMfaConfiguration(properties);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: userPool?.Arn,
          ProviderName: providerName,
          ProviderURL: providerUrl,
          UserPoolId: physicalId,
        },
        ...(effectiveProperties !== properties ? { effectiveProperties } : {}),
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
