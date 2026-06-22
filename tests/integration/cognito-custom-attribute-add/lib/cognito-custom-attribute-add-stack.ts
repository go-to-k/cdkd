import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

// cdkd Cognito add-custom-attribute integ probe.
//
// Phase 1 (base): a User Pool with custom attributes tenantId + level.
// Phase 2 (CDKD_TEST_UPDATE=true): add a third custom attribute `region`.
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

    const customAttributes: Record<string, cognito.ICustomAttribute> = {
      tenantId: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: true }),
      level: new cognito.NumberAttribute({ min: 0, max: 100, mutable: false }),
    };
    if (addAttr) {
      customAttributes['region'] = new cognito.StringAttribute({ mutable: true });
    }

    new cognito.UserPool(this, 'Pool', {
      userPoolName: 'cdkd-cognito-attr-add-test',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      customAttributes,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
