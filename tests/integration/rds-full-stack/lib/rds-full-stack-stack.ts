import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Realistic single-instance RDS deployment fixture.
 *
 * This fixture deliberately occupies a DIFFERENT corner of the RDS test
 * matrix than the two existing RDS fixtures:
 *
 *   - `rds-aurora` exercises an Aurora Serverless v2 CLUSTER (+ writer
 *     instance + DBProxy family) and a standalone L1 `CfnDBCluster`
 *     asserting the #609 DBCluster security-property silent-drop closure.
 *   - `rds-dbinstance-backfill` exercises a standalone L1 `CfnDBInstance`
 *     asserting the #609 DBInstance security-property silent-drop closure
 *     and the `provisionedBy=sdk` routing guard.
 *
 * Neither of those:
 *   - uses an explicit `rds.DatabaseInstance` L2 with an explicit
 *     DBSubnetGroup + DBParameterGroup pair, nor
 *   - consumes the DBInstance's COMPUTED endpoint address via an
 *     `Fn::GetAtt(<DBInstance>, Endpoint.Address)` downstream reference.
 *
 * This fixture targets exactly that angle: the realistic "stand up a DB
 * and wire its endpoint into a consumer" shape. The angle being stressed
 * is cdkd's event-driven DAG + intrinsic-function resolution under a
 * slow-create resource:
 *
 *   1. The SSM Parameter REFERENCES `Endpoint.Address` of the DBInstance.
 *      `Endpoint.Address` is a CFn computed attribute that does NOT exist
 *      until AWS finishes creating the instance (~5-10 min). cdkd's DAG
 *      must therefore: create the SubnetGroup + ParameterGroup + SG first,
 *      then the DBInstance, WAIT for it to become available, read the
 *      `Endpoint.Address` attribute back, and only THEN create the SSM
 *      Parameter with the resolved value. If cdkd parallelized the
 *      Parameter against the instance, or read the attribute before the
 *      instance was available, the parameter value would be empty.
 *   2. The custom DBSubnetGroup + DBParameterGroup are explicit
 *      dependencies of the DBInstance (Ref edges), so they must be created
 *      BEFORE the instance — exercising the ordering for those sub-types.
 *
 * Cost / teardown shape: db.t3.micro / 20 GiB gp2 / single-AZ / 2 isolated
 * subnets / no NAT gateways / `deletionProtection: false` / no final
 * snapshot / `RemovalPolicy.DESTROY` — the smallest reliable instance that
 * still produces a real endpoint. RDS create is ~5-10 min and delete is a
 * few minutes more, so this integ is SLOW by RDS nature (acceptable).
 *
 * Implementation note (L2 vs L1): unlike the two #609 fixtures, this one
 * INTENTIONALLY uses the L2 `rds.DatabaseInstance` because the realistic
 * "stand up a DB" shape is the whole point. The L2 emits CDK-default
 * top-level props that may trip cdkd's #614 silent-drop routing and flip
 * the resource onto the Cloud Control path — but that is FINE here: this
 * fixture does NOT assert silent-drop closure or `provisionedBy=sdk`. The
 * computed `Endpoint.Address` attribute is resolved on BOTH the SDK
 * provider path (rds-provider.ts) and the Cloud Control path, so the
 * GetAtt-of-computed-endpoint assertion holds regardless of which route
 * cdkd picks.
 */
export class RdsFullStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC: 2 AZs (RDS DBSubnetGroup requires >= 2 AZs), no NAT gateways,
    // isolated subnets only (the DB is private; no egress needed).
    const vpc = new ec2.Vpc(this, 'DbVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Explicit Security Group for the DB instance (self-referencing Postgres
    // ingress so the rule is concrete; no external access).
    const securityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Security group for the rds-full-stack DBInstance',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(
      securityGroup,
      ec2.Port.tcp(5432),
      'Allow Postgres access from within the security group'
    );

    // Explicit DBSubnetGroup spanning the two isolated subnets. cdkd must
    // create this BEFORE the instance (Ref edge from the instance).
    const subnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Explicit subnet group for the rds-full-stack DBInstance',
    });

    // Explicit DBParameterGroup with a non-default parameter so verify.sh can
    // assert the instance is using OUR group (and not the engine default).
    // `application_name` is a dynamic Postgres parameter (no reboot needed).
    const parameterGroup = new rds.ParameterGroup(this, 'DbParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_4,
      }),
      description: 'Explicit parameter group for the rds-full-stack DBInstance',
      parameters: {
        application_name: 'cdkd-rds-full-stack',
      },
    });

    // The small single-AZ Postgres instance. CDK auto-creates a Secrets
    // Manager secret for the credentials (the realistic default). The
    // explicit subnetGroup + parameterGroup + securityGroup are all wired in.
    const dbInstance = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_4,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      subnetGroup,
      parameterGroup,
      securityGroups: [securityGroup],
      allocatedStorage: 20,
      storageType: rds.StorageType.GP2,
      multiAz: false,
      // CDK-managed Secrets Manager credentials (auto-generated). This is the
      // realistic default and avoids a literal password in the fixture.
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin'),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // No final snapshot so destroy is clean + cheap.
      deleteAutomatedBackups: true,
      backupRetention: cdk.Duration.days(0),
    });

    // The consumer: an SSM Parameter whose value is the DBInstance's COMPUTED
    // endpoint address. `dbInstance.instanceEndpoint.hostname` synthesizes to
    // `Fn::GetAtt: [<Database logical id>, Endpoint.Address]` — a computed
    // attribute only known after the instance is available. This is the
    // load-bearing reference: it forces cdkd to create the parameter AFTER
    // the instance create completes and to resolve the GetAtt to the real
    // endpoint hostname.
    new ssm.StringParameter(this, 'DbEndpointParameter', {
      parameterName: '/cdkd/rds-full-stack/db-endpoint',
      stringValue: dbInstance.instanceEndpoint.hostname,
      description: 'Computed RDS endpoint address resolved via Fn::GetAtt',
    });

    // Outputs for human inspection / debugging.
    new cdk.CfnOutput(this, 'DbEndpointAddress', {
      value: dbInstance.instanceEndpoint.hostname,
      description: 'RDS instance endpoint address (computed)',
    });
    new cdk.CfnOutput(this, 'DbEndpointPort', {
      value: cdk.Token.asString(dbInstance.instanceEndpoint.port),
      description: 'RDS instance endpoint port (computed)',
    });
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });
  }
}
