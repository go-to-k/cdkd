#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaConfigFieldRemovalStack } from '../lib/lambda-config-field-removal-stack.ts';

const app = new cdk.App();
new LambdaConfigFieldRemovalStack(app, 'CdkdLambdaConfigFieldRemovalExample', {
  description: 'cdkd Lambda config-field removal reset (issue #1155) integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
