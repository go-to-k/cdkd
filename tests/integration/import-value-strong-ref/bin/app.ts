#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProducerStack } from '../lib/producer-stack.ts';
import { ConsumerStack } from '../lib/consumer-stack.ts';

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

new ProducerStack(app, 'CdkdImportValueProducer', {
  description: 'Producer stack for Issue #343 integ test — exports BucketArn',
  env: { region },
});

new ConsumerStack(app, 'CdkdImportValueConsumer', {
  description: 'Consumer stack for Issue #343 integ test — imports BucketArn',
  env: { region },
});
