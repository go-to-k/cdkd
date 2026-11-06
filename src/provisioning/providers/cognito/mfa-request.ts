import type {
  WebAuthnFactorConfigurationType,
  SetUserPoolMfaConfigCommandInput,
  UserVerificationType,
  SmsConfigurationType,
  UserPoolMfaType,
  AuthFactorType,
} from '@aws-sdk/client-cognito-identity-provider';
import { type ConfigStringOptions, requireConfigString } from '../../config-shape.js';
import type { SecretMasker } from '../../../types/resource.js';
import { maskDeep } from '../../masked-retry-logger.js';

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
 *
 * **The email-OTP model, stated once (issue #1924): the `EmailMfaConfiguration`
 * block's PRESENCE is the factor.** `EmailMfaConfigType` is exactly
 * `{Message?, Subject?}` -- unlike `SoftwareTokenMfaConfigType` it has no
 * `Enabled` member, so the API has no way to carry a message template without
 * enabling email OTP, nor to report one. That is read off the API's TYPE, not
 * measured: a live probe needs a DEVELOPER email sender (a COGNITO_DEFAULT pool
 * refuses the block outright), which the maintainer's account does not have.
 * Both sides honor that: `buildMfaConfigRequest` sends the block for `EMAIL_OTP` OR a bare
 * message/subject (announcing the second, since the template did not list the
 * factor), and `readCurrentState` reads a present block back as `EMAIL_OTP`.
 */
export const MFA_FACTOR_SMS = 'SMS_MFA';

export const MFA_FACTOR_SOFTWARE_TOKEN = 'SOFTWARE_TOKEN_MFA';

export const MFA_FACTOR_EMAIL_OTP = 'EMAIL_OTP';

/**
 * The one `WebAuthnConfiguration.FactorConfiguration` value AWS accepts beside
 * `MfaConfiguration: ON` when `WEB_AUTHN` is an allowed first auth factor
 * (issue #2064). Typed against the SDK enum so a rename upstream is a compile
 * error rather than a silently never-matching comparison.
 */
export const WEB_AUTHN_MULTI_FACTOR =
  'MULTI_FACTOR_WITH_USER_VERIFICATION' satisfies WebAuthnFactorConfigurationType;

/**
 * CFn path every `MfaConfiguration` shape refusal in this provider reports.
 * One constant so the three sites that READ the property -- `create`,
 * `update`, and `narrowMfaConfiguration` (the diff / effectiveProperties
 * side) -- cannot word the same fault differently. `buildMfaConfigRequest`
 * performs no read of its own; it is handed the already-guarded value.
 */
export const MFA_CONFIGURATION_PATH = 'AWS::Cognito::UserPool MfaConfiguration';

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
export type DeclaredMfaConfigurationKind = 'absent' | 'blank' | 'refused' | 'usable';

export function classifyDeclaredMfaConfiguration(raw: unknown): DeclaredMfaConfigurationKind {
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
export function readDeclaredMfaConfiguration(raw: unknown, options: ConfigStringOptions): string {
  const value = requireConfigString(raw, '', MFA_CONFIGURATION_PATH, options);
  return value.trim() === '' ? '' : value;
}

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
export function readEnabledMfas(properties: Record<string, unknown>): {
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
export function hasMfaConfigProps(properties: Record<string, unknown>): boolean {
  // `declaresFactor` (not just a non-empty array) so a mis-shaped declaration
  // still routes through SetUserPoolMfaConfig and fails loudly, rather than
  // skipping the call and dropping the factor in silence.
  return (
    readEnabledMfas(properties).declaresFactor ||
    !!(properties['EmailAuthenticationMessage'] as string | undefined) ||
    !!(properties['EmailAuthenticationSubject'] as string | undefined) ||
    !!(properties['WebAuthnRelyingPartyID'] as string | undefined) ||
    !!(properties['WebAuthnUserVerification'] as string | undefined) ||
    !!(properties['WebAuthnFactorConfiguration'] as string | undefined)
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
export function buildMfaConfigRequest(
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
  // this sink. `maskLeaves` below is the inner layer: it hands the masker the raw
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
  // Issue #2064. Reachable since the SDK floor carries `FactorConfiguration`;
  // it is what lets `WEB_AUTHN` sit beside `MfaConfiguration: ON`.
  const webAuthnFactorConfiguration =
    (properties['WebAuthnFactorConfiguration'] as WebAuthnFactorConfigurationType | undefined) ||
    undefined;

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
  // The email-OTP factor and the email message/subject share one sub-block,
  // and the block IS the factor (the model at `MFA_FACTOR_EMAIL_OTP`). Emit it
  // when EMAIL_OTP is enabled OR a custom message/subject is supplied; the
  // second enables email OTP whether or not `EnabledMfas` lists it, which is
  // announced below rather than changed (not sending the block would drop the
  // declared message, and would flip the OPTIONAL default this block keeps).
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
  if (
    webAuthnRpId !== undefined ||
    webAuthnUserVerification !== undefined ||
    webAuthnFactorConfiguration !== undefined
  ) {
    request.WebAuthnConfiguration = {
      ...(webAuthnRpId !== undefined ? { RelyingPartyId: webAuthnRpId } : {}),
      ...(webAuthnUserVerification !== undefined
        ? { UserVerification: webAuthnUserVerification }
        : {}),
      ...(webAuthnFactorConfiguration !== undefined
        ? { FactorConfiguration: webAuthnFactorConfiguration }
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
  // `anyFactorBlock`. That transcript lives at
  // `describeUnsupportedMfaCombination`, the PRE-FLIGHT REFUSAL it decides
  // (issue #1977; it used to decide a warning at this same site, which the
  // refusal replaced). `readLiveMfaConfiguration`'s ledger carries
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

  // Issue #1924: a bare message/subject sends the block, and the block IS the
  // email-OTP factor, so this call enables EMAIL_OTP although `EnabledMfas`
  // does not list it -- and `readCurrentState` will report it there. Say so,
  // naming the edit that makes the template describe what AWS holds. Skipped
  // for a MALFORMED `EnabledMfas`, whose own warning below already names it.
  if (
    request.EmailMfaConfiguration !== undefined &&
    !factors.has(MFA_FACTOR_EMAIL_OTP) &&
    !enabledMfasMalformed
  ) {
    warn(
      `UserPool ${physicalId}: EmailAuthenticationMessage / EmailAuthenticationSubject is sent ` +
        `in SetUserPoolMfaConfig's EmailMfaConfiguration block, which has no enable switch of ` +
        `its own -- sending it ENABLES the ${MFA_FACTOR_EMAIL_OTP} MFA factor although EnabledMfas ` +
        `does not list it, and a read-back reports EnabledMfas with ${MFA_FACTOR_EMAIL_OTP}. Add ` +
        `${MFA_FACTOR_EMAIL_OTP} to EnabledMfas to declare it, or remove the message and subject ` +
        `if email OTP is not wanted.`
    );
  }

  const anyFactorBlock = hasAnyMfaFactorBlock(request);

  // The OFF-plus-factor-block combination that USED to be warned about here
  // (issue #1932 item 2, reworded by issue #1968) is now a PRE-FLIGHT REFUSAL
  // raised by {@link describeUnsupportedMfaCombination} before the first AWS
  // call (issue #1977). The warning is gone rather than kept alongside it: the
  // refusal fires strictly earlier, carries the same remedy, and leaving both
  // would print a warning about a request that is never built.
  //
  // The MEASUREMENT that decided it stays recorded at the refusal, not here,
  // so there is exactly one place stating why the combination cannot ship.

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
  const maskLeaves = (v: unknown): unknown => maskDeep(v, maskSecrets);
  const dropped: string[] = unrecognizedFactors.map(
    (f) => JSON.stringify(maskLeaves(f)) ?? String(f)
  );
  if (enabledMfasMalformed) {
    dropped.push(`${JSON.stringify(maskLeaves(properties['EnabledMfas']))} (not a list)`);
  }
  if (dropped.length > 0) {
    // THREE outcomes. It was four until issue #1977 made OFF-plus-a-factor-block
    // a pre-flight REFUSAL: `create` / `update` run
    // {@link describeUnsupportedMfaCombination} before their first AWS call, so
    // by the time a LOGGER reaches this function the OFF arm can no longer be
    // carrying a factor block, and the fourth arm ("AWS REJECTS this call
    // outright") was unreachable rather than merely rare. Deleting it is what
    // keeps the surviving OFF arm TRUE: with the refusal in front, OFF here
    // really does mean no factor block and really does deploy an MFA-disabled
    // pool.
    //
    // That reachability argument is the pre-flight's, not this function's:
    // `buildMfaConfigRequest` stays a pure builder and its diff-side caller
    // (`resolveSentMfaConfiguration`) passes no logger, so nothing here fires
    // for it. A future caller that reaches `applyMfaConfig` WITHOUT running the
    // pre-flight would re-open the gap -- keep the two together.
    //
    // The non-OFF split stands unchanged: the arm says a block IS SENT rather
    // than that a factor IS ENABLED, because that is all this code knows --
    // e.g. SMS_MFA without SmsConfiguration sends a block AWS then rejects.
    // (`anyFactorBlock` is hoisted above and shared with the pre-flight, so
    // "a factor block IS sent" has one definition.)
    const consequence =
      request.MfaConfiguration === 'OFF'
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
export function resolveSentMfaConfiguration(
  properties: Record<string, unknown>,
  declaredMfaConfiguration: string
): string | undefined {
  const request = buildMfaConfigRequest('', properties, undefined, declaredMfaConfiguration);
  if (request) return request.MfaConfiguration;
  return declaredMfaConfiguration || undefined;
}

/**
 * "This `SetUserPoolMfaConfig` request carries an MFA FACTOR sub-block."
 *
 * ONE definition, shared by `buildMfaConfigRequest`'s dropped-entry warning and
 * by the pre-flight refusal below, so the message and the refusal cannot
 * disagree about the same request. It is precisely
 * `{Sms, SoftwareToken, Email}MfaConfiguration` -- `WebAuthnConfiguration` is
 * deliberately NOT a member, because WebAuthn is not an MFA factor and rides
 * alongside `MfaConfiguration: OFF` on every passkey-only pool (issue #1920).
 */
export function hasAnyMfaFactorBlock(request: SetUserPoolMfaConfigCommandInput): boolean {
  return (
    request.SmsMfaConfiguration !== undefined ||
    request.SoftwareTokenMfaConfiguration !== undefined ||
    request.EmailMfaConfiguration !== undefined
  );
}

/**
 * The `Policies.SignInPolicy.AllowedFirstAuthFactors` members AWS refuses to
 * combine with MFA (issue #1975).
 *
 * A DENY-list, deliberately, even though the AWS message states an ALLOW-list
 * ("Only PASSWORD and WEB_AUTHN (if configured) can be enabled as an auth
 * factor if MFA is enabled"). Written from the allow-list, a member AWS adds
 * LATER would be refused by cdkd on the day it starts working -- the same
 * reason the unrecognized-`EnabledMfas` case in `buildMfaConfigRequest` warns
 * rather than throws, since that set is a hardcoded mirror of an AWS enum. The
 * cost of the deny-list is the reverse and is the cheaper one: a future
 * incompatible factor is simply not pre-flighted, which is the pre-#1975
 * behavior (a loud AWS rejection), not a regression.
 *
 * The two members ARE the whole of today's `AuthFactorType` enum outside the
 * allowed pair (`EMAIL_OTP`, `PASSWORD`, `SMS_OTP`, `WEB_AUTHN` --
 * `@aws-sdk/client-cognito-identity-provider`), so the deny-list and the
 * allow-list agree on every value that exists right now.
 *
 * BOTH members are MEASURED (us-east-1, 2026-08-19, issue #1975) -- neither is
 * extrapolated from the other, which is the failure mode this file's own
 * unrecognized-factor comment warns about:
 *
 *   [PASSWORD, EMAIL_OTP] + SetUserPoolMfaConfig(ON) -> REJECTED
 *   [PASSWORD, SMS_OTP]   + SetUserPoolMfaConfig(ON) -> REJECTED, same message
 *
 * The `SMS_OTP` probe needed a precondition worth recording, because without it
 * the interesting call is never reached: on a pool with NO `SmsConfiguration`,
 * `CreateUserPool` refuses the factor outright ("SMS_OTP can not be configured
 * as AuthFactor as user pool is missing valid SMS configuration"), so the probe
 * had to stand up an SNS-caller IAM role + ExternalId first. That earlier,
 * different refusal is AWS's own and is NOT something this pre-flight
 * duplicates.
 *
 * Typed `satisfies AuthFactorType[]` rather than left as `string[]`: the values
 * mirror an SDK enum, so a rename upstream should be a COMPILE error here
 * rather than a silently-never-matching deny-list.
 */
export const MFA_INCOMPATIBLE_FIRST_AUTH_FACTORS = [
  'EMAIL_OTP',
  'SMS_OTP',
] as const satisfies AuthFactorType[];

/**
 * `Policies.SignInPolicy.AllowedFirstAuthFactors` as a list of STRINGS, or an
 * empty list when the template declares nothing usable there.
 *
 * Every mis-shape reads as ABSENT rather than as a violation: this feeds a
 * REFUSAL, so guessing at a container cdkd could not read would block a deploy
 * over a value it never understood. A genuinely broken `Policies` blob is AWS's
 * to reject, with its own message.
 *
 * The two containers are traversed with `?.` rather than with the
 * `typeof x === 'object' && !Array.isArray(x)` guard `config-shape.ts` uses,
 * and that is deliberate rather than sloppy: those guards are load-bearing
 * THERE because the helper REFUSES a non-object, while here the only outcome is
 * "no factors", which is exactly what indexing a string / number / array
 * already yields. The version carrying them was written first and MEASURED
 * inert -- deleting either clause failed no test and could not be made to,
 * since no template value indexes to anything at those keys. `?.` keeps the one
 * behaviour that is real (a declared `null` throws on a bare index) and leaves
 * nothing unfalsifiable behind.
 *
 * The two filters below are NOT the same kind of thing, and saying so matters
 * because an earlier revision of this comment claimed both were load-bearing and
 * "each fenced by a test" -- which was false for one of them, and a false fence
 * claim is what stops the next reader re-checking.
 *
 *  - `Array.isArray` is a RUNTIME guard and IS fenced: without it a scalar
 *    `AllowedFirstAuthFactors: 'EMAIL_OTP'` is read as a declaration and
 *    refused, and the test for that shape reds when it is dropped.
 *  - The string filter is a TYPE NARROWING and is INERT at runtime. `includes`
 *    compares by SameValueZero, so a non-string member can never equal a
 *    deny-list entry however it is spelled; deleting the filter fails NO test,
 *    and no test could be written that it would fail. It earns its place by
 *    giving the caller a `string[]`, and by keeping this function honest if a
 *    future caller ever COERCES a member instead of comparing it. The
 *    nested-list case in the suite fences that hypothetical `String(member)`
 *    implementation -- i.e. the mistake, not this code.
 */
export function readAllowedFirstAuthFactors(properties: Record<string, unknown>): string[] {
  const signInPolicy = (properties['Policies'] as Record<string, unknown> | undefined)?.[
    'SignInPolicy'
  ] as Record<string, unknown> | undefined;
  const factors = signInPolicy?.['AllowedFirstAuthFactors'];
  if (!Array.isArray(factors)) return [];
  return factors.filter((factor): factor is string => typeof factor === 'string');
}
