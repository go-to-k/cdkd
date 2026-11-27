#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppSyncSchemaUpdateDriftStack } from '../lib/appsync-schema-update-drift-stack.ts';

const app = new cdk.App();
new AppSyncSchemaUpdateDriftStack(app, 'CdkdAppSyncSchemaUpdateDriftExample', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
