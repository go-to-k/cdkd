import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * Minimal asset-bearing stack for the gc-custom-asset-names integ
 * (tests/integration/gc-custom-asset-names/verify.sh, issue #1026).
 *
 * The Lambda code comes from `lambda.Code.fromAsset(...)` over a small
 * multi-file local directory — a real FILE asset (inline code produces no
 * asset), so `cdkd deploy` must zip + publish it. With the region
 * bootstrapped via `cdkd bootstrap --asset-bucket <custom> --container-repo
 * <custom>` (issue #1011), the publish goes to the CUSTOM-named cdkd asset
 * bucket, and the function's `Code.S3Bucket` / `Code.S3Key` recorded in
 * cdkd state must point at it. The uploaded object is then the REFERENCED
 * asset that `cdkd gc` (issue #1012) must keep while deleting a seeded
 * unreferenced object from the same bucket.
 *
 * covers: AWS::Lambda::Function
 * covers: AWS::IAM::Role
 */
export class GcCustomAssetNamesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
    });
  }
}
