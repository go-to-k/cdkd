import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/** The table name `verify.sh` sweeps and asserts by. */
export const STREAM_MEMBERS_TABLE_NAME = 'cdkd-stream-members-test-table';
/** The one tag the stream declares. */
export const STREAM_TAG = { Key: 'cdkd-stream-owner', Value: 'integ-3458' };

/**
 * Integ probe for `StreamSpecification.ResourcePolicy` and
 * `StreamSpecification.Tags` (issue #3458).
 *
 * Neither is a member of the SDK's `StreamSpecification`, so cdkd used to drop
 * both on the wire (deploy green, the stream with no policy and no tags) and
 * could not read either back for drift. CloudFormation applies both against
 * the STREAM arn, re-applies both after a `StreamViewType` change mints a new
 * arn, and removes both when they leave a block whose stream stays.
 *
 * Its OWN stack and table: the sibling stack wires an EventSourceMapping to its
 * stream, and the view-type change below replaces the stream arn.
 *
 * `CDKD_TEST_UPDATE` is a comma-separated token list, MONOTONIC across phases:
 *
 *   (unset)              NEW_IMAGE, with both members
 *   `viewtype`           KEYS_ONLY, with both members — a NEW stream arn
 *   `viewtype,removed`   KEYS_ONLY, with neither — the arn stays, both go
 *
 * The sibling stack reads the same variable as the literal `true`, which is
 * none of these tokens; each `verify.sh` step deploys ONE stack by name.
 *
 * Set via addPropertyOverride rather than an L2 prop so the fixture does not
 * pin a minimum aws-cdk-lib version.
 */
export class DynamodbStreamMembersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tokens = new Set((process.env.CDKD_TEST_UPDATE ?? '').split(','));
    const table = new dynamodb.Table(this, 'MembersTable', {
      tableName: STREAM_MEMBERS_TABLE_NAME,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: tokens.has('viewtype')
        ? dynamodb.StreamViewType.KEYS_ONLY
        : dynamodb.StreamViewType.NEW_IMAGE,
    });

    if (tokens.has('removed')) return;
    const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
    cfnTable.addPropertyOverride('StreamSpecification.ResourcePolicy', {
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'CdkdIntegStreamRead',
            Effect: 'Allow',
            // The account's own root: a grant that widens nothing.
            Principal: { AWS: `arn:aws:iam::${this.account}:root` },
            Action: 'dynamodb:DescribeStream',
            // The stream arn does not exist until the table does, so the
            // statement cannot name it.
            Resource: '*',
          },
        ],
      },
    });
    cfnTable.addPropertyOverride('StreamSpecification.Tags', [STREAM_TAG]);
  }
}
