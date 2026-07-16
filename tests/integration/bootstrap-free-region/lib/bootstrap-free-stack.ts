import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * Minimal asset-bearing stack for the cdk-bootstrap-free deploy integ
 * (tests/integration/bootstrap-free-region/verify.sh).
 *
 * Deployed into a region that has NEVER been `cdk bootstrap`ed. The CDK
 * default synthesizer emits the `BootstrapVersion` SSM-typed parameter
 * (default `/cdk-bootstrap/hnb659fds/version`) into this template — the
 * fixture proves cdkd does not resolve it (nothing outside Rules references
 * it), so `cdkd bootstrap` + `cdkd deploy` work with no CDK bootstrap at
 * all, publishing the Lambda ZIP asset to cdkd-owned storage.
 */
export class BootstrapFreeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
    });
  }
}
