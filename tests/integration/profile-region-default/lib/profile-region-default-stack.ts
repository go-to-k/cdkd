import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * One SSM parameter whose VALUE is the region it was deployed in, so the
 * fixture can read back which region a bare `cdkd deploy` actually used —
 * the resource's own region and `AWS::Region` both — and an export, so the
 * exports index is written in that run too.
 *
 * covers: AWS::SSM::Parameter
 */
export class ProfileRegionDefaultStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The description is the fixture's UPDATE lever (`-c paramDescription=...`):
    // a held stack must be updated where it lives, not re-created elsewhere.
    const param = new ssm.StringParameter(this, 'RegionParam', {
      parameterName: '/cdkd-integ/profile-region-default/region',
      stringValue: cdk.Aws.REGION,
      description: String(this.node.tryGetContext('paramDescription') ?? 'v1'),
    });

    new cdk.CfnOutput(this, 'RegionParamName', {
      value: param.parameterName,
      exportName: 'CdkdProfileRegionDefaultParamName',
    });
  }
}
