import {
  buildMfaConfigRequest,
  hasAnyMfaFactorBlock,
  MFA_CONFIGURATION_PATH,
  readAllowedFirstAuthFactors,
  MFA_INCOMPATIBLE_FIRST_AUTH_FACTORS,
  WEB_AUTHN_MULTI_FACTOR,
  readDeclaredMfaConfiguration,
  resolveSentMfaConfiguration,
} from './mfa-request.js';

/**
 * The two sub-keys of the CFn `Policies` blob — exactly the members
 * `UserPoolPolicyType` declares, and exactly the keys `toSdkUserPoolPolicies`
 * forwards. Iterated by the #1979 removal announcement so a sub-key AWS adds
 * later joins BOTH the forwarding and the announcement in one edit here.
 */
export const POLICIES_SUB_KEYS = ['PasswordPolicy', 'SignInPolicy'] as const;

type PoliciesSubKey = (typeof POLICIES_SUB_KEYS)[number];

/**
 * Would this property bag put `Policies.<subKey>` on the wire?
 *
 * MIRRORS the wire's own two truthiness gates rather than re-deriving a
 * "present" notion of its own: `create()` / `update()` gate on
 * `if (properties['Policies'])` and `toSdkUserPoolPolicies` gates each sub-key
 * on `if (policies['SignInPolicy'])`. The #1979 removal announcement must fire
 * exactly when the wire STOPS carrying a sub-key it previously carried, so a
 * hand-written presence test here (`in`, `!== undefined`, a plain-object
 * guard) would disagree with the wire on `null` / `''` / `0` / `false` — the
 * config-shape.ts share-the-predicate rule, applied to a truthiness gate.
 * Agreement is pinned by a unit table that drives every value shape through
 * the PUBLIC `update()` and asserts warn-iff-not-sent.
 */
export function sendsPoliciesSubKey(bag: Record<string, unknown>, subKey: PoliciesSubKey): boolean {
  const policies = bag['Policies'];
  if (!policies) return false;
  return Boolean((policies as Record<string, unknown>)[subKey]);
}

/**
 * What the removal announcement tells the user about each sub-key: a short
 * label for the live value the pool keeps, and the AWS default the user must
 * DECLARE explicitly to get reset behavior (there is no removal path on the
 * wire, so an explicit declaration is the only way to change the live value).
 */
export const POLICIES_SUB_KEY_ANNOUNCEMENT: Record<
  PoliciesSubKey,
  { label: string; reset: string }
> = {
  PasswordPolicy: {
    label: 'password policy',
    reset:
      'the AWS default is MinimumLength: 8 with every character-class requirement enabled ' +
      'and TemporaryPasswordValidityDays: 7',
  },
  SignInPolicy: {
    label: 'sign-in policy',
    reset: 'the AWS default is AllowedFirstAuthFactors: [PASSWORD]',
  },
};

