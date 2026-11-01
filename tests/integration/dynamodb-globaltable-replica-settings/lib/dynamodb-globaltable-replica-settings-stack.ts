import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface DynamoDBGlobalTableReplicaSettingsStackProps extends cdk.StackProps {
  /** The second replica's region; must differ from the stack's own. */
  readonly secondRegion: string;
  /** A customer managed key in `secondRegion`, created by verify.sh. */
  readonly replicaKeyArn: string;
  /** A second customer managed key in `secondRegion`, for the `rotated` mode. */
  readonly replicaKey2Arn: string;
  /** A Kinesis data stream in `secondRegion`, created by verify.sh (issue #5365). */
  readonly replicaStreamArn: string;
}

/**
 * Real-AWS fixture for issue #5355: a two-region `TableV2` whose replica
 * settings CDK renders PER REPLICA — `Replicas[].SSESpecification.KMSMasterKeyId`,
 * `Replicas[].TableClass` and `Replicas[].DeletionProtectionEnabled`. cdkd read
 * the first two under names the CFn schema does not have and never sent the
 * third for a cross-region replica.
 *
 * Issue #5365 adds the per-replica settings cdkd never sent: point-in-time
 * recovery, Contributor Insights, a Kinesis stream and a stream resource policy
 * on both replicas from the first deploy, and a table resource policy (which
 * CloudFormation refuses in the deploy that creates a replica) under `policy`.
 *
 * covers: AWS::DynamoDB::GlobalTable, AWS::KMS::Key, AWS::KMS::Alias, AWS::Kinesis::Stream
 *
 * `CDKD_TEST_UPDATE` (comma-separated):
 *   - `tag`:     tag the table, an ordinary change that drives `update()`;
 *   - `rotated`: move both regions to a second customer managed key;
 *   - `managed`: move from the customer managed keys to the AWS managed key
 *                (`TableEncryptionV2.awsManagedKey()`), class kept;
 *   - `policy`:  a table resource policy on both replicas (issue #5365);
 *   - `removed`: drop the customer managed key (no `encryption`), the
 *                `tableClass` and the replica's `deletionProtection` — the
 *                removals CloudFormation resets (measured for #5355) — and
 *                every #5365 setting, which CloudFormation resets too;
 *   - `protect`: with `removed`, protect the replica again (destroy then
 *                needs `--remove-protection`).
 *   - `idx`:     issue #5489: a global secondary index `gsi1` whose per-replica
 *                Contributor Insights is on in both regions, and a tag on each
 *                replica's stream. `removed` drops the insights and the tags
 *                (the index stays while `idx` is set). Also a single-region
 *                `ModeTable` (with a sort key) declaring
 *                `GlobalTableSettingsReplicationMode: ENABLED`;
 *   - `gsi`:     go-to-k/cdkd#5487: `gsi1` alone, which verify.sh's Phase 1a
 *                cuts short with a deadline;
 *   - `lsi`:     issue #5489: add a local secondary index to the live
 *                `ModeTable`, which DynamoDB cannot do (the deploy must be
 *                refused);
 *   - `replmode`: issue #5489: `GlobalTableSettingsReplicationMode` on both
 *                replicas, which CloudFormation refuses on a table with more
 *                than one replica (the deploy must be refused);
 *   - `ssetable`: a second two-region table on the AWS owned key, for the
 *                `drift --revert` phase of issue #5399. The first table has
 *                switched encryption four times by then, and DynamoDB refused a
 *                further switch on it with LimitExceededException;
 *   - `ts`:      go-to-k/cdkd#2762: a two-region `table4` declaring
 *                `VectorIndexes`, `WarmThroughput` and `TableType`, and a
 *                single-region `table5` with settings replication ENABLED and a
 *                table-level `ReadOnDemandThroughputSettings`;
 *   - `ts2`:     with `ts`, add a second vector index, raise the warm
 *                throughput and the read ceiling;
 *   - `tsshape`: with `ts`, change `vec1`'s dimensions, which DynamoDB cannot
 *                do in place (the deploy must be refused);
 *   - `tsregional`: with `ts`, `TableType: Regional` on the two-replica table,
 *                which CloudFormation refuses (so must the deploy).
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

    const localStream = new kinesis.Stream(this, 'LocalStream', {
      streamName: `${this.stackName}-local`,
      streamMode: kinesis.StreamMode.ON_DEMAND,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // Account-root grants: valid, and inert for anyone outside the account.
    const grant = (action: string): iam.PolicyDocument =>
      new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            principals: [new iam.AccountRootPrincipal()],
            actions: [action],
            resources: ['*'],
          }),
        ],
      });
    // The same five settings on each replica (issue #5365), each in its own
    // region; `removed` drops them all.
    const settings = (stream: kinesis.IStream): ddb.TableOptionsV2 =>
      removed
        ? {}
        : {
            pointInTimeRecoverySpecification: {
              pointInTimeRecoveryEnabled: true,
              recoveryPeriodInDays: 10,
            },
            contributorInsightsSpecification: { enabled: true },
            kinesisStream: stream,
            streamResourcePolicy: grant('dynamodb:GetRecords'),
            ...(modes.has('policy') && { resourcePolicy: grant('dynamodb:GetItem') }),
          };

    // Issue #5489: the replica-level options of `gsi1` (CDK renders them per
    // replica; the deploy region's come from the index's own props).
    const idx = modes.has('idx');
    // go-to-k/cdkd#5487: `gsi` adds `gsi1` alone (no insights, no stream tags,
    // no ModeTable), for verify.sh's cut-short Phase 1a.
    const withGsi = idx || modes.has('gsi');
    const indexInsights = idx && !removed;
    const table = new ddb.TableV2(this, 'ReplicaSettingsTable', {
      tableName: `${this.stackName}-table`,
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      ...(withGsi && {
        globalSecondaryIndexes: [
          {
            indexName: 'gsi1',
            partitionKey: { name: 'gpk', type: ddb.AttributeType.STRING },
            projectionType: ddb.ProjectionType.KEYS_ONLY,
            ...(indexInsights && { contributorInsightsSpecification: { enabled: true } }),
          },
        ],
      }),

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
      ...settings(localStream),
      replicas: [
        {
          region: props.secondRegion,
          ...((!removed || modes.has('protect')) && { deletionProtection: true }),
          ...(indexInsights && {
            globalSecondaryIndexOptions: {
              gsi1: { contributorInsightsSpecification: { enabled: true } },
            },
          }),
          ...settings(kinesis.Stream.fromStreamArn(this, 'ReplicaStream', props.replicaStreamArn)),
        },
      ],
    });
    if (modes.has('tag')) cdk.Tags.of(table).add('Cdkd5355', 'tagged');
    // Issue #5489: TableV2 has no prop for these two replica members.
    const cfnTable = table.node.defaultChild as ddb.CfnGlobalTable;
    const replicaCount = 2;
    for (let i = 0; i < replicaCount; i++) {
      if (indexInsights) {
        cfnTable.addPropertyOverride(`Replicas.${i}.ReplicaStreamSpecification.Tags`, [
          { Key: 'Cdkd5489', Value: `stream-${i}` },
        ]);
      }
      if (modes.has('replmode')) {
        cfnTable.addPropertyOverride(`Replicas.${i}.GlobalTableSettingsReplicationMode`, 'ENABLED');
      }
    }
    if (idx) {
      // One replica, the only shape the settings replication mode is valid on.
      const modeTable = new ddb.TableV2(this, 'ModeTable', {
        tableName: `${this.stackName}-table3`,
        partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
        sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        ...(modes.has('lsi') && {
          localSecondaryIndexes: [
            {
              indexName: 'lsi1',
              sortKey: { name: 'lsk', type: ddb.AttributeType.STRING },
              projectionType: ddb.ProjectionType.KEYS_ONLY,
            },
          ],
        }),
      });
      (modeTable.node.defaultChild as ddb.CfnGlobalTable).addPropertyOverride(
        'Replicas.0.GlobalTableSettingsReplicationMode',
        'ENABLED'
      );
    }

    if (modes.has('ssetable')) {
      new ddb.TableV2(this, 'SseRevertTable', {
        tableName: `${this.stackName}-table2`,
        partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        replicas: [{ region: props.secondRegion }],
      });
    }

    // go-to-k/cdkd#2762: L1 overrides, as `TableV2` has no prop for these. None
    // of them may route the table to Cloud Control; verify.sh reads the record.
    if (modes.has('ts')) {
      const update2 = modes.has('ts2');
      const vectorTable = new ddb.TableV2(this, 'VectorTable', {
        tableName: `${this.stackName}-table4`,
        partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        replicas: [{ region: props.secondRegion }],
      });
      const cfnVector = vectorTable.node.defaultChild as ddb.CfnGlobalTable;
      const vectorIndex = (indexName: string, attribute: string, dimensions: number): object => ({
        IndexName: indexName,
        VectorAttribute: { AttributeName: attribute },
        Dimensions: dimensions,
        DistanceFunction: 'COSINE',
        Projection: { ProjectionType: 'KEYS_ONLY' },
      });
      cfnVector.addPropertyOverride('VectorIndexes', [
        vectorIndex('vec1', 'embedding', modes.has('tsshape') ? 4 : 3),
        ...(update2 ? [vectorIndex('vec2', 'embedding2', 4)] : []),
      ]);
      cfnVector.addPropertyOverride('WarmThroughput', {
        ReadUnitsPerSecond: update2 ? 14000 : 13000,
      });
      cfnVector.addPropertyOverride(
        'TableType',
        modes.has('tsregional') ? 'Regional' : 'GlobalTableReplica'
      );
      const readTable = new ddb.TableV2(this, 'TableLevelReadTable', {
        tableName: `${this.stackName}-table5`,
        partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const cfnRead = readTable.node.defaultChild as ddb.CfnGlobalTable;
      cfnRead.addPropertyOverride('Replicas.0.GlobalTableSettingsReplicationMode', 'ENABLED');
      cfnRead.addPropertyOverride('ReadOnDemandThroughputSettings', {
        MaxReadRequestUnits: update2 ? 55 : 50,
      });
      cfnRead.addPropertyOverride('TableType', 'Regional');
    }

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
