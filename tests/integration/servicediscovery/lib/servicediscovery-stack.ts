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
 */
export class ServiceDiscoveryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
      dnsConfig: {
        dnsRecords: [{ type: 'A', ttl: 60 }],
        routingPolicy: 'WEIGHTED',
      },
      serviceAttributes: {
        team: 'cdkd',
        tier: 'backend',
      },
    });

    new cdk.CfnOutput(this, 'NamespaceId', {
      value: namespace.attrId,
      description: 'Cloud Map PrivateDnsNamespace Id',
    });
  }
}