/**
 * The PRE-FLIGHT: the reason this user-pool configuration cannot be applied at
 * all, or `undefined` when nothing is known to refuse it.
 *
 * Three rules, all for combinations AWS rejects 100% of the time, and all
 * raised BEFORE the first AWS call on BOTH the create and the update path. The
 * ordering is what makes them worth refusing rather than warning about: on the
 * UPDATE path `UpdateUserPool` lands FIRST and `SetUserPoolMfaConfig` is
 * refused afterwards, so sending the request leaves a PARTIAL APPLY behind --
 * with the security-relevant half being the half that did NOT apply (the MFA
 * configuration), while the half that did is the one loosening authentication.
 * Nothing unwinds it, and a retry cannot succeed until the user reverse-engineers
 * an AWS-worded error about a field they did not think they were changing.
 *
 * Rule 1 (issue #1977) -- `MfaConfiguration` resolves to OFF while the request
 * carries an MFA factor block. MEASURED us-east-1 2026-08-19 (issue #1968):
 *
 *   {ON,  SoftwareTokenMfaConfiguration: {Enabled: true}}   -> ACCEPTED (control)
 *   {OFF, SoftwareTokenMfaConfiguration: {Enabled: true}}   -> rejected
 *   {OFF, SoftwareTokenMfaConfiguration: {Enabled: false}}  -> rejected
 *   {OFF, EmailMfaConfiguration: {Message, Subject}}        -> rejected
 *
 * all with `InvalidParameterException: Invalid MFA configuration given, can't
 * turn off MFA and configure an MFA together`. The `Enabled: false` arm settles
 * the KEY: a block that enables NOTHING is still refused, so the rule is about
 * the block's PRESENCE -- exactly what `hasAnyMfaFactorBlock` tests -- and
 * since that predicate is precisely the three factor sub-blocks, no accepted
 * case survives. (Bound on the Email arm: an OPTIONAL control with that block
 * failed with a DIFFERENT error, "Cannot set EmailMfaConfiguration when user
 * pool EmailConfiguration contains an EmailSendingAccount of COGNITO_DEFAULT",
 * so it has no isolated control of its own -- informative in itself, since it
 * shows the exclusion is evaluated BEFORE the email-sending-account check.)
 *
 * Rule 2 (issue #1975) -- the `SetUserPoolMfaConfig` request resolves
 * `MfaConfiguration` to ON while `Policies.SignInPolicy.AllowedFirstAuthFactors`
 * allows `EMAIL_OTP` or `SMS_OTP`. AWS refuses with `Only PASSWORD and WEB_AUTHN
 * (if configured) can be enabled as an auth factor if MFA is enabled`. MEASURED
 * us-east-1 2026-08-19, both members and both MFA modes:
 *
 *   {[PASSWORD, EMAIL_OTP], ON}       -> rejected
 *   {[PASSWORD, EMAIL_OTP], OPTIONAL} -> ACCEPTED
 *   {[PASSWORD, SMS_OTP],   ON}       -> rejected (pool WITH a valid SmsConfiguration)
 *   {[PASSWORD, SMS_OTP],   OPTIONAL} -> ACCEPTED
 *
 * So `=== 'ON'` is MEASURED-CORRECT rather than merely conservative: OPTIONAL is
 * ACCEPTED, and widening this to `!== 'OFF'` would REFUSE A WORKING DEPLOY. An
 * earlier revision of this comment called OPTIONAL unmeasured; it is not, and
 * the measurement is what settles the narrowing rather than a cost argument.
 *
 * WHY THE MESSAGE DOES NOT OFFER `WEB_AUTHN` AS THE ESCAPE HATCH, even though
 * AWS's own error text names it as accepted. MEASURED us-east-1 2026-08-20: a
 * pool allowing `WEB_AUTHN` as a first auth factor is REJECTED by
 * `SetUserPoolMfaConfig(ON, SoftwareTokenMfa)` --
 *
 *   InvalidParameterException: Cannot set WebAuthn factor configuration to
 *   SINGLE_FACTOR if MFA is required and WebAuthn is an allowed first auth factor
 *
 * -- with NO WebAuthn block at all, with `UserVerification: preferred`, and with
 * `required`. The only accepted shape is
 * `WebAuthnConfiguration.FactorConfiguration = MULTI_FACTOR_WITH_USER_VERIFICATION`
 * (the CFn `WebAuthnFactorConfiguration`), so switching to `WEB_AUTHN` is a
 * two-property edit with its own rule -- rule 3 -- and the remedy names the
 * one-property fix instead.
 *
 * Rule 3 (issue #2064) -- the request resolves `MfaConfiguration` to ON while
 * the allowed first auth factors include `WEB_AUTHN` and the request does not
 * carry `FactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION`. It cannot
 * be a deny-list entry: the SAME factor is legal or illegal by that one field.
 * MEASURED us-east-1 2026-09-23, on a pool allowing `[PASSWORD, WEB_AUTHN]`:
 *
 *   {ON,  SoftwareToken, FactorConfiguration: MULTI}                   -> ACCEPTED
 *   {ON,  SoftwareToken, FactorConfiguration: MULTI, UV: preferred}    -> ACCEPTED
 *   {OFF, FactorConfiguration: MULTI}                                  -> ACCEPTED
 *   {ON,  SoftwareToken, FactorConfiguration: SINGLE_FACTOR}           -> rejected
 *   {ON,  SoftwareToken, no WebAuthn block}, live value MULTI          -> rejected
 *
 * all rejections reading "Cannot set WebAuthn factor configuration to
 * SINGLE_FACTOR if MFA is required and WebAuthn is an allowed first auth
 * factor". The last line is what licenses reading the REQUEST rather than the
 * pool: `SetUserPoolMfaConfig` is a full replace here too, so an omitted block
 * is SINGLE_FACTOR whatever the pool held. It is the #1975 partial apply
 * exactly -- measured from both an OFF and an OPTIONAL pool, `UpdateUserPool`
 * adding `WEB_AUTHN` LANDED and the `SetUserPoolMfaConfig(ON)` after it was
 * rejected. (From a pool already at ON, `UpdateUserPool` itself refuses to add
 * `WEB_AUTHN` -- "WEB_AUTHN cannot be used as an auth factor when MFA is
 * enabled if not configured for MFA" -- atomically.)
 *
 * SCOPE LIMIT, deliberate and load-bearing: rule 2 fires only when a
 * `SetUserPoolMfaConfig` request is actually BUILT (`hasMfaConfigProps`), i.e.
 * the template declares `EnabledMfas` / an email-OTP message or subject /
 * WebAuthn. With NONE of those, `MfaConfiguration` rides on the SINGLE
 * `CreateUserPool` / `UpdateUserPool` call and no second call follows -- so
 * there is no two-call window and structurally NOTHING to partly apply, which
 * is the entire harm this pre-flight exists to prevent. Refusing there would
 * ALSO be an over-refusal on a shape AWS accepts: a pool created with
 * `AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP]` and no MFA configuration
 * call at all is ACCEPTED (measured, same session -- the pool came up fine and
 * only the later `SetUserPoolMfaConfig(ON)` failed). Such a template is left to
 * AWS, which answers it atomically.
 *
 * CLOUDFORMATION PARITY, settled by A/B rather than assumed -- both issues made
 * this an explicit precondition. CloudFormation hits the SAME rejections and
 * rolls the stack back:
 *
 *   {MfaConfiguration: OFF, EnabledMfas: [SOFTWARE_TOKEN_MFA]}
 *     -> ROLLBACK_COMPLETE, "Invalid MFA configuration given, can't turn off
 *        MFA and configure an MFA together"
 *   {MfaConfiguration: ON, EnabledMfas: [SOFTWARE_TOKEN_MFA],
 *    AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP]}  (ESSENTIALS tier)
 *     -> ROLLBACK_COMPLETE, "Only PASSWORD and WEB_AUTHN..."
 *
 * So refusing is PARITY-PRESERVING, not a divergence: cdkd refuses the same SET
 * of templates CloudFormation refuses, only EARLIER (before the first API call
 * instead of after a partial apply) and in cdkd's own wording. Nothing that
 * deploys under CloudFormation is blocked here.
 *
 * Both rules read the value cdkd would SEND rather than the raw template value,
 * from ONE `buildMfaConfigRequest` call, so the refusal and the request can
 * never disagree about what OFF / ON means for a given bag. The build runs with
 * NO logger, so the pre-flight is silent and `applyMfaConfig`'s own warnings
 * still fire exactly once.
 *
 * WHICH FACTOR LIST rules 2 and 3 read (issue #2051): the one the pool will
 * hold when `SetUserPoolMfaConfig` runs. When the template SENDS
 * `Policies.SignInPolicy.AllowedFirstAuthFactors` as a list that is the
 * template's list; when it does not, it is the LIVE list, because an omitted
 * sub-key -- or a sent `SignInPolicy` without the member -- is PRESERVED by
 * `UpdateUserPool` (the ledger at `readLiveMfaConfiguration`;
 * `sendsFirstAuthFactorList`). `update()` supplies that live
 * list as `liveFirstAuthFactors`, read only when a rule could fire on it; on
 * create, and when the read fails, it is absent and only the template is
 * judged -- AWS's own default `[PASSWORD]` cannot trip either rule. MEASURED
 * us-east-1 2026-09-23: a pool at `[PASSWORD, EMAIL_OTP]` + OPTIONAL took an
 * `UpdateUserPool` omitting `Policies` (its `AutoVerifiedAttributes` canary
 * landed, the factor list survived), then `SetUserPoolMfaConfig(ON)` was
 * rejected -- the partial apply of DELETING `SignInPolicy` while setting ON.
 *
 * The OTHER #2051 path -- omitting `MfaConfiguration` while adding `EMAIL_OTP`
 * to a pool whose live MFA is ON -- is NOT a partial apply and is not guarded:
 * MEASURED the same day, `UpdateUserPool` itself rejects the added factor
 * ("Only PASSWORD and WEB_AUTHN (if configured) can be enabled as an auth
 * factor if MFA is enabled") and its co-sent `AutoVerifiedAttributes` did NOT
 * land, so AWS answers it atomically before any second call.
 *
 * Deliberately UNCONDITIONAL -- no `CreateContext.replayingState` downgrade.
 * `.claude/rules/providers.md` says a create-path pre-flight refusal MUST
 * downgrade on a replay, so this is a STATED EXCEPTION rather than an
 * oversight, and the rule's own reasoning is what licenses it: the downgrade
 * exists because a refusal against a STATE record leaves a resource
 * un-rollbackable with no template-side remedy. That presupposes the replay
 * could otherwise SUCCEED. Here it cannot -- every combination is rejected by
 * AWS 100% of the time (measured above, and CloudFormation rolls back on the
 * same templates), so downgrading would trade a clear cdkd-worded refusal for
 * the identical failure arriving later from AWS, on the create path with a
 * pool to roll back and on the update path with a partial apply. Revisit this
 * if AWS ever starts accepting one of them.
 *
 * That argument is about the REPLAY failing either way, not about state being
 * unable to hold the combination -- the live-list arm can meet a perfectly
 * legitimate record. Example: a record at `ON` with no `SignInPolicy`, then a
 * failed deploy that lowered MFA and added `EMAIL_OTP`; the rollback replays
 * the `ON` record against a live `EMAIL_OTP` and is refused. It would have been
 * rejected by AWS all the same, and in both cases the pool keeps the MFA value
 * the failed deploy left -- a rollback cannot restore `ON` until the live
 * factor list allows it, which the refusal text names.
 */
