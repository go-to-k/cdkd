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
 * (`CDKD_TEST_UPDATE=true`) REMOVES both from the template, and `batchSize`
 * with them (issue #1160: CloudFormation resets a removed SQS `BatchSize` to
 * 10, which cdkd used to leave at 5) and `enabled: false` (issue #1160:
 * CloudFormation sends `Enabled: true` on that removal, re-enabling the
 * mapping, which cdkd used to leave disabled). Before the fix, `LambdaEventSourceMappingProvider.update()`
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

    // UPDATE phase removes FilterCriteria + ScalingConfig + batchSize + enabled.
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
        // UPDATE phase: removed, so AWS must fall back to the SQS default 10.
        batchSize: isUpdate ? undefined : 5,
        // UPDATE phase: removed, so the mapping must be turned back on.
        enabled: isUpdate ? undefined : false,
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
