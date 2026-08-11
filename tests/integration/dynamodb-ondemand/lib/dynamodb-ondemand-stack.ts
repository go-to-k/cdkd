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

    // A THIRD table for the `BillingMode` REMOVAL semantic (issue #1553).
    //
    // Removing the property from a PAY_PER_REQUEST table used to emit an
    // `UpdateTable` carrying NO mutable field — the change was detected, but
    // the BillingMode assignment was skipped because the resolved value was
    // `undefined` — so DynamoDB rejected the call and the deploy failed with a
    // confusing error on every attempt.
    //
    // What removal MEANS was measured against real CloudFormation before the
    // fix (us-east-1, 2026-08-11): CFn RESETS to the type default PROVISIONED,
    // and fails outright (`Property ProvisionedThroughput cannot be empty`)
    // when the template declares no capacity either. This phase reproduces the
    // supported half of that A/B end to end.
    //
    // It CARRIES a GlobalSecondaryIndex since issue #1588, which is the whole
    // point of the index here. That issue's predecessor deliberately left the
    // index out because the provider did not carry per-index
    // `ProvisionedThroughput` into the flip call — and the consequence was not
    // a degraded flip but an IMPOSSIBLE one. Measured against real AWS on
    // 2026-08-11: the flip with only table-level capacity is rejected with
    // `ValidationException: One or more parameter values were invalid:
    // ProvisionedThroughput must be specified for index: <name>`, and the same
    // call carrying `GlobalSecondaryIndexUpdates[].Update.ProvisionedThroughput`
    // is accepted. So this index is what makes the phase exercise the flip a
    // real template hits, rather than the index-free special case.
    //
    // The index is UNCONDITIONAL — only its capacity is mode-keyed — because a
    // mode-gated INDEX would be dropped by any later deploy that clears the
    // mode, and dropping a live GSI is a slow, destructive operation rather
    // than the in-place update this phase is about. Its capacity is absent on
    // the PAY_PER_REQUEST baseline (AWS rejects per-index capacity on an
    // on-demand table) and declared on the update, which is exactly the shape
    // the provider has to forward.
    //
    // A hand-written L1 because `dynamodb.Table` always emits `billingMode` —
    // the property has to be genuinely ABSENT from the template. The table is
    // UNCONDITIONAL and only its properties are mode-keyed; a mode-gated
    // RESOURCE would be DELETED by any later deploy that clears the mode.
    const billingRemovalTable = new dynamodb.CfnTable(this, 'BillingRemovalTable', {
      tableName: 'cdkd-ondemand-test-billing-removal-table',
      keySchema: [{ attributeName: 'id', keyType: 'HASH' }],
      attributeDefinitions: [
        { attributeName: 'id', attributeType: 'S' },
        { attributeName: 'gsipk', attributeType: 'S' },
      ],
      globalSecondaryIndexes: [
        {
          indexName: 'billing-removal-gsi',
          keySchema: [{ attributeName: 'gsipk', keyType: 'HASH' }],
          projection: { projectionType: 'ALL' },
          ...(isUpdate
            ? { provisionedThroughput: { readCapacityUnits: 2, writeCapacityUnits: 2 } }
            : {}),
        },
      ],
      // Baseline declares PAY_PER_REQUEST; the update REMOVES the property.
      ...(isUpdate
        ? { provisionedThroughput: { readCapacityUnits: 3, writeCapacityUnits: 4 } }
        : { billingMode: 'PAY_PER_REQUEST' }),
    });
    billingRemovalTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'BillingRemovalTableName', {
      value: billingRemovalTable.ref,
      description:
        'PAY_PER_REQUEST table whose BillingMode is REMOVED under CDKD_TEST_UPDATE=true (issue #1553)',
    });
  }
}
