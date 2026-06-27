import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * Lambda SQS event source with `maxConcurrency`
 * (`ScalingConfig.MaximumConcurrency`, a newer ESM attribute) plus
 * `reportBatchItemFailures`. Both are easy-to-silent-drop ESM fields a basic
 * SQS->Lambda fixture never exercises. Confirmed CLEAN by a /hunt-bugs sweep;
 * this fixture is the regression guard.
 */
const MAXCONC = 5;

export class SqsEsmMaxConcurrencyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const queue = new sqs.Queue(this, 'Queue', {
      queueName: `${this.stackName}-queue`,
      visibilityTimeout: cdk.Duration.seconds(60),
    });
    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler=async()=>({batchItemFailures:[]});'),
    });
    fn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        maxConcurrency: MAXCONC,
        reportBatchItemFailures: true,
      })
    );
  }
}
