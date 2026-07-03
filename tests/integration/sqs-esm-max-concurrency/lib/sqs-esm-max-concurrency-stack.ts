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
 *
 * Issue #976 (removal-on-UPDATE): the base phase creates the ESM WITH
 * `FilterCriteria` + `ScalingConfig.MaximumConcurrency`; the UPDATE phase
 * (`CDKD_TEST_UPDATE=true`) REMOVES both from the template and bumps
 * `batchSize`. Before the fix, `LambdaEventSourceMappingProvider.update()`
 * omitted the removed properties from `UpdateEventSourceMapping` and AWS
 * silently kept filtering + kept the concurrency cap; the fix sends the
 * documented clear sentinels (`FilterCriteria: {}` / `ScalingConfig: {}`) so
 * AWS clears them. verify.sh asserts the AWS-current filter + cap before AND
 * after the update.
 */
const MAXCONC = 5;

export class SqsEsmMaxConcurrencyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // UPDATE phase removes FilterCriteria + ScalingConfig and bumps batchSize.
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

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
        batchSize: isUpdate ? 10 : 5,
        // Base phase: filter + concurrency cap set. UPDATE phase: both removed
        // (undefined) so the template no longer carries them — the removal
        // path must send the documented clear sentinels to AWS.
        maxConcurrency: isUpdate ? undefined : MAXCONC,
        reportBatchItemFailures: true,
        filters: isUpdate ? undefined : [lambda.FilterCriteria.filter({ body: ['hunt'] })],
      })
    );
  }
}
