import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * A small SDK-path stack for timing deploy / redeploy / destroy across two
 * cdkd builds (go-to-k/cdkd#4705's performance check). Four independent
 * resources, all on native SDK providers, none named explicitly except the
 * parameter, which is scoped by the per-run stack name.
 *
 * covers: AWS::SQS::Queue
 * covers: AWS::SNS::Topic
 * covers: AWS::SSM::Parameter
 * covers: AWS::DynamoDB::Table
 */
export class PerfStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new sqs.Queue(this, 'Queue', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new sns.Topic(this, 'Topic');

    new ssm.StringParameter(this, 'Parameter', {
      parameterName: `/${this.stackName}/perf`,
      stringValue: 'perf-value',
    });

    new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
