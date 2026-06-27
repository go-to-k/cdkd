#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApigwUsagePlanKeyStack } from '../lib/apigw-usage-plan-key-stack.ts';

const app = new cdk.App();
new ApigwUsagePlanKeyStack(app, 'CdkdApigwUsagePlanKeyExample', {
  description: 'cdkd API Gateway UsagePlan + ApiKey + UsagePlanKey (compound-id Ref) integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
