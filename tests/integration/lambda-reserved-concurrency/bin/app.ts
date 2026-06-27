#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaReservedConcurrencyStack } from '../lib/lambda-reserved-concurrency-stack.ts';

const app = new cdk.App();
new LambdaReservedConcurrencyStack(app, 'CdkdLambdaReservedConcurrencyExample', {
  description: 'cdkd Lambda reservedConcurrentExecutions + Function URL integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
