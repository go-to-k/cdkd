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
 * The function's ENVIRONMENT carries two ECR image references spelled in the
 * WIDENED host forms issues #1792 / #1793 taught gc's matcher — an UPPER-cased
 * plain host with an UPPER-cased digest, and a dual-stack FIPS
 * `<acct>.dkr-ecr-fips.<region>.on.aws` host with a tag. `verify.sh` exports
 * them AFTER pushing the images they name into the custom container repo (the
 * digest is not knowable at synth time), and they enter the template rather
 * than the state file on purpose: cdkd's OWN deploy then writes them into
 * `state.properties`, so `cdkd gc`'s reference scan reads them from exactly
 * where it would read a real one. cdkd's publisher can only ever emit the
 * plain lower-case host, which is why a widened spelling has to come from
 * outside the publisher — a hand-written L1 `Image` property or an imported
 * CloudFormation record is how it happens for real.
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
      // Both keys are ALWAYS declared, with a placeholder when the env var is
      // absent, so a bare `cdk synth` outside verify.sh produces the same
      // template shape. The values are inert to the function itself — what
      // matters is that they land in cdkd state for gc to scan.
      environment: {
        // `<acct>.DKR.ECR.<REGION>.AMAZONAWS.COM/<repo>@SHA256:<UPPER HEX>`
        GC_INTEG_UPPER_DIGEST_REF: process.env['GC_INTEG_UPPER_DIGEST_REF'] ?? 'unset',
        // `<acct>.dkr-ecr-fips.<region>.on.aws/<repo>:<tag>`
        GC_INTEG_DUALSTACK_FIPS_TAG_REF:
          process.env['GC_INTEG_DUALSTACK_FIPS_TAG_REF'] ?? 'unset',
      },
    });
  }
}
