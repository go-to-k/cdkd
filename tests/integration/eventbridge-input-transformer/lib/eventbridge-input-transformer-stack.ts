import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * EventBridge Rule with a target InputTransformer integ.
 *
 * `RuleTargetInput.fromObject(...)` synthesizes a Targets[].InputTransformer
 * (InputPathsMap + InputTemplate, where InputTemplate is a JSON string carrying
 * `<var>` references). The eventbridge-rule-provider has handling code for this
 * shape but NO integ fixture exercised it. The target is an SQS queue so the
 * functional check can read the delivered message and assert it is the
 * TRANSFORMED template, not the raw event.
 *
 * The transform shape is driven by CDKD_TEST_UPDATE so verify.sh can exercise
 * the UPDATE phase (an added `version` field changes the InputTransformer,
 * which must reach AWS as an in-place Rule update).
 *
 * covers: AWS::Events::Rule
 * covers: AWS::SQS::Queue
 */
export class EventbridgeInputTransformerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const queue = new sqs.Queue(this, 'TargetQ', {
      queueName: 'cdkd-eb-transform-q',
      retentionPeriod: cdk.Duration.hours(1),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const rule = new events.Rule(this, 'Rule', {
      ruleName: 'cdkd-eb-transform-rule',
      eventPattern: {
        source: ['cdkd.bughunt'],
        detailType: ['order'],
      },
    });

    const updating = process.env.CDKD_TEST_UPDATE === 'true';

    // RuleTargetInput.fromObject -> Targets[].InputTransformer
    // (InputPathsMap + InputTemplate). The UPDATE phase adds a `version` field
    // so the InputTransformer changes and must be applied in place.
    const message = updating
      ? events.RuleTargetInput.fromObject({
          transformed: true,
          version: 2,
          orderId: events.EventField.fromPath('$.detail.orderId'),
          src: events.EventField.fromPath('$.source'),
        })
      : events.RuleTargetInput.fromObject({
          transformed: true,
          orderId: events.EventField.fromPath('$.detail.orderId'),
          src: events.EventField.fromPath('$.source'),
        });

    rule.addTarget(new targets.SqsQueue(queue, { message }));

    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'RuleName', { value: rule.ruleName });
  }
}
