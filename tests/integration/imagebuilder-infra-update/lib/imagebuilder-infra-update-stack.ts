import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import type { Construct } from 'constructs';

/**
 * An EC2 Image Builder infrastructure configuration WITHOUT `resourceTags`
 * (issue #6569).
 *
 * `AWS::ImageBuilder::InfrastructureConfiguration` has no SDK provider, so it
 * goes through Cloud Control, whose read model for such a configuration
 * carries `"ResourceTags": {}`. Cloud Control applies an update patch on top
 * of that model, so every update sent the empty map and
 * `UpdateInfrastructureConfiguration` refused it (`resourceTags length must
 * satisfy min_items 1`). cdkd now removes the read-back empty key.
 *
 * `CDKD_TEST_UPDATE=true` changes `instanceTypes` and
 * `terminateInstanceOnFailure` and removes `description`: all mutable, so the
 * configuration must update in place.
 *
 * covers: AWS::ImageBuilder::InfrastructureConfiguration
 * covers: AWS::IAM::InstanceProfile
 */
export class ImageBuilderInfraUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const updating = process.env.CDKD_TEST_UPDATE === 'true';

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    const profile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [role.roleName],
    });

    // Deliberately no `resourceTags`: the case under test.
    const infra = new imagebuilder.CfnInfrastructureConfiguration(this, 'Infra', {
      name: `${this.stackName}-infra`,
      instanceProfileName: profile.ref,
      instanceTypes: updating ? ['t3.small', 't3.medium'] : ['t3.micro'],
      terminateInstanceOnFailure: !updating,
      ...(updating ? {} : { description: 'cdkd integ #6569' }),
    });

    new cdk.CfnOutput(this, 'InfraArn', { value: infra.attrArn });
    new cdk.CfnOutput(this, 'InstanceProfileName', { value: profile.ref });
    new cdk.CfnOutput(this, 'RoleName', { value: role.roleName });
  }
}
