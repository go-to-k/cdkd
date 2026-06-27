import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { KinesisEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * Lambda EventSourceMapping from a Kinesis stream with `FilterCriteria` plus
 * `bisectBatchOnError`. `FilterCriteria` is an easy-to-silent-drop ESM
 * attribute. Confirmed CLEAN by a /hunt-bugs sweep; this fixture is the
 * regression guard.
 *
 * The Kinesis stream is given `RemovalPolicy.DESTROY` (CDK defaults it to
 * RETAIN) so destroy leaves zero orphans.
 */
export class KinesisEsmFilterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const stream = new kinesis.Stream(this, 'Stream', {
      streamName: `${this.stackName}-stream`,
      shardCount: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler=async()=>({ok:true});'),
    });
    fn.addEventSource(
      new KinesisEventSource(stream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        bisectBatchOnError: true,
        filters: [lambda.FilterCriteria.filter({ data: { type: ['order'] } })],
        retryAttempts: 2,
      })
    );
  }
}
