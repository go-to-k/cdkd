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
    // A SECOND index, present on the baseline and REMOVED by the same deploy
    // that flips the billing mode — issue #1617, the shape #1588 left
    // unconvergeable. AWS demands per-index capacity for every index still
    // LIVE at flip time, and this one is not in the update template at all, so
    // there is no capacity to send; before the fix the flip was rejected by
    // name on every deploy and cdkd's Delete op (which ran AFTER the flip) was
    // never reached. The fix deletes it FIRST, so this phase asserts both that
    // the flip succeeds and that the index is gone.
    //
    // allow-mode-gated-drop: the removal IS the scenario. Unlike the sibling
    // index above, this one is deliberately mode-gated — Phase 1.5 is the last
    // deploy in this fixture (destroy follows), so no later step re-drops it.
    const droppedGsi = isUpdate
      ? []
      : [
          {
            indexName: 'billing-removal-dropped-gsi',
            keySchema: [{ attributeName: 'droppedpk', keyType: 'HASH' }],
            projection: { projectionType: 'KEYS_ONLY' },
          },
        ];

    const billingRemovalTable = new dynamodb.CfnTable(this, 'BillingRemovalTable', {
      tableName: 'cdkd-ondemand-test-billing-removal-table',
      keySchema: [{ attributeName: 'id', keyType: 'HASH' }],
      attributeDefinitions: [
        { attributeName: 'id', attributeType: 'S' },
        { attributeName: 'gsipk', attributeType: 'S' },
        // Only while the index that uses it is declared: DynamoDB rejects a
        // CreateTable whose AttributeDefinitions carry an attribute no key
        // schema references.
        ...(isUpdate ? [] : [{ attributeName: 'droppedpk', attributeType: 'S' }]),
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
        ...droppedGsi,
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

    // --- Per-GSI on-demand CEILING update -------------------------------
    //
    // A FOURTH table, carrying the half of issue go-to-k/cdkd#3287 that no unit
    // test can reach: what AWS actually holds after the edit.
    //
    // **go-to-k/cdkd#3287** — `UpdateGlobalSecondaryIndexAction` declares
    // `OnDemandThroughput` and NEITHER per-index update arm ever set it, while
    // `updateHasMember` was set only by the capacity and warm arms. So a
    // template whose only edit was a live index's ceiling fired no op at all,
    // deployed GREEN, and was recorded as applied — the edit lost permanently.
    // The index's READ ceiling is therefore the ONLY thing this table changes
    // under CDKD_TEST_UPDATE=true: no capacity edit, no warm-throughput edit,
    // nothing else that could make an op exist for another reason. The WRITE
    // ceiling is the CONTROL and must survive unchanged — without it, a fix
    // that re-asserted the whole block would look identical to one that sent
    // the edit.
    //
    // **go-to-k/cdkd#3265** — the TABLE-level ceiling declares one LEGAL
    // member and one spelling CloudFormation's Integer grammar REJECTS (a
    // padded `' 25 '`). Both members are SDK-OPTIONAL, so unlike the
    // `ProvisionedThroughput` sibling the request SUCCEEDS with that half
    // unapplied — a GREEN deploy, not a loud failure — which is the outcome
    // only a real `DescribeTable` can confirm. verify.sh asserts AWS ends up
    // holding the read ceiling and NO write ceiling, and that the rejected
    // member did not take its legal sibling down with it.
    //
    // What verify.sh deliberately does NOT assert is the RECORD side: state
    // still carries the declared `' 25 '`, so `cdkd drift` reports the
    // difference until the template is fixed. That is go-to-k/cdkd#3286, which
    // stays open — closing it needs `effectiveProperties` plus its
    // `canonicalizeDesiredProperties` twin AND an agreeing
    // `observedProperties` capture in `deploy-engine.ts`.
    //
    // A hand-written L1 plus an `addPropertyOverride` for the padded value.
    // BOTH halves are required, and the second was measured rather than
    // assumed: the L2 types these members as `number`, and the L1's own
    // generated validator (`convertCfnTablePropsToCloudFormation`) REFUSES a
    // string too — `cdk synth` dies with `supplied properties not correct for
    // "OnDemandThroughputProperty"`. `addPropertyOverride` writes straight into
    // the rendered template, which is the only way to synthesize the rejected
    // SPELLING this phase is about.
    //
    // The table and its index are UNCONDITIONAL; only the ceiling VALUE is
    // mode-keyed, the same rule the sibling tables above follow. A mode-gated
    // index would be DROPPED by any later deploy that clears the mode, and
    // dropping a live GSI is a slow, destructive operation rather than the
    // in-place update this phase is about.
    const gsiCeilingTable = new dynamodb.CfnTable(this, 'GsiCeilingTable', {
      tableName: 'cdkd-ondemand-test-gsi-ceiling-table',
      billingMode: 'PAY_PER_REQUEST',
      keySchema: [{ attributeName: 'id', keyType: 'HASH' }],
      attributeDefinitions: [
        { attributeName: 'id', attributeType: 'S' },
        { attributeName: 'gsipk', attributeType: 'S' },
      ],
      onDemandThroughput: {
        maxReadRequestUnits: 30,
      },
      globalSecondaryIndexes: [
        {
          indexName: 'gsi-ceiling',
          keySchema: [{ attributeName: 'gsipk', keyType: 'HASH' }],
          projection: { projectionType: 'ALL' },
          onDemandThroughput: {
            maxReadRequestUnits: isUpdate ? 40 : 20,
            maxWriteRequestUnits: 15,
          },
        },
      ],
    });
    gsiCeilingTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    // The padded write ceiling, written past the L1 validator. CloudFormation
    // refuses this spelling at properties validation, so cdkd DROPS the member
    // and warns — and because both members are SDK-OPTIONAL the request still
    // SUCCEEDS (measured us-east-1 2026-09-17: `CreateTable` with an empty
    // `OnDemandThroughput` is ACCEPTED and `DescribeTable` then reports no
    // ceiling at all), which is what makes the record fold necessary rather
    // than cosmetic.
    gsiCeilingTable.addPropertyOverride('OnDemandThroughput.MaxWriteRequestUnits', ' 25 ');

    new cdk.CfnOutput(this, 'GsiCeilingTableName', {
      value: gsiCeilingTable.ref,
      description:
        'PAY_PER_REQUEST table whose per-GSI OnDemandThroughput read ceiling changes under CDKD_TEST_UPDATE=true (issues #3287 / #3265)',
    });

    // A FIFTH table, for the REMOVAL direction of the same property (issue
    // go-to-k/cdkd#3373) — the half no unit test can settle, because what is
    // under test is whether AWS honours `-1` as a reset and reports the member
    // ABSENT afterwards.
    //
    // An absent member KEEPS whatever maximum the table already carries, so
    // before #3373 a template edit dropping a ceiling deployed GREEN, was
    // recorded as applied, and left the live maximum in force forever. cdkd now
    // substitutes DynamoDB's `-1` reset sentinel per MEMBER, at the TABLE level
    // and per INDEX.
    //
    // The fixture shape follows `.claude/rules/testing.md`'s REMOVAL-testing
    // convention, and every part of it is load-bearing:
    //
    //  - **both positions on ONE table**, because #3373's whole premise is that
    //    the table-level and per-index answers must move together;
    //  - **a RETAINED sibling at each position** — the READ ceiling stays
    //    declared while the WRITE ceiling is dropped. Without it a wholesale
    //    reset that cleared BOTH members would pass identically;
    //  - **the retained value is asserted LIVE in the baseline phase** before
    //    the removal phase asserts the dropped one is gone, or "gone" also
    //    passes for a member that never reached AWS at all;
    //  - **values disjoint from every other table in this fixture**, so a
    //    `DescribeTable` assertion cannot match the wrong resource.
    //
    // It is a separate table rather than an arm on `gsiCeilingTable` because
    // that table's WRITE ceiling is the CONTROL for #3287's send assertion —
    // dropping it there would delete the very thing that discriminates "the
    // edit was sent" from "the whole block was re-asserted".
    //
    // The table and its index are UNCONDITIONAL; only the ceiling MEMBERS are
    // mode-keyed, for the reason stated at `gsiCeilingTable` above.
    const ceilingRemovalTable = new dynamodb.CfnTable(this, 'CeilingRemovalTable', {
      tableName: 'cdkd-ondemand-test-ceiling-removal-table',
      billingMode: 'PAY_PER_REQUEST',
      keySchema: [{ attributeName: 'id', keyType: 'HASH' }],
      attributeDefinitions: [
        { attributeName: 'id', attributeType: 'S' },
        { attributeName: 'gsipk', attributeType: 'S' },
      ],
      onDemandThroughput: {
        maxReadRequestUnits: 61,
        // DROPPED by the update phase. `AWS::NoValue` is not available on an
        // L1 property object, so the member is omitted from the synthesized
        // template outright — which is exactly the shape under test: a
        // template that no longer DECLARES the member.
        ...(isUpdate ? {} : { maxWriteRequestUnits: 57 }),
      },
      globalSecondaryIndexes: [
        {
          indexName: 'gsi-ceiling-removal',
          keySchema: [{ attributeName: 'gsipk', keyType: 'HASH' }],
          projection: { projectionType: 'ALL' },
          onDemandThroughput: {
            maxReadRequestUnits: 43,
            ...(isUpdate ? {} : { maxWriteRequestUnits: 39 }),
          },
        },
      ],
    });
    ceilingRemovalTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'CeilingRemovalTableName', {
      value: ceilingRemovalTable.ref,
      description:
        'PAY_PER_REQUEST table whose TABLE-level and per-GSI OnDemandThroughput WRITE ceilings are REMOVED under CDKD_TEST_UPDATE=true, with the READ ceilings retained (issue go-to-k/cdkd#3373)',
    });
  }
}
