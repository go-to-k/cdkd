import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * Cognito example stack
 *
 * Demonstrates:
 * - AWS::Cognito::UserPool
 * - AWS::Cognito::UserPoolDomain
 * - AWS::Cognito::UserPool #609 backfill properties (UserPoolTier / EnabledMfas
 *   / EmailAuthenticationMessage+Subject / WebAuthnRelyingPartyID+UserVerification)
 * - AWS::Cognito::UserPool passkey-only shape (#1920): WebAuthn with no MFA
 *   factor and no MfaConfiguration, which must land as MfaConfiguration OFF
 * - AWS::Cognito::UserPool MFA update transitions (#1925), under
 *   CDKD_TEST_UPDATE=true: enabling MFA on an existing pool (the UpdateUserPool
 *   gate) and dropping an undeclared MfaConfiguration back to OFF (the
 *   announced downgrade)
 */
export class CognitoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // User Pool
    const userPool = new cognito.UserPool(this, 'TestUserPool', {
      userPoolName: `cdkd-test-pool-${cdk.Aws.ACCOUNT_ID}`,
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      // Passwordless sign-in policy (issue #1380): synthesizes
      // Policies.SignInPolicy.AllowedFirstAuthFactors, which the provider
      // silently dropped on create/update before the fix. EMAIL_OTP as a
      // FIRST auth factor works with the default Cognito email sender
      // (unlike EMAIL_OTP as MFA, which needs SES — see the BackfillUserPool
      // note below). Requires the ESSENTIALS tier, so it is set explicitly.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInPolicy: {
        allowedFirstAuthFactors: { password: true, emailOtp: true },
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // UserPool Domain (hosted UI)
    userPool.addDomain('Domain', {
      cognitoDomain: {
        domainPrefix: `cdkd-test-${this.account}`,
      },
    });

    // L1 UserPool exercising the issue #609 backfill properties. Uses
    // CfnUserPool (not the L2 UserPool) so each backfill property is set
    // explicitly and the integ can assert the exact SDK-path wire shape. None
    // of this template's top-level properties are silent-drop, so cdkd routes
    // the pool through the SDK CognitoUserPoolProvider (not the CC-API
    // fallback) — the path the backfill code lives on.
    //
    // Properties exercised:
    // - UserPoolTier         (CreateUserPool direct)
    // - EnabledMfas          (SetUserPoolMfaConfig: SOFTWARE_TOKEN_MFA)
    // - WebAuthnRelyingPartyID / WebAuthnUserVerification
    //                        (SetUserPoolMfaConfig.WebAuthnConfiguration)
    //
    // WebAuthn passkeys + EnabledMfas require the ESSENTIALS tier (or higher),
    // so UserPoolTier must be set. MfaConfiguration must be ON/OPTIONAL for the
    // SetUserPoolMfaConfig factor enablement to be accepted. cdkd issues
    // CreateUserPool WITHOUT MfaConfiguration here (AWS would reject ON/OPTIONAL
    // before a factor is enabled) and SetUserPoolMfaConfig sets it + the factor
    // together — the order CloudFormation/CDK use.
    //
    // NOTE: EMAIL_OTP + EmailAuthenticationMessage/Subject are intentionally
    // NOT exercised here. AWS rejects EmailMfaConfiguration unless the pool's
    // EmailConfiguration uses a real SES sender (EmailSendingAccount=DEVELOPER
    // with a verified SES identity) — the default COGNITO_DEFAULT sender is
    // refused. Verifying an SES identity is an async / manual prerequisite a
    // portable automated integ cannot set up, so EMAIL_OTP / EmailAuthentication*
    // stay unit-test-only (the provider wiring is correct + exercised by the
    // unit suite; a real-AWS assertion would need an SES-configured account).
    const backfillPool = new cognito.CfnUserPool(this, 'BackfillUserPool', {
      userPoolName: `cdkd-test-backfill-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      // Deliberately ON, not OPTIONAL: OPTIONAL is exactly what the no-value
      // default produces for a pool with a factor, so an OPTIONAL here could
      // not distinguish "the template's explicit value was threaded through"
      // from "the default fired". ON is reachable only by threading.
      mfaConfiguration: 'ON',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
      webAuthnRelyingPartyId: 'auth.cdkd.example.com',
      webAuthnUserVerification: 'preferred',
    });
    backfillPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Passkey-only pool (issue #1920). WebAuthn is configured as the FIRST
    // auth factor with NO MFA factor and — the load-bearing part — NO
    // MfaConfiguration property at all. CloudFormation defaults that to OFF,
    // but cdkd used to default the post-create SetUserPoolMfaConfig call to
    // OPTIONAL, and AWS rejects OPTIONAL when no real MFA factor is enabled
    // ("Invalid MFA Configuration given. SMS MFA, Email MFA, or Software Token
    // MFA must be enabled."), which failed the create and then rolled the pool
    // back via the post-create atomicity path.
    //
    // DO NOT set mfaConfiguration on this pool: its ABSENCE is the input under
    // test. Setting it would make the arm vacuous — the explicit value would
    // be threaded through and the defaulting branch never exercised.
    const passkeyOnlyPool = new cognito.CfnUserPool(this, 'PasskeyOnlyUserPool', {
      userPoolName: `cdkd-test-passkey-only-${cdk.Aws.ACCOUNT_ID}`,
      // WebAuthn passkeys require the ESSENTIALS tier (or higher).
      userPoolTier: 'ESSENTIALS',
      webAuthnRelyingPartyId: 'passkey.cdkd.example.com',
      webAuthnUserVerification: 'required',
    });
    passkeyOnlyPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // The OPTIONAL half of the same defaulting rule (issue #1920). A real MFA
    // factor with NO MfaConfiguration must still land as OPTIONAL -- otherwise
    // the fix's own failure mode is the dangerous one: a pool that declared a
    // factor would deploy with MFA switched OFF. As with the passkey pool, the
    // ABSENCE of mfaConfiguration is the input under test -- do not add one.
    const factorDefaultPool = new cognito.CfnUserPool(this, 'FactorDefaultUserPool', {
      userPoolName: `cdkd-test-factor-default-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });
    factorDefaultPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ---------------------------------------------------------------------
    // CDKD_TEST_UPDATE arms (issue #1925). Both pools below CHANGE shape
    // between the base deploy and the update deploy; that transition is the
    // subject under test, so neither arm may be made to look like the other.
    // ---------------------------------------------------------------------
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // Item 1 -- the enable-MFA-on-update transition.
    //
    // Base arm: NO MfaConfiguration and NO EnabledMfas, so the pool is created
    // with MFA genuinely off and `hasMfaConfigProps` is false (no
    // SetUserPoolMfaConfig call happens at all).
    // Update arm: MfaConfiguration + a real factor arrive together.
    //
    // Before the fix, `update()` forwarded MfaConfiguration to UpdateUserPool
    // unconditionally. That call runs BEFORE the SetUserPoolMfaConfig that
    // enables the factor, so AWS sees "MFA required/optional" on a pool with no
    // factor enabled -- the rejection the create path has always gated against.
    // The fix applies the same `!hasMfaConfigProps` gate on update, so
    // MfaConfiguration travels on SetUserPoolMfaConfig together with the factor.
    //
    // ON, not OPTIONAL, on the update arm: OPTIONAL is exactly what the
    // no-value default produces for a pool that declares a factor, so an
    // OPTIONAL assertion could not tell a threaded explicit value from a fired
    // default. ON is reachable only by threading, and it triggers the same
    // pre-fix UpdateUserPool rejection. Same argument as BackfillUserPool above.
    const mfaTransitionPool = new cognito.CfnUserPool(this, 'MfaTransitionUserPool', {
      userPoolName: `cdkd-test-mfa-transition-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      ...(isUpdate
        ? { mfaConfiguration: 'ON', enabledMfas: ['SOFTWARE_TOKEN_MFA'] }
        : {}),
    });
    mfaTransitionPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Item 3 -- the undeclared downgrade to OFF is ANNOUNCED, not silent.
    //
    // Base arm: MFA really on (OPTIONAL + SOFTWARE_TOKEN_MFA) alongside a
    // WebAuthn config.
    // Update arm: MfaConfiguration and EnabledMfas both REMOVED, leaving only
    // the WebAuthn config.
    //
    // WebAuthn is not an MFA factor, so on the update arm `hasMfaConfigProps`
    // is still true (SetUserPoolMfaConfig runs) while the resolved
    // MfaConfiguration defaults to OFF -- and because that call is a full
    // replace, the live OPTIONAL is overwritten and the factor is dropped. That
    // is template-is-truth / CloudFormation parity and is deliberately NOT
    // changed; what the fix adds is a warning naming the live value it is about
    // to turn off. The WebAuthn config must stay on BOTH arms: it is what keeps
    // the update routed through SetUserPoolMfaConfig at all, and dropping it
    // would make the arm vacuous.
    const mfaDowngradePool = new cognito.CfnUserPool(this, 'MfaDowngradeUserPool', {
      userPoolName: `cdkd-test-mfa-downgrade-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      webAuthnRelyingPartyId: 'downgrade.cdkd.example.com',
      webAuthnUserVerification: 'preferred',
      ...(isUpdate
        ? {}
        : { mfaConfiguration: 'OPTIONAL', enabledMfas: ['SOFTWARE_TOKEN_MFA'] }),
    });
    mfaDowngradePool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: userPool.userPoolArn,
    });

    new cdk.CfnOutput(this, 'BackfillUserPoolId', {
      value: backfillPool.ref,
    });

    new cdk.CfnOutput(this, 'PasskeyOnlyUserPoolId', {
      value: passkeyOnlyPool.ref,
    });

    new cdk.CfnOutput(this, 'FactorDefaultUserPoolId', {
      value: factorDefaultPool.ref,
    });

    new cdk.CfnOutput(this, 'MfaTransitionUserPoolId', {
      value: mfaTransitionPool.ref,
    });

    new cdk.CfnOutput(this, 'MfaDowngradeUserPoolId', {
      value: mfaDowngradePool.ref,
    });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'cognito');
  }
}
