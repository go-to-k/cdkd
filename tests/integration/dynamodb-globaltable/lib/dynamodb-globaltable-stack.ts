import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Real-AWS test fixture for cdkd's `AWS::DynamoDB::GlobalTable` SDK
 * Provider. Closes Issue #383.
 *
 * The user-reported bug: a `dynamodb.TableV2` construct WITHOUT an
 * explicit `tableName` synthesized as `AWS::DynamoDB::GlobalTable` and
 * fell through to Cloud Control API, which auto-generated random names
 * like `yq2phLewTEUtzr4sy2gYFRU4I-1OGJ0UFLOKOOV` instead of the cdkd
 * `${stackName}-X<hash>` shape.
 *
 * This fixture deploys a single-region TableV2 with:
 *   - partitionKey + sortKey (the user's reported shape)
 *   - PAY_PER_REQUEST billing (CDK's TableV2 default)
 *   - NO explicit `tableName` (the bug trigger)
 *   - RemovalPolicy.DESTROY so the destroy step cleans up
 *
 * verify.sh asserts the deployed table name starts with `${StackName}-`
 * (proving the SDK Provider name generator ran, not CC API's auto-gen).
 *
 * UPDATE testing (post-PR #384 follow-up, Item F): the `CDKD_TEST_UPDATE`
 * env var mutates the TableV2 properties on synth so a second
 * `cdkd deploy` exercises the in-place update path. Supported values:
 *   - `ttl`:                 enable TimeToLiveAttribute
 *   - `tags`:                add `UpdateTest=true` user tag
 *   - `deletion-protection`: enable DeletionProtection
 *   - `billing-provisioned`: flip BillingMode to PROVISIONED (fixed 5/5)
 *   - `autoscaling`:         PROVISIONED with Capacity.autoscaled on
 *                            read AND write (closes Issue #402 Item B —
 *                            exercises the write path's RegisterScalableTarget
 *                            + PutScalingPolicy wiring end-to-end).
 *   - `cross-region`:        add a second replica region (eu-west-1).
 *                            Gated behind `CDKD_INTEG_MULTI_REGION=1` in
 *                            verify.sh because the wall-clock is 15–25
 *                            min per round-trip — the default `bash
 *                            verify.sh` invocation stays under 8 min.
 *
 * The values can be combined comma-separated, e.g.
 * `CDKD_TEST_UPDATE=ttl,tags`. Unknown values are silently ignored so
 * future verify.sh scenarios can add new keys without touching the
 * stack.
 *
 * The stack ALSO deploys two unconditional GSI-carrying tables for Issue
 * #1387 (per-GSI throughput CFn -> SDK translation) — see the block at the
 * bottom of the constructor.
 */
export class DynamoDBGlobalTableStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const updateMode = (process.env.CDKD_TEST_UPDATE ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Billing-mode resolution. Both `billing-provisioned` and
    // `autoscaling` flip to PROVISIONED; `autoscaling` additionally
    // wraps the capacity in `Capacity.autoscaled(...)` so cdkd's
    // RegisterScalableTarget + PutScalingPolicy wiring is exercised.
    const useAutoScaling = updateMode.includes('autoscaling');
    const useProvisioned = useAutoScaling || updateMode.includes('billing-provisioned');

    // Replicas:
    //   - `cross-region`: add a second replica region (eu-west-1) on
    //     top of the deploy region. The deploy region is implicit
    //     when `replicas` is unset; when set, every region (incl. the
    //     deploy region) MUST be listed explicitly.
    const deployRegion = props.env?.region ?? 'us-east-1';
    const wantsCrossRegion = updateMode.includes('cross-region');

    // The canonical user-reported scenario: TableV2 with no explicit
    // tableName. Pre-PR, cdkd fell through to CC API and AWS auto-
    // generated a random opaque name. Post-PR, cdkd's new SDK Provider
    // generates `${stackName}-<logicalId>-<hash>`.
    const tableProps: ddb.TablePropsV2 = {
      partitionKey: { name: 'sessionId', type: ddb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: ddb.AttributeType.STRING },
      // BillingMode is mutable via the in-place update path; default
      // PAY_PER_REQUEST unless the test asked to flip.
      billing: useProvisioned
        ? ddb.Billing.provisioned({
            readCapacity: useAutoScaling
              ? ddb.Capacity.autoscaled({
                  minCapacity: 5,
                  maxCapacity: 50,
                  targetUtilizationPercent: 70,
                })
              : ddb.Capacity.fixed(5),
            // CDK 2.244+ disallows `Capacity.fixed()` for `writeCapacity`
            // on `TableV2` (the construct synthesizes
            // `AWS::DynamoDB::GlobalTable`, where write capacity must
            // be auto-scaled — Aurora-style replicas do not support a
            // fixed write throughput). Always use autoscaled write
            // capacity; the `useAutoScaling=false` integ scenario
            // still differentiates by using FIXED read + autoscaled
            // write (matches what a typical TableV2 user gets when
            // asking for PROVISIONED).
            writeCapacity: ddb.Capacity.autoscaled({
              minCapacity: 5,
              maxCapacity: 100,
              targetUtilizationPercent: 70,
            }),
          })
        : ddb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      ...(updateMode.includes('ttl') && { timeToLiveAttribute: 'expiresAt' }),
      ...(updateMode.includes('deletion-protection') && { deletionProtection: true }),
      ...(wantsCrossRegion && {
        replicas: [{ region: 'eu-west-1' }],
      }),
    };

    const historyTable = new ddb.TableV2(this, 'HistoryTable', tableProps);

    if (updateMode.includes('tags')) {
      cdk.Tags.of(historyTable).add('UpdateTest', 'true');
    }

    // Surface the name + ARN as outputs so verify.sh can assert against
    // them without an extra DescribeTable call.
    new cdk.CfnOutput(this, 'TableName', {
      value: historyTable.tableName,
      description: 'AWS-side physical name of the deployed GlobalTable',
    });
    new cdk.CfnOutput(this, 'TableArn', {
      value: historyTable.tableArn,
      description: 'AWS-side ARN of the deployed GlobalTable',
    });
    new cdk.CfnOutput(this, 'DeployRegion', {
      value: deployRegion,
      description: 'Deploy (primary) region',
    });

    // ─── Issue #1387: per-GSI throughput translation ────────────────────
    //
    // The CFn `AWS::DynamoDB::GlobalTable` schema models per-GSI throughput
    // completely differently from the DynamoDB SDK's `CreateTable` shape, and
    // cdkd used to forward the blob raw. The AWS SDK v3 serializer drops
    // unknown members, so:
    //
    //   - a PROVISIONED GlobalTable with a GSI failed `CreateTable` outright
    //     (AWS requires `ProvisionedThroughput` on every index), and
    //   - `TableV2`'s per-GSI on-demand limits vanished silently.
    //
    // Both tables are UNCONDITIONAL (not gated behind `CDKD_TEST_UPDATE`) so
    // the very first baseline deploy exercises the create path that used to
    // fail. A single table cannot carry both billing modes, hence two.
    //
    // `TableV2` (L2) is used rather than `CfnGlobalTable` (L1) because the L2
    // exposes every property this fixture needs — per-GSI `readCapacity` /
    // `writeCapacity` and per-GSI `maxReadRequestUnits` /
    // `maxWriteRequestUnits` — so no escape hatch is required.
    //
    // NOTE the asymmetry the fix had to get right: per-GSI READ capacity
    // synthesizes onto `Replicas[?Region==<deploy region>]
    // .GlobalSecondaryIndexes[]`, while WRITE capacity stays on the
    // top-level GSI. `CreateTable` needs both halves in ONE
    // `ProvisionedThroughput` object.
    const gsiProvisionedTable = new ddb.TableV2(this, 'GsiProvisionedTable', {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      billing: ddb.Billing.provisioned({
        readCapacity: ddb.Capacity.fixed(5),
        // TableV2 requires auto-scaled write capacity (the GlobalTable CFn
        // shape has no literal WriteCapacityUnits).
        //
        // `seedCapacity` (8) differs from `minCapacity` (1) so the TABLE-level
        // half of issue #1435 is discriminating against real AWS: verify.sh
        // asserts the created table-level WriteCapacityUnits is 1. Without a
        // seed here, flipping the table-level call site back to 'seed' would
        // break no assertion and only the per-index value would be pinned.
        writeCapacity: ddb.Capacity.autoscaled({
          minCapacity: 1,
          maxCapacity: 10,
          seedCapacity: 8,
          targetUtilizationPercent: 70,
        }),
      }),
      globalSecondaryIndexes: [
        {
          indexName: 'byStatus',
          partitionKey: { name: 'status', type: ddb.AttributeType.STRING },
          // -> Replicas[local].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings
          //
          // AUTOSCALED rather than fixed so the fourth scalable dimension,
          // `dynamodb:index:ReadCapacityUnits`, gets real-AWS coverage — with
          // a fixed read capacity that dimension is never registered and half
          // the new index-level surface would be unit-tested only. minCapacity
          // is 7 so step 4b's existing `ReadCapacityUnits = 7` assertion holds
          // unchanged (issue #1435: a create takes MinCapacity).
          readCapacity: ddb.Capacity.autoscaled({
            minCapacity: 7,
            maxCapacity: 70,
            targetUtilizationPercent: 65,
          }),
          // -> GlobalSecondaryIndexes[].WriteProvisionedThroughputSettings
          //    .WriteCapacityAutoScalingSettings.
          //
          // Issue #1435: on a fresh CREATE, CloudFormation provisions the
          // index at `minCapacity` (2), NOT `seedCapacity` (3) —
          // live-verified against a real CFn stack. `seedCapacity` applies
          // only to the PAY_PER_REQUEST -> PROVISIONED flip. verify.sh
          // asserts 2 here.
          //
          // Issue #1419: min/max/targetUtilizationPercent must ALSO become a
          // real `dynamodb:index:WriteCapacityUnits` scalable target +
          // target-tracking policy. Before the fix nothing at index level was
          // ever registered, so the index sat at its initial capacity forever
          // and the fixture's green assertion on that initial value hid it.
          writeCapacity: ddb.Capacity.autoscaled({
            minCapacity: 2,
            maxCapacity: 20,
            seedCapacity: 3,
            targetUtilizationPercent: 60,
          }),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const gsiOnDemandTable = new ddb.TableV2(this, 'GsiOnDemandTable', {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      billing: ddb.Billing.onDemand({
        // NOTE: cdkd does not wire this TABLE-level read ceiling at all today
        // (it synthesizes to `Replicas[local].ReadOnDemandThroughputSettings`,
        // which the provider never reads) — tracked as issue #1436. It stays
        // here because it is what the canonical CDK call emits; verify.sh
        // deliberately asserts only the WRITE member so this fixture does not
        // encode the gap as expected behavior.
        maxReadRequestUnits: 100,
        // Issue #1434: REMOVING this from the template must RESET the live
        // table-level ceiling, not silently no-op — the table-level sibling of
        // the per-GSI case #1423. `drop-table-ondemand-limit` drops it, and
        // verify.sh asserts the member reads back ABSENT (the reset surfaces
        // as absence, never as -1).
        // -> WriteOnDemandThroughputSettings.MaxWriteRequestUnits
        ...(updateMode.includes('drop-table-ondemand-limit')
          ? {}
          : { maxWriteRequestUnits: 200 }),
      }),
      globalSecondaryIndexes: [
        {
          indexName: 'byOwner',
          partitionKey: { name: 'owner', type: ddb.AttributeType.STRING },
          // -> Replicas[local].GlobalSecondaryIndexes[].ReadOnDemandThroughputSettings
          maxReadRequestUnits: 50,
          // Issue #1423: REMOVING this from the template must RESET the live
          // ceiling, not silently no-op. `drop-gsi-ondemand-limits` drops ONLY
          // the write limit and keeps the read one, which is the harder case:
          // the two are independent CDK props, so a fix that only reset when
          // the whole on-demand block disappeared would still drop this edit.
          // verify.sh asserts the write member is ABSENT while read is still
          // 50 (the reset reads back as absence, never as -1).
          // -> GlobalSecondaryIndexes[].WriteOnDemandThroughputSettings
          ...(updateMode.includes('drop-gsi-ondemand-limits')
            ? {}
            : { maxWriteRequestUnits: 60 }),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'GsiProvisionedTableName', {
      value: gsiProvisionedTable.tableName,
      description: 'PROVISIONED GlobalTable whose GSI carries WriteProvisionedThroughputSettings',
    });
    new cdk.CfnOutput(this, 'GsiOnDemandTableName', {
      value: gsiOnDemandTable.tableName,
      description: 'On-demand GlobalTable whose GSI carries per-index on-demand limits',
    });
  }
}
