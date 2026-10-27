import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * A DocumentDB-sourced Lambda event source mapping, updated in place (issue
 * #1160).
 *
 * covers: AWS::Lambda::EventSourceMapping
 * covers: AWS::DocDB::DBCluster
 * covers: AWS::DocDB::DBInstance
 *
 * `UpdateEventSourceMapping` refuses `DocumentDBEventSourceConfig.DatabaseName`
 * and `.CollectionName`, even unchanged, and CloudFormation sends
 * `{ FullDocument }` alone (A/B on the issue). The phases, chosen by
 * `CDKD_TEST_UPDATE`:
 *
 * - unset (baseline): `db1` / `c1` / `UpdateLookup`, `BatchSize: 10`.
 * - `change`: `BatchSize: 20`, `CollectionName: c2`, `FullDocument: Default`.
 *   The update must succeed, apply `BatchSize` and `FullDocument`, and keep
 *   `c1` with a warning (CloudFormation keeps it too).
 * - `removal`: the block drops `CollectionName` and `FullDocument`. The live
 *   values stay, as CloudFormation keeps them, and cdkd warns.
 *
 * The mapping stays disabled, so nothing polls the cluster. The master
 * password comes from a generated secret, through a dynamic reference.
 */
export class LambdaEsmDocumentdbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_UPDATE ?? '';
    const prefix = this.stackName.toLowerCase();

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new docdb.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for the lambda-esm-documentdb fixture',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const secret = new secretsmanager.Secret(this, 'Secret', {
      secretName: `${this.stackName}-docdb`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'cdkdadmin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\ \'',
        passwordLength: 24,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cluster = new docdb.CfnDBCluster(this, 'Cluster', {
      dbClusterIdentifier: `${prefix}-cluster`,
      masterUsername: 'cdkdadmin',
      masterUserPassword: secret.secretValueFromJson('password').unsafeUnwrap(),
      dbSubnetGroupName: subnetGroup.ref,
      storageEncrypted: false,
      deletionProtection: false,
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const instance = new docdb.CfnDBInstance(this, 'Instance', {
      dbInstanceIdentifier: `${prefix}-db`,
      dbClusterIdentifier: cluster.ref,
      // The smallest DocDB class (see the docdb-fix-forward-orphan fixture).
      dbInstanceClass: 'db.t3.medium',
    });
    instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler=async()=>({});'),
    });
    // What Lambda checks on a DocumentDB mapping's execution role.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds:DescribeDBClusters',
          'rds:DescribeDBClusterParameters',
          'rds:DescribeDBSubnetGroups',
          'ec2:CreateNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DescribeVpcs',
          'ec2:DeleteNetworkInterface',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
        ],
        resources: ['*'],
      })
    );
    secret.grantRead(fn);

    const documentDb =
      phase === 'change'
        ? { databaseName: 'db1', collectionName: 'c2', fullDocument: 'Default' }
        : phase === 'removal'
          ? { databaseName: 'db1' }
          : { databaseName: 'db1', collectionName: 'c1', fullDocument: 'UpdateLookup' };

    const mapping = new lambda.CfnEventSourceMapping(this, 'Mapping', {
      functionName: fn.functionName,
      eventSourceArn: cdk.Stack.of(this).formatArn({
        service: 'rds',
        resource: 'cluster',
        resourceName: cluster.ref,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      }),
      enabled: false,
      batchSize: phase === '' ? 10 : 20,
      sourceAccessConfigurations: [{ type: 'BASIC_AUTH', uri: secret.secretArn }],
      documentDbEventSourceConfig: documentDb,
    });
    mapping.node.addDependency(instance);
    mapping.node.addDependency(fn.role!);
  }
}
