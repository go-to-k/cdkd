#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MigrationStack } from '../lib/migration-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
new MigrationStack(app, 'Cdkd4705MigrateSingle', {
  description: 'cdkd #4705 migration probe: one stack under one state prefix',
  env,
  withRole: true,
});
new MigrationStack(app, 'Cdkd4705MigratePair', {
  description: 'cdkd #4705 migration probe: one stack name under two state prefixes',
  env,
  withRole: false,
});
