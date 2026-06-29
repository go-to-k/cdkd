import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * In-place upstream-attribute propagation.
 *
 * `Derived`'s value embeds `Fn::GetAtt[Base, Value]` (via Fn::Sub). When `Base`
 * is updated IN PLACE (its `Value` property changes, same physical id), the
 * resolved value of `Derived` changes too -- CloudFormation re-evaluates and
 * updates `Derived`. cdkd previously resolved `Derived`'s GetAtt against the
 * CURRENT state at diff time, so `Derived` compared equal (NO_CHANGE) and never
 * re-provisioned -> it kept the STALE upstream value. This fixture proves cdkd
 * now propagates the change.
 *
 *   covers: AWS::SSM::Parameter
 *
 * Phase 1 sets Base=`world`; Derived resolves to `hello-world`. Phase 2
 * (CDKD_TEST_UPDATE=true) changes Base=`world2`; Derived must become
 * `hello-world2` (NOT stay `hello-world`).
 */
export class InplaceAttrPropagationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const baseValue = process.env.CDKD_TEST_UPDATE === 'true' ? 'world2' : 'world';

    const base = new ssm.StringParameter(this, 'Base', {
      parameterName: `/${this.stackName}/base`,
      stringValue: baseValue,
    });

    // Derived embeds Base's Value attribute via Fn::Sub -> Fn::GetAtt[Base, Value].
    new ssm.StringParameter(this, 'Derived', {
      parameterName: `/${this.stackName}/derived`,
      stringValue: cdk.Fn.sub('hello-${BaseVal}', { BaseVal: base.stringValue }),
    });

    new cdk.CfnOutput(this, 'BaseValue', { value: base.stringValue });
  }
}