export function describeUnsupportedMfaCombination(
  properties: Record<string, unknown>,
  declaredMfaConfiguration: string,
  liveFirstAuthFactors?: readonly string[]
): string | undefined {
  // ONE build, reused by every rule -- an earlier revision called
  // `resolveSentMfaConfiguration` for rule 2, which rebuilt the same request a
  // second (and, inside that helper, a third) time for the same bag.
  const request = buildMfaConfigRequest('', properties, undefined, declaredMfaConfiguration);

  if (request && request.MfaConfiguration === 'OFF' && hasAnyMfaFactorBlock(request)) {
    const blocks = [
      ...(request.SmsMfaConfiguration !== undefined ? ['SmsMfaConfiguration'] : []),
      ...(request.SoftwareTokenMfaConfiguration !== undefined
        ? ['SoftwareTokenMfaConfiguration']
        : []),
      ...(request.EmailMfaConfiguration !== undefined ? ['EmailMfaConfiguration'] : []),
    ];
    return (
      `${MFA_CONFIGURATION_PATH} is OFF while an MFA factor is configured ` +
      `(SetUserPoolMfaConfig would carry ${blocks.join(', ')}, built from EnabledMfas / ` +
      `EmailAuthenticationMessage / EmailAuthenticationSubject). AWS rejects that combination ` +
      `("Invalid MFA configuration given, can't turn off MFA and configure an MFA together"), ` +
      `so cdkd refuses it before sending anything rather than leaving a partly-applied update ` +
      `behind. Set MfaConfiguration to ON or OPTIONAL (or remove it) to enable the declared ` +
      `factor. (If MFA is genuinely not wanted, remove EnabledMfas / ` +
      `EmailAuthenticationMessage / EmailAuthenticationSubject instead.)`
    );
  }

  // `request &&` is the SCOPE LIMIT from the docstring, not defensive noise: with
  // no MFA-routed property there is no second call, so no partial apply is
  // possible and the combination is AWS's to answer atomically -- which it does,
  // by ACCEPTING a pool whose sign-in policy allows EMAIL_OTP.
  //
  // Reading `request.MfaConfiguration` (the value that will be SENT) rather than
  // `declaredMfaConfiguration` (what the template wrote) keeps rules 2 and 3 on
  // the same footing as rule 1. The two agree for every input today -- the
  // default resolves to OPTIONAL or OFF and never to ON, so only a declared ON
  // reaches here -- and that is exactly why the SENT value is the right one to
  // read: it stays correct if the default rule ever changes, and it cannot
  // disagree with what `applyMfaConfig` puts on the wire.
  if (!request || request.MfaConfiguration !== 'ON') return undefined;

  // The list the pool will hold when SetUserPoolMfaConfig runs (issue #2051):
  // the template's when it SENDS a factor list, otherwise the live one, which
  // an omission preserves (see `sendsFirstAuthFactorList`).
  const fromTemplate = sendsFirstAuthFactorList(properties);
  const factors = fromTemplate
    ? readAllowedFirstAuthFactors(properties)
    : (liveFirstAuthFactors ?? []);
  const where = fromTemplate
    ? `Policies.SignInPolicy.AllowedFirstAuthFactors allows`
    : `the pool's LIVE Policies.SignInPolicy.AllowedFirstAuthFactors allows`;
  // Why the live list is the one that counts, for the live arm only.
  const liveNote = fromTemplate
    ? ''
    : ` (this template does not declare Policies.SignInPolicy.AllowedFirstAuthFactors, and ` +
      `UpdateUserPool PRESERVES an omitted sub-key, so the live list is what ` +
      `SetUserPoolMfaConfig meets)`;
  const partialApply =
    `and on an update the rest of the change has already been applied by the time it does, ` +
    `so cdkd refuses it before sending anything rather than leaving a partly-applied update ` +
    `behind.`;

  // Widened to `readonly string[]` for the membership test ONLY: the constant
  // is `as const satisfies AuthFactorType[]`, so the SDK-enum fence is applied
  // at its declaration and this cast cannot weaken it. Without the widening
  // `includes` demands an `AuthFactorType`, which is the one type this list
  // deliberately does NOT accept -- every member of it is a candidate.
  const denied: readonly string[] = MFA_INCOMPATIBLE_FIRST_AUTH_FACTORS;
  const offending = factors.filter((factor) => denied.includes(factor));
  if (offending.length > 0) {
    // The template arm's text is unchanged from #1975; the integ fixture greps
    // its prefix.
    return fromTemplate
      ? `${MFA_CONFIGURATION_PATH} is ON while ` +
          `Policies.SignInPolicy.AllowedFirstAuthFactors allows ` +
          `${offending.join(', ')}. AWS rejects that combination ("Only PASSWORD and WEB_AUTHN ` +
          `(if configured) can be enabled as an auth factor if MFA is enabled"), and on an ` +
          `update the sign-in policy has already been applied by the time it does, so cdkd ` +
          `refuses it before sending anything rather than leaving a partly-applied update ` +
          `behind. Remove ${offending.join(', ')} from ` +
          `Policies.SignInPolicy.AllowedFirstAuthFactors, leaving PASSWORD. (Setting ` +
          `MfaConfiguration to OPTIONAL or OFF also clears the conflict, but weakens MFA.)`
      : `${MFA_CONFIGURATION_PATH} is ON while ${where} ${offending.join(', ')}${liveNote}. ` +
          `AWS rejects that combination ("Only PASSWORD and WEB_AUTHN (if configured) can be ` +
          `enabled as an auth factor if MFA is enabled"), ${partialApply} Declare ` +
          `Policies.SignInPolicy with AllowedFirstAuthFactors that leave out ` +
          `${offending.join(', ')} (for example [PASSWORD]) -- removing the block cannot remove ` +
          `a factor. (Setting MfaConfiguration to OPTIONAL or OFF also clears the conflict, but ` +
          `weakens MFA.)`;
  }

  // Rule 3 (issue #2064). Reads the REQUEST's FactorConfiguration, never the
  // pool's: an omitted block is SINGLE_FACTOR (measured, see the docstring).
  if (
    factors.includes('WEB_AUTHN') &&
    request.WebAuthnConfiguration?.FactorConfiguration !== WEB_AUTHN_MULTI_FACTOR
  ) {
    return (
      `${MFA_CONFIGURATION_PATH} is ON while ${where} WEB_AUTHN${liveNote} and ` +
      `WebAuthnFactorConfiguration is not ${WEB_AUTHN_MULTI_FACTOR}. AWS rejects that ` +
      `combination ("Cannot set WebAuthn factor configuration to SINGLE_FACTOR if MFA is ` +
      `required and WebAuthn is an allowed first auth factor"), ${partialApply} Set ` +
      `WebAuthnFactorConfiguration to ${WEB_AUTHN_MULTI_FACTOR}, which is the only value AWS ` +
      `accepts beside MFA ON, or ${
        fromTemplate
          ? 'remove WEB_AUTHN from Policies.SignInPolicy.AllowedFirstAuthFactors'
          : 'declare Policies.SignInPolicy with AllowedFirstAuthFactors that leave out WEB_AUTHN'
      }. (Setting MfaConfiguration to OPTIONAL also clears the conflict, but weakens MFA.)`
    );
  }

  return undefined;
}

