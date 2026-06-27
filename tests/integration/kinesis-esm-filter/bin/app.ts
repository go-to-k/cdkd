#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { KinesisEsmFilterStack } from '../lib/kinesis-esm-filter-stack.ts';

const app = new cdk.App();
new KinesisEsmFilterStack(app, 'CdkdKinesisEsmFilterExample', {
  description: 'cdkd Lambda Kinesis ESM FilterCriteria + tumbling window integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
