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
    // - EnabledMfas          (SetUserPoolMfaConfig: SOFTWARE_TOKEN_MFA + EMAIL_OTP)
    // - EmailAuthenticationMessage / EmailAuthenticationSubject
    //                        (SetUserPoolMfaConfig.EmailMfaConfiguration)
    // - WebAuthnRelyingPartyID / WebAuthnUserVerification
    //                        (SetUserPoolMfaConfig.WebAuthnConfiguration)
    //
    // EMAIL_OTP, the email-OTP message/subject template, and WebAuthn passkeys
    // all require the ESSENTIALS tier (or higher), so UserPoolTier must be set
    // for the SetUserPoolMfaConfig call to succeed. MfaConfiguration must be
    // ON/OPTIONAL for EnabledMfas to be accepted.
    const backfillPool = new cognito.CfnUserPool(this, 'BackfillUserPool', {
      userPoolName: `cdkd-test-backfill-${cdk.Aws.ACCOUNT_ID}`,
      userPoolTier: 'ESSENTIALS',
      mfaConfiguration: 'OPTIONAL',
      enabledMfas: ['SOFTWARE_TOKEN_MFA', 'EMAIL_OTP'],
      emailAuthenticationMessage: 'Your cdkd sign-in code is {####}',
      emailAuthenticationSubject: 'cdkd sign-in code',
      webAuthnRelyingPartyId: 'auth.cdkd.example.com',
      webAuthnUserVerification: 'preferred',
    });
    backfillPool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

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

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'cognito');
  }
}
