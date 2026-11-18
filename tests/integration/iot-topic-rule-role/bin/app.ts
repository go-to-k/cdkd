#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IotTopicRuleRoleStack } from '../lib/iot-topic-rule-role-stack.ts';

const app = new cdk.App();
new IotTopicRuleRoleStack(app, 'CdkdIotTopicRuleRole', {
  description: 'cdkd IoT topic rule created with a same-stack role (issue #6559)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
