#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaEsmDocumentdbStack } from '../lib/lambda-esm-documentdb-stack.ts';

const app = new cdk.App();
new LambdaEsmDocumentdbStack(app, 'CdkdLambdaEsmDocumentdbExample', {
  description: 'cdkd Lambda DocumentDB event source mapping update integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
