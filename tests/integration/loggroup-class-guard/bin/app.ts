#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LoggroupClassGuardStack } from '../lib/loggroup-class-guard-stack.ts';

const app = new cdk.App();
new LoggroupClassGuardStack(app, 'CdkdLoggroupClassGuardExample', {
  description: 'cdkd LogGroupClass update-guard (updates are not supported -> typed error + --replace) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
