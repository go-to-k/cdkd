import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * DynamoDB Table ResourcePolicy / KinesisStreamSpecification /
 * ContributorInsightsSpecification backfill integ fixture (issue #609).
 *
 * Exercises the three silent-drop properties the #609 slice wires into
 * `DynamoDBTableProvider`:
 *
 *  - `ResourcePolicy` — rides on CreateTable (serialized PolicyDocument);
 *    read back via GetResourcePolicy.
 *  - `KinesisStreamSpecification` — post-ACTIVE
 *    EnableKinesisStreamingDestination control-plane call; read back via
 *    DescribeKinesisStreamingDestination.
 *  - `ContributorInsightsSpecification` — post-ACTIVE
 *    UpdateContributorInsights control-plane call; read back via
 *    DescribeContributorInsights.
 *
 * (`ImportSourceSpecification`, the 4th #609 property, is unhandledByDesign —
 * S3 import uses the separate ImportTable API — so it is intentionally not
 * exercised here.)
 *
 * verify.sh asserts each property reaches AWS after `cdkd deploy` and that
 * `cdkd destroy` cleans up the table + the Kinesis stream.
 */
export class DynamodbTablePolicyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const stream = new kinesis.Stream(this, 'KdsStream', {
      streamName: 'cdkd-table-policy-test-stream',
      shardCount: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const table = new dynamodb.Table(this, 'PolicyTable', {
      tableName: 'cdkd-table-policy-test-table',
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // KinesisStreamSpecification — synthesizes to the top-level CFn
      // property KinesisStreamSpecification.StreamArn.
      kinesisStream: stream,
      // ContributorInsightsSpecification — synthesizes to
      // ContributorInsightsSpecification.Enabled (+ Mode).
      contributorInsightsSpecification: {
        enabled: true,
        mode: dynamodb.ContributorInsightsMode.ACCESSED_AND_THROTTLED_KEYS,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ResourcePolicy — synthesizes to the top-level CFn property
    // ResourcePolicy.PolicyDocument. A minimal table-scoped policy granting
    // a read action to this account (self-reference keeps the fixture
    // standalone — no extra principals to clean up).
    table.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.AccountRootPrincipal()],
        actions: ['dynamodb:GetItem'],
        resources: ['*'],
      })
    );
  }
}
