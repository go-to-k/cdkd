#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NodejsFunctionStack } from '../lib/nodejs-function-stack.ts';

const app = new cdk.App();
new NodejsFunctionStack(app, 'CdkdNodejsFunctionExample', {
  description: 'cdkd NodejsFunction (esbuild-bundled TS Lambda) functional integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
