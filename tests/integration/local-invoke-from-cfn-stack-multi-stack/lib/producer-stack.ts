import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface ProducerStackProps extends cdk.StackProps {
  /**
   * The CloudFormation `Export.Name` to publish under. The consumer
   * stack's Lambda env var resolves the same name via
   * `Fn::ImportValue`.
   */
  readonly exportName: string;
}

/**
 * Producer stack for the 2-stack `Fn::ImportValue` integ (issue #611).
 *
 * One SSM Parameter (small / cheap / fast) carrying a stable literal
 * value. Its `Ref` (the parameter name) is published as a CloudFormation
 * output with the configured `Export.Name` so a sibling stack can
 * resolve it via `Fn::ImportValue`.
 *
 * The Parameter's `Ref` (which is the parameter name itself, e.g.
 * `CdkdLocalInvokeMultiStackProducer-SharedParameter-XXXX`) is what
 * gets exported. The consumer's Lambda env var ends up with that exact
 * string when `--from-cfn-stack` substitutes the `Fn::ImportValue`.
 *
 * The integ then reads the same parameter name via
 * `aws cloudformation list-exports` (or `describe-stacks --query
 * Outputs[?ExportName==...]`) and asserts the Lambda echoes back
 * exactly that string.
 */
export class ProducerStack extends cdk.Stack {
  readonly sharedParameter: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: ProducerStackProps) {
    super(scope, id, props);

    this.sharedParameter = new ssm.StringParameter(this, 'SharedParameter', {
      stringValue: 'multi-stack-shared-payload-v1',
      description: 'Shared payload exported to the consumer stack via Fn::ImportValue.',
    });

    new cdk.CfnOutput(this, 'SharedValueExport', {
      value: this.sharedParameter.parameterName,
      exportName: props.exportName,
      description:
        'Export name resolved by the consumer stack\'s Lambda env var via Fn::ImportValue.',
    });
  }
}
