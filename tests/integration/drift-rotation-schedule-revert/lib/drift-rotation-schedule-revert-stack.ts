import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Integ probe for go-to-k/cdkd#6497 and #6498: an `AWS::SecretsManager::RotationSchedule`
 * (Cloud Control routed) declared as `ScheduleExpression: rate(60 days)` with
 * `RotateImmediatelyOnUpdate: false`.
 *
 * - #6497: Secrets Manager reads the schedule back with `AutomaticallyAfterDays: 60`
 *   too, and `cdkd drift --revert` sent both, which Secrets Manager refuses.
 * - #6498: the revert dropped the write-only `RotateImmediatelyOnUpdate`, so
 *   Secrets Manager rotated immediately. The rotation function does nothing, so
 *   an immediate rotation never finishes and leaves an `AWSPENDING` version.
 */
export class DriftRotationScheduleRevertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const secret = new secretsmanager.Secret(this, 'Secret', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // Secrets Manager runs the function's testSecret step even without an
    // immediate rotation; its own log group goes with the stack.
    const rotation = new lambda.Function(this, 'Rotation', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      logGroup: new logs.LogGroup(this, 'RotationLogs', {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.ONE_DAY,
      }),
    });
    secret.addRotationSchedule('Schedule', {
      rotationLambda: rotation,
      automaticallyAfter: cdk.Duration.days(60),
      rotateImmediatelyOnUpdate: false,
    });
  }
}
