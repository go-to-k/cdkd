import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

/**
 * AWS Cloud Map namespace-kinds example stack (issue #1044).
 *
 * Exercises the two `ProvisioningType: NON_PROVISIONABLE` namespace kinds
 * that only work through cdkd's SDK provider (Cloud Control cannot handle
 * them at all):
 *
 * - `AWS::ServiceDiscovery::HttpNamespace` — API-only discovery namespace.
 * - `AWS::ServiceDiscovery::PublicDnsNamespace` — creates a public Route 53
 *   hosted zone alongside the namespace; the fixture reads the
 *   `HostedZoneId` attribute so the GetAtt path is exercised, and verify.sh
 *   asserts the hosted zone is deleted with the namespace on destroy.
 *
 * Both creates/deletes are async operation-based (OperationId ->
 * GetOperation polling), the exact plumbing under test. The public
 * namespace also sets `Properties.DnsProperties.SOA.TTL` to exercise the
 * create-side passthrough.
 */
export class ServiceDiscoveryNamespacesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'servicediscovery-namespaces');

    const httpNamespace = new servicediscovery.CfnHttpNamespace(this, 'HttpNamespace', {
      name: 'cdkd-integ-http-ns',
      description: 'cdkd integ HTTP namespace',
      tags: [{ key: 'env', value: 'integ' }],
    });

    const publicDnsNamespace = new servicediscovery.CfnPublicDnsNamespace(
      this,
      'PublicDnsNamespace',
      {
        // NOTE: not *.example.com — Route 53 rejects hosted-zone creation
        // for AWS-reserved domains ("is reserved by AWS!", InvalidDomainName).
        name: 'cdkd-integ-ns.cdkd-integ-test.com',
        description: 'cdkd integ public DNS namespace',
        properties: {
          dnsProperties: {
            soa: { ttl: 90 },
          },
        },
        tags: [{ key: 'env', value: 'integ' }],
      }
    );

    new cdk.CfnOutput(this, 'HttpNamespaceId', {
      value: httpNamespace.attrId,
      description: 'Cloud Map HttpNamespace Id',
    });
    new cdk.CfnOutput(this, 'HttpNamespaceArn', {
      value: httpNamespace.attrArn,
      description: 'Cloud Map HttpNamespace Arn',
    });
    new cdk.CfnOutput(this, 'PublicDnsNamespaceId', {
      value: publicDnsNamespace.attrId,
      description: 'Cloud Map PublicDnsNamespace Id',
    });
    new cdk.CfnOutput(this, 'PublicDnsNamespaceHostedZoneId', {
      value: publicDnsNamespace.attrHostedZoneId,
      description: 'Route 53 public hosted zone created for the PublicDnsNamespace',
    });
  }
}
