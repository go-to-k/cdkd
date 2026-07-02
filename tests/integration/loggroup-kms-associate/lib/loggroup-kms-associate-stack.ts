import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';

// cdkd LogGroup KmsKeyId-update integ probe (issue #958 item 1).
//
// Phase 1 (base): log group with no KMS key; a customer-managed key exists in
// the stack (with the logs-service key-policy grant the fixture wires
// manually — see below) but is not yet associated.
// Phase 2 (CDKD_TEST_UPDATE=true): the log group associates the key.
//
// CFn applies a KmsKeyId change in place ("Update requires: No interruption")
// via AssociateKmsKey / DisassociateKmsKey. cdkd's
// logs-loggroup-provider.update() previously had no KmsKeyId branch (while
// ReplacementRulesRegistry classifies it as updateable), so the association
// was silently dropped: the deploy reported success while AWS kept the log
// group unencrypted (and the next diff saw no change since state recorded the
// key, so it could never self-heal). The fix wires AssociateKmsKey /
// DisassociateKmsKey into update(); verify.sh proves BOTH directions reach
// AWS (associate on phase 2, disassociate on a phase-1 re-deploy).
//
// The key is declared in BOTH phases (only the log group's reference toggles)
// so the update diff is exactly the KmsKeyId property. RemovalPolicy.DESTROY
// schedules the key's deletion on destroy (7-day KMS pending-deletion window
// is AWS-mandated and not an orphan).
export class LoggroupKmsAssociateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const withKey = process.env.CDKD_TEST_UPDATE === 'true';

    const key = new kms.Key(this, 'LgKey', {
      description: 'cdkd loggroup-kms-associate integ probe key',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    // AssociateKmsKey requires the key policy to allow the CloudWatch Logs
    // service principal (the logs L2 does NOT wire this automatically —
    // CloudFormation users must add it too, per the AWS::Logs::LogGroup
    // KmsKeyId docs). Declared in BOTH phases so the phase diff stays
    // exactly the log group's KmsKeyId property.
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${cdk.Aws.REGION}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:*`,
          },
        },
      })
    );

    const lg = new logs.LogGroup(this, 'KmsLg', {
      retention: logs.RetentionDays.ONE_DAY,
      encryptionKey: withKey ? key : undefined,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'LgName', { value: lg.logGroupName });
    new cdk.CfnOutput(this, 'KeyArn', { value: key.keyArn });
  }
}
