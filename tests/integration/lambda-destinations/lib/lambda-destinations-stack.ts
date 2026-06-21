import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';

/**
 * Lambda async destinations integ.
 *
 * CDK synthesizes an AWS::Lambda::EventInvokeConfig carrying both a
 * DestinationConfig (OnSuccess / OnFailure SQS targets) AND tunables
 * (MaximumRetryAttempts / MaximumEventAgeInSeconds). cdkd has NO SDK provider
 * for that type, so it routes via Cloud Control. DestinationConfig is a
 * write-only property — Cloud Control read handlers cannot return it — so an
 * in-place UPDATE that changes MaximumRetryAttempts MUST still re-include the
 * DestinationConfig in the patch or the destinations would be silently dropped
 * (the write-only-properties.ts re-include path; see issue #809). This fixture
 * pins that behavior end-to-end.
 *
 * The retry count is driven by CDKD_TEST_UPDATE so verify.sh can exercise the
 * UPDATE phase: baseline 2, updated 1.
 *
 * covers: AWS::Lambda::EventInvokeConfig
 * covers: AWS::Lambda::Function
 * covers: AWS::SQS::Queue
 */
export class LambdaDestinationsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const successQ = new sqs.Queue(this, 'SuccessQ', {
      queueName: 'cdkd-lambda-dest-success',
      retentionPeriod: cdk.Duration.hours(1),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const failureQ = new sqs.Queue(this, 'FailureQ', {
      queueName: 'cdkd-lambda-dest-failure',
      retentionPeriod: cdk.Duration.hours(1),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const updating = process.env.CDKD_TEST_UPDATE === 'true';

    const fn = new lambda.Function(this, 'Handler', {
      functionName: 'cdkd-lambda-dest-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      // Succeed for any normal payload; throw when invoked with {fail:true}.
      code: lambda.Code.fromInline(
        `exports.handler = async (e) => { if (e && e.fail) { throw new Error("intentional"); } return { ok: true, echo: e }; };`,
      ),
      onSuccess: new destinations.SqsDestination(successQ),
      onFailure: new destinations.SqsDestination(failureQ),
      // Baseline 2 -> updated 1 (in-place UPDATE of the EventInvokeConfig).
      retryAttempts: updating ? 1 : 2,
      maxEventAge: cdk.Duration.minutes(5),
    });

    new cdk.CfnOutput(this, 'FnName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'SuccessQUrl', { value: successQ.queueUrl });
    new cdk.CfnOutput(this, 'FailureQUrl', { value: failureQ.queueUrl });
  }
}
