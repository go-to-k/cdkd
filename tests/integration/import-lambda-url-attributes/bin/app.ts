#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportLambdaUrlAttributesStack } from '../lib/import-lambda-url-attributes-stack.ts';

const app = new cdk.App();
new ImportLambdaUrlAttributesStack(app, 'CdkdImportLambdaUrlAttributes', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
