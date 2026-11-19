import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';

/**
 * A PROVISIONED DynamoDB table with read + write Application Auto Scaling — one
 * of the most common daily CDK patterns. CDK synthesizes the table plus four
 * Application Auto Scaling resources, none of which have a dedicated cdkd SDK
 * provider, so they route through the Cloud Control API fallback:
 *
 *   covers: AWS::DynamoDB::Table
 *   covers: AWS::ApplicationAutoScaling::ScalableTarget
 *   covers: AWS::ApplicationAutoScaling::ScalingPolicy
 *
 * The ScalingPolicy references the ScalableTarget, whose CFn `Ref` returns a
 * compound id (`service-namespace|resource-id|scalable-dimension`) — the
 * compound-id Ref hazard cdkd previously hit on ApiGateway / AppConfig. This
 * fixture is the regression guard for that path plus the in-place
 * MaxCapacity UPDATE.
 *
 * Phase 2 (CDKD_TEST_UPDATE=true) raises both ScalableTargets' MaxCapacity
 * 10 -> 20, which must be an in-place Cloud Control patch (not a replacement).
 *
 * Phase 3 (CDKD_TEST_RENAME=true, go-to-k/cdkd#4701) renames the table, which
 * replaces it and, through the create-only `ResourceId`, both ScalableTargets
 * under new ids. Each ScalingPolicy holds its target in `ScalingTargetId`,
 * which the schema lists create-only AND write-only, so it must be replaced
 * onto the new target, not updated in place.
 */
export class DynamodbAutoscalingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'Table', {
      tableName:
        process.env.CDKD_TEST_RENAME === 'true'
          ? 'cdkd-autoscaling-test-table-b'
          : 'cdkd-autoscaling-test-table',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Phase 1 baseline MaxCapacity is 10; Phase 2 (UPDATE) raises it to 20.
    const maxCap = process.env.CDKD_TEST_UPDATE === 'true' ? 20 : 10;

    const readScaling = table.autoScaleReadCapacity({
      minCapacity: 5,
      maxCapacity: maxCap,
    });
    readScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });

    const writeScaling = table.autoScaleWriteCapacity({
      minCapacity: 5,
      maxCapacity: maxCap,
    });
    writeScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });

    // Issue #6612: CloudFormation's `Ref` of a ScalingPolicy is its ARN alone
    // (what a CloudWatch alarm's `AlarmActions` takes), while cdkd records the
    // Cloud Control id `<Arn>|<ScalableDimension>`. verify.sh compares this
    // output with the live read policy's ARN.
    const readPolicy = this.node
      .findAll()
      .find(
        (c): c is appscaling.CfnScalingPolicy =>
          c instanceof appscaling.CfnScalingPolicy && c.node.path.includes('ReadScaling')
      );
    if (!readPolicy) throw new Error('no read-capacity CfnScalingPolicy in the stack');
    new cdk.CfnOutput(this, 'ReadPolicyRef', { value: readPolicy.ref });
  }
}
