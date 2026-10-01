import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as smsvoice from 'aws-cdk-lib/aws-smsvoice';

/**
 * Integ probe for the `--remove-protection` compensation of issue #2204: when
 * `cdkd destroy --remove-protection` turns a guard off and the delete then
 * fails TERMINALLY, cdkd turns the guard back on before reporting the failure.
 *
 * covers: AWS::EC2::Instance
 * covers: AWS::SMSVOICE::ProtectConfiguration
 *
 * Three protected resources, one per compensated delete route:
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
 *
 * verify.sh makes each delete fail terminally from OUTSIDE with a dependent
 * cdkd does not manage: stop protection (`DisableApiStop`) on each instance,
 * which refuses `TerminateInstances` without touching `DisableApiTermination`,
 * and a configuration set associated with the protect configuration, which
 * refuses its delete. No VPC of its own:
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
  }
}
