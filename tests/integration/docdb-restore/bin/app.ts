#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DocdbRestoreStack } from '../lib/docdb-restore-stack.ts';

const app = new cdk.App();
new DocdbRestoreStack(app, 'CdkdDocdbRestoreExample', {
  description: 'cdkd DocDB cluster restore (snapshot and point-in-time) integ',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
