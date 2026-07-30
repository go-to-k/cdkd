import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * EC2 instance fan-out fixture (issue #1292).
 *
 * TEN t3.nano instances sharing ONE freshly-named IAM instance profile,
 * launched concurrently. This is the worst case for the dense
 * IAM-propagation retry schedule added in #1288: every instance's
 * RunInstances fails with `Invalid IAM Instance Profile name` until EC2's
 * view of IAM catches up, and during that window ten parallel retry loops
 * put ~0.54 * 10 req/s against the account's RunInstances token bucket
 * (which refills at roughly 2 req/s). The #1292 question is whether the
 * throttle-aware backoff + the `sawPropagation` budget latch let the
 * deploy CONVERGE rather than exhaust a retry budget mid-storm.
 *
 * The `suffix` context value (passed by verify.sh as `-c suffix=<epoch>`)
 * keeps the instance profile and role names COLD on every run -- a
 * re-created profile under a warm name propagates ~5x faster (7.91s median
 * cold vs 1.49s warm, measured in the benchmark repo), which would shrink
 * the storm window and mask the interaction this fixture exists to
 * exercise.
 *
 * Instances are RAW L1 `ec2.CfnInstance` so every emitted top-level
 * property is SDK-provider-handled and the resources stay on the SDK path
 * (the path that carries the propagation retry; Cloud Control would hide
 * it). t3.nano keeps the vCPU footprint at 20 against the account's
 * 113-vCPU on-demand quota.
 */
export class Ec2InstanceFanoutStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const suffix = this.node.tryGetContext('suffix');
    if (!suffix) {
      throw new Error('pass -c suffix=<unique> so the IAM names are cold (see fixture doc)');
    }

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc,
      description: 'Fan-out fixture SG (no ingress)',
      allowAllOutbound: true,
    });

    // Freshly-named role + instance profile: the cold-path key. The names
    // carry the per-run suffix so AWS has never seen them before.
    const role = new iam.Role(this, 'InstanceRole', {
      roleName: `fanout-role-${suffix}`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    const profile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      instanceProfileName: `fanout-prof-${suffix}`,
      roles: [role.roleName],
    });

    const ami = ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;

    for (let i = 0; i < 10; i++) {
      new ec2.CfnInstance(this, `Instance${i}`, {
        imageId: ami,
        instanceType: 't3.nano',
        subnetId: vpc.publicSubnets[0].subnetId,
        availabilityZone: vpc.publicSubnets[0].availabilityZone,
        securityGroupIds: [securityGroup.securityGroupId],
        // The Ref edge onto the ONE shared profile is what synchronizes the
        // fan-out: all ten instances dispatch the moment the profile
        // completes, so their RunInstances retries overlap the same cold
        // propagation window.
        iamInstanceProfile: profile.ref,
      });
    }
  }
}
