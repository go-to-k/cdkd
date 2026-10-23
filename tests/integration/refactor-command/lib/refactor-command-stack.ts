import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export const PFX = 'cdkd-refactor-command';

/**
 * Generation "a" (default) and generation "b" (`CDKD_TEST_UPDATE=true`) differ
 * ONLY in construct ids, so every renamed resource has a new logical id and
 * unchanged properties -- the case `cdkd refactor` keeps.
 *
 * - The table (explicit name, holds a data item) moves under a renamed parent.
 * - The queue (cdkd-generated name) is renamed.
 * - The two topics are identical, so the detection cannot pair them on its
 *   own: verify.sh names them with `--override-file`.
 * - The SSM parameter keeps its construct id and references all three, so it
 *   must show no change once the renames are applied.
 */
export class RefactorCommandStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const renamed = process.env.CDKD_TEST_UPDATE === 'true';

    const parent = new Construct(this, renamed ? 'Storage' : 'Legacy');
    const table = new dynamodb.Table(parent, renamed ? 'Data' : 'Table', {
      tableName: `${PFX}-data`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const queue = new sqs.Queue(this, renamed ? 'WorkQueue' : 'Queue', {
      visibilityTimeout: cdk.Duration.seconds(45),
    });

    const alertsX = new sns.Topic(this, renamed ? 'AlertsX' : 'TopicX');
    const alertsY = new sns.Topic(this, renamed ? 'AlertsY' : 'TopicY');

    new ssm.StringParameter(this, 'Wiring', {
      parameterName: `/cdkd-integ/${PFX}/wiring`,
      stringValue: cdk.Fn.join('|', [
        queue.queueUrl,
        table.tableName,
        alertsX.topicArn,
        alertsY.topicArn,
      ]),
    });
  }
}
