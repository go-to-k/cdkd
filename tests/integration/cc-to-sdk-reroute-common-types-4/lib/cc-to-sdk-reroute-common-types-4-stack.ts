import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

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

/**
 * physicalId-parity arm for issue 6454, batch 4: a resource of each of six
 * types, recorded `provisionedBy: 'cc-api'`, returns to its SDK provider
 * without churn.
 *
 * covers: AWS::Events::EventBus, AWS::ServiceDiscovery::PrivateDnsNamespace,
 * AWS::ServiceDiscovery::Service, AWS::Glue::Workflow, AWS::Glue::Crawler,
 * AWS::ElasticLoadBalancingV2::LoadBalancer
 *
 * Every resource under test is a LEAF: nothing in the stack references it, so
 * verify.sh's `--recreate-via-cc-api` replaces only that resource and no
 * dependent's create-only property changes with it. Each one's logical id is
 * fixed so verify.sh can name it without reading the template. verify.sh holds
 * each type's identity witness and live readback.
 */
export class CcToSdkRerouteCommonTypes4Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phaseName = process.env.CDKD_TEST_PHASE ?? 'base';
    const value = VALUE_BY_PHASE[phaseName] ?? 'a';
    const phase = `phase-${value}`;
    const fixed = (resource: cdk.CfnResource, logicalId: string): void => {
      resource.overrideLogicalId(logicalId);
    };

    fixed(
      new events.CfnEventBus(this, 'EventBus', { name: `${this.stackName}-bus`, description: phase }),
      'RerouteEventBus'
    );

    // NOT under test: the VPC the private namespace and the load balancer sit
    // in, its two subnets, and the HTTP namespace the service registers in.
    const hostVpc = new ec2.CfnVPC(this, 'HostVpc', {
      cidrBlock: '10.45.0.0/24',
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });
    const subnets = [0, 1].map(
      (i) =>
        new ec2.CfnSubnet(this, `HostSubnet${i}`, {
          vpcId: hostVpc.ref,
          cidrBlock: `10.45.0.${i * 128}/25`,
          availabilityZone: cdk.Fn.select(i, cdk.Fn.getAzs()),
        })
    );
    const hostNamespace = new servicediscovery.CfnHttpNamespace(this, 'HostNamespace', {
      name: `${this.stackName}-host-ns`,
    });

    fixed(
      new servicediscovery.CfnPrivateDnsNamespace(this, 'PrivateNamespace', {
        name: 'cdkd-reroute-common-types-4.internal',
        vpc: hostVpc.ref,
        description: phase,
      }),
      'ReroutePrivateNamespace'
    );

    fixed(
      new servicediscovery.CfnService(this, 'DiscoveryService', {
        name: 'reroute',
        namespaceId: hostNamespace.attrId,
        // Cloud Control's update of this type reports SUCCESS but does not
        // apply a Description change (measured us-east-1, 2026-11-17), so the
        // pinned phase leaves `phase-b` live. `flip` therefore declares a
        // third value, or the SDK update would be invisible against it.
        description: phaseName === 'flip' ? 'phase-c' : phase,
      }),
      'RerouteDiscoveryService'
    );

    fixed(
      new glue.CfnWorkflow(this, 'GlueWorkflow', { name: `${this.stackName}-workflow`, description: phase }),
      'RerouteGlueWorkflow'
    );

    // NOT under test: the crawler's role, database and target bucket. AWS
    // validates that a crawler's S3 target exists, so the bucket is real.
    const crawlerBucket = new s3.CfnBucket(this, 'CrawlerBucket');
    crawlerBucket.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    const crawlerRole = new iam.CfnRole(this, 'CrawlerRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'glue.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
    });
    const crawlerDatabase = new glue.CfnDatabase(this, 'CrawlerDatabase', {
      catalogId: this.account,
      databaseInput: { name: 'cdkd_reroute_common_types_4' },
    });
    fixed(
      new glue.CfnCrawler(this, 'GlueCrawler', {
        role: crawlerRole.attrArn,
        databaseName: crawlerDatabase.ref,
        description: phase,
        targets: { s3Targets: [{ path: `s3://${crawlerBucket.ref}/prefix/` }] },
      }),
      'RerouteGlueCrawler'
    );

    fixed(
      new elbv2.CfnLoadBalancer(this, 'LoadBalancer', {
        scheme: 'internal',
        type: 'application',
        subnets: subnets.map((s) => s.ref),
        loadBalancerAttributes: [{ key: 'idle_timeout.timeout_seconds', value: value === 'a' ? '60' : '61' }],
      }),
      'RerouteLoadBalancer'
    );

    new cdk.CfnOutput(this, 'HostVpcId', { value: hostVpc.ref });
    new cdk.CfnOutput(this, 'HostNamespaceId', { value: hostNamespace.attrId });
    new cdk.CfnOutput(this, 'CrawlerRoleName', { value: crawlerRole.ref });
    new cdk.CfnOutput(this, 'CrawlerDatabaseName', { value: crawlerDatabase.ref });
    new cdk.CfnOutput(this, 'CrawlerBucketName', { value: crawlerBucket.ref });
  }
}
