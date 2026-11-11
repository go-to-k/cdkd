#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsPitrRestoreStack } from '../lib/rds-pitr-restore-stack.ts';

const app = new cdk.App();
new RdsPitrRestoreStack(app, 'CdkdRdsPitrRestoreExample', {
  description: 'cdkd RDS DB cluster point-in-time restore integ',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
