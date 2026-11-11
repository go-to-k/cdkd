import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/** The SSM parameter names this fixture creates, read back by verify.sh. */
export const PARAM_PREFIX = '/cdkd/destroy-manifest-deps';

/**
 * go-to-k/cdkd#6115: a stack holding one SSM parameter. With `reads` set, the
 * parameter's value is another stack's parameter ARN, which with
 * `crossRegionReferences: true` crosses regions through CDK's
 * `Custom::CrossRegionExportWriter` / `Reader` and SSM -- the reference
 * leaves only a manifest dependency, no `Fn::ImportValue`.
 *
 * covers: AWS::SSM::Parameter
 */
export class ParamStack extends cdk.Stack {
  public readonly param: ssm.StringParameter;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { paramName: string; reads?: ssm.StringParameter }
  ) {
    super(scope, id, props);
    this.param = new ssm.StringParameter(this, 'Param', {
      parameterName: `${PARAM_PREFIX}/${props.paramName}`,
      stringValue: props.reads !== undefined ? props.reads.parameterArn : props.paramName,
    });
  }
}
