import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

/**
 * AWS Cloud Map (ServiceDiscovery) example stack.
 *
 * Exercises the #609 backfill of `AWS::ServiceDiscovery::Service.ServiceAttributes`:
 * a key->value map applied via the post-create `UpdateServiceAttributes`
 * control-plane call (NOT accepted by `CreateService`). Uses L1 `CfnService`
 * per the #609 fixture convention so the SDK provider path is the one under
 * test.
 *
 * A `PrivateDnsNamespace` requires a VPC, but only the VPC id — no subnets /
 * NAT / IGW are needed, so a bare `CfnVPC` keeps the fixture light and the
 * destroy clean (no ENI / NAT orphan risk).
 *
 * Issue #1160 removal phases, cumulative, selected by `CDKD_TEST_REMOVAL`
 * (`kept` < `combined` < `refused`). They follow the CloudFormation A/Bs on
 * go-to-k/cdkd#1160 (issuecomment-6272137682, issuecomment-6281592365):
 * - `kept`: `Service` drops its `Description` on its own (KEPT), and
 *   `TtlService` drops its `Description` beside a DnsRecords TTL change (the
 *   TTL applies — CloudFormation drops it, a deliberate divergence — and the
 *   Description is KEPT).
 * - `combined`: `HcService` drops its `Description` beside a
 *   `HealthCheckConfig` change (the Description is CLEARED), and `Service`
 *   drops its `DnsConfig` on its own (KEPT).
 * - `refused`: `RefusedService` drops its `DnsConfig` beside a `Description`
 *   change, which AWS refuses (`Service dns config cannot be null`) as it
 *   does for CloudFormation.
 *
 * `HcService` lives in a `PublicDnsNamespace`: a Route 53 `HealthCheckConfig`
 * is only accepted there.
 */
export class ServiceDiscoveryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = ['', 'kept', 'combined', 'refused'].indexOf(process.env.CDKD_TEST_REMOVAL ?? '');
    if (phase < 0) throw new Error(`unknown CDKD_TEST_REMOVAL: ${process.env.CDKD_TEST_REMOVAL}`);
    const kept = phase >= 1;
    const combined = phase >= 2;
    const refused = phase >= 3;

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'servicediscovery');

    // Bare VPC purely to host the private DNS namespace.
    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.0.0.0/16',
    });

    // Private DNS namespace (associates with the VPC via vpc.ref -> DAG edge).
    const namespace = new servicediscovery.CfnPrivateDnsNamespace(this, 'Namespace', {
      name: 'cdkd-svcdisc.local',
      vpc: vpc.ref,
    });

    // Cloud Map service with ServiceAttributes (the #609 backfill prop).
    // namespaceId references the namespace's attrId -> DAG edge so the
    // namespace is created first. serviceAttributes uses custom (non-AWS_-
    // prefixed) keys; they are applied post-create via UpdateServiceAttributes.
    new servicediscovery.CfnService(this, 'Service', {
      name: 'cdkd-svcdisc-service',
      namespaceId: namespace.attrId,
      ...(kept ? {} : { description: 'cdkd-svcdisc-kept-description' }),
      ...(combined
        ? {}
        : { dnsConfig: { dnsRecords: [{ type: 'A', ttl: 60 }], routingPolicy: 'WEIGHTED' } }),
      serviceAttributes: {
        team: 'cdkd',
        tier: 'backend',
      },
    });

    // Issue #1160 `kept`: Description removed beside a DnsRecords-only change.
    new servicediscovery.CfnService(this, 'TtlService', {
      name: 'cdkd-svcdisc-ttl',
      namespaceId: namespace.attrId,
      ...(kept ? {} : { description: 'cdkd-svcdisc-ttl-description' }),
      dnsConfig: { dnsRecords: [{ type: 'A', ttl: kept ? 150 : 90 }] },
    });

    // Issue #1160 `refused`: DnsConfig removed beside a Description change.
    new servicediscovery.CfnService(this, 'RefusedService', {
      name: 'cdkd-svcdisc-refused',
      namespaceId: namespace.attrId,
      description: refused ? 'cdkd-svcdisc-refused-changed' : 'cdkd-svcdisc-refused',
      ...(refused ? {} : { dnsConfig: { dnsRecords: [{ type: 'A', ttl: 90 }] } }),
    });

    // Issue #1160 `combined`: Description removed beside a HealthCheckConfig
    // change. Not delegated anywhere: the hosted zone only has to exist.
    const publicNamespace = new servicediscovery.CfnPublicDnsNamespace(this, 'PublicNamespace', {
      name: 'cdkd-svcdisc-hc.cdkd-integ-test.com',
    });
    new servicediscovery.CfnService(this, 'HcService', {
      name: 'cdkd-svcdisc-hc',
      namespaceId: publicNamespace.attrId,
      ...(combined ? {} : { description: 'cdkd-svcdisc-hc-description' }),
      dnsConfig: { dnsRecords: [{ type: 'A', ttl: 60 }], routingPolicy: 'WEIGHTED' },
      healthCheckConfig: { type: 'HTTP', resourcePath: '/health', failureThreshold: combined ? 2 : 3 },
    });

    new cdk.CfnOutput(this, 'NamespaceId', {
      value: namespace.attrId,
      description: 'Cloud Map PrivateDnsNamespace Id',
    });
  }
}
