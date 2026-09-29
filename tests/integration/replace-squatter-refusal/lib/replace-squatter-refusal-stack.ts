import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

/**
 * Fixture for issue #3979's deploy arm: `cdkd deploy --replace` deletes the
 * OLD resource first when a replacement's create-first attempt collides on a
 * name, and must do so only when the old resource provably holds the name the
 * create SENT.
 *
 * covers: AWS::ECR::Repository
 *
 * One ECR repository, env-parameterized so verify.sh drives every phase from
 * ONE app:
 *
 *   - `REPO_NAME` set: an explicit `repositoryName`; unset: none, so cdkd
 *     generates `<stack>-<logicalId>` (lower-cased). Dropping or adding the
 *     name changes the create-only `RepositoryName`: a REPLACEMENT.
 *   - `REPO_KMS=true`: `EncryptionConfiguration` KMS (the AWS-managed key, no
 *     charge), create-only, so a REPLACEMENT that KEEPS the name — the
 *     genuine delete-first case (negative control).
 *
 * ECR is chosen because `CreateRepository` is NOT name-idempotent (a taken
 * name is `RepositoryAlreadyExistsException`, never the existing repo), its
 * generated name is predicted verbatim by cdkd, and an empty repository costs
 * nothing.
 */
export class ReplaceSquatterRefusalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'replace-squatter-refusal');

    const name = process.env.REPO_NAME;
    const repo = new ecr.CfnRepository(this, 'Repo', {
      ...(name !== undefined && name !== '' && { repositoryName: name }),
      ...(process.env.REPO_KMS === 'true' && {
        encryptionConfiguration: { encryptionType: 'KMS' },
      }),
      emptyOnDelete: true,
    });
    repo.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
