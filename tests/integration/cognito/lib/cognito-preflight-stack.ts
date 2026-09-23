import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * The MFA pre-flight refusal arms (issues #1975, #1977, #2064 and #2051).
 *
 * A SEPARATE stack from `CognitoStack` on purpose. Both refusal arms need an
 * UPDATE deploy that FAILS, while `CognitoStack`'s own `CDKD_TEST_UPDATE` phase
 * needs one that SUCCEEDS -- the two cannot share a deploy, and folding them
 * into one stack would make each arm's evidence depend on the other arm's
 * failure not having cancelled it.
 *
 * The refusing arms are selected ONE AT A TIME by `CDKD_TEST_PREFLIGHT_ARM`
 * (`A`, `B`, `D`, `E`, `F`, `G` or `H`), rather than mutating several in one update deploy. That is
 * load-bearing rather than tidiness: the deploy engine sets `interrupted` on
 * the FIRST resource failure and cancels pending siblings, so a single update
 * carrying both mutations could legitimately log one refusal and never reach
 * the other -- and the run would then "pass" with one arm unexercised. One arm
 * per deploy means each refusal is individually attributed and neither can hide
 * behind the other.
 *
 * WHAT EACH ARM PROVES
 *
 * Arm A (#1977) -- `MfaConfiguration` pinned to OFF beside a declared MFA
 * factor. The update ALSO changes one unrelated mutable field
 * (`AutoVerifiedAttributes`) as a CANARY. `AutoVerifiedAttributes` is chosen
 * because the provider forwards it on `UpdateUserPool` and AWS is MEASURED to
 * reset it when omitted, so it is a field whose post-refusal value is
 * unambiguous. Pre-fix the ordering is `UpdateUserPool` first (canary lands),
 * `SetUserPoolMfaConfig` second (rejected) -- so the canary having NOT moved is
 * the proof that no AWS call went out at all. Post-fix the refusal is raised
 * before the first call and the canary stays empty.
 *
 * Arm B (#1975) -- `MfaConfiguration: ON` beside a sign-in policy that allows
 * `EMAIL_OTP` as a first auth factor. Here the canary IS the payload: the
 * loosened `Policies.SignInPolicy` is exactly what `UpdateUserPool` carries and
 * what pre-fix landed while the MFA half was refused. The pool must still
 * report `[PASSWORD]` afterwards.
 *
 * Arms C1..C4 -- the NEGATIVE controls, which exist to stop an over-broad
 * refusal shipping. They are never mutated; they only have to deploy CLEANLY in
 * the base phase.
 *
 * Arm D (#2064) -- `WEB_AUTHN` added to the sign-in policy while MFA goes ON,
 * WITHOUT `WebAuthnFactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION`.
 * Same canary as arm B: the sign-in policy is the payload `UpdateUserPool`
 * would land before `SetUserPoolMfaConfig(ON)` is rejected.
 *
 * Arm E (#2051) -- the LIVE-state arm. `Policies` is DELETED from the template
 * (so `UpdateUserPool` preserves the live `[PASSWORD, EMAIL_OTP]`) while MFA
 * goes ON, plus an `AutoVerifiedAttributes` canary as in arm A. Only a read of
 * the live pool can see the conflict; the template alone carries none.
 *
 * Arm F (#2064) -- the ACCEPTING shape on arm D's pool, which must SUCCEED:
 * the same edit plus `WebAuthnFactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION`.
 * Run after D, so the pool it updates is the one D's refusal left untouched.
 *
 * Arm G (#3562) -- the same accepting edit from a pool already at ON (arm B's
 * pool, after B's refusal left it at `ON` + `[PASSWORD]`). `UpdateUserPool`
 * refuses to add `WEB_AUTHN` there until the factor configuration changed, so
 * this deploys only because `SetUserPoolMfaConfig` now goes FIRST; it deploys
 * under CloudFormation too (measured).
 *
 * Arm H (#3562, the PARITY fence) -- on control C4's pool (live `ON`), lower
 * MFA to `OPTIONAL` while ADDING `EMAIL_OTP`. CloudFormation rolls this edit
 * back (measured), so it must still FAIL, atomically, with the pool untouched:
 * a "fix" that reordered it would hide a production failure.
 */
export class CognitoPreflightStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // `A` mutates the #1977 pool, `B` / `G` the #1975 pool, `D` / `F` the
    // #2064 pool, `E` the #2051 pool, `H` control C4's pool; anything else
    // (including unset) is the BASE arm that must deploy cleanly. Deliberately NOT keyed
    // on `CDKD_TEST_UPDATE`: `CognitoStack`'s update phase sets that variable
    // and synthesizes this app too, and an arm that reacted to it would flip
    // shape during a deploy that is not looking at it.
    const arm = process.env.CDKD_TEST_PREFLIGHT_ARM;
    // The SUCCEEDING arms run in the order F, G, H, and each later deploy
    // synthesizes every pool, so a pool an earlier arm changed must KEEP that
    // shape in the later arms -- otherwise arm G would silently revert arm F's
    // pool, and arm H arm G's, as an unasserted extra update. (A refused arm
    // leaves its pool at base, so the refusing arms need no such carry.)
    const afterF = arm === 'F' || arm === 'G' || arm === 'H';
    const afterG = arm === 'G' || arm === 'H';

    // --- Arm A (issue #1977) ------------------------------------------------
    // Base: MFA genuinely on (OPTIONAL + a real factor) and NO
    // `AutoVerifiedAttributes` -- the canary's baseline is its ABSENCE, so a
    // canary that lands is visible as a value appearing rather than as one
    // value replacing another.
    //
    // Update: `MfaConfiguration: OFF` while `EnabledMfas` still declares
    // SOFTWARE_TOKEN_MFA (the combination AWS rejects 100% of the time), plus
    // the canary. Do NOT drop `enabledMfas` on the update arm -- its presence
    // is what builds the `SoftwareTokenMfaConfiguration` block the refusal is
    // keyed on, and without it the arm becomes a plain, accepted MFA downgrade.
    const preflightOffPool = new cognito.CfnUserPool(this, 'PreflightOffPool', {
      userPoolName: `cdkd-test-mfa-preflight-off-${cdk.Aws.ACCOUNT_ID}`,
      // EnabledMfas requires the ESSENTIALS tier (or higher).
      userPoolTier: 'ESSENTIALS',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
      mfaConfiguration: arm === 'A' ? 'OFF' : 'OPTIONAL',
      ...(arm === 'A' ? { autoVerifiedAttributes: ['email'] } : {}),
    });
    preflightOffPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // --- Arm B (issue #1975) ------------------------------------------------
    // Base: ESSENTIALS tier (required by `SignInPolicy`), MFA really ON with a
    // real factor, and a sign-in policy allowing only PASSWORD -- which AWS
    // accepts alongside MFA, so the base arm doubles as negative control C1
    // (see below).
    //
    // Update: `EMAIL_OTP` is ADDED to the sign-in policy while MFA stays ON.
    const preflightSignInPool = new cognito.CfnUserPool(this, 'PreflightSignInPool', {
      userPoolName: `cdkd-test-mfa-preflight-signin-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
      mfaConfiguration: 'ON',
      ...(afterG ? { webAuthnFactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION' } : {}),
      policies: {
        signInPolicy: {
          allowedFirstAuthFactors:
            arm === 'B'
              ? ['PASSWORD', 'EMAIL_OTP']
              : afterG
                ? ['PASSWORD', 'WEB_AUTHN']
                : ['PASSWORD'],
        },
      },
    });
    preflightSignInPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // --- Negative control C1 ------------------------------------------------
    // Not a pool of its own: it is `PreflightSignInPool`'s BASE arm, asserted
    // in the base phase. It is the shape in which the #1975 rule actually
    // EVALUATES (`MfaConfiguration` resolves to ON and a `SignInPolicy` is
    // present) and must NOT fire, because every allowed member is allowed. A
    // refusal keyed on "ON plus any SignInPolicy" instead of on the deny-listed
    // members would fail the base deploy here.

    // --- Negative control C2 ------------------------------------------------
    // A deny-listed member (`EMAIL_OTP`) present while `MfaConfiguration` is
    // OPTIONAL. MEASURED us-east-1 2026-08-19: AWS ACCEPTS this, which is why
    // the rule is narrowed to `=== 'ON'`. This arm is the fence on that
    // narrowing: widening the refusal to `!== 'OFF'` -- the obvious "be safe"
    // edit -- refuses a template AWS deploys happily, and this pool's create
    // fails the moment someone makes it.
    const preflightOptionalEmailOtpPool = new cognito.CfnUserPool(
      this,
      'PreflightOptionalEmailOtpPool',
      {
        userPoolName: `cdkd-test-mfa-preflight-optional-${cdk.Aws.ACCOUNT_ID}`,
        userPoolTier: 'ESSENTIALS',
        enabledMfas: ['SOFTWARE_TOKEN_MFA'],
        mfaConfiguration: 'OPTIONAL',
        policies: {
          signInPolicy: {
            allowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'],
          },
        },
      }
    );
    preflightOptionalEmailOtpPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // --- Negative control C3 ------------------------------------------------
    // `WEB_AUTHN` in the sign-in policy alongside a configured passkey setup
    // and a real MFA factor. The refusal must not treat WEB_AUTHN as a denied
    // member.
    //
    // `MfaConfiguration` is OPTIONAL here, and that is NOT the arm we wanted --
    // it is the strongest one cdkd can currently REACH. MEASURED us-east-1
    // 2026-08-20, on a pool whose sign-in policy allows WEB_AUTHN:
    //
    //   SetUserPoolMfaConfig(ON, SoftwareTokenMfa, no WebAuthn block)
    //     -> InvalidParameterException: Cannot set WebAuthn factor
    //        configuration to SINGLE_FACTOR if MFA is required and WebAuthn is
    //        an allowed first auth factor
    //   ... + WebAuthnConfiguration{UserVerification: preferred | required}
    //     -> same rejection
    //   ... + WebAuthnConfiguration{FactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION}
    //     -> ACCEPTED
    //   SetUserPoolMfaConfig(OPTIONAL, SoftwareTokenMfa, FactorConfiguration SINGLE_FACTOR)
    //     -> ACCEPTED  <- this arm
    //
    // The ON arm is control C4 below, now that `WebAuthnFactorConfiguration`
    // is sendable (issue #2064). This one stays at OPTIONAL: it is the fence
    // on rule 3's `=== 'ON'` narrowing, since SINGLE_FACTOR is ACCEPTED here.
    const preflightWebAuthnPool = new cognito.CfnUserPool(this, 'PreflightWebAuthnPool', {
      userPoolName: `cdkd-test-mfa-preflight-webauthn-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
      mfaConfiguration: 'OPTIONAL',
      webAuthnRelyingPartyId: 'preflight.cdkd.example.com',
      webAuthnUserVerification: 'required',
      policies: {
        signInPolicy: {
          allowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'],
        },
      },
    });
    preflightWebAuthnPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // --- Negative control C4 (issue #2064) ----------------------------------
    // The ACCEPTING shape on the CREATE path: WEB_AUTHN + MfaConfiguration ON +
    // WebAuthnFactorConfiguration MULTI_FACTOR_WITH_USER_VERIFICATION. Rule 3
    // evaluates and must NOT fire; before #2064 this property was not sendable
    // at all, so the shape could not deploy through cdkd's SDK path.
    const preflightWebAuthnOnPool = new cognito.CfnUserPool(this, 'PreflightWebAuthnOnPool', {
      userPoolName: `cdkd-test-mfa-preflight-webauthn-on-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
      mfaConfiguration: arm === 'H' ? 'OPTIONAL' : 'ON',
      webAuthnFactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
      policies: {
        signInPolicy: {
          allowedFirstAuthFactors:
            arm === 'H' ? ['PASSWORD', 'WEB_AUTHN', 'EMAIL_OTP'] : ['PASSWORD', 'WEB_AUTHN'],
        },
      },
    });
    preflightWebAuthnOnPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // --- Arms D and F (issue #2064) -----------------------------------------
    // Base: MFA OPTIONAL with a real factor and a PASSWORD-only sign-in policy
    // -- NOT ON, because from a pool already at ON `UpdateUserPool` refuses to
    // add WEB_AUTHN by itself (measured), atomically, and there would be no
    // partial apply to prevent. From OPTIONAL it LANDS (measured 2026-09-23).
    //
    // D: ON + WEB_AUTHN, no factor configuration -> refused, nothing sent.
    // F: the same plus MULTI -> must deploy.
    const webAuthnArm = arm === 'D' || afterF;
    const preflightWebAuthnSinglePool = new cognito.CfnUserPool(
      this,
      'PreflightWebAuthnSinglePool',
      {
        userPoolName: `cdkd-test-mfa-preflight-webauthn-single-${cdk.Aws.ACCOUNT_ID}`,
        userPoolTier: 'ESSENTIALS',
        enabledMfas: ['SOFTWARE_TOKEN_MFA'],
        mfaConfiguration: webAuthnArm ? 'ON' : 'OPTIONAL',
        ...(afterF ? { webAuthnFactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION' } : {}),
        policies: {
          signInPolicy: {
            allowedFirstAuthFactors: webAuthnArm ? ['PASSWORD', 'WEB_AUTHN'] : ['PASSWORD'],
          },
        },
      }
    );
    preflightWebAuthnSinglePool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // --- Arm E (issue #2051) ------------------------------------------------
    // Base: the C2 shape (EMAIL_OTP allowed under OPTIONAL, which AWS accepts).
    // E: `Policies` DELETED + MFA ON + an AutoVerifiedAttributes canary. The
    // template then declares no factor at all, so only the live read can see
    // that the pool still allows EMAIL_OTP -- an omitted sub-key is preserved.
    const preflightLivePolicyPool = new cognito.CfnUserPool(this, 'PreflightLivePolicyPool', {
      userPoolName: `cdkd-test-mfa-preflight-live-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
      mfaConfiguration: arm === 'E' ? 'ON' : 'OPTIONAL',
      ...(arm === 'E'
        ? { autoVerifiedAttributes: ['email'] }
        : {
            policies: {
              signInPolicy: {
                allowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'],
              },
            },
          }),
    });
    preflightLivePolicyPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'PreflightOffPoolId', { value: preflightOffPool.ref });
    new cdk.CfnOutput(this, 'PreflightSignInPoolId', { value: preflightSignInPool.ref });
    new cdk.CfnOutput(this, 'PreflightOptionalEmailOtpPoolId', {
      value: preflightOptionalEmailOtpPool.ref,
    });
    new cdk.CfnOutput(this, 'PreflightWebAuthnPoolId', { value: preflightWebAuthnPool.ref });
    new cdk.CfnOutput(this, 'PreflightWebAuthnOnPoolId', { value: preflightWebAuthnOnPool.ref });
    new cdk.CfnOutput(this, 'PreflightWebAuthnSinglePoolId', {
      value: preflightWebAuthnSinglePool.ref,
    });
    new cdk.CfnOutput(this, 'PreflightLivePolicyPoolId', { value: preflightLivePolicyPool.ref });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'cognito');
  }
}
