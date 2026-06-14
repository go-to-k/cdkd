import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Failure-seeking fixture for the CC-API attribute-enrichment gap on
 * `AWS::OpenSearchService::Domain`.
 *
 * OpenSearch Service Domain has NO SDK provider, so it always routes through
 * Cloud Control. Pre-fix, `Fn::GetAtt(<Domain>, 'DomainEndpoint')` (the
 * `https://search-...es.amazonaws.com` URL clients connect to) and
 * `Fn::GetAtt(<Domain>, 'Arn')` fell through the intrinsic resolver's
 * `constructAttribute` to the physicalId (the domain NAME) instead of the real
 * endpoint hostname / ARN — so a connection string or IAM resource statement
 * built from it pointed at garbage with a silent deploy success.
 *
 * This stack deploys the smallest public single-node domain (`t3.small.search`,
 * 10 GiB gp3, no VPC) and stores its `DomainEndpoint` / `Arn` into SSM
 * Parameters via Fn::GetAtt. verify.sh asserts the stored endpoint is the real
 * `*.es.amazonaws.com` hostname (not the domain name) and the Arn is a real
 * `arn:aws:es:...:domain/...` ARN.
 */
export class OpenSearchDomainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // L2 Domain for robust, battle-tested defaults (no VPC / no fine-grained
    // access control — a public single-node domain with no access policy is
    // inaccessible but valid, which is all this read-only endpoint test needs).
    const domain = new opensearch.Domain(this, 'Domain', {
      // Explicit name (3-28 chars, lowercase letter-first) so verify.sh's
      // orphan sweep can match it deterministically; without it AWS
      // auto-generates an opaque name the sweep cannot find.
      domainName: 'cdkd-opensearch-getatt',
      version: opensearch.EngineVersion.openSearch('2.19'),
      capacity: {
        dataNodes: 1,
        dataNodeInstanceType: 't3.small.search',
        multiAzWithStandbyEnabled: false,
      },
      ebs: {
        volumeSize: 10,
        volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
      },
      // RETAIN is the L2 default for this stateful resource; force DESTROY so
      // the integ leaves no orphan.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Reach the underlying L1 to read the exact CFn return-value attributes the
    // enrichment targets (DomainEndpoint / Arn), rather than the L2 getters
    // which may synthesize the ARN client-side instead of via Fn::GetAtt.
    const cfnDomain = domain.node.defaultChild as opensearch.CfnDomain;

    // LOAD-BEARING: these SSM Parameters' Value is a Fn::GetAtt against the
    // domain's computed endpoint / ARN. Pre-fix they resolved to the domain
    // name (garbage); post-fix they hold the real endpoint hostname / ARN.
    new ssm.CfnParameter(this, 'DomainEndpointParam', {
      name: '/cdkd-integ/opensearch-domain/endpoint',
      type: 'String',
      value: cfnDomain.attrDomainEndpoint,
    });
    new ssm.CfnParameter(this, 'DomainArnParam', {
      name: '/cdkd-integ/opensearch-domain/arn',
      type: 'String',
      value: cfnDomain.attrArn,
    });

    new cdk.CfnOutput(this, 'DomainName', { value: domain.domainName });
  }
}
