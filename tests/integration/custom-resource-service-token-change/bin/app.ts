#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CrServiceTokenChangeStack } from '../lib/cr-service-token-change-stack.ts';

const app = new cdk.App();
new CrServiceTokenChangeStack(app, 'CdkdCrServiceTokenChange', {
  description: 'cdkd refuses a changed custom-resource ServiceToken integ (issue #4749)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
