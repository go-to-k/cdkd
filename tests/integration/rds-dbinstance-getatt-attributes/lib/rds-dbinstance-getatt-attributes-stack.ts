import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * Issue #6242: `Fn::GetAtt [Db, DbiResourceId]` resolved to the DB instance
 * IDENTIFIER, since the RDS provider never recorded it. CDK's
 * `instanceResourceId` is that attribute, and `grantConnect` builds its
 * `rds-db:connect` ARN from it, so IAM database auth was granted on a
 * resource id that does not exist. `Endpoint.HostedZoneId` and
 * `CertificateDetails.*` fell back the same way.
 *
 * The role's inline policy (via `grantConnect`) and the Outputs are what
 * verify.sh compares with `DescribeDBInstances`.
 *
 * Issue #7006: the update phases change the port (`CDKD_TEST_DB_PORT`) and
 * the CA certificate (`CDKD_TEST_DB_CA`) in place. RDS applies both after
 * ModifyDBInstance returns, so the instance record must take them only once
 * applied; the SSM parameters are the READERS whose values verify.sh reads
 * live after each update.
 *
 * covers: AWS::RDS::DBInstance, AWS::SSM::Parameter
 */
export class RdsDbinstanceGetattAttributesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      natGateways: 0,
      maxAzs: 2,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'iso', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });

    const port = Number(process.env['CDKD_TEST_DB_PORT'] ?? '5432');
    const ca = process.env['CDKD_TEST_DB_CA'] ?? 'rds-ca-rsa2048-g1';

    const db = new rds.DatabaseInstance(this, 'Db', {
      instanceIdentifier: `${id.toLowerCase()}-db`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      allocatedStorage: 20,
      // Declared from the first deploy, so an update phase CHANGES each.
      port,
      caCertificate: rds.CaCertificate.of(ca),
      iamAuthentication: true,
      // No `deleteAutomatedBackups`: cdkd's SDK provider does not wire it, so
      // declaring it routes the instance through Cloud Control, which records
      // every attribute and never reaches the #6242 path.
      backupRetention: cdk.Duration.days(0),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'AppRole', {
      roleName: `${id}-app`,
      assumedBy: new iam.AccountRootPrincipal(),
    });
    db.grantConnect(role, 'app');

    const cfnDb = db.node.defaultChild as rds.CfnDBInstance;
    new cdk.CfnOutput(this, 'DbiResourceId', { value: db.instanceResourceId });
    new cdk.CfnOutput(this, 'EndpointHostedZoneId', { value: cfnDb.attrEndpointHostedZoneId });
    new cdk.CfnOutput(this, 'CertCA', { value: cfnDb.attrCertificateDetailsCaIdentifier });
    new cdk.CfnOutput(this, 'CertValidTill', { value: cfnDb.attrCertificateDetailsValidTill });
    new cdk.CfnOutput(this, 'EndpointPort', { value: db.dbInstanceEndpointPort });

    // Issue #7006: readers of what an in-place update moves late.
    new ssm.StringParameter(this, 'PortReader', {
      parameterName: `/${id}/db-port`,
      stringValue: db.dbInstanceEndpointPort,
    });
    new ssm.StringParameter(this, 'CaReader', {
      parameterName: `/${id}/db-ca`,
      stringValue: cfnDb.attrCertificateDetailsCaIdentifier,
    });
  }
}
