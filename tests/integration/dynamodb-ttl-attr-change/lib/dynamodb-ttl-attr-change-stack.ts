import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * DynamoDB TTL AttributeName-change actionable-error integ fixture.
 *
 * Exercises the `DynamoDBTableProvider.update` guard that pre-emptively
 * rejects changing a table's `TimeToLiveSpecification.AttributeName` between
 * two enabled specs (e.g. `ttlA` -> `ttlB`) in a single deploy.
 *
 * Such a change is impossible on AWS regardless of the tool: DynamoDB allows
 * TTL on only one attribute and rejects enabling it on a new attribute while
 * TTL is still active on the old one (`TimeToLive is active on a different
 * AttributeName`), AND rate-limits `UpdateTimeToLive` to one change per table
 * per ~1 hour (so disable-then-re-enable in one deploy is impossible too).
 * CloudFormation hits the same wall and rolls back. cdkd used to let the
 * opaque raw AWS error bubble up; the guard now throws a clear
 * `ProvisioningError` BEFORE the doomed API call spelling out the two-deploy
 * remediation.
 *
 * The TTL attribute is switched via `CDKD_TEST_UPDATE`:
 *   - default deploy:        TTL enabled on `ttlA`
 *   - CDKD_TEST_UPDATE=true: TTL enabled on `ttlB`  (the rejected transition)
 *
 * `CDKD_TEST_TTL=disable` instead declares `{ Enabled: false }` with NO
 * `AttributeName` (valid per the CFn schema; issue #5447), which must disable
 * TTL on the recorded `ttlA` rather than send nothing.
 *
 * The table also carries a stream read by a Lambda event source mapping
 * (issue #6560), and `CDKD_TEST_UPDATE=true` changes its `StreamViewType`
 * (`NEW_IMAGE` -> `NEW_AND_OLD_IMAGES`) in the same deploy as the TTL rename.
 * The rename must be refused BEFORE the stream change: refused after it, the
 * rollback reverted the view type, which re-mints the stream, and the mapping
 * was left `Disabled` on the deleted stream ARN.
 *
 * verify.sh deploys the `ttlA` table (succeeds), re-deploys requesting `ttlB`
 * plus the view-type change (must FAIL with the actionable message and leave
 * TTL on `ttlA`, the stream ARN and the mapping untouched), re-deploys the
 * name-less disable, then destroys the table cleanly.
 */
export class DynamodbTtlAttrChangeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ttlAttribute = process.env.CDKD_TEST_UPDATE === 'true' ? 'ttlB' : 'ttlA';

    const disableTtl = process.env.CDKD_TEST_TTL === 'disable';

    const table = new dynamodb.Table(this, 'TtlTable', {
      tableName: 'cdkd-ttl-attr-change-test',
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // TimeToLiveSpecification — synthesizes to { AttributeName, Enabled: true }.
      timeToLiveAttribute: disableTtl ? undefined : ttlAttribute,
      stream:
        process.env.CDKD_TEST_UPDATE === 'true'
          ? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES
          : dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The stream's consumer (issue #6560): its mapping must stay Enabled on
    // the table's current stream after the refused deploy.
    const consumer = new lambda.Function(this, 'StreamConsumer', {
      functionName: 'cdkd-ttl-attr-change-stream-consumer',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context):\n    return None\n'),
    });
    consumer.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 1,
      })
    );

    if (disableTtl) {
      // The L2 always pairs Enabled with an AttributeName; the escape hatch
      // writes the name-less disable a hand-written template can carry.
      (table.node.defaultChild as dynamodb.CfnTable).addPropertyOverride(
        'TimeToLiveSpecification',
        { Enabled: false }
      );
    }
  }
}