/**
 * Does this bag put `Policies.SignInPolicy.AllowedFirstAuthFactors` on the
 * wire as a LIST? Only then does the pool's list change. MEASURED us-east-1
 * 2026-09-23: an `UpdateUserPool` carrying `SignInPolicy: {}` landed (its
 * `AutoVerifiedAttributes` canary applied) and left a live
 * `[PASSWORD, EMAIL_OTP]` intact -- so a SENT sub-key without the member is,
 * for the factor list, the same as an omitted one. The sub-key gate is the
 * wire's own (`sendsPoliciesSubKey`); the member gate mirrors
 * `readAllowedFirstAuthFactors`, which reads a non-list as nothing. A declared
 * non-list takes the live arm, the side that can refuse (what AWS does with
 * that shape is unmeasured). An EMPTY list counts as sent and judges nothing, which is safe:
 * MEASURED the same day, `UpdateUserPool` rejects `AllowedFirstAuthFactors: []`
 * ("Member must have length greater than or equal to 1") atomically -- its
 * co-sent `AutoVerifiedAttributes` did not land.
 */
function sendsFirstAuthFactorList(properties: Record<string, unknown>): boolean {
  if (!sendsPoliciesSubKey(properties, 'SignInPolicy')) return false;
  const signInPolicy = (properties['Policies'] as Record<string, unknown>)[
    'SignInPolicy'
  ] as Record<string, unknown>;
  return Array.isArray(signInPolicy['AllowedFirstAuthFactors']);
}

