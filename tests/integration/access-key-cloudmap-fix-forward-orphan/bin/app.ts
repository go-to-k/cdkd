#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AccessKeyCloudMapFixForwardOrphanStack } from '../lib/access-key-cloudmap-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new AccessKeyCloudMapFixForwardOrphanStack(app, 'CdkdAccessKeyCloudMapFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
