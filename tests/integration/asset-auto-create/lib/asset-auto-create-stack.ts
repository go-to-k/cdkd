import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * Minimal asset-bearing stack for the deploy-time asset-storage auto-create
 * integ (tests/integration/asset-auto-create/verify.sh, issue #1007).
 *
 * Deployed into a region with NO bootstrap marker and NO CDK bootstrap: the
 * first deploy must auto-create the cdkd asset bucket + container repo +
 * marker and publish this Lambda ZIP asset there; with
 * --no-auto-asset-storage the same deploy must stay in legacy mode instead.
 */
export class AssetAutoCreateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
    });
  }
}
