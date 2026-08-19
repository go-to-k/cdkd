import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * The MFA pre-flight refusal arms (issues #1975 and #1977).
 *
 * A SEPARATE stack from `CognitoStack` on purpose. Both refusal arms need an
 * UPDATE deploy that FAILS, while `CognitoStack`'s own `CDKD_TEST_UPDATE` phase
 * needs one that SUCCEEDS -- the two cannot share a deploy, and folding them
 * into one stack would make each arm's evidence depend on the other arm's
 * failure not having cancelled it.
 *
 * The refusing arms are selected ONE AT A TIME by `CDKD_TEST_PREFLIGHT_ARM`
 * (`A` or `B`), rather than mutating both in a single update deploy. That is
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
 * Arms C1..C3 -- the NEGATIVE controls, which exist to stop an over-broad
 * refusal shipping. They are never mutated; they only have to deploy CLEANLY in
 * the base phase.
 */
export class CognitoPreflightStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // `A` mutates the #1977 pool, `B` the #1975 pool, anything else (including
    // unset) is the BASE arm that must deploy cleanly. Deliberately NOT keyed
    // on `CDKD_TEST_UPDATE`: `CognitoStack`'s update phase sets that variable
    // and synthesizes this app too, and an arm that reacted to it would flip
    // shape during a deploy that is not looking at it.
    const arm = process.env.CDKD_TEST_PREFLIGHT_ARM;

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
      policies: {
        signInPolicy: {
          allowedFirstAuthFactors: arm === 'B' ? ['PASSWORD', 'EMAIL_OTP'] : ['PASSWORD'],
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
    // `FactorConfiguration` is on the live `SetUserPoolMfaConfig` API but NOT on
    // the SDK version this repo pins (@aws-sdk/client-cognito-identity-provider
    // 3.1018.0), and the provider lists `WebAuthnFactorConfiguration` as
    // unhandled-by-design for exactly that reason. So `MfaConfiguration: ON`
    // beside a WEB_AUTHN first-auth factor is UNDEPLOYABLE through cdkd today,
    // for an AWS-side reason that has nothing to do with this pre-flight.
    // Asserting it here would fence AWS's constraint, not cdkd's refusal.
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

    new cdk.CfnOutput(this, 'PreflightOffPoolId', { value: preflightOffPool.ref });
    new cdk.CfnOutput(this, 'PreflightSignInPoolId', { value: preflightSignInPool.ref });
    new cdk.CfnOutput(this, 'PreflightOptionalEmailOtpPoolId', {
      value: preflightOptionalEmailOtpPool.ref,
    });
    new cdk.CfnOutput(this, 'PreflightWebAuthnPoolId', { value: preflightWebAuthnPool.ref });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'cognito');
  }
}
