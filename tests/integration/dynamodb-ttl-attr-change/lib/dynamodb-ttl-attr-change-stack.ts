import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

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
 * verify.sh deploys the `ttlA` table (succeeds), re-deploys requesting `ttlB`
 * (must FAIL with the actionable message and leave TTL on `ttlA` untouched),
 * re-deploys the name-less disable, then destroys the table cleanly.
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
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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
