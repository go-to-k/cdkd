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
 * NEVER point `url` at a real provider's issuer (GitHub's
 * token.actions.githubusercontent.com included): an AWS account holds only
 * ONE OIDC provider per issuer URL, so the fixture would collide with the
 * account's real provider, and its cleanup and destroy would delete it. An
 * earlier version used GitHub's URL; an agent deleted the account's real
 * GitHub provider to make room, which broke an unrelated GitHub Actions role
 * for 18 days. The issuer is a fictitious per-run host on example.com
 * (`CDKD_OIDC_HOST`, set by verify.sh), so a run never collides with a killed
 * earlier run's leftover provider either. A fixed dummy thumbprint keeps the
 * CDK handler from fetching the (nonexistent) host's TLS certificate.
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

    // Fictitious issuer host, never a real provider's (see the class comment).
    const host = process.env.CDKD_OIDC_HOST ?? 'cdkd-integ-oidc.example.com';
    if (!host.endsWith('.example.com')) {
      throw new Error(`CDKD_OIDC_HOST must be a fictitious *.example.com host, got '${host}'`);
    }

    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: `https://${host}`,
      clientIds,
      thumbprints: ['0123456789abcdef0123456789abcdef01234567'],
    });

    const role = new iam.Role(this, 'DeployRole', {
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${host}:aud`]: 'sts.amazonaws.com',
        },
        StringLike: {
          [`${host}:sub`]: 'repo:example-org/example-repo:*',
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
