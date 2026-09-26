import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/** Parameter name the verify script reads back; deterministic for cleanup. */
export const CHILD_PARAMETER_NAME = '/cdkd-integ/nested-stack-replace-guard/param';

/**
 * The child whose destruction the guard must prevent. One SSM parameter is
 * enough: the assertion is that the replacement refusal lands before the
 * child is touched, read back through the parameter's `LastModifiedDate`.
 */
class ChildNestedStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pin the logical id so the child's state key is `<parent>~Child`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');
    new ssm.StringParameter(this, 'Param', {
      parameterName: CHILD_PARAMETER_NAME,
      stringValue: 'child-value',
    });
  }
}

/**
 * Issue #2548: a nested stack's `StackName` is createOnly, so adding one
 * (accepted with `--prefer-sdk-route AWS::CloudFormation::Stack:StackName`)
 * diffs as a replacement of the whole child stack. The guard must refuse it
 * without `--force-stateful-recreation`.
 *
 * `CDKD_TEST_UPDATE=stackname` adds the `StackName` override.
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::SSM::Parameter
 */
export class NestedStackReplaceGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const child = new ChildNestedStack(this, 'Child');
    if ((process.env.CDKD_TEST_UPDATE ?? '').split(',').includes('stackname')) {
      (child.nestedStackResource as cdk.CfnResource).addPropertyOverride(
        'StackName',
        'cdkd-integ-renamed-child'
      );
    }
  }
}
