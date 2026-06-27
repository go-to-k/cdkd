#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaAliasProvisionedConcurrencyStack } from '../lib/lambda-alias-provisioned-concurrency-stack.ts';

const app = new cdk.App();
new LambdaAliasProvisionedConcurrencyStack(app, 'CdkdLambdaAliasProvisionedConcurrencyExample', {
  description: 'cdkd Lambda Version + Alias provisioned concurrency integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
