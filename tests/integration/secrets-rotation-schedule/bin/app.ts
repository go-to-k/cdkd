#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretsRotationScheduleStack } from '../lib/secrets-rotation-schedule-stack.ts';

const app = new cdk.App();
new SecretsRotationScheduleStack(app, 'CdkdSecretsRotationScheduleExample', {
  description: 'cdkd Secrets Manager RotationSchedule (CC-API) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
