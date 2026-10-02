import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as smsvoice from 'aws-cdk-lib/aws-smsvoice';

/**
 * Integ probe for the `--remove-protection` compensation of issue #2204: when
 * `cdkd destroy --remove-protection` turns a guard off and the delete then
 * fails TERMINALLY, cdkd turns the guard back on before reporting the failure.
 *
 * covers: AWS::EC2::Instance
 * covers: AWS::SMSVOICE::ProtectConfiguration
 * covers: AWS::AutoScaling::AutoScalingGroup
 * covers: AWS::EC2::LaunchTemplate
 *
 * Four protected resources, one per compensated delete route:
 *
 *  - `SdkInstance` — `DisableApiTermination: true`, every property handled by
 *    the SDK `EC2Provider`, so it deletes through `TerminateInstances`.
 *  - `CcInstance` — the same, plus `InstanceInitiatedShutdownBehavior`, which
 *    the SDK provider does not handle, so the #614 silent-drop rule routes the
 *    whole resource through Cloud Control (`provisionedBy: cc-api`).
 *    `'stop'` is the AWS default, so the property changes nothing else.
 *  - `ProtectConfig` — `AWS::SMSVOICE::ProtectConfiguration`, a Cloud Control
 *    protection-registry type (`cc-protection-properties.ts`),
 *    `DeletionProtectionEnabled: true`.
 *  - `ProtectedAsg` — an Auto Scaling group (`DeletionProtection:
 *    'prevent-all-deletion'`) launching ONE instance whose launch template
 *    sets `DisableApiTermination: true`. Its arm is the INSTANCE's guard: the
 *    group delete turns it off on every launched instance (issue #796), and
 *    when that group delete then fails terminally, cdkd must turn it back on.
 *
 * verify.sh makes each delete fail terminally from OUTSIDE with a dependent
 * cdkd does not manage: stop protection (`DisableApiStop`) on each instance,
 * which refuses `TerminateInstances` without touching `DisableApiTermination`,
 * and a configuration set associated with the protect configuration, which
 * refuses its delete. The group has no such dependent (`ForceDelete` deletes
 * through everything that would otherwise hold it), so verify.sh runs the
 * destroy under a role that may not call `UpdateAutoScalingGroup` on it: the
 * group's own flip is refused, and its `prevent-all-deletion` refuses the
 * delete, after cdkd has turned the instance's guard off. No VPC of its own:
 * the instances sit in the account's default VPC (subnet passed in through
 * `CDKD_INTEG_SUBNET_ID`), so the failing destroy is not followed by a VPC
 * teardown retrying `DependencyViolation` behind two live instances.
 */
export class RemoveProtectionCompensationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const subnetId = process.env.CDKD_INTEG_SUBNET_ID;
    if (!subnetId) {
      throw new Error('CDKD_INTEG_SUBNET_ID is required (a default-VPC subnet id; verify.sh sets it)');
    }
    const imageId = ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;

    new ec2.CfnInstance(this, 'SdkInstance', {
      imageId,
      instanceType: 't3.nano',
      subnetId,
      disableApiTermination: true,
      tags: [{ key: 'cdkd-integ', value: 'rp-compensation' }],
    });

    new ec2.CfnInstance(this, 'CcInstance', {
      imageId,
      instanceType: 't3.nano',
      subnetId,
      disableApiTermination: true,
      instanceInitiatedShutdownBehavior: 'stop',
      tags: [{ key: 'cdkd-integ', value: 'rp-compensation' }],
    });

    new smsvoice.CfnProtectConfiguration(this, 'ProtectConfig', {
      deletionProtectionEnabled: true,
      tags: [{ key: 'cdkd-integ', value: 'rp-compensation' }],
    });

    // A literal name, so verify.sh's cleanup can find a leftover without
    // state. Instances carry their OWN tag value: the instance sweep must not
    // terminate a group's instance while the group is still there to replace it.
    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'ProtectedAsgLt', {
      launchTemplateName: 'cdkd-rp-comp-asg-lt',
      launchTemplateData: {
        imageId,
        instanceType: 't3.nano',
        disableApiTermination: true,
        tagSpecifications: [
          {
            resourceType: 'instance',
            tags: [{ key: 'cdkd-integ', value: 'rp-compensation-asg' }],
          },
        ],
      },
    });
    const group = new autoscaling.CfnAutoScalingGroup(this, 'ProtectedAsg', {
      minSize: '1',
      maxSize: '1',
      desiredCapacity: '1',
      vpcZoneIdentifier: [subnetId],
      launchTemplate: {
        launchTemplateId: launchTemplate.ref,
        version: launchTemplate.attrLatestVersionNumber,
      },
      tags: [{ key: 'cdkd-integ', value: 'rp-compensation-asg', propagateAtLaunch: false }],
    });
    group.addPropertyOverride('DeletionProtection', 'prevent-all-deletion');
  }
}
