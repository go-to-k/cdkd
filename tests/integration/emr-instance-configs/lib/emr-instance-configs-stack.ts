import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as emr from 'aws-cdk-lib/aws-emr';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * Minimal fixture for the AWS::EMR::InstanceGroupConfig SDK provider
 * (issue #1070). Both InstanceGroupConfig and InstanceFleetConfig are
 * ProvisioningType: NON_PROVISIONABLE, so no Cloud Control fallback exists —
 * this fixture is the end-to-end proof of the InstanceGroupConfig SDK
 * provider.
 *
 * A cluster is created group-based (its master is a `masterInstanceGroup`), so
 * a standalone `AWS::EMR::InstanceGroupConfig` (the group-based sibling of the
 * inline `Cluster.Instances`) can be attached to it. A single cluster's
 * instance-collection type is fixed at create (groups XOR fleets), so ONE
 * cluster can only exercise ONE of the two new types; the InstanceFleetConfig
 * provider — structurally identical (same create-poll / no-op-delete /
 * scale-to-0-TASK design, different API) — is covered by unit tests. Keeping a
 * single cluster is a deliberate cost bound (an EMR cluster bills per
 * instance-hour).
 *
 * covers: AWS::EMR::Cluster
 * covers: AWS::EMR::InstanceGroupConfig
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::SecurityGroup
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::InstanceProfile
 *
 * Smallest LEGAL shape for this type: a master + one core node (1x m5.xlarge
 * each) plus a standalone TASK instance group (1x m5.xlarge, ON_DEMAND),
 * `emr-7.9.0`, in a public subnet (no NAT). The core node is REQUIRED — EMR
 * rejects AddInstanceGroups on a master-only job flow, so a standalone TASK
 * group needs a cluster that already has a core group. An
 * `AutoTerminationPolicy` idle-timeout of 1 hour bounds the worst-case cost if
 * a destroy is ever skipped.
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) resizes the TASK group from 1 -> 2
 * instances (`ModifyInstanceGroups`, polled until RUNNING) against the SAME
 * cluster + group — the group Id must stay unchanged (no replacement).
 *
 * DELETE: there is no standalone "delete instance group" API in EMR. The
 * group is released when the cluster terminates (`TerminateJobFlows`); the
 * InstanceGroupConfig provider's delete additionally best-effort scales a TASK
 * group to 0 first. On destroy the group depends on the cluster (via
 * `JobFlowId`), so it is deleted before the cluster — zero orphans once the
 * cluster terminates.
 */
export class EmrInstanceConfigsStack extends cdk.Stack {
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

    // Explicit EMR-managed security group shared by master + slave. Providing
    // one stops EMR from auto-creating its own `ElasticMapReduce-master` /
    // `-slave` groups (which are NOT in the CDK template, so cdkd's destroy
    // can't delete them and they'd block the VPC teardown). A single shared
    // group gets only SELF-referencing rules, which do not block
    // `DeleteSecurityGroup`. (See the emr-cluster fixture for the full
    // rationale.)
    const emrSg = new ec2.SecurityGroup(this, 'EmrSg', {
      vpc,
      description: 'cdkd integ EMR managed SG (shared master/slave)',
      allowAllOutbound: true,
    });

    const cluster = new emr.CfnCluster(this, 'Cluster', {
      name: 'cdkd-integ-emr-instance-configs',
      releaseLabel: 'emr-7.9.0',
      serviceRole: serviceRole.roleArn,
      jobFlowRole: instanceProfile.ref,
      // Cap orphan cost if a destroy is ever skipped.
      autoTerminationPolicy: { idleTimeout: 3600 },
      instances: {
        ec2SubnetId: vpc.publicSubnets[0].subnetId,
        emrManagedMasterSecurityGroup: emrSg.securityGroupId,
        emrManagedSlaveSecurityGroup: emrSg.securityGroupId,
        // Master + one core node. A CORE group is REQUIRED before a standalone
        // TASK instance group can be attached — EMR rejects AddInstanceGroups on
        // a master-only job flow ("Cannot add instance groups to a master only
        // job flow"). Both are 1x m5.xlarge; the cluster stays alive with no
        // steps so the standalone TASK group can be added and resized.
        keepJobFlowAliveWhenNoSteps: true,
        terminationProtected: false,
        masterInstanceGroup: {
          instanceCount: 1,
          instanceType: 'm5.xlarge',
          market: 'ON_DEMAND',
          name: 'Master',
        },
        coreInstanceGroup: {
          instanceCount: 1,
          instanceType: 'm5.xlarge',
          market: 'ON_DEMAND',
          name: 'Core',
        },
      },
      tags: [
        // Constant tag used by verify.sh cleanup to find leftover clusters.
        { key: 'cdkd-integ', value: 'emr-instance-configs' },
      ],
    });
    cluster.node.addDependency(serviceRole, ec2Role, instanceProfile);

    // The standalone TASK instance group — the resource under test. It is
    // added to the EXISTING cluster (referenced by JobFlowId) via
    // AddInstanceGroups, rather than declared inline in Cluster.Instances.
    const taskGroup = new emr.CfnInstanceGroupConfig(this, 'TaskGroup', {
      jobFlowId: cluster.ref,
      instanceRole: 'TASK',
      instanceType: 'm5.xlarge',
      instanceCount: isUpdate ? 2 : 1,
      market: 'ON_DEMAND',
      name: 'cdkd-integ-task-group',
    });
    // AddInstanceGroups requires the cluster to be WAITING/RUNNING first; the
    // JobFlowId Ref already induces this ordering, but make it explicit.
    taskGroup.node.addDependency(cluster);

    new cdk.CfnOutput(this, 'ClusterId', { value: cluster.ref });
    // Ref / Fn::GetAtt Id of the standalone instance group — proves the
    // provider's physicalId + attribute wiring.
    new cdk.CfnOutput(this, 'TaskGroupId', { value: taskGroup.ref });
    new cdk.CfnOutput(this, 'TaskGroupAttrId', { value: taskGroup.attrId });
  }
}
