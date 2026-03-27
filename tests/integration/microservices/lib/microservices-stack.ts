import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Microservices communication stack
 *
 * Demonstrates:
 * - SNS Topic as event bus (fan-out pattern)
 * - 2 SQS Queues subscribing to the topic with filter policies
 * - 2 Lambda Functions with SQS event source mappings
 * - Each Lambda has its own DLQ
 * - SSM Parameters for service configuration
 * - CfnOutputs for topic ARN, queue URLs
 *
 * Architecture:
 *   SNS Topic (event bus)
 *     ├── service-a-queue (all messages) → service-a Lambda
 *     │     └── service-a-dlq
 *     └── service-b-queue (filtered: eventType=order) → service-b Lambda
 *           └── service-b-dlq
 */
export class MicroservicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- SNS Topic (Event Bus) ---
    const eventBus = new sns.Topic(this, 'EventBus', {
      topicName: 'cdkd-microservices-event-bus',
      displayName: 'Microservices Event Bus',
    });

    // --- Service A: DLQ + Queue + Lambda ---
    const serviceADlq = new sqs.Queue(this, 'ServiceADlq', {
      queueName: 'cdkd-microservices-service-a-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const serviceAQueue = new sqs.Queue(this, 'ServiceAQueue', {
      queueName: 'cdkd-microservices-service-a-queue',
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: serviceADlq,
        maxReceiveCount: 3,
      },
    });

    // Service A subscribes to ALL messages
    eventBus.addSubscription(
      new subscriptions.SqsSubscription(serviceAQueue)
    );

    const serviceAConfig = new ssm.StringParameter(this, 'ServiceAConfig', {
      parameterName: '/cdkd-test/microservices/service-a/config',
      stringValue: JSON.stringify({
        serviceName: 'service-a',
        version: '1.0.0',
        maxRetries: 3,
        timeoutSeconds: 30,
      }),
      description: 'Service A configuration',
    });

    const serviceAFn = new lambda.Function(this, 'ServiceAFunction', {
      functionName: 'cdkd-microservices-service-a',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset('lambda/service-a'),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        SERVICE_NAME: 'service-a',
        QUEUE_URL: serviceAQueue.queueUrl,
        CONFIG_PATH: serviceAConfig.parameterName,
      },
    });

    serviceAFn.addEventSource(
      new eventsources.SqsEventSource(serviceAQueue, {
        batchSize: 10,
      })
    );

    // --- Service B: DLQ + Queue + Lambda ---
    const serviceBDlq = new sqs.Queue(this, 'ServiceBDlq', {
      queueName: 'cdkd-microservices-service-b-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const serviceBQueue = new sqs.Queue(this, 'ServiceBQueue', {
      queueName: 'cdkd-microservices-service-b-queue',
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: serviceBDlq,
        maxReceiveCount: 3,
      },
    });

    // Service B subscribes with filter policy (only 'order' events)
    eventBus.addSubscription(
      new subscriptions.SqsSubscription(serviceBQueue, {
        filterPolicy: {
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: ['order'],
          }),
        },
      })
    );

    const serviceBConfig = new ssm.StringParameter(this, 'ServiceBConfig', {
      parameterName: '/cdkd-test/microservices/service-b/config',
      stringValue: JSON.stringify({
        serviceName: 'service-b',
        version: '1.0.0',
        maxRetries: 5,
        timeoutSeconds: 60,
      }),
      description: 'Service B configuration',
    });

    const serviceBFn = new lambda.Function(this, 'ServiceBFunction', {
      functionName: 'cdkd-microservices-service-b',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset('lambda/service-b'),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        SERVICE_NAME: 'service-b',
        QUEUE_URL: serviceBQueue.queueUrl,
        CONFIG_PATH: serviceBConfig.parameterName,
      },
    });

    serviceBFn.addEventSource(
      new eventsources.SqsEventSource(serviceBQueue, {
        batchSize: 5,
      })
    );

    // --- Outputs ---
    new cdk.CfnOutput(this, 'EventBusTopicArn', {
      value: eventBus.topicArn,
      description: 'SNS Topic ARN (event bus)',
    });

    new cdk.CfnOutput(this, 'ServiceAQueueUrl', {
      value: serviceAQueue.queueUrl,
      description: 'Service A SQS Queue URL',
    });

    new cdk.CfnOutput(this, 'ServiceADlqUrl', {
      value: serviceADlq.queueUrl,
      description: 'Service A Dead Letter Queue URL',
    });

    new cdk.CfnOutput(this, 'ServiceAFunctionName', {
      value: serviceAFn.functionName,
      description: 'Service A Lambda function name',
    });

    new cdk.CfnOutput(this, 'ServiceBQueueUrl', {
      value: serviceBQueue.queueUrl,
      description: 'Service B SQS Queue URL',
    });

    new cdk.CfnOutput(this, 'ServiceBDlqUrl', {
      value: serviceBDlq.queueUrl,
      description: 'Service B Dead Letter Queue URL',
    });

    new cdk.CfnOutput(this, 'ServiceBFunctionName', {
      value: serviceBFn.functionName,
      description: 'Service B Lambda function name',
    });

    new cdk.CfnOutput(this, 'ServiceAConfigPath', {
      value: serviceAConfig.parameterName,
      description: 'Service A SSM Parameter path',
    });

    new cdk.CfnOutput(this, 'ServiceBConfigPath', {
      value: serviceBConfig.parameterName,
      description: 'Service B SSM Parameter path',
    });
  }
}
