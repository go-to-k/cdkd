#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsTaskdefTagsLaunchTypeStack } from '../lib/ecs-taskdef-tags-launch-type-stack.ts';

const app = new cdk.App();
new EcsTaskdefTagsLaunchTypeStack(app, 'CdkdEcsTaskdefTagsLaunchTypeExample', {
  description: 'cdkd ECS TaskDefinition Tags update + Service LaunchType replacement integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
