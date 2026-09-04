#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LoggroupNeverExpireGuardStack } from '../lib/loggroup-never-expire-guard-stack.ts';

const app = new cdk.App();
new LoggroupNeverExpireGuardStack(app, 'CdkdLoggroupNeverExpireGuardExample', {
  description:
    'cdkd never-expire log-group stateful-guard (issue #2558) integ probe: an unset RetentionInDays must not read as ephemeral',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
