import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as redshift from 'aws-cdk-lib/aws-redshift';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Failure-seeking fixture for the CC-API attribute-enrichment gap on
 * `AWS::Redshift::Cluster`.
 *
 * Redshift Cluster has NO SDK provider, so it always routes through Cloud
 * Control. Pre-fix, `Fn::GetAtt(<Cluster>, 'Endpoint.Address')` /
 * `Endpoint.Port` fell through the intrinsic resolver's `constructAttribute`
 * to the physicalId (the cluster identifier) instead of the real
 * `*.redshift.amazonaws.com` endpoint — so a JDBC/ODBC connection string built
 * from it pointed at garbage.
 *
 * This stack deploys a single-node `ra3.large` cluster (smallest orderable), with
 * AWS-managed master credentials (no literal password in the fixture), and
 * stores its `Endpoint.Address` / `Endpoint.Port` into SSM Parameters via
 * Fn::GetAtt. verify.sh asserts the stored value is the real endpoint hostname.
 */
export class RedshiftClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const sg = new ec2.SecurityGroup(this, 'RedshiftSg', {
      vpc,
      description: 'cdkd redshift-cluster-getatt fixture SG',
      allowAllOutbound: true,
    });

    const subnetGroup = new redshift.CfnClusterSubnetGroup(this, 'SubnetGroup', {
      description: 'cdkd redshift-cluster-getatt fixture subnet group',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    // L1 CfnCluster: single-node ra3.large, AWS-managed master password
    // (manageMasterPassword) so no literal secret is committed. Redshift has
    // no core L2.
    const cluster = new redshift.CfnCluster(this, 'Cluster', {
      // Explicit identifier: Redshift requires it to start with a letter and
      // contain only lowercase letters, digits, and single hyphens. Without
      // this, the CC-API physical id (CDK-generated) is rejected at CREATE
      // with "ClusterIdentifier is not a valid identifier".
      clusterIdentifier: 'cdkdredshift-getatt',
      clusterType: 'single-node',
      // ra3.large is the smallest single-node-capable orderable node type;
      // the legacy dc2.large is no longer orderable (AWS returns
      // "Invalid node type: dc2.large").
      nodeType: 'ra3.large',
      dbName: 'cdkddb',
      masterUsername: 'cdkdadmin',
      manageMasterPassword: true,
      clusterSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [sg.securityGroupId],
      publiclyAccessible: false,
    });
    cluster.addDependency(subnetGroup);

    // LOAD-BEARING: these SSM Parameters' Value is a Fn::GetAtt against the
    // cluster's computed endpoint. Pre-fix they resolved to the cluster id
    // (garbage); post-fix they hold the real endpoint hostname/port.
    new ssm.CfnParameter(this, 'EndpointAddressParam', {
      name: '/cdkd-integ/redshift-cluster/endpoint-address',
      type: 'String',
      value: cluster.attrEndpointAddress,
    });
    new ssm.CfnParameter(this, 'EndpointPortParam', {
      name: '/cdkd-integ/redshift-cluster/endpoint-port',
      type: 'String',
      value: cluster.attrEndpointPort,
    });

    new cdk.CfnOutput(this, 'ClusterId', { value: cluster.ref });
  }
}
