import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export const NOECHO_PARAM_EXPORT_NAME = 'CdkdCrNoEchoNestedParamValue';

/**
 * The CHILD of {@link ParamValueStack}: a CDK nested stack, whose parameters
 * are never declared `NoEcho`, fed the parent's `NoEcho` PARAMETER value.
 */
class ParamValueChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pinned so the child's cdkd state key is `<parent>~ParamValueChild`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('ParamValueChild');
    const value = new cdk.CfnParameter(this, 'ParentValue', { type: 'String' });
    new ssm.StringParameter(this, 'ChildValue', {
      parameterName: '/cdkd-integ/cr-noecho-nested/paramvalue-child/value',
      stringValue: value.valueAsString,
    });
  }
}

/**
 * A `NoEcho` template PARAMETER (go-to-k/cdkd#4043, schema v11, design §8):
 * its value is passed to a nested child, read by a same-stack SSM parameter,
 * and EXPORTED. Every persisted copy is `***`; the consumer stack imports the
 * export, which the in-run recovery serves in one `deploy --all` and a separate
 * run refuses (maintainer decision 2).
 *
 * Its own stack, apart from {@link ParamParentStack}: that stack's nested row
 * also reads a NoEcho CUSTOM RESOURCE attribute, and a row re-sent on every
 * deploy (a NoEcho parameter reader has no readback for a nested stack) would
 * be refused whenever that custom resource does not re-run.
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::SSM::Parameter
 */
export class ParamValueStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const secret = new cdk.CfnParameter(this, 'NoEchoValue', {
      type: 'String',
      noEcho: true,
      // An inert, distinctive literal (verify.sh's PARAMVALUE_TOKEN), so the
      // whole-blob scans cannot collide with ordinary text.
      default: 'noecho-paramvalue-token-integ',
    });
    secret.overrideLogicalId('NoEchoValue');
    new ParamValueChild(this, 'ParamValueChild', {
      parameters: { ParentValue: secret.valueAsString },
    });
    new ssm.StringParameter(this, 'SameStackValue', {
      parameterName: '/cdkd-integ/cr-noecho-nested/paramvalue/value',
      stringValue: secret.valueAsString,
    });
    new cdk.CfnOutput(this, 'NoEchoParamExport', {
      value: secret.valueAsString,
      exportName: NOECHO_PARAM_EXPORT_NAME,
    }).overrideLogicalId('NoEchoParamExport');
  }
}
