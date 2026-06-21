import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * Integ probe for ECR ImageScanningConfiguration / EncryptionConfiguration
 * CFn(PascalCase) -> SDK(camelCase) mapping.
 *
 * The ECR CFn property `ImageScanningConfiguration: { ScanOnPush: true }` and
 * `EncryptionConfiguration: { EncryptionType, KmsKey }` were forwarded to the
 * AWS SDK verbatim (cast `as ImageScanningConfiguration`), but the SDK input is
 * camelCase — so the unknown `ScanOnPush` key was ignored and scanOnPush
 * silently reset to false (and a KMS repo's KmsKey was dropped). `imageScanOnPush:
 * true` never reached AWS. This fixture asserts scanOnPush actually reaches AWS
 * on create AND that toggling it off via UPDATE reaches AWS.
 *
 * Phase 1 (no env): scanOnPush true + a lifecycle rule.
 * Phase 2 (CDKD_TEST_UPDATE=true): scanOnPush false.
 */
export class EcrScanningStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // A KMS key to exercise the EncryptionConfiguration { EncryptionType: KMS,
    // KmsKey } CFn->SDK casing path (the KmsKey was silently dropped pre-fix,
    // falling back to AES256). EncryptionConfiguration is immutable so it is
    // identical across both phases.
    const key = new kms.Key(this, 'Key', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    new ecr.Repository(this, 'Repo', {
      repositoryName: `${this.stackName.toLowerCase()}-repo`,
      imageScanOnPush: !isUpdate,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: key,
      lifecycleRules: [{ description: 'keep last 5', maxImageCount: 5 }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
  }
}
