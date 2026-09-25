import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

/**
 * Integ probe for `cdkd import --migrate-from-cloudformation` recording the
 * attribute maps `create()` records (issue #3627), last batch. Before the fix
 * each resolved wrong after an import:
 *
 * - StepFunctions `Name` / `StateMachineRevisionId` → the ARN;
 * - WAFv2 WebACL `Id` / `LabelNamespace` → the ARN — and the import itself
 *   THREW, because CloudFormation's physical id is `name|id|scope`;
 * - Cognito UserPool `ProviderName` / `ProviderURL` → the pool id;
 * - RDS DBCluster `Endpoint.Address` / `Endpoint.Port` /
 *   `ReadEndpoint.Address` → the cluster identifier;
 * - S3 Vectors `VectorBucketArn` → refused, and CloudFormation's physical id is
 *   the ARN, which the import sent to `GetVectorBucket` as a name.
 *
 * One SSM parameter per attribute carries the `Fn::GetAtt`. The cluster sits in
 * an L1 VPC with no route tables, which `--migrate-from-cloudformation` did not
 * adopt before #3661.
 */
export class ImportAttributeReadbackFinalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pin = (c: cdk.CfnResource, logicalId: string) => c.overrideLogicalId(logicalId);
    const param = (logicalId: string, value: string) => {
      const p = new ssm.StringParameter(this, logicalId, { stringValue: value });
      pin(p.node.defaultChild as cdk.CfnResource, logicalId);
    };

    const sfnRole = new iam.Role(this, 'SfnRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    const machine = new sfn.CfnStateMachine(this, 'Machine', {
      roleArn: sfnRole.roleArn,
      definitionString: JSON.stringify({ StartAt: 'Done', States: { Done: { Type: 'Pass', End: true } } }),
    });
    pin(machine, 'Machine');
    param('MachineNameParam', machine.attrName);
    param('MachineRevisionParam', machine.attrStateMachineRevisionId);

    const acl = new wafv2.CfnWebACL(this, 'Acl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: false,
        metricName: 'cdkd-import-readback',
        sampledRequestsEnabled: false,
      },
    });
    pin(acl, 'Acl');
    param('AclIdParam', acl.attrId);
    param('AclLabelNamespaceParam', acl.attrLabelNamespace);

    const pool = new cognito.CfnUserPool(this, 'Pool', {});
    pool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    pin(pool, 'Pool');
    param('PoolProviderNameParam', pool.attrProviderName);
    param('PoolProviderUrlParam', pool.attrProviderUrl);

    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.43.0.0/16' });
    pin(vpc, 'Vpc');
    const subnet = (logicalId: string, index: number, cidr: string) => {
      const s = new ec2.CfnSubnet(this, logicalId, {
        vpcId: vpc.ref,
        cidrBlock: cidr,
        availabilityZone: cdk.Fn.select(index, cdk.Fn.getAzs()),
      });
      pin(s, logicalId);
      return s;
    };
    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'DbSubnets', {
      dbSubnetGroupDescription: 'cdkd import readback integ (#3627)',
      subnetIds: [subnet('SubnetA', 0, '10.43.0.0/24').ref, subnet('SubnetB', 1, '10.43.1.0/24').ref],
    });
    pin(subnetGroup, 'DbSubnets');
    const cluster = new rds.CfnDBCluster(this, 'Db', {
      engine: 'aurora-postgresql',
      masterUsername: 'cdkd',
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.ref,
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 1 },
      deletionProtection: false,
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    pin(cluster, 'Db');
    param('DbEndpointParam', cluster.attrEndpointAddress);
    param('DbPortParam', cluster.attrEndpointPort);
    param('DbReadEndpointParam', cluster.attrReadEndpointAddress);

    const vectors = new cdk.CfnResource(this, 'Vectors', {
      type: 'AWS::S3Vectors::VectorBucket',
      properties: {},
    });
    vectors.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    pin(vectors, 'Vectors');
    param('VectorsArnParam', vectors.getAtt('VectorBucketArn').toString());
  }
}
