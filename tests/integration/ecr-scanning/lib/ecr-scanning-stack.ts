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
 * Phase 1 (no env): scanOnPush true + a lifecycle rule + two Tags
 *   (`env=dev`, `team=platform`).
 * Phase 2 (CDKD_TEST_UPDATE=true): scanOnPush false; the `env` tag value is
 *   CHANGED to `prod` and the `team` tag is REMOVED. This exercises the
 *   update() tag-diff: `ECRProvider.update()` used to call `TagResourceCommand`
 *   only (additive), so a removed tag survived on AWS (issue #981). The fix
 *   untags the removed key(s) via `UntagResourceCommand` before re-tagging.
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

    const repo = new ecr.Repository(this, 'Repo', {
      repositoryName: `${this.stackName.toLowerCase()}-repo`,
      imageScanOnPush: !isUpdate,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: key,
      lifecycleRules: [{ description: 'keep last 5', maxImageCount: 5 }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Phase 1: env=dev, team=platform. Phase 2: env changed to prod, team
    // removed entirely (untag path).
    cdk.Tags.of(repo).add('env', isUpdate ? 'prod' : 'dev');
    if (!isUpdate) {
      cdk.Tags.of(repo).add('team', 'platform');
    }
  }
}
