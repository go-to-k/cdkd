import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6940 rule (1): under `cdkd deploy --no-wait`, a `Fn::GetAtt`
 * of a value a skipped-wait resource reports only once ready waits for it.
 *
 * The RDS instance's create returns while it is `creating`, so its record has
 * no `Endpoint.Address` / `Endpoint.Port` yet. An echo custom resource and two
 * Outputs reference them. Before #6940 the references were refused at once and
 * the deploy failed; now they wait for the instance's `available` wait (one
 * shared wait), read the instance again, serve RDS's endpoint, and leave it on
 * the record.
 *
 * Nothing here declares a property the SDK provider leaves unwired, which
 * would route the instance through Cloud Control (whose create waits);
 * verify.sh asserts the route.
 *
 * covers: AWS::RDS::DBInstance
 */
export class NoWaitGetattRdsEndpointStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const name = id.toLowerCase();

    // A bare VPC and two subnets, found by their Name tags in cleanup.
    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.43.0.0/16',
      tags: [{ key: 'Name', value: `${id}-vpc` }],
    });
    const subnets = [0, 1].map(
      (i) =>
        new ec2.CfnSubnet(this, `Subnet${i}`, {
          vpcId: vpc.ref,
          cidrBlock: `10.43.${i}.0/24`,
          availabilityZone: cdk.Fn.select(i, cdk.Fn.getAzs()),
          tags: [{ key: 'Name', value: `${id}-subnet-${i}` }],
        })
    );
    const dbSubnets = new rds.CfnDBSubnetGroup(this, 'DbSubnets', {
      dbSubnetGroupName: `${name}-db`,
      dbSubnetGroupDescription: 'cdkd #6940 integ',
      subnetIds: subnets.map((s) => s.ref),
    });

    // AWS manages the master password; no backups, so no automated backup or
    // snapshot is left to sweep.
    const db = new rds.CfnDBInstance(this, 'Db', {
      dbInstanceIdentifier: `${name}-db`,
      engine: 'postgres',
      engineVersion: '16',
      dbInstanceClass: 'db.t4g.micro',
      allocatedStorage: '20',
      masterUsername: 'cdkd',
      manageMasterUserPassword: true,
      dbSubnetGroupName: dbSubnets.ref,
      backupRetentionPeriod: 0,
    });
    db.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // The echo returns the properties it was sent as one JSON string (cdkd's
    // synchronous path). Its role and log group are named for the sweep.
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
      runtime: lambda.Runtime.NODEJS_22_X,
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
    const echoed = new cdk.CustomResource(this, 'EchoEndpoint', {
      serviceToken: echo.functionArn,
      properties: {
        Address: db.attrEndpointAddress,
        Port: db.attrEndpointPort,
      },
    });

    new cdk.CfnOutput(this, 'Echo', { value: echoed.getAttString('Json') });
    new cdk.CfnOutput(this, 'DbEndpointAddress', { value: db.attrEndpointAddress });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
  }
}
