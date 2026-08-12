import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * CloudFormation-fallback cross-stack reference integ fixture (issue #1697).
 *
 * The PRODUCER in this topology is deliberately NOT a cdk/cdkd app: verify.sh
 * creates it with raw `aws cloudformation deploy` from
 * ../cfn-producer-template.json, so it has NO cdkd state record. This CONSUMER
 * stack (deployed via cdkd) references the producer both ways:
 *
 *   1. `Fn::ImportValue 'CdkdCfnFallbackExport'` — must resolve via the
 *      CloudFormation `ListExports` fallback (the export exists in no cdkd
 *      state record).
 *   2. `Fn::GetStackOutput { StackName: 'CdkdCfnFallbackProducer',
 *      OutputName: 'SharedValue' }` — must resolve via the CloudFormation
 *      `DescribeStacks` fallback (the producer has no cdkd state file).
 *
 * Each resolved value lands in an SSM parameter so verify.sh can read the
 * REAL post-deploy values back from AWS and compare them against the
 * producer's outputs (which carry a per-run suffix, proving freshness).
 *
 * The `Fn::GetStackOutput` intrinsic is injected via addPropertyOverride —
 * same pattern as tests/integration/cross-stack-references (the
 * `cdk.Fn.getStackOutput` helper is not available; the synthesized template
 * is identical).
 */

export const PRODUCER_STACK_NAME = 'CdkdCfnFallbackProducer';
export const EXPORT_NAME = 'CdkdCfnFallbackExport';
export const IMPORTVALUE_PARAM_NAME = '/cdkd/cfn-fallback-integ/via-importvalue';
export const GETSTACKOUTPUT_PARAM_NAME = '/cdkd/cfn-fallback-integ/via-getstackoutput';

export class CfnFallbackConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // (1) Fn::ImportValue -> CloudFormation ListExports fallback.
    new ssm.CfnParameter(this, 'ViaImportValue', {
      type: 'String',
      name: IMPORTVALUE_PARAM_NAME,
      value: cdk.Fn.importValue(EXPORT_NAME),
      description: 'cdkd #1697 integ: value resolved via the ListExports fallback',
    });

    // (2) Fn::GetStackOutput -> CloudFormation DescribeStacks fallback.
    const viaGetStackOutput = new ssm.CfnParameter(this, 'ViaGetStackOutput', {
      type: 'String',
      name: GETSTACKOUTPUT_PARAM_NAME,
      value: 'placeholder-replaced-at-deploy-time',
      description: 'cdkd #1697 integ: value resolved via the DescribeStacks fallback',
    });
    viaGetStackOutput.addPropertyOverride('Value', {
      'Fn::GetStackOutput': {
        StackName: PRODUCER_STACK_NAME,
        OutputName: 'SharedValue',
      },
    });
  }
}
