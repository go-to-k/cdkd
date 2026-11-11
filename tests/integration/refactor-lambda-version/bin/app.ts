#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RefactorLambdaVersionStack } from '../lib/refactor-lambda-version-stack.ts';

const app = new cdk.App();
new RefactorLambdaVersionStack(app, 'CdkdRefactorLambdaVersionExample', {
  description: 'cdkd refactor: a new Lambda version or API deployment is not a rename',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
