#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsScheduleTargetsStack } from '../lib/ecs-schedule-targets-stack.ts';

const app = new cdk.App();
new EcsScheduleTargetsStack(app, 'CdkdEcsScheduleTargetsExample', {
  description: 'cdkd ECS Fargate targets on Events Rule + Scheduler Schedule (issues 1381/1382)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
