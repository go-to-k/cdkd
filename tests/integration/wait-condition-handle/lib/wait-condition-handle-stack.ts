import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudformation from 'aws-cdk-lib/aws-cloudformation';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Regression guard for issue #1020: a stack carrying a bare
 * `AWS::CloudFormation::WaitConditionHandle` failed cdkd's pre-flight
 * outright ("not supported by Cloud Control API and no SDK provider is
 * registered"). The type is emitted by `cdk-multi-region-stack` as an
 * empty-template placeholder, so any app using that construct was
 * undeployable. The no-op `WaitConditionHandleProvider` synthesizes a
 * placeholder physical id and never calls AWS.
 *
 * The stack mirrors the real-world shape: a bare handle (no properties,
 * nothing referencing it) next to an ordinary resource, plus an output
 * `Ref`-ing the handle so the placeholder physical id is exercised through
 * intrinsic resolution.
 *
 * Phase envs (set by verify.sh):
 * - CDKD_TEST_UPDATE=true -> SSM parameter value 'base' -> 'updated'
 *   (the handle itself has no properties; the update deploy must keep its
 *   physical id and not touch AWS for it).
 */
export class WaitConditionHandleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const handle = new cloudformation.CfnWaitConditionHandle(this, 'Placeholder');

    const value = process.env.CDKD_TEST_UPDATE === 'true' ? 'updated' : 'base';
    new ssm.StringParameter(this, 'Param', {
      parameterName: `/${this.stackName}/param`,
      stringValue: value,
    });

    new cdk.CfnOutput(this, 'HandleRef', { value: handle.ref });
  }
}
