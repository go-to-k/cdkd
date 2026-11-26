import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Issue #7006, the Neptune arm: an in-place `DBPort` change applies after
 * ModifyDBCluster returns, so an update recording the cluster from the read
 * right after the call kept the OLD `Port`, and a reader re-resolved after
 * the update got it. `CDKD_TEST_DB_PORT` sets the port; the SSM parameter is
 * the READER verify.sh reads live after the update.
 *
 * One cluster with no instance (Neptune allows that), in an isolated VPC: the
 * lightest Neptune shape. Every property set is one the Neptune SDK provider
 * handles, so the cluster stays on the SDK route.
 *
 * covers: AWS::Neptune::DBCluster, AWS::Neptune::DBSubnetGroup, AWS::SSM::Parameter
 */
export class NeptuneClusterPortStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const port = Number(process.env['CDKD_TEST_DB_PORT'] ?? '8182');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new neptune.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for the neptune-cluster-port fixture',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const cluster = new neptune.CfnDBCluster(this, 'Cluster', {
      dbClusterIdentifier: `${this.stackName.toLowerCase()}-cluster`,
      dbSubnetGroupName: subnetGroup.ref,
      // Declared from the first deploy, so the update phase CHANGES it.
      dbPort: port,
      deletionProtection: false,
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new ssm.StringParameter(this, 'PortReader', {
      parameterName: `/${id}/cluster-port`,
      stringValue: cluster.attrPort,
    });
    new cdk.CfnOutput(this, 'ClusterPort', { value: cluster.attrPort });
  }
}
