#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RetainOrphanRedeployStack } from '../lib/retain-orphan-redeploy-stack.ts';

const app = new cdk.App();
new RetainOrphanRedeployStack(app, 'CdkdRetainOrphanRedeployExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
