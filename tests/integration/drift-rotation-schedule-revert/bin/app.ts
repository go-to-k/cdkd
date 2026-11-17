#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftRotationScheduleRevertStack } from '../lib/drift-rotation-schedule-revert-stack.ts';

const app = new cdk.App();
new DriftRotationScheduleRevertStack(app, 'CdkdDriftRotationScheduleRevertExample', {
  description: 'cdkd drift --revert on a Secrets Manager rotation schedule integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
