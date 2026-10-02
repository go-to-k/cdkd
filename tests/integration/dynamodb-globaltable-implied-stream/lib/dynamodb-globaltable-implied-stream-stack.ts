import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';

export interface DynamoDBGlobalTableImpliedStreamStackProps extends cdk.StackProps {
  /** The second replica's region; must differ from the stack's own. */
  readonly secondRegion: string;
}

/**
 * Real-AWS fixture for issue #1723: an `AWS::DynamoDB::GlobalTable` with TWO
 * replicas and NO `StreamSpecification`.
 *
 * covers: AWS::DynamoDB::GlobalTable
 *
 * Hand-written as the L1 on purpose. `TableV2` always emits
 * `StreamSpecification` for a multi-replica table, so the `needsStream`
 * auto-enable in `DynamoDBGlobalTableProvider.create()` is structurally
 * unreachable from an L2 — the template has to be silent about the stream.
 *
 * `CDKD_TEST_UPDATE` (comma-separated) shapes the later phases:
 *   - `ttl`:            add a top-level `TimeToLiveSpecification`, an ordinary
 *                       in-place change that drives `update()` (whose record
 *                       must keep the stream);
 *   - `declare-stream`: declare the very stream cdkd enabled
 *                       (`NEW_AND_OLD_IMAGES`), which must diff as NO change;
 *   - `tag`:            tag the local replica, a second ordinary change so a
 *                       deploy that also declares the stream reaches
 *                       `update()`'s stream arm.
 */
export class DynamoDBGlobalTableImpliedStreamStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DynamoDBGlobalTableImpliedStreamStackProps) {
    super(scope, id, props);

    const modes = new Set((process.env.CDKD_TEST_UPDATE ?? '').split(',').filter(Boolean));

    const table = new ddb.CfnGlobalTable(this, 'ImpliedStreamTable', {
      tableName: `${this.stackName}-table`,
      billingMode: 'PAY_PER_REQUEST',
      attributeDefinitions: [{ attributeName: 'pk', attributeType: 'S' }],
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
      replicas: [
        {
          region: this.region,
          ...(modes.has('tag') && { tags: [{ key: 'Cdkd1723', value: 'tagged' }] }),
        },
        { region: props.secondRegion },
      ],
      ...(modes.has('ttl') && {
        timeToLiveSpecification: { enabled: true, attributeName: 'expiresAt' },
      }),
      ...(modes.has('declare-stream') && {
        streamSpecification: { streamViewType: 'NEW_AND_OLD_IMAGES' },
      }),
    });
    table.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'TableName', { value: table.ref });
  }
}
