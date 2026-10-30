#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApigwCloudWatchRoleRedeployStack } from '../lib/apigw-cloudwatch-role-redeploy-stack.ts';

const app = new cdk.App();

// verify.sh deploys the same app under two stack names: one for the released
// binary's premise, one for this build.
new ApigwCloudWatchRoleRedeployStack(app, process.env.ACRR_STACK ?? 'CdkdApigwCwRoleNew', {
  description: 'API Gateway account CloudWatch role across destroy and redeploy (issue #5064)',
});
