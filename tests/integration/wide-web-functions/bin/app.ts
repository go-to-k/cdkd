#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WideWebFunctionsStack } from '../lib/wide-web-functions-stack.ts';

const app = new cdk.App();
new WideWebFunctionsStack(app, 'CdkdWideWebFunctionsExample', {
  description: 'cdkd wide stack: 12 independent Lambda Web Functions (issue #5242)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
