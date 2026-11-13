import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * An `Fn::Select` whose index is past the end of a list only the deploy can
 * resolve (go-to-k/cdkd#6181): the stack name holds no `-`, so splitting it
 * on `-` gives one element and index 1 selects nothing. CloudFormation refuses
 * such a template at CreateStack; cdkd sent the literal
 * `{{Fn::Select:1:OutOfBounds}}` as the parameter value and deployed green.
 *
 * `Good` has no dependency on `Bad`, so it may be created before `Bad` fails:
 * the rollback must remove it.
 */
export class SelectOutOfBoundsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    new ssm.StringParameter(this, 'Good', {
      parameterName: '/cdkd-select-oob/good',
      stringValue: 'ok',
    });
    new ssm.StringParameter(this, 'Bad', {
      parameterName: '/cdkd-select-oob/bad',
      stringValue: cdk.Fn.select(1, cdk.Fn.split('-', cdk.Aws.STACK_NAME)),
    });
  }
}
