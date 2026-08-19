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
 * It carries the S3 SIBLING of that arm too (issue #1847). Six references name
 * seeded objects in the custom asset bucket by a spelling that really reaches
 * them — an UPPER-cased and a mixed-case host of each of the two HTTPS shapes,
 * the `S3://` scheme, and an UPPER-cased BUCKET in the virtual-hosted shape,
 * where the bucket is the leftmost DNS label and host names are
 * case-insensitive. Two more spell the bucket upper-cased where S3 compares it
 * byte-for-byte instead (a path-style PATH segment and an `s3://` AUTHORITY),
 * so they name a bucket that cannot exist and their objects must be DELETED.
 *
 * That last pair is the discriminator separating gc's fix from the blanket `i`
 * flag: the fold follows the bucket's ROLE in each URL rather than applying to
 * every occurrence of the name. All eight keys are deliberately NOT
 * `<sha256>.<ext>`-shaped, because gc's name-independent content-hash pass
 * collects such tokens out of ANY string regardless of host and would protect
 * them without the matchers doing anything (issue #1781 measured 71 of 72
 * objects accidentally protected that way).
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
        // S3 host-case arm (issue #1847). The six below must all be COLLECTED
        // as references, so their objects survive gc.
        // `https://<bucket>.S3.<REGION>.AMAZONAWS.COM/<key>`
        GC_INTEG_S3_VIRTUAL_UPPER_REF: process.env['GC_INTEG_S3_VIRTUAL_UPPER_REF'] ?? 'unset',
        // `https://<bucket>.S3.<region>.AmAzOnAwS.CoM/<key>`
        GC_INTEG_S3_VIRTUAL_MIXED_REF: process.env['GC_INTEG_S3_VIRTUAL_MIXED_REF'] ?? 'unset',
        // `https://S3.<REGION>.AMAZONAWS.COM/<bucket>/<key>`
        GC_INTEG_S3_PATH_UPPER_REF: process.env['GC_INTEG_S3_PATH_UPPER_REF'] ?? 'unset',
        // `https://s3.<region>.AmAzOnAwS.CoM/<bucket>/<key>`
        GC_INTEG_S3_PATH_MIXED_REF: process.env['GC_INTEG_S3_PATH_MIXED_REF'] ?? 'unset',
        // `S3://<bucket>/<key>` — the scheme is this shape's only case-carrying
        // segment, since the bucket is the URI authority.
        GC_INTEG_S3_URI_UPPER_REF: process.env['GC_INTEG_S3_URI_UPPER_REF'] ?? 'unset',
        // `https://<BUCKET>.s3.<region>.amazonaws.com/<key>` — bucket as a DNS
        // LABEL, so this names the live object and must be collected too.
        GC_INTEG_S3_VIRTUAL_BUCKETCASE_REF:
          process.env['GC_INTEG_S3_VIRTUAL_BUCKETCASE_REF'] ?? 'unset',
        // The two NEGATIVE controls: the bucket upper-cased where S3 compares
        // it byte-for-byte (a path segment, then a URI authority). Neither may
        // be collected — their objects are expected to be DELETED.
        GC_INTEG_S3_PATH_BUCKETCASE_REF:
          process.env['GC_INTEG_S3_PATH_BUCKETCASE_REF'] ?? 'unset',
        GC_INTEG_S3_URI_BUCKETCASE_REF:
          process.env['GC_INTEG_S3_URI_BUCKETCASE_REF'] ?? 'unset',
      },
    });
  }
}
