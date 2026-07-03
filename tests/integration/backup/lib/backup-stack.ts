import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as backup from 'aws-cdk-lib/aws-backup';

/**
 * Integ probe for the AWS::Backup::* Fn::GetAtt enrichment gap (issue #984).
 *
 * `AWS::Backup::*` types have NO SDK provider (pure Cloud Control). The CC
 * CREATE ResourceModel is sparse for Backup, so `Fn::GetAtt(<Vault>,
 * 'BackupVaultArn')` (the canonical CDK shape, emitted by
 * `vault.backupVaultArn`) fell through cdkd's intrinsic resolver's
 * `constructAttribute` default to the physicalId — which for a BackupVault is
 * the vault NAME, not the ARN. The `CfnOutput('VaultArn')` then carried the
 * bare vault name instead of a real `arn:aws:backup:...` ARN (deploy stayed
 * green — a silent GetAtt divergence).
 *
 * This fixture wires the whole Backup family (Vault + Plan referencing the
 * vault + a tag-based Selection) so the deploy exercises the enrichment, and
 * exposes the vault ARN as a stack output verify.sh asserts starts with
 * `arn:aws:backup:` (NOT the bare vault name).
 */
// covers: AWS::Backup::BackupVault
// covers: AWS::Backup::BackupPlan
// covers: AWS::Backup::BackupSelection
export class BackupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: `${this.stackName.toLowerCase()}-vault`,
      // No recovery points are ever created in this integ, so the vault is
      // empty and can be deleted cleanly on destroy.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const plan = new backup.BackupPlan(this, 'Plan', {
      backupPlanName: `${this.stackName.toLowerCase()}-plan`,
      backupVault: vault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'DailyRule',
          scheduleExpression: cdk.aws_events.Schedule.cron({
            hour: '5',
            minute: '0',
          }),
          deleteAfter: cdk.Duration.days(35),
        }),
      ],
    });

    // A tag-based selection exercises AWS::Backup::BackupSelection (its CC
    // primaryIdentifier is the compound `Id` = `<SelectionId>_<BackupPlanId>`,
    // joined by an UNDERSCORE).
    const selection = plan.addSelection('Selection', {
      resources: [
        backup.BackupResource.fromTag('cdkd-backup-integ', 'true'),
      ],
    });

    // The output value is Fn::GetAtt(Vault, 'BackupVaultArn') — the attribute
    // whose enrichment this integ regression-guards.
    new cdk.CfnOutput(this, 'VaultArn', {
      value: vault.backupVaultArn,
    });

    // `Ref` on the selection: CFn returns the bare BackupSelectionId (issue
    // #995). cdkd must return the same, NOT the compound `Id`. Reach the L1
    // child to emit a raw `{Ref: <logicalId>}`.
    const cfnSelection = selection.node.defaultChild as backup.CfnBackupSelection;
    new cdk.CfnOutput(this, 'SelectionRef', {
      value: cfnSelection.ref,
    });
  }
}
