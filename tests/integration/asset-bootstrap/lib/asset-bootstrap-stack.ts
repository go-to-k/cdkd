import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * Minimal asset-bearing stack for the issue #1002 PR 1 integ
 * (tests/integration/asset-bootstrap/verify.sh).
 *
 * The single Lambda ZIP asset is what makes `cdkd deploy` read the
 * per-region bootstrap marker (asset-mode detection only fires for stacks
 * that actually publish assets), so this fixture exercises:
 * - legacy mode (no marker): one `cdk gc`-hazard info line, publish unchanged
 * - cdkd-assets mode (marker present): existence verification, no info line
 * - marker present but ECR repo deleted: hard error before any provisioning
 */
export class AssetBootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
    });
  }
}
