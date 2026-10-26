import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface DynamoDBGlobalTableReplicaSettingsStackProps extends cdk.StackProps {
  /** The second replica's region; must differ from the stack's own. */
  readonly secondRegion: string;
  /** A customer managed key in `secondRegion`, created by verify.sh. */
  readonly replicaKeyArn: string;
  /** A second customer managed key in `secondRegion`, for the `rotated` mode. */
  readonly replicaKey2Arn: string;
}

/**
 * Real-AWS fixture for issue #5355: a two-region `TableV2` whose replica
 * settings CDK renders PER REPLICA — `Replicas[].SSESpecification.KMSMasterKeyId`,
 * `Replicas[].TableClass` and `Replicas[].DeletionProtectionEnabled`. cdkd read
 * the first two under names the CFn schema does not have and never sent the
 * third for a cross-region replica.
 *
 * covers: AWS::DynamoDB::GlobalTable, AWS::KMS::Key, AWS::KMS::Alias
 *
 * `CDKD_TEST_UPDATE` (comma-separated):
 *   - `tag`:     tag the table, an ordinary change that drives `update()`;
 *   - `rotated`: move both regions to a second customer managed key;
 *   - `managed`: move from the customer managed keys to the AWS managed key
 *                (`TableEncryptionV2.awsManagedKey()`), class kept;
 *   - `removed`: drop the customer managed key (no `encryption`), the
 *                `tableClass` and the replica's `deletionProtection` — the
 *                removals CloudFormation resets (measured for #5355);
 *   - `protect`: with `removed`, protect the replica again (destroy then
 *                needs `--remove-protection`).
 *
 * verify.sh gives the stack a per-run name, which the table name and the key
 * aliases follow, so a run never meets another run's table or alias.
 */
export class DynamoDBGlobalTableReplicaSettingsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DynamoDBGlobalTableReplicaSettingsStackProps) {
    super(scope, id, props);

    const modes = new Set((process.env.CDKD_TEST_UPDATE ?? '').split(',').filter(Boolean));
    const removed = modes.has('removed');

    const localKey = new kms.Key(this, 'LocalKey', {
      alias: `${this.stackName}-local`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    const localKey2 = new kms.Key(this, 'LocalKey2', {
      alias: `${this.stackName}-local2`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    const table = new ddb.TableV2(this, 'ReplicaSettingsTable', {
      tableName: `${this.stackName}-table`,
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      ...(!removed && {
        encryption: modes.has('managed')
          ? ddb.TableEncryptionV2.awsManagedKey()
          : modes.has('rotated')
            ? ddb.TableEncryptionV2.customerManagedKey(localKey2, {
                [props.secondRegion]: props.replicaKey2Arn,
              })
            : ddb.TableEncryptionV2.customerManagedKey(localKey, {
                [props.secondRegion]: props.replicaKeyArn,
              }),
        tableClass: ddb.TableClass.STANDARD_INFREQUENT_ACCESS,
      }),
      replicas: [
        {
          region: props.secondRegion,
          ...((!removed || modes.has('protect')) && { deletionProtection: true }),
        },
      ],
    });
    if (modes.has('tag')) cdk.Tags.of(table).add('Cdkd5355', 'tagged');

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
