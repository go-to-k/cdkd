#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsClusterCapacitySettingsStack } from '../lib/ecs-cluster-capacity-settings-stack.ts';

const app = new cdk.App();
new EcsClusterCapacitySettingsStack(app, 'CdkdEcsClusterCapacitySettings', {
  description: 'cdkd ECS cluster capacity providers + settings changed in one update (issue #6562)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
