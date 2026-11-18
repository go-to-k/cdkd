import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * Integ probe for issue #6548: `cdkd destroy --remove-protection` on a
 * protected user pool whose password policy sets
 * `TemporaryPasswordValidityDays`.
 *
 * covers: AWS::Cognito::UserPool
 *
 * `DescribeUserPool` returns the deprecated
 * `AdminCreateUserConfig.UnusedAccountValidityDays` on every pool, and on this
 * one AWS refuses an `UpdateUserPool` carrying it. cdkd's flip of
 * `DeletionProtection` echoes the read back, so before the fix it fell back
 * to the `DeletionProtection`-only write, which `keepOriginal` (verification
 * required before an email update) makes AWS refuse too: the guard stayed on
 * and the destroy failed. Self sign-up off (`AllowAdminCreateUserOnly: true`)
 * and device tracking are settings that write would reset, so verify.sh reads
 * them after the compensated failure.
 */
export class CognitoRemoveProtectionTempPasswordStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pool = new cognito.UserPool(this, 'Pool', {
      userPoolName: `${id}-pool`,
      signInAliases: { email: true },
      autoVerify: { email: true },
      keepOriginal: { email: true },
      selfSignUpEnabled: false,
      passwordPolicy: { minLength: 12, tempPasswordValidity: cdk.Duration.days(3) },
      deviceTracking: { challengeRequiredOnNewDevice: true, deviceOnlyRememberedOnUserPrompt: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
  }
}
