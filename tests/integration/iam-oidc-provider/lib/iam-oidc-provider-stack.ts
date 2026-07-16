import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ probe for the GitHub Actions OIDC federation pattern — the single
 * most common IAM pattern in CI. `iam.OpenIdConnectProvider` synthesizes
 * `Custom::AWSCDKOpenIdConnectProvider` (a Lambda-backed CDK custom
 * resource), so this exercises cdkd's custom-resource CREATE / UPDATE /
 * DELETE lifecycle on a construct virtually every CDK-on-GitHub-Actions
 * user deploys.
 *
 * Phase 1 (no env): provider with the single `sts.amazonaws.com` clientId
 * plus a deploy role trusting it (WebIdentityPrincipal with aud + sub
 * conditions).
 * Phase 2 (CDKD_TEST_UPDATE=true): a second clientId is added — a custom
 * resource UPDATE with changed properties. The provider must be updated in
 * place (same CreateDate), not recreated.
 *
 * NOTE: an AWS account can hold only ONE OIDC provider per issuer URL, so
 * this fixture assumes the test account has no pre-existing provider for
 * token.actions.githubusercontent.com (verify.sh's pre-run cleanup deletes
 * it by that deterministic ARN).
 *
 * covers: AWS::IAM::Role
 * Confirmed CLEAN by a /hunt-bugs sweep (2026-07-17); this fixture is the
 * regression guard.
 */
export class IamOidcProviderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const clientIds =
      process.env.CDKD_TEST_UPDATE === 'true'
        ? ['sts.amazonaws.com', 'https://integ.cdkd-example.com']
        : ['sts.amazonaws.com'];

    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds,
    });

    const role = new iam.Role(this, 'DeployRole', {
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': 'repo:example-org/example-repo:*',
        },
      }),
      description: 'cdkd integ GitHub Actions deploy role',
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListAllMyBuckets'],
        resources: ['*'],
      })
    );

    new cdk.CfnOutput(this, 'ProviderArn', { value: provider.openIdConnectProviderArn });
    new cdk.CfnOutput(this, 'RoleArn', { value: role.roleArn });
  }
}
