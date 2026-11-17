import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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
 * physicalId-parity arm for issue 6454, batch 5: an
 * `AWS::ServiceDiscovery::Service` in a DNS namespace and one in an HTTP
 * namespace, each recorded `provisionedBy: 'cc-api'`, return to the SDK
 * provider without churn.
 *
 * covers: AWS::ServiceDiscovery::Service
 *
 * AWS refuses UpdateService for a service in an HTTP (API-only) namespace
 * (go-to-k/cdkd#6484), so that one changes only its Tags; the DNS one changes
 * its Description. Both services are LEAVES, and each logical id is fixed.
 */
export class CcToSdkRerouteCommonTypes5Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const value = VALUE_BY_PHASE[process.env.CDKD_TEST_PHASE ?? 'base'] ?? 'a';
    const phase = `phase-${value}`;
    const fixed = (resource: cdk.CfnResource, logicalId: string): void => {
      resource.overrideLogicalId(logicalId);
    };

    // NOT under test: the two namespaces and the VPC the DNS one sits in.
    const hostVpc = new ec2.CfnVPC(this, 'HostVpc', {
      cidrBlock: '10.46.0.0/24',
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });
    const dnsNamespace = new servicediscovery.CfnPrivateDnsNamespace(this, 'DnsNamespace', {
      name: 'cdkd-reroute-common-types-5.internal',
      vpc: hostVpc.ref,
    });
    const httpNamespace = new servicediscovery.CfnHttpNamespace(this, 'HttpNamespace', {
      name: `${this.stackName}-ns`,
    });

    fixed(
      new servicediscovery.CfnService(this, 'DnsService', {
        name: 'dns-svc',
        namespaceId: dnsNamespace.attrId,
        dnsConfig: { dnsRecords: [{ type: 'A', ttl: 60 }] },
        description: phase,
      }),
      'RerouteDnsService'
    );

    fixed(
      new servicediscovery.CfnService(this, 'HttpService', {
        name: 'http-svc',
        namespaceId: httpNamespace.attrId,
        tags: [{ key: 'cdkd-phase', value: phase }],
      }),
      'RerouteHttpService'
    );

    new cdk.CfnOutput(this, 'HostVpcId', { value: hostVpc.ref });
    new cdk.CfnOutput(this, 'DnsNamespaceId', { value: dnsNamespace.attrId });
    new cdk.CfnOutput(this, 'HttpNamespaceId', { value: httpNamespace.attrId });
  }
}
