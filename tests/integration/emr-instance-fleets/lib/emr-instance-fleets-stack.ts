import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as emr from 'aws-cdk-lib/aws-emr';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * Fleet-based sibling of the `emr-instance-configs` fixture (issue #1400).
 *
 * `emr-instance-configs` covers the instance-GROUP half of issue #1070 /
 * #1383. A cluster's instance-collection type is fixed at create (groups XOR
 * fleets), so it structurally cannot also cover the FLEET half — which left
 * every `InstanceTypeConfigs` conversion site with unit-test-only proof:
 *
 *  - `EMRClusterProvider.toInstanceFleetConfig` (the INLINE
 *    `Cluster.Instances.{Master,Core}InstanceFleet` path), and
 *  - `EMRInstanceFleetConfigProvider.create` / its `ModifyInstanceFleet`
 *    update path (the STANDALONE `AWS::EMR::InstanceFleetConfig` path).
 *
 * #1383 was precisely a send-side-looks-fine / AWS-silently-discards bug: the
 * SDK v3 serializer drops unknown members, so CFn's
 * `Configuration.ConfigurationProperties` had to be renamed to the SDK's
 * `Properties`. A unit test proves cdkd SENDS the block; only a real cluster
 * proves EMR ACCEPTED it. Every fleet here therefore carries a per-instance-type
 * `Configurations` marker that verify.sh reads back from AWS.
 *
 * covers: AWS::EMR::Cluster
 * covers: AWS::EMR::InstanceFleetConfig
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::SecurityGroup
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::InstanceProfile
 *
 * Smallest LEGAL shape for this type: a master fleet + a core fleet (target
 * On-Demand capacity 1 each, 1x `m5.xlarge`) plus a standalone TASK fleet
 * (1x `m5.xlarge`), `emr-7.9.0`, in a public subnet (no NAT). `AddInstanceFleet`
 * only accepts a TASK fleet, and EMR rejects it on a master-only job flow, so
 * the core fleet is required. Fleet-based clusters take `Ec2SubnetIds` (plural)
 * — `Ec2SubnetId` applies to the uniform instance-GROUP configuration only. An
 * `AutoTerminationPolicy` idle-timeout of 1 hour bounds the worst-case cost if
 * a destroy is ever skipped.
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) resizes the standalone TASK fleet's
 * `TargetOnDemandCapacity` from 1 -> 2 (`ModifyInstanceFleet`, polled until the
 * provisioned capacity settles) against the SAME cluster + fleet — the fleet Id
 * must stay unchanged (no replacement). `InstanceTypeConfigs` is deliberately
 * identical across both phases: it IS mutable on `ModifyInstanceFleet`, but
 * changing it here would make a failed capacity assertion ambiguous between the
 * resize and the config conversion.
 *
 * DELETE: there is no standalone "delete instance fleet" API in EMR. The fleet
 * is released when the cluster terminates (`TerminateJobFlows`); the
 * InstanceFleetConfig provider's delete additionally best-effort scales a TASK
 * fleet to 0 first. On destroy the fleet depends on the cluster (via
 * `ClusterId`), so it is deleted before the cluster — zero orphans once the
 * cluster terminates.
 */
export class EmrInstanceFleetsStack extends cdk.Stack {
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

    /**
     * Per-instance-type `Configurations` carrying a marker verify.sh reads back
     * through `ListInstanceFleets`. This is the nested blob issue #1383 fixed:
     * CFn spells the bag `ConfigurationProperties`, the SDK member is
     * `Properties`, and an unrenamed key is silently dropped by the serializer.
     */
    const markerConfigurations = (marker: string) => [
      {
        classification: 'core-site',
        configurationProperties: { 'cdkd.integ.marker': marker },
      },
    ];

    const cluster = new emr.CfnCluster(this, 'Cluster', {
      name: 'cdkd-integ-emr-instance-fleets',
      releaseLabel: 'emr-7.9.0',
      serviceRole: serviceRole.roleArn,
      jobFlowRole: instanceProfile.ref,
      // Cap orphan cost if a destroy is ever skipped.
      autoTerminationPolicy: { idleTimeout: 3600 },
      instances: {
        // Fleet-based clusters use the PLURAL subnet list; `Ec2SubnetId` is the
        // instance-group form and EMR rejects it alongside instance fleets.
        ec2SubnetIds: [vpc.publicSubnets[0].subnetId],
        emrManagedMasterSecurityGroup: emrSg.securityGroupId,
        emrManagedSlaveSecurityGroup: emrSg.securityGroupId,
        // The cluster stays alive with no steps so the standalone TASK fleet can
        // be added and resized. The CORE fleet is REQUIRED — EMR rejects
        // AddInstanceFleet on a master-only job flow.
        keepJobFlowAliveWhenNoSteps: true,
        terminationProtected: false,
        // INLINE fleets — the `EMRClusterProvider.toInstanceFleetConfig`
        // conversion site, distinct from the standalone provider below.
        masterInstanceFleet: {
          name: 'Master',
          targetOnDemandCapacity: 1,
          instanceTypeConfigs: [
            {
              instanceType: 'm5.xlarge',
              weightedCapacity: 1,
              configurations: markerConfigurations('master-fleet'),
            },
          ],
        },
        coreInstanceFleet: {
          name: 'Core',
          targetOnDemandCapacity: 1,
          instanceTypeConfigs: [
            {
              instanceType: 'm5.xlarge',
              weightedCapacity: 1,
              configurations: markerConfigurations('core-fleet'),
            },
          ],
        },
      },
      tags: [
        // Constant tag used by verify.sh cleanup to find leftover clusters.
        { key: 'cdkd-integ', value: 'emr-instance-fleets' },
      ],
    });
    cluster.node.addDependency(serviceRole, ec2Role, instanceProfile);

    // The standalone TASK instance fleet — the resource under test. It is added
    // to the EXISTING cluster (referenced by ClusterId) via AddInstanceFleet,
    // rather than declared inline in Cluster.Instances above.
    const taskFleet = new emr.CfnInstanceFleetConfig(this, 'TaskFleet', {
      clusterId: cluster.ref,
      instanceFleetType: 'TASK',
      name: 'cdkd-integ-task-fleet',
      targetOnDemandCapacity: isUpdate ? 2 : 1,
      instanceTypeConfigs: [
        {
          instanceType: 'm5.xlarge',
          weightedCapacity: 1,
          configurations: markerConfigurations('task-fleet'),
        },
      ],
    });
    // AddInstanceFleet requires the cluster to be WAITING/RUNNING first; the
    // ClusterId Ref already induces this ordering, but make it explicit.
    taskFleet.node.addDependency(cluster);

    new cdk.CfnOutput(this, 'ClusterId', { value: cluster.ref });
    // Ref / Fn::GetAtt Id of the standalone instance fleet — proves the
    // provider's physicalId + attribute wiring.
    new cdk.CfnOutput(this, 'TaskFleetId', { value: taskFleet.ref });
    new cdk.CfnOutput(this, 'TaskFleetAttrId', { value: taskFleet.attrId });
  }
}
