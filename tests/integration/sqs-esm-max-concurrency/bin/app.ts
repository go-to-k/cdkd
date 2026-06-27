#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SqsEsmMaxConcurrencyStack } from '../lib/sqs-esm-max-concurrency-stack.ts';

const app = new cdk.App();
new SqsEsmMaxConcurrencyStack(app, 'CdkdSqsEsmMaxConcurrencyExample', {
  description: 'cdkd Lambda SQS ESM ScalingConfig.MaximumConcurrency integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
