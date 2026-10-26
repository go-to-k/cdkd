import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
 * - `kept`: `Service` drops its `Description` on its own; `DnsKeptService`
 *   drops its `DnsConfig` and `HcKeptService` its `HealthCheckConfig`, each
 *   beside a declared, UNCHANGED `Description` (all KEPT — before the fix
 *   cdkd sent the declared fields, which cleared the first and third and was
 *   refused for the second); and `TtlService` drops its `Description` beside
 *   a DnsRecords TTL change (the TTL applies — CloudFormation drops it, a
 *   deliberate divergence — and the Description is KEPT).
 *   `SecretHcKeptService` drops its `HealthCheckConfig` beside an UNCHANGED
 *   `Description` read from a secret dynamic reference, which state records as
 *   its `{{resolve:...}}` token (go-to-k/cdkd#5112: KEPT, as CloudFormation
 *   compares templates; before the fix the token read as changed and the
 *   health check was cleared). `NoEchoHcKeptService` does the same beside a
 *   `Description` from a `NoEcho` parameter, recorded as `***`: KEPT, because
 *   the engine reads the service back and AWS holds the value.
 * - `combined`: `HcService` drops its `Description` beside a
 *   `HealthCheckConfig` change (the Description is CLEARED).
 * - `refused`: `RefusedService` drops its `DnsConfig` beside a `Description`
 *   change, which AWS refuses (`Service dns config cannot be null`) as it
 *   does for CloudFormation.
 *
 * `HcService` lives in a `PublicDnsNamespace`: a Route 53 `HealthCheckConfig`
 * is only accepted there.
 *
 * go-to-k/cdkd#5348: `NamelessService` declares no `name` (the L2's
 * `@default CloudFormation-generated name`); cdkd used to refuse its create.
 * It is identical in every phase, so each redeploy must keep its generated
 * name.
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
      dnsConfig: { dnsRecords: [{ type: 'A', ttl: 60 }], routingPolicy: 'WEIGHTED' },
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

    // Issue #1160 `kept`: DnsConfig removed beside an unchanged Description.
    new servicediscovery.CfnService(this, 'DnsKeptService', {
      name: 'cdkd-svcdisc-dns-kept',
      namespaceId: namespace.attrId,
      description: 'cdkd-svcdisc-dns-kept',
      ...(kept ? {} : { dnsConfig: { dnsRecords: [{ type: 'A', ttl: 90 }] } }),
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

    // Issue #1160 `kept`: HealthCheckConfig removed beside an unchanged
    // Description.
    new servicediscovery.CfnService(this, 'HcKeptService', {
      name: 'cdkd-svcdisc-hc-kept',
      namespaceId: publicNamespace.attrId,
      description: 'cdkd-svcdisc-hc-kept',
      dnsConfig: { dnsRecords: [{ type: 'A', ttl: 60 }], routingPolicy: 'WEIGHTED' },
      ...(kept
        ? {}
        : { healthCheckConfig: { type: 'HTTP', resourcePath: '/health', failureThreshold: 3 } }),
    });

    // go-to-k/cdkd#5112 `kept`: HealthCheckConfig removed beside an unchanged
    // Description that is a secret dynamic reference. The secret's value is
    // generated by AWS, never written in the template.
    const descriptionSecret = new secretsmanager.CfnSecret(this, 'DescriptionSecret', {
      name: 'cdkd-svcdisc-desc-secret',
      generateSecretString: { passwordLength: 16, excludePunctuation: true },
    });
    new servicediscovery.CfnService(this, 'SecretHcKeptService', {
      name: 'cdkd-svcdisc-secret-hc-kept',
      namespaceId: publicNamespace.attrId,
      description: cdk.Fn.join('', [
        '{{resolve:secretsmanager:',
        descriptionSecret.ref,
        ':SecretString:::}}',
      ]),
      dnsConfig: { dnsRecords: [{ type: 'A', ttl: 60 }], routingPolicy: 'WEIGHTED' },
      ...(kept
        ? {}
        : { healthCheckConfig: { type: 'HTTP', resourcePath: '/health', failureThreshold: 3 } }),
    });

    // go-to-k/cdkd#5112 `kept`: HealthCheckConfig removed beside an unchanged
    // Description from a NoEcho parameter (state records `***`).
    const noEchoDescription = new cdk.CfnParameter(this, 'SvcNoEchoDescription', {
      type: 'String',
      noEcho: true,
      default: 'cdkd-svcdisc-noecho-description',
    });
    new servicediscovery.CfnService(this, 'NoEchoHcKeptService', {
      name: 'cdkd-svcdisc-noecho-hc-kept',
      namespaceId: publicNamespace.attrId,
      description: noEchoDescription.valueAsString,
      dnsConfig: { dnsRecords: [{ type: 'A', ttl: 60 }], routingPolicy: 'WEIGHTED' },
      ...(kept
        ? {}
        : { healthCheckConfig: { type: 'HTTP', resourcePath: '/health', failureThreshold: 3 } }),
    });

    // go-to-k/cdkd#5348: no `name`, so cdkd generates one.
    const namelessService = new servicediscovery.CfnService(this, 'NamelessService', {
      namespaceId: namespace.attrId,
      dnsConfig: { dnsRecords: [{ type: 'A', ttl: 60 }] },
    });
    new cdk.CfnOutput(this, 'NamelessServiceName', {
      value: namelessService.attrName,
      description: 'Generated name of the nameless Cloud Map service',
    });

    new cdk.CfnOutput(this, 'NamespaceId', {
      value: namespace.attrId,
      description: 'Cloud Map PrivateDnsNamespace Id',
    });
  }
}
