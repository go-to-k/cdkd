import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * covers: AWS::SSM::Parameter
 *
 * Exercises stack-level `terminationProtection` (go-to-k/cdkd#5238): a stack
 * deployed with it set must refuse `cdkd destroy` / `cdkd state destroy`
 * unless `--remove-protection` is passed, the same way CloudFormation refuses
 * a protected stack's delete. `CDKD_TEST_UPDATE=true` flips the CDK-code
 * setting off (nothing else about the stack changes) so the fixture can
 * assert that a redeploy clears the recorded flag too.
 */
export class TerminationProtectionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      terminationProtection: process.env.CDKD_TEST_UPDATE === 'true' ? false : true,
    });

    new ssm.StringParameter(this, 'Param', {
      stringValue: 'protected',
    });
  }
}
