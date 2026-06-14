import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * DynamoDB backfill integ fixture (issue #609).
 *
 * A single PAY_PER_REQUEST (on-demand) DynamoDB table that exercises every
 * #609 DynamoDB::Table backfill property in one place (the project policy is
 * to fold per-property probes into one existing fixture rather than
 * proliferate per-property fixtures):
 *
 *  - `OnDemandThroughput` — the on-demand capacity caps. The CDK L2
 *    `maxReadRequestUnits` / `maxWriteRequestUnits` props synthesize to the
 *    top-level CFn property `OnDemandThroughput.MaxReadRequestUnits` /
 *    `MaxWriteRequestUnits`. Rides directly on CreateTable.
 *  - `ResourcePolicy` — rides on CreateTable (serialized PolicyDocument);
 *    read back via GetResourcePolicy.
 *  - `KinesisStreamSpecification` — post-ACTIVE
 *    EnableKinesisStreamingDestination control-plane call; read back via
 *    DescribeKinesisStreamingDestination. Needs a Kinesis stream in the
 *    fixture.
 *  - `ContributorInsightsSpecification` — post-ACTIVE
 *    UpdateContributorInsights control-plane call; read back via
 *    DescribeContributorInsights.
 *
 * Each of these was a silent-drop in cdkd's `DynamoDBTableProvider` before
 * the #609 backfill (the value never reached AWS). Every property the table
 * sets is in the provider's `handledProperties`, so the resource routes via
 * the SDK path (not the CC-API #614 silent-drop fallback) — verify.sh asserts
 * `provisionedBy=sdk` as a routing guard.
 *
 * (`ImportSourceSpecification`, the other #609 property, is unhandledByDesign
 * — S3 import uses the separate ImportTable API — so it is intentionally not
 * exercised here.)
 *
 * The fixture's verify.sh asserts each property reaches AWS after
 * `cdkd deploy`, and that `cdkd destroy` cleans up the table + the Kinesis
 * stream + the cdkd state file.
 */
export class DynamodbOndemandStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const stream = new kinesis.Stream(this, 'KdsStream', {
      streamName: 'cdkd-ondemand-test-stream',
      shardCount: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const table = new dynamodb.Table(this, 'OndemandTable', {
      tableName: 'cdkd-ondemand-test-table',
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // OnDemandThroughput — synthesizes to OnDemandThroughput.MaxReadRequestUnits /
      // MaxWriteRequestUnits.
      maxReadRequestUnits: 10,
      maxWriteRequestUnits: 5,
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

    // --- BillingMode / ProvisionedThroughput in-place UPDATE coverage ----
    //
    // A SECOND, standalone PROVISIONED table whose capacity (and, when
    // combined with the billing-mode flip below, billing mode) changes under
    // CDKD_TEST_UPDATE=true. This isolates the BillingMode /
    // ProvisionedThroughput update path from the OnDemand table above so the
    // assertions can't be confused by the on-demand caps.
    //
    // Both BillingMode and ProvisionedThroughput are mutable yet update() used
    // to issue NO UpdateTable for either — a pure capacity bump (or a pure
    // billing-mode switch) was silently dropped (state recorded the new value
    // as applied, so the next deploy saw no diff and AWS stayed stale). This
    // fixture's Phase-1.5 re-deploy + describe-table assertion is the
    // real-AWS proof the silent drop is closed.
    //
    // Default deploy:        PROVISIONED, RCU=5  / WCU=5.
    // CDKD_TEST_UPDATE=true: PROVISIONED, RCU=20 / WCU=10  (pure capacity
    //                        change — the load-bearing silent-drop case).
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    new dynamodb.Table(this, 'ProvisionedTable', {
      tableName: 'cdkd-ondemand-test-provisioned-table',
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: isUpdate ? 20 : 5,
      writeCapacity: isUpdate ? 10 : 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
