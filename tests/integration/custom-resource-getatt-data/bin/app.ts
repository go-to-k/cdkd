#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CrGetAttDataStack } from '../lib/cr-getatt-data-stack.ts';

const app = new cdk.App();
new CrGetAttDataStack(app, 'CdkdCrGetAttDataExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
