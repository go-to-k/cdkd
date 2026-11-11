#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SqsFifoUnnamedStack } from '../lib/sqs-fifo-unnamed-stack.ts';

const app = new cdk.App();
new SqsFifoUnnamedStack(app, 'CdkdSqsFifoUnnamedExample', {
  description: 'cdkd un-named FIFO SQS queue integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
