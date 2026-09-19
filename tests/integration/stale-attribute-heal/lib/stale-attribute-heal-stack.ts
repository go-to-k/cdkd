import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * The scenario issue #1852 opens with.
 *
 * v1 (default): one `AWS::SSM::Parameter`, and NO reference to its `Arn`.
 * v2 (`CDKD_TEST_UPDATE=true`): the SAME parameter, byte-identical, plus ONE
 * output reading `param.attrArn`. No resource property changes between the two,
 * so the v2 deploy takes cdkd's no-change path and never runs the provider's
 * `update()` — which is exactly why a record that lacks `Arn` used to stay
 * broken forever. `verify.sh` strips `Arn` from the state record between the
 * two deploys to reproduce a record written by a pre-#1824 binary.
 *
 * An L1 `CfnParameter` on purpose: the L2's `parameterArn` is an `Fn::Join`
 * built from the NAME, which never asks cdkd for the `Arn` attribute at all.
 */
export class StaleAttributeHealStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const param = new ssm.CfnParameter(this, 'Param', {
      // A literal: parameter names are per account + region, and `verify.sh`
      // reads the live parameter by this exact name.
      name: '/cdkd-test/stale-attribute-heal/param',
      type: 'String',
      value: 'stale-attribute-heal',
    });

    if (process.env.CDKD_TEST_UPDATE === 'true') {
      new cdk.CfnOutput(this, 'ParamArn', { value: param.attrArn });
    }
  }
}
