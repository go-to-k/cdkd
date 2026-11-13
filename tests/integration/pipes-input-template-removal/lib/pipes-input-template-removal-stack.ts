import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Issue #6233: `UpdatePipe` keeps a member it is not sent, so removing an
 * `InputTemplate` used to leave the live input transformer in place.
 *
 * Baseline: SQS -> FIFO SQS pipe with a Lambda enrichment, an
 * `EnrichmentParameters.InputTemplate` and a `TargetParameters.InputTemplate`
 * beside `SqsQueueParameters.MessageGroupId`. `CDKD_TEST_REMOVAL=true` drops the
 * whole `EnrichmentParameters` block and ONLY the target's `InputTemplate`,
 * keeping `MessageGroupId` (the case cdkd used to miss without a warning).
 * `Description` and `Enrichment` are the retained siblings.
 * `CDKD_TEST_REMOVE_ENRICHMENT=true` (from the baseline) removes `Enrichment`
 * TOGETHER with `EnrichmentParameters`, as dropping an enrichment from a CDK
 * app does: the update then carries `Enrichment: ''` beside the
 * `EnrichmentParameters: { InputTemplate: '' }` clear.
 *
 * The pipe stays STOPPED: nothing here needs it to poll.
 */
export class PipesInputTemplateRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';
    const removeEnrichment = process.env.CDKD_TEST_REMOVE_ENRICHMENT === 'true';

    const source = new sqs.Queue(this, 'Source', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    const target = new sqs.Queue(this, 'Target', {
      fifo: true,
      contentBasedDeduplication: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const enrichment = new lambda.Function(this, 'Enrichment', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async (event) => event;'),
    });

    const role = new iam.Role(this, 'PipeRole', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    source.grantConsumeMessages(role);
    target.grantSendMessages(role);
    enrichment.grantInvoke(role);

    new pipes.CfnPipe(this, 'Pipe', {
      roleArn: role.roleArn,
      source: source.queueArn,
      target: target.queueArn,
      desiredState: 'STOPPED',
      description: 'cdkd-6233-kept',
      ...(removeEnrichment ? {} : { enrichment: enrichment.functionArn }),
      ...(removal || removeEnrichment
        ? {}
        : { enrichmentParameters: { inputTemplate: '{"enriched": <$.body>}' } }),
      targetParameters: {
        ...(removal ? {} : { inputTemplate: '{"wrapped": <$.body>}' }),
        sqsQueueParameters: { messageGroupId: 'cdkd-6233-group' },
      },
    });
  }
}
