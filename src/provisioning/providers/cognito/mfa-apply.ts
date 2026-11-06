import { describeUnsupportedMfaCombination } from './mfa-preflight.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  type DeclaredMfaConfigurationKind,
  buildMfaConfigRequest,
  WEB_AUTHN_MULTI_FACTOR,
} from './mfa-request.js';
import type { SecretMasker } from '../../../types/resource.js';
import {
  SetUserPoolMfaConfigCommand,
  type SetUserPoolMfaConfigCommandInput,
  GetUserPoolMfaConfigCommand,
  DescribeUserPoolCommand,
  type GetUserPoolMfaConfigCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import { safeStringify, describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { CognitoUserPoolProvider } from '../cognito-provider.js';

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
export function warnOnBlankMfaConfiguration(this: CognitoUserPoolProvider, raw: unknown): void {
  if (typeof raw !== 'string' || raw.trim() !== '') return;
  this.logger.warn(
    `AWS::Cognito::UserPool MfaConfiguration is an empty string, which declares no MFA mode ` +
      `and is treated as absent -- a collapsed Fn::Join or an empty String parameter ` +
      `produces this shape. The pool deploys with the default MFA configuration instead; ` +
      `declare ON / OPTIONAL / OFF explicitly, or omit the property, to say which was meant.`
  );
}

/**
 * Raise {@link describeUnsupportedMfaCombination}'s verdict as a typed
 * refusal, or return silently when there is nothing to refuse.
 *
 * A `ProvisioningError` so both call sites behave the way each already does
 * with the sibling `MfaConfiguration` shape refusal: on the create path it
 * surfaces as the provider's own error rather than an AWS one, and on the
 * update path `update()`'s catch re-throws an already-wrapped
 * `ProvisioningError` unchanged, so it is not double-wrapped. Both call sites
 * are OUTSIDE their method's try, so the throw travels untouched either way.
 *
 * `target` is the pool NAME on create (there is no physical id yet) and the
 * physical id on update, matching what each path passes to its other
 * `ProvisioningError`s.
 */
export function assertMfaCombinationApplicable(
  this: CognitoUserPoolProvider,
  logicalId: string,
  resourceType: string,
  target: string,
  properties: Record<string, unknown>,
  declaredMfaConfiguration: string,
  liveFirstAuthFactors?: readonly string[]
): void {
  const reason = describeUnsupportedMfaCombination(
    properties,
    declaredMfaConfiguration,
    liveFirstAuthFactors
  );
  if (reason === undefined) return;
  throw new ProvisioningError(reason, resourceType, logicalId, target);
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
export async function applyMfaConfig(
  this: CognitoUserPoolProvider,
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
export function reportMfaConfigurationOff(
  this: CognitoUserPoolProvider,
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
 * - `LambdaConfig`, `UserPoolAddOns`, `VerificationMessageTemplate`,
 *   `SmsAuthenticationMessage`, `DeviceConfiguration` and
 *   `AdminCreateUserConfig.AllowAdminCreateUserOnly` — DO reset when omitted;
 *   `UserPoolTags`, `AccountRecoverySetting` and `EmailConfiguration` do NOT
 *   (2026-09-29, issue #4066; the full table is at `USER_POOL_ECHO_MEMBERS`).
 * - `KeyConfiguration` — a customer-managed key DOES reset to `AWS_OWNED_KEY`;
 *   `IssuerConfiguration` does NOT (2026-11-01, issue #2762). Both are
 *   writable in either direction on `UpdateUserPool`.
 * - `DeletionProtection` — does NOT reset when omitted (2026-09-23, issue
 *   #2675): a pool created `ACTIVE` stayed `ACTIVE` through an
 *   `UpdateUserPool` omitting it, whose co-sent `AutoVerifiedAttributes`
 *   change landed (the call ran), and an explicit `INACTIVE` then applied
 *   (the field is writable on this call rather than ignored).
 * - `WebAuthnConfiguration.FactorConfiguration` (a `SetUserPoolMfaConfig`
 *   field) — does NOT reset through an `UpdateUserPool` that omits every MFA
 *   member (2026-09-23, issue #2064).
 * - `Policies` — neither sub-key resets, measured in BOTH directions
 *   (2026-08-19, issue #1968; details at `toSdkUserPoolPolicies`): a
 *   container sent without `SignInPolicy` left `SignInPolicy` intact, a
 *   container sent without `PasswordPolicy` left `PasswordPolicy` intact,
 *   and omitting the container outright left both. Forwarding is still
 *   REQUIRED to APPLY a changed sub-key — preservation is not application —
 *   and no omission can express a REMOVAL. CloudFormation measured the same
 *   way on all three removal edits (2026-09-02, issue #1979; transcript at
 *   `toSdkUserPoolPolicies`), so the update path ANNOUNCES the removal via
 *   `warnOnUnremovablePoliciesSubKeys` instead of resetting.
 *
 * What CloudFormation does when the TEMPLATE removes a member (2026-10-27,
 * issue #1160, one throwaway stack): `AccountRecoverySetting`,
 * `SmsConfiguration`, `UserPoolTier` and `DeletionProtection` are kept
 * (`warnOnKeptRemovedMembers`); `MfaConfiguration` with its factors goes
 * OFF (`turnOffRemovedMfa`); a removed `UserPoolTags` key is untagged
 * (`untagRemovedUserPoolTags`, from the type schema's tagging contract).
 * On the same edit (2026-11-01, issue #2762) `KeyConfiguration` resets to
 * `AWS_OWNED_KEY` and `IssuerConfiguration` is kept.
 *
 * `SetUserPoolMfaConfig` — a DIFFERENT API with a DIFFERENT rule, kept in
 * its own section so neither list is read as evidence for the other:
 *
 * - `MfaConfiguration` — an omitted value is read as OFF. With a factor
 *   sub-block in the request AWS REJECTS the call; with none it accepts and
 *   resets the pool to MFA-disabled. An EXPLICIT OFF beside a block is
 *   rejected the same way (2026-08-19, issue #1968; the transcript lives at
 *   `describeUnsupportedMfaCombination`, which since issue #1977 REFUSES that
 *   combination before any call rather than warning about it).
 * - `WebAuthnConfiguration.FactorConfiguration` — an omitted block is read as
 *   SINGLE_FACTOR even on a pool holding MULTI_FACTOR_WITH_USER_VERIFICATION
 *   (2026-09-23, issue #2064; transcript at `describeUnsupportedMfaCombination`).
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
export async function readLiveMfaConfiguration(
  this: CognitoUserPoolProvider,
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
    // the session name to the terminal (a warning is not persisted).
    // Same split as the `dynamodb-index-busy-delete` DescribeTable arm.
    this.logger.debug(
      `GetUserPoolMfaConfig failed for UserPool ${physicalId} ` +
        `(${error instanceof Error ? safeStringify(error.name) : typeof error}): ` +
        `${describeAwsFailure(error).detail}`
    );
    return { failed: true };
  }
}

/**
 * The pool's live `Policies.SignInPolicy.AllowedFirstAuthFactors`, for the
 * pre-flight (issue #2051), or `undefined` when it cannot be read.
 *
 * FAILS OPEN: an unreadable pool is judged on the template alone, which is
 * the pre-#2051 behavior -- AWS then answers with its own rejection. Refusing
 * on a failed read would block deploys over a question cdkd never answered.
 * `update()` already needs `cognito-idp:DescribeUserPool` (its post-update
 * attribute read), so this adds no permission. An ABSENT list (a pool with
 * no sign-in policy) is AWS's default `[PASSWORD]`, which trips no rule, so
 * it reads as empty.
 */
export async function readLiveAllowedFirstAuthFactors(
  this: CognitoUserPoolProvider,
  physicalId: string
): Promise<readonly string[] | undefined> {
  try {
    // Transient errors are retried before failing open: a single blip would
    // otherwise silently drop the guard this read exists for. The SDK's own
    // retry already covers throttling.
    const response = await this.retryOnTransientControlPlane(
      () => this.getClient().send(new DescribeUserPoolCommand({ UserPoolId: physicalId })),
      `DescribeUserPool(${physicalId}) before the MFA pre-flight`
    );
    const factors = response.UserPool?.Policies?.SignInPolicy?.AllowedFirstAuthFactors;
    return Array.isArray(factors) ? factors : [];
  } catch (error) {
    // Debug, not warn: the AWS message can quote the account, role and
    // session (see `readLiveMfaConfiguration`), and failing open loses
    // nothing the deploy needs.
    this.logger.debug(
      `DescribeUserPool failed for UserPool ${physicalId} before the MFA pre-flight ` +
        `(${error instanceof Error ? safeStringify(error.name) : typeof error}): ` +
        `${describeAwsFailure(error).detail}`
    );
    return undefined;
  }
}

/**
 * The pool's FULL live MFA configuration when `SetUserPoolMfaConfig` has to
 * go FIRST (issue #3562), or `undefined` to keep the usual order.
 *
 * MFA-first is needed exactly when the live pool is at `ON` without
 * `MULTI_FACTOR_WITH_USER_VERIFICATION`: `UpdateUserPool` then refuses to add
 * `WEB_AUTHN` until the factor configuration has changed. Anything else --
 * live `OFF` / `OPTIONAL`, live `MULTI` already, or a read that FAILED --
 * keeps `UpdateUserPool` first, which is the pre-#3562 behaviour and at worst
 * the atomic rejection it always was. The returned response is also what
 * `restoreMfaConfig` replays if `UpdateUserPool` fails after the MFA call
 * landed.
 */
export async function readMfaFirstPrior(
  this: CognitoUserPoolProvider,
  physicalId: string
): Promise<GetUserPoolMfaConfigCommandOutput | undefined> {
  try {
    const live = await this.retryOnTransientControlPlane(
      () => this.getClient().send(new GetUserPoolMfaConfigCommand({ UserPoolId: physicalId })),
      `GetUserPoolMfaConfig(${physicalId}) for the call order`
    );
    return live.MfaConfiguration === 'ON' &&
      live.WebAuthnConfiguration?.FactorConfiguration !== WEB_AUTHN_MULTI_FACTOR
      ? live
      : undefined;
  } catch (error) {
    // Debug only: the raw AWS message can carry account / role / session text
    // (see `readLiveMfaConfiguration`), and failing back to the usual order
    // loses nothing the deploy needs.
    this.logger.debug(
      `GetUserPoolMfaConfig failed for UserPool ${physicalId} while choosing the call order ` +
        `(${error instanceof Error ? safeStringify(error.name) : typeof error}): ` +
        `${describeAwsFailure(error).detail}`
    );
    return undefined;
  }
}

/**
 * Put back the MFA configuration `readMfaFirstPrior` read, after
 * `UpdateUserPool` failed behind an MFA-first `SetUserPoolMfaConfig` (issue
 * #3562). Without this the reversed order leaves the #1975 partial apply
 * mirrored: the MFA change landed, the rest did not. MEASURED us-east-1
 * 2026-09-23: replaying the earlier `GetUserPoolMfaConfig` members through
 * `SetUserPoolMfaConfig` restored the pool exactly, after a MULTI change had
 * landed and the `UpdateUserPool` behind it was rejected.
 *
 * Best effort: the caller re-throws the ORIGINAL error either way, and a
 * failed restore is announced (error CLASS at warn, detail at debug) rather
 * than replacing it.
 */
export async function restoreMfaConfig(
  this: CognitoUserPoolProvider,
  physicalId: string,
  prior: GetUserPoolMfaConfigCommandOutput
): Promise<void> {
  // Every configuration member `SetUserPoolMfaConfigCommandInput` carries --
  // the call is a full replace, so a member added to that type later must be
  // added here too, or a restore resets it.
  const request: SetUserPoolMfaConfigCommandInput = {
    UserPoolId: physicalId,
    ...(prior.MfaConfiguration !== undefined && { MfaConfiguration: prior.MfaConfiguration }),
    ...(prior.SmsMfaConfiguration !== undefined && {
      SmsMfaConfiguration: prior.SmsMfaConfiguration,
    }),
    ...(prior.SoftwareTokenMfaConfiguration !== undefined && {
      SoftwareTokenMfaConfiguration: prior.SoftwareTokenMfaConfiguration,
    }),
    ...(prior.EmailMfaConfiguration !== undefined && {
      EmailMfaConfiguration: prior.EmailMfaConfiguration,
    }),
    ...(prior.WebAuthnConfiguration !== undefined && {
      WebAuthnConfiguration: prior.WebAuthnConfiguration,
    }),
  };
  try {
    await this.retryOnTransientControlPlane(
      () => this.getClient().send(new SetUserPoolMfaConfigCommand(request)),
      `SetUserPoolMfaConfig(${physicalId}) restore`
    );
    this.logger.debug(`Restored the previous MFA configuration on UserPool ${physicalId}`);
  } catch (restoreError) {
    const aws = pasteableAwsCommand();
    const region = await this.regionArg(aws);
    this.logger.warn(
      `UserPool ${physicalId}: UpdateUserPool failed after SetUserPoolMfaConfig had already ` +
        `applied the new MFA configuration, and restoring the previous one also failed ` +
        `(${restoreError instanceof Error ? safeStringify(restoreError.name) : typeof restoreError}). The pool ` +
        `may now carry the NEW MFA configuration with its OLD sign-in policy; re-run the deploy, ` +
        `or check it with ${aws`aws cognito-idp get-user-pool-mfa-config --user-pool-id ${physicalId}${region}`.render()}.`
    );
    this.logger.debug(
      `MFA restore failure detail for UserPool ${physicalId}: ` +
        `${describeAwsFailure(restoreError).detail}`
    );
  }
}

/**
 * Retry a Cognito control-plane call on transient "settling" errors. A
 * SetUserPoolMfaConfig issued immediately after CreateUserPool (or another
 * control-plane write) can briefly hit `ConcurrentModificationException` /
 * "please retry". Backoff is capped at 4s, but the DEFAULT 3 attempts means
 * only TWO sleeps -- 1s then 2s, 3s total -- so the 4s step is unreachable
 * unless a caller raises `maxAttempts`. (`retryable-errors/patterns.ts`'s Cognito
 * SMS-role entry depends on that arithmetic; an earlier revision of it
 * copied a 7s figure out of this comment's previous wording.)
 */
export async function retryOnTransientControlPlane<T>(
  this: CognitoUserPoolProvider,
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // `.detail`, never `.summary`: the classifier below matches AWS's OWN
      // wording, which `.summary` replaces with the wire name alone. Same text as
      // the `instanceof Error ?` ternary it replaced, minus that ternary's throw.
      const msg = describeAwsFailure(error).detail;
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
 * Turn MFA off when the template stops declaring it (issue #1160).
 *
 * A template that drops `MfaConfiguration` and every MFA factor property
 * sends no MFA member at all, and `UpdateUserPool` keeps `MfaConfiguration`
 * when omitted, so the pool stayed `OPTIONAL` / `ON`. CloudFormation turns
 * it OFF: MEASURED us-east-1 2026-10-27 on a throwaway stack whose pool went
 * from `MfaConfiguration: OPTIONAL` + `EnabledMfas: [SMS_MFA,
 * SOFTWARE_TOKEN_MFA]` to neither, the update read `MfaConfiguration: OFF`
 * and no `SoftwareTokenMfaConfiguration` from `GetUserPoolMfaConfig`.
 *
 * Sent as `SetUserPoolMfaConfig` with `MfaConfiguration: OFF` and no factor
 * block: the shape measured to be accepted and to leave the pool
 * MFA-disabled (issue #1968, at `buildMfaConfigRequest`), where a factor
 * block beside OFF is refused.
 */
export async function turnOffRemovedMfa(
  this: CognitoUserPoolProvider,
  logicalId: string,
  physicalId: string,
  previousMfaConfiguration: string
): Promise<void> {
  await this.retryOnTransientControlPlane(
    () =>
      this.getClient().send(
        new SetUserPoolMfaConfigCommand({ UserPoolId: physicalId, MfaConfiguration: 'OFF' })
      ),
    `SetUserPoolMfaConfig(${physicalId})`
  );
  this.logger.warn(
    safeMsg`Cognito User Pool ${logicalId} (${physicalId}): the template no longer declares ` +
      safeMsg`MfaConfiguration or an MFA factor, so cdkd turned MFA OFF (it was ` +
      safeMsg`${previousMfaConfiguration}), as CloudFormation does on the same edit. Declare ` +
      safeMsg`MfaConfiguration and EnabledMfas to keep MFA on.`
  );
}
