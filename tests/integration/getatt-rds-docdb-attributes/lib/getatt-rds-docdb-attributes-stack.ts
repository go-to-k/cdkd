import * as cdk from 'aws-cdk-lib';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

/**
 * Issue #6242 (tail), measured against CloudFormation: the read-only
 * attributes of an RDS DB instance and DB cluster that cdkd refused, served
 * as CloudFormation serves them. The whole `Endpoint` / `CertificateDetails` /
 * `ReadEndpoint` objects (string members), the lists (`[]`), the boolean, the
 * status and the timestamps reach a consumer through an echo custom resource
 * (an inline Lambda that returns the properties it was sent as one JSON
 * string), because an Output can only carry a string. verify.sh compares the
 * echo with `DescribeDBInstances` / `DescribeDBClusters`.
 *
 * `ServerlessV2PlatformVersion` is referenced on the UPDATE phase
 * (`CDKD_TEST_UPDATE=true`), once the serverless v2 cluster has had an
 * instance: whether DocumentDB reports it the moment the cluster create
 * returns is not measured, so the reference is served either from the
 * create's record or from the re-read a record lacking it triggers.
 *
 * `MasterUserSecret.SecretArn` (#6913) is referenced on both RDS types and
 * compared with the describe's; the cluster's recorded `StorageThroughput` is
 * compared with the describe's without a reference (whether RDS reports one
 * for an Aurora standard-storage cluster is not measured).
 *
 * Nothing here declares a property the SDK providers leave unwired (such as
 * `deleteAutomatedBackups`), which would route the resource through Cloud
 * Control and skip the path under test; verify.sh asserts the route.
 *
 * covers: AWS::RDS::DBInstance
 * covers: AWS::RDS::DBCluster
 * covers: AWS::DocDB::DBCluster
 */
export class GetattRdsDocdbAttributesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const name = id.toLowerCase();

    // A bare VPC and two subnets (no route tables, gateways or security
    // groups of its own): every resource here has a fixed name or an Output,
    // so verify.sh can sweep it and prove it gone.
    // The Name tag is how verify.sh's cleanup finds the VPC without state.
    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.42.0.0/16',
      tags: [{ key: 'Name', value: `${id}-vpc` }],
    });
    const subnets = [0, 1].map(
      (i) =>
        new ec2.CfnSubnet(this, `Subnet${i}`, {
          vpcId: vpc.ref,
          cidrBlock: `10.42.${i}.0/24`,
          availabilityZone: cdk.Fn.select(i, cdk.Fn.getAzs()),
          tags: [{ key: 'Name', value: `${id}-subnet-${i}` }],
        })
    );
    const subnetIds = subnets.map((s) => s.ref);

    // One RDS subnet group for the instance and the cluster.
    const dbSubnets = new rds.CfnDBSubnetGroup(this, 'DbSubnets', {
      dbSubnetGroupName: `${name}-db`,
      dbSubnetGroupDescription: 'cdkd #6242 integ',
      subnetIds,
    });

    // RDS DB instance. AWS manages the master password (no Secrets Manager
    // secret of the stack's, nothing resolved into state). One day of
    // backups, so RDS reports a LatestRestorableTime, as on the measured
    // CloudFormation stack.
    const cfnDb = new rds.CfnDBInstance(this, 'Db', {
      dbInstanceIdentifier: `${name}-db`,
      engine: 'postgres',
      engineVersion: '16',
      dbInstanceClass: 'db.t4g.micro',
      allocatedStorage: '20',
      masterUsername: 'cdkd',
      manageMasterUserPassword: true,
      dbSubnetGroupName: dbSubnets.ref,
      backupRetentionPeriod: 1,
    });
    cfnDb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // RDS (Aurora) DB cluster with no instance: its endpoints and storage
    // encryption type exist as soon as the cluster does.
    const cluster = new rds.CfnDBCluster(this, 'Cluster', {
      dbClusterIdentifier: `${name}-cl`,
      engine: 'aurora-postgresql',
      masterUsername: 'cdkd',
      manageMasterUserPassword: true,
      dbSubnetGroupName: dbSubnets.ref,
      storageEncrypted: true,
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // DocumentDB serverless v2 cluster with one serverless instance.
    const docdbSubnets = new docdb.CfnDBSubnetGroup(this, 'DocdbSubnets', {
      dbSubnetGroupName: `${name}-doc`,
      dbSubnetGroupDescription: 'cdkd #6242 integ',
      subnetIds,
    });
    const docCluster = new docdb.CfnDBCluster(this, 'DocCluster', {
      dbClusterIdentifier: `${name}-doc`,
      engineVersion: '5.0.0',
      masterUsername: 'cdkd',
      // AWS manages the password: the fixture seeds no secret.
      manageMasterUserPassword: true,
      dbSubnetGroupName: docdbSubnets.ref,
      storageEncrypted: true,
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 1 },
    });
    docCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    const docInstance = new docdb.CfnDBInstance(this, 'DocInstance', {
      dbClusterIdentifier: docCluster.ref,
      dbInstanceIdentifier: `${name}-doc-1`,
      dbInstanceClass: 'db.serverless',
    });
    docInstance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // The echo: returns the properties it was sent, ServiceToken removed, as
    // one JSON string. Direct payload return (cdkd's synchronous path). Its
    // role and log group are named, so verify.sh can prove them gone.
    const role = new iam.Role(this, 'EchoRole', {
      roleName: `${id}-echo`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    const logGroup = new logs.LogGroup(this, 'EchoLogs', {
      logGroupName: `/aws/lambda/${id}-echo`,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const echo = new lambda.Function(this, 'EchoHandler', {
      functionName: `${id}-echo`,
      role,
      logGroup,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  if (event.RequestType === 'Delete') {
    return { Status: 'SUCCESS', PhysicalResourceId: event.PhysicalResourceId || 'echo' };
  }
  const { ServiceToken, ...props } = event.ResourceProperties || {};
  return { PhysicalResourceId: 'echo', Data: { Json: JSON.stringify(props) } };
};
`),
    });
    const getAtt = (r: cdk.CfnResource, attr: string): cdk.IResolvable => r.getAtt(attr);
    const echoed = new cdk.CustomResource(this, 'EchoAttributes', {
      serviceToken: echo.functionArn,
      properties: {
        DbEndpoint: getAtt(cfnDb, 'Endpoint'),
        DbCertificateDetails: getAtt(cfnDb, 'CertificateDetails'),
        DbStatusInfos: getAtt(cfnDb, 'StatusInfos'),
        DbReadReplicaDBInstanceIdentifiers: getAtt(cfnDb, 'ReadReplicaDBInstanceIdentifiers'),
        DbReadReplicaDBClusterIdentifiers: getAtt(cfnDb, 'ReadReplicaDBClusterIdentifiers'),
        DbDBInstanceStatus: getAtt(cfnDb, 'DBInstanceStatus'),
        DbInstanceCreateTime: getAtt(cfnDb, 'InstanceCreateTime'),
        DbLatestRestorableTime: getAtt(cfnDb, 'LatestRestorableTime'),
        DbIsStorageConfigUpgradeAvailable: getAtt(cfnDb, 'IsStorageConfigUpgradeAvailable'),
        ClEndpoint: getAtt(cluster, 'Endpoint'),
        ClReadEndpoint: getAtt(cluster, 'ReadEndpoint'),
        ClStorageEncryptionType: getAtt(cluster, 'StorageEncryptionType'),
        // #6913: the AWS-managed master-user secret's ARN, which the L2s'
        // `secret` reads under `manageMasterUserPassword`.
        DbMasterUserSecretArn: cfnDb.attrMasterUserSecretSecretArn,
        ClMasterUserSecretArn: cluster.attrMasterUserSecretSecretArn,
        ...(isUpdate && {
          DocServerlessV2PlatformVersion: getAtt(docCluster, 'ServerlessV2PlatformVersion'),
        }),
      },
    });
    echoed.node.addDependency(docInstance);

    new cdk.CfnOutput(this, 'Echo', { value: echoed.getAttString('Json') });
    // The dotted members, from the same record as the whole objects.
    new cdk.CfnOutput(this, 'DbEndpointAddress', { value: cfnDb.attrEndpointAddress });
    new cdk.CfnOutput(this, 'DbEndpointPort', { value: cfnDb.attrEndpointPort });
    new cdk.CfnOutput(this, 'ClEndpointAddress', { value: cluster.attrEndpointAddress });
    // The unnamed resources' ids, for verify.sh's sweep.
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
    new cdk.CfnOutput(this, 'SubnetIds', { value: cdk.Fn.join(' ', subnetIds) });
  }
}
