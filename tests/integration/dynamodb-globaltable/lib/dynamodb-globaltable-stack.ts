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
            writeCapacity: useAutoScaling
              ? ddb.Capacity.autoscaled({
                  minCapacity: 5,
                  maxCapacity: 100,
                  targetUtilizationPercent: 70,
                })
              : ddb.Capacity.fixed(5),
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
  }
}
