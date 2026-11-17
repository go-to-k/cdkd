import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';

/**
 * The value each routing phase declares on every resource under test.
 * Consecutive deploys must differ: one the differ calls NO_CHANGE never
 * provisions a resource, so it could not flip. verify.sh runs its `cdkd diff`
 * with `pinned`, because `seed` and `flip` declare the same value.
 */
const VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  pinned: 'a',
  flip: 'b',
};

/** Web ACL names, also each one's metric name. verify.sh repeats them. */
export const REGIONAL_ACL_NAME = 'cdkd-reroute-ct10-acl';
export const CLOUDFRONT_ACL_NAME = 'cdkd-reroute-ct10-cfacl';

/**
 * physicalId-parity arm for issue 6490, batch 10: two `AWS::WAFv2::WebACL`s
 * (one REGIONAL, one CLOUDFRONT) and an `AWS::CodeCommit::Repository`, each
 * recorded `provisionedBy: 'cc-api'`, return to the SDK provider without churn.
 *
 * covers: AWS::WAFv2::WebACL
 * covers: AWS::CodeCommit::Repository
 *
 * Every id DIFFERS between the layers (measured us-east-1, 2026-11-17): Cloud
 * Control records `<Name>|<Id>|<Scope>` for a web ACL and the RepositoryId
 * UUID for a repository; the SDK providers record the web ACL ARN and the
 * repository name. Neither SDK id is inside the Cloud Control one, so each
 * entry's normalizer reads the record: the ARN is built from the stack's
 * region, account and partition, and the name is the record's
 * RepositoryName.
 *
 * A CLOUDFRONT web ACL exists only in us-east-1, so verify.sh refuses any
 * other region. Mutable properties: each web ACL's and the repository's
 * Description. Nothing references another resource under test, and each
 * logical id is fixed.
 */
export class CcToSdkRerouteCommonTypes10Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const value = VALUE_BY_PHASE[phase] ?? 'a';

    const webAcl = (logicalId: string, name: string, aclScope: 'REGIONAL' | 'CLOUDFRONT') => {
      const acl = new wafv2.CfnWebACL(this, logicalId, {
        name,
        scope: aclScope,
        description: `phase-${value}`,
        defaultAction: { allow: {} },
        visibilityConfig: {
          sampledRequestsEnabled: false,
          cloudWatchMetricsEnabled: false,
          metricName: name,
        },
      });
      acl.overrideLogicalId(logicalId);
      return acl;
    };
    const regional = webAcl('RerouteRegionalWebAcl', REGIONAL_ACL_NAME, 'REGIONAL');
    const cloudFront = webAcl('RerouteCloudFrontWebAcl', CLOUDFRONT_ACL_NAME, 'CLOUDFRONT');

    // Deleted with the stack (DeletionPolicy Delete, stated rather than left
    // to the L1 default). It holds no commits.
    const repository = new codecommit.CfnRepository(this, 'RerouteRepository', {
      repositoryName: 'cdkd-reroute-ct10-repo',
      repositoryDescription: `phase-${value}`,
    });
    repository.overrideLogicalId('RerouteRepository');
    repository.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Ref of a web ACL is `<Name>|<Id>|<Scope>` on both layers; GetAtt Arn and
    // Id are read beside it. Ref of a repository is its RepositoryId.
    new cdk.CfnOutput(this, 'RegionalWebAclRef', { value: regional.ref });
    new cdk.CfnOutput(this, 'RegionalWebAclArn', { value: regional.attrArn });
    new cdk.CfnOutput(this, 'RegionalWebAclId', { value: regional.attrId });
    new cdk.CfnOutput(this, 'CloudFrontWebAclRef', { value: cloudFront.ref });
    new cdk.CfnOutput(this, 'CloudFrontWebAclArn', { value: cloudFront.attrArn });
    new cdk.CfnOutput(this, 'CloudFrontWebAclId', { value: cloudFront.attrId });
    new cdk.CfnOutput(this, 'RepositoryRef', { value: repository.ref });
    new cdk.CfnOutput(this, 'RepositoryName', { value: repository.attrName });
    new cdk.CfnOutput(this, 'RepositoryArn', { value: repository.attrArn });
  }
}
