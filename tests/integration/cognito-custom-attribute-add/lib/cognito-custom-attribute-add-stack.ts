import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

// cdkd Cognito add-custom-attribute integ probe.
//
// Phase 1 (base): a User Pool with custom attributes tenantId + level.
// Phase 2 (CDKD_TEST_UPDATE=true): add a third custom attribute `region`, and
//   rename the pool (issue #5358: update() never sent PoolName, so the rename
//   deployed "successfully" while AWS kept the old name).
// Phase 2b (CDKD_TEST_UPDATE=true + CDKD_TEST_USERNAME_CHANGE=true): also flip
//   signInCaseSensitive, a UsernameConfiguration change UpdateUserPool has no
//   member for. CloudFormation refuses it ("Updates are not allowed for
//   property"); cdkd must refuse too instead of dropping it (issue #5358).
//
// AWS supports adding a custom attribute in place (AddCustomAttributes), but
// cdkd's cognito-provider.update() previously ignored Schema entirely, so the
// added attribute was silently dropped (the deploy reported success, AWS kept
// the old schema, and the next diff saw the change again with nothing applied).
// The fix wires AddCustomAttributes into update(); this fixture proves the
// added attribute actually reaches AWS.
export class CognitoCustomAttributeAddStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const addAttr = process.env.CDKD_TEST_UPDATE === 'true';
    const usernameChange = process.env.CDKD_TEST_USERNAME_CHANGE === 'true';

    const customAttributes: Record<string, cognito.ICustomAttribute> = {
      tenantId: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: true }),
      level: new cognito.NumberAttribute({ min: 0, max: 100, mutable: false }),
    };
    if (addAttr) {
      customAttributes['region'] = new cognito.StringAttribute({ mutable: true });
    }

    // Issue #1160: Phase 1 also declares a tag, OPTIONAL software-token MFA and
    // an ADMIN_ONLY account recovery; Phase 2 removes all three. CloudFormation
    // untags the key, turns MFA OFF, and keeps the account recovery setting.
    const pool = new cognito.UserPool(this, 'Pool', {
      userPoolName: addAttr ? 'cdkd-cognito-attr-add-test-renamed' : 'cdkd-cognito-attr-add-test',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      customAttributes,
      ...(usernameChange ? { signInCaseSensitive: false } : {}),
      ...(addAttr
        ? {}
        : {
            mfa: cognito.Mfa.OPTIONAL,
            mfaSecondFactor: { sms: false, otp: true },
            accountRecovery: cognito.AccountRecovery.NONE,
          }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    if (addAttr) {
      // The L2 always synthesizes AccountRecoverySetting, so remove it by hand.
      (pool.node.defaultChild as cognito.CfnUserPool).addPropertyDeletionOverride(
        'AccountRecoverySetting'
      );
    } else {
      cdk.Tags.of(pool).add('cdkd-1160-removed', 'phase1');
    }
  }
}
