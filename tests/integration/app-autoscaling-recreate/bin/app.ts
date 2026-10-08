#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppAutoscalingRecreateStack } from '../lib/app-autoscaling-recreate-stack.ts';

const app = new cdk.App();
new AppAutoscalingRecreateStack(app, 'CdkdAppAutoscalingRecreateExample', {
  description: 'cdkd import records a scalable target on Cloud Control; its recreate is refused (issue #4706)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
