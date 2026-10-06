import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

/**
 * A failed-CREATE orphan named from a secret (go-to-k/cdkd#3869).
 *
 * `RepositoryName` comes from the fixture's secret (`repo` field). ECR
 * accepts `CreateRepository` and rejects the follow-up `PutLifecyclePolicy`
 * (`tagStatus` must be `tagged`, `untagged` or `any`), so the provider proves
 * it made the repository before failing and the deploy, run with
 * `--no-rollback`, journals it (`physicalIdRecoveredFromError: true`). No
 * state record holds it, so `cdkd destroy` deletes it from the journal; that
 * delete's lines must not name the repository.
 *
 * covers: AWS::ECR::Repository
 */
export class SecretDerivedOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const secretName = process.env.SDIN_SECRET_NAME ?? 'cdkd-integ-sdin-unset';
    const repo = new ecr.CfnRepository(this, 'SecretOrphanRepo', {
      repositoryName: cdk.SecretValue.secretsManager(secretName, {
        jsonField: 'repo',
      }).unsafeUnwrap(),
      lifecyclePolicy: {
        lifecyclePolicyText: JSON.stringify({
          rules: [
            {
              rulePriority: 1,
              selection: {
                tagStatus: 'cdkd-not-a-tag-status',
                countType: 'imageCountMoreThan',
                countNumber: 1,
              },
              action: { type: 'expire' },
            },
          ],
        }),
      },
    });
    repo.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
