#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppConfigStack } from '../lib/appconfig-stack.ts';

const app = new cdk.App();
new AppConfigStack(app, 'CdkdAppConfigExample', {
  description: 'cdkd AppConfig chain (compound-id Ref) integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
