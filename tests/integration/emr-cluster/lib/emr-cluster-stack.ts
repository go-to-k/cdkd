import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as emr from 'aws-cdk-lib/aws-emr';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * Minimal single-node EMR-on-EC2 fixture for the AWS::EMR::Cluster SDK
 * provider (issue #1043). The type is ProvisioningType: NON_PROVISIONABLE,
 * so no Cloud Control fallback exists — this fixture is the end-to-end proof
 * of the SDK provider. Built on the L1 `emr.CfnCluster` (aws-cdk-lib ships no
 * L2 for EMR clusters).
 *
 * covers: AWS::EMR::Cluster
 * covers: AWS::EC2::VPC
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::InstanceProfile
 *
 * Smallest / cheapest legal shape: a single master node (1x m5.xlarge, no
 * core/task), `emr-7.9.0`, in a public subnet (no NAT). An
 * `AutoTerminationPolicy` idle-timeout of 1 hour bounds the worst-case cost
 * if a destroy is ever skipped — long enough not to race the normal
 * deploy/verify/destroy window, short enough to cap an orphan.
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) exercises the LIMITED mutable surface:
 *   - StepConcurrencyLevel 1 -> 5 (ModifyCluster)
 *   - VisibleToAllUsers true -> false (SetVisibleToAllUsers)
 *   - Tag value change + tag REMOVAL (AddTags / RemoveTags)
 * All near-instant API calls against the SAME running cluster — the ClusterId
 * must stay unchanged (no replacement).
 */
export class EmrClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // VPC with 1 AZ, public subnet only, no NAT (cheapest legal shape).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    // EMR service role — assumed by the EMR service to manage the cluster.
    const serviceRole = new iam.Role(this, 'EmrServiceRole', {
      assumedBy: new iam.ServicePrincipal('elasticmapreduce.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonElasticMapReduceRole'),
      ],
    });

    // EMR EC2 (JobFlow) role — assumed by the cluster's EC2 instances, wrapped
    // in an instance profile that the cluster references as its JobFlowRole.
    const ec2Role = new iam.Role(this, 'EmrEc2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonElasticMapReduceforEC2Role'
        ),
      ],
    });
    const instanceProfile = new iam.CfnInstanceProfile(this, 'EmrEc2InstanceProfile', {
      roles: [ec2Role.roleName],
    });

    const cluster = new emr.CfnCluster(this, 'Cluster', {
      name: 'cdkd-integ-emr',
      releaseLabel: 'emr-7.9.0',
      serviceRole: serviceRole.roleArn,
      jobFlowRole: instanceProfile.ref,
      visibleToAllUsers: !isUpdate,
      stepConcurrencyLevel: isUpdate ? 5 : 1,
      // Cap orphan cost if a destroy is ever skipped. 1h is well beyond the
      // normal deploy+verify+destroy window, so it never races the test.
      autoTerminationPolicy: { idleTimeout: 3600 },
      instances: {
        ec2SubnetId: vpc.publicSubnets[0].subnetId,
        // Single-node cluster: master only, stays alive with no steps.
        keepJobFlowAliveWhenNoSteps: true,
        terminationProtected: false,
        masterInstanceGroup: {
          instanceCount: 1,
          instanceType: 'm5.xlarge',
          market: 'ON_DEMAND',
          name: 'Master',
        },
      },
      tags: [
        // Constant tag used by verify.sh cleanup to find leftover clusters.
        { key: 'cdkd-integ', value: 'emr-cluster' },
        { key: 'env', value: isUpdate ? 'changed' : 'test' },
        // Removed in the UPDATE phase — exercises RemoveTags.
        ...(isUpdate ? [] : [{ key: 'dropme', value: 'yes' }]),
      ],
    });

    // IAM must exist before RunJobFlow references the roles / instance profile.
    cluster.node.addDependency(serviceRole, ec2Role, instanceProfile);

    new cdk.CfnOutput(this, 'ClusterId', { value: cluster.ref });
    // Fn::GetAtt MasterPublicDNS — proves the provider's attribute wiring.
    new cdk.CfnOutput(this, 'MasterPublicDns', { value: cluster.attrMasterPublicDns });
  }
}
