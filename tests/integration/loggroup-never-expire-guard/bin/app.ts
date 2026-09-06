#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LoggroupNeverExpireGuardStack } from '../lib/loggroup-never-expire-guard-stack.ts';

const app = new cdk.App();
new LoggroupNeverExpireGuardStack(app, 'CdkdLoggroupNeverExpireGuardExample', {
  description:
    'cdkd log-group stateful-guard integ probe: an unset RetentionInDays must not read as ephemeral (issue #2558), and a string-valued or observed-only one must still settle the guard (issue #2521)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
