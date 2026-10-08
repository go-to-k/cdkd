import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Integ fixture for issue #4706: an Application Auto Scaling scalable target
 * and its scaling policy across `cdkd import` and `--recreate-via-cc-api`.
 *
 * A scalable target has no SDK provider, so `cdkd import` reads it through
 * Cloud Control and must record `provisionedBy: cc-api`, as a deploy does.
 * `--recreate-via-cc-api` of it is then refused as a no-op, also from a record
 * saying `sdk` (what an earlier `cdkd import` wrote). Before the fix it went
 * through: deregistering the target deleted its scaling policies, the target
 * came back under the same `ResourceId|ScalableDimension|ServiceNamespace` id,
 * and state kept the policy.
 *
 * The cheapest scalable target: a PROVISIONED table at 1 RCU / 1 WCU, read
 * capacity scaled 1..2 by one target-tracking policy.
 *
 * covers: AWS::DynamoDB::Table
 * covers: AWS::ApplicationAutoScaling::ScalableTarget
 * covers: AWS::ApplicationAutoScaling::ScalingPolicy
 */
export class AppAutoscalingRecreateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'Table', {
      tableName: `${this.stackName}-table`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    table
      .autoScaleReadCapacity({ minCapacity: 1, maxCapacity: 2 })
      .scaleOnUtilization({ targetUtilizationPercent: 70 });
  }
}
