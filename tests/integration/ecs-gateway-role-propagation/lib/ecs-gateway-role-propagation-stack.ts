import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * An AWS::ECS::Gateway created in the SAME deploy as its infrastructure role
 * (issue #5661).
 *
 * covers: AWS::ECS::Gateway
 * covers: AWS::IAM::Role
 *
 * The gateway has no SDK provider, so cdkd creates it through Cloud Control,
 * seconds after the role. While the role propagates, ECS rejects the create
 * with "Could not assume the infrastructure role ...", then with "Access
 * denied: AWS was not able to validate the provided access credentials
 * (Service: Ecs, ...)". Before #5661 cdkd failed the deploy on either; now
 * both are on the IAM-propagation retry schedule. CloudFormation creates the
 * same template.
 *
 * Deliberately ONE deploy with no head start: the #5634 fixture works around
 * the race by deploying the role a phase early and waiting 30s, which is
 * exactly what this fixture must not do. The role has no name, so each run's
 * role is new (verify.sh asserts its CreateDate is after the run started).
 *
 * The rest is what the gateway needs and nothing more: a host-shared ALB, so
 * two public subnets with an internet route. No cluster association, no
 * service.
 *
 * Cost: the gateway's ALB runs for the length of the test.
 */
export class EcsGatewayRolePropagationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // verify.sh's per-run nonce. Its teardown sweep deletes the fixed-name
    // gateway ONLY when it carries this run's tag.
    const runId = process.env.CDKD_INTEG_RUN_ID ?? 'unset';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    // The trust and managed policy CloudFormation accepted for the #5634
    // gateway (a throwaway stack posted on that issue).
    const infraRole = new iam.Role(this, 'GatewayInfraRole', {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonECSInfrastructureRoleForGatewayHostSharedALB'
        ),
      ],
    });

    // The installed aws-cdk-lib has no L1 for the gateway, so it is raw CFn.
    // The gateway API accepts only HTTPS on 443 today, with no certificate.
    const gateway = new cdk.CfnResource(this, 'Gateway', {
      type: 'AWS::ECS::Gateway',
      properties: {
        GatewayName: 'cdkd-ecs-gw-role-propagation',
        InfrastructureRoleArn: infraRole.roleArn,
        // The API default is TRUE, which refuses the destroy.
        DeletionProtection: false,
        Tags: [{ Key: 'cdkd-integ-run-id', Value: runId }],
        Configuration: {
          HostSharedAlb: {
            NetworkConfiguration: {
              Subnets: vpc.publicSubnets.map((s) => s.subnetId),
            },
            Scheme: 'internet-facing',
            Protocol: 'HTTPS',
            Port: 443,
          },
        },
      },
    });
    // An internet-facing ALB needs the internet gateway attached and routed
    // first (and torn down only after the ALB is gone). Each public subnet's
    // `internetConnectivityEstablished` carries its default route and, through
    // it, the gateway attachment. The role dependency is already implied by
    // `roleArn`; stated so the race this fixture exists for is explicit.
    gateway.node.addDependency(infraRole);
    for (const subnet of vpc.publicSubnets) {
      gateway.node.addDependency(subnet.internetConnectivityEstablished);
    }

    new cdk.CfnOutput(this, 'GatewayArn', { value: gateway.getAtt('Arn').toString() });
    new cdk.CfnOutput(this, 'InfraRoleArn', { value: infraRole.roleArn });
  }
}
