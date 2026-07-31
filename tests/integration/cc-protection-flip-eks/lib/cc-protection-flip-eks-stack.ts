import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eks from 'aws-cdk-lib/aws-eks';

/**
 * Integ probe for the generic CC-routed deletion-protection flip on
 * `AWS::EKS::Cluster` (issue #1315, mechanism from #1312 / #1314). The
 * cluster deploys with `DeletionProtection: true`, so a bare destroy must
 * fail on it and `destroy --remove-protection` must flip the property off
 * via a Cloud Control UpdateResource patch and delete cleanly. Kept
 * separate from the fast `cc-protection-flip` fixture because the EKS
 * control plane takes ~10-15 min each way.
 *
 * covers: AWS::EKS::Cluster
 *
 * Minimal L1 cluster: a 2-AZ public-subnet VPC (no NAT) + the EKS cluster
 * role. The cluster has a deterministic name so verify.sh's cleanup can
 * discover leftovers without state.
 */
export class CcProtectionFlipEksStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const role = new iam.Role(this, 'ClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
      ],
    });

    new eks.CfnCluster(this, 'Cluster', {
      name: 'cdkd-ccprot-eks',
      roleArn: role.roleArn,
      deletionProtection: true,
      resourcesVpcConfig: {
        subnetIds: vpc.publicSubnets.map((s) => s.subnetId),
      },
    });
  }
}