/**
 * Does the pre-flight need the pool's LIVE first-auth-factor list (issue
 * #2051)? Only when rules 2 / 3 can evaluate -- a `SetUserPoolMfaConfig`
 * request resolving to ON -- AND the template does not send
 * `Policies.SignInPolicy`, so the live list is what that call will meet. Every
 * other update spends no extra read.
 */
export function mfaPreflightNeedsLiveSignInPolicy(
  properties: Record<string, unknown>,
  declaredMfaConfiguration: string
): boolean {
  const request = buildMfaConfigRequest('', properties, undefined, declaredMfaConfiguration);
  return request?.MfaConfiguration === 'ON' && !sendsFirstAuthFactorList(properties);
}

/**
 * Could this update need `SetUserPoolMfaConfig` BEFORE `UpdateUserPool`
 * (issue #3562)? True only for the shape that FAILS in cdkd's usual order and
 * DEPLOYS under CloudFormation: the request keeps MFA `ON`, carries
 * `FactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION`, and the
 * template's factor list includes `WEB_AUTHN`. Whether the order actually
 * flips is then decided by the pool's LIVE MFA state
 * (`readMfaFirstPrior`) -- this only decides whether that read is worth making.
 *
 * MEASURED us-east-1 2026-09-23, from a pool at `ON` + SINGLE_FACTOR +
 * `[PASSWORD]`:
 *
 *   UpdateUserPool adding WEB_AUTHN first -> REJECTED ("WEB_AUTHN cannot be
 *     used as an auth factor when MFA is enabled if not configured for MFA")
 *   SetUserPoolMfaConfig(ON, MULTI) first, then UpdateUserPool -> both ACCEPTED
 *   CloudFormation, the same template edit -> UPDATE_COMPLETE
 *
 * The OTHER order-dependent edit the issue measured -- lowering MFA from `ON`
 * while ADDING `EMAIL_OTP` / `SMS_OTP` -- deliberately keeps cdkd's order:
 * CloudFormation ROLLS BACK that edit (same day, UPDATE_ROLLBACK_COMPLETE with
 * the same AWS message), so succeeding there would hide from a cdkd user a
 * failure their production CloudFormation deploy will hit. cdkd's own
 * rejection is atomic (`UpdateUserPool` refuses before anything lands).
 */
export function mfaMayNeedToPrecedeUpdateUserPool(
  properties: Record<string, unknown>,
  declaredMfaConfiguration: string
): boolean {
  const request = buildMfaConfigRequest('', properties, undefined, declaredMfaConfiguration);
  return (
    request?.MfaConfiguration === 'ON' &&
    request.WebAuthnConfiguration?.FactorConfiguration === WEB_AUTHN_MULTI_FACTOR &&
    // Reads the SENT list: `readAllowedFirstAuthFactors` answers `[]` unless
    // `AllowedFirstAuthFactors` is a list, so this also implies one is sent.
    readAllowedFirstAuthFactors(properties).includes('WEB_AUTHN')
  );
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
export function narrowMfaConfiguration(
  properties: Record<string, unknown>
): Record<string, unknown> {
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
    // Copy-and-`delete`: drops `MfaConfiguration` from a shallow copy, leaving
    // the caller's bag untouched.
    const withoutMfaConfiguration = { ...properties };
    delete withoutMfaConfiguration['MfaConfiguration'];
    return withoutMfaConfiguration;
  }
  return { ...properties, MfaConfiguration: sent };
}
